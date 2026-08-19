import { describe, expect, it } from "vitest";
import { ExecutionCoordinator, type ExecutionGateState } from "../src/application/execution/ExecutionCoordinator.js";
import { resolveExecutionGate } from "../src/application/runtime/TradingRuntimeManager.js";
import { TradingReconciliationService } from "../src/application/execution/TradingReconciliationService.js";
import { RealExecutionProposalGateway } from "../src/application/execution/RealExecutionProposalGateway.js";
import type {
  ExecutionGateway,
  ExecutionOrderContext,
  ExecutionOrderLookupResult,
  ProtectionOrderRequest,
  RecoverableExecutionGateway,
  SubmittedOrder
} from "../src/application/ports/ExecutionGateway.js";
import type { ExecutionIntent } from "../src/application/execution/ExecutionIntent.js";
import type { ExecutionIntentRepository } from "../src/application/execution/ExecutionIntentRepository.js";
import type { DecisionLogger } from "../src/application/ports/Logger.js";
import type { EntryPlan } from "../src/domain/entry/EntryCalculator.js";
import type { RiskDecision } from "../src/domain/risk/RiskDecision.js";
import type { AppConfig } from "../src/application/config/AppConfig.js";
import { defaultTradingSettings } from "../src/application/config/AppConfig.js";
import { MarketScanner } from "../src/application/scanner/MarketScanner.js";
import type { BinanceFuturesMarketData } from "../src/infrastructure/market-data/BinanceFuturesMarketData.js";
import { MemoryExecutionIntentRepository } from "../src/infrastructure/execution/MemoryExecutionIntentRepository.js";
import { MemoryRealExecutionProposalRepository } from "../src/infrastructure/execution/MemoryRealExecutionProposalRepository.js";
import { createExecutionGateway } from "../src/infrastructure/execution/createExecutionGateway.js";
import { MemoryTradingRepository } from "../src/infrastructure/persistence/MemoryTradingRepository.js";
import { LockedRealExecutionGateway } from "../src/infrastructure/execution/LockedRealExecutionGateway.js";
import { isRecoverableExecutionGateway } from "../src/application/ports/ExecutionGateway.js";

describe("ExecutionCoordinator", () => {
  it("submits the same setup only once across repeated scanner calls", async () => {
    const repository = new MemoryExecutionIntentRepository();
    const delegate = new RecordingGateway();
    const coordinator = coordinatorFor("account-a", repository, delegate);

    const first = await coordinator.submitBracketOrder(plan(), risk());
    const second = await coordinator.submitBracketOrder(plan(), risk());
    const third = await coordinator.submitBracketOrder(plan(), risk());

    expect(first.orderId).toBe("entry-1");
    expect(second.orderId).toBe("entry-1");
    expect(third.orderId).toBe("entry-1");
    expect(delegate.calls).toHaveLength(1);
    expect((await repository.listByAccount("account-a"))[0]?.status).toBe("PROTECTED");
  });

  it("fails closed after an ambiguous timeout and does not retry with a new order", async () => {
    const repository = new MemoryExecutionIntentRepository();
    const delegate = new RecordingGateway([new Error("network timeout after acceptance")]);
    const coordinator = coordinatorFor("account-a", repository, delegate);

    await expect(coordinator.submitBracketOrder(plan(), risk())).rejects.toThrow("RECONCILIATION_REQUIRED");
    await expect(coordinator.submitBracketOrder(plan(), risk())).rejects.toThrow("RECONCILIATION_REQUIRED");

    expect(delegate.calls).toHaveLength(1);
    expect((await repository.listByAccount("account-a"))[0]?.status).toBe("RECONCILIATION_REQUIRED");
  });

  it("accepts an entry order recovered by clientOrderId after an ambiguous timeout", async () => {
    const repository = new MemoryExecutionIntentRepository();
    const delegate = new RecoverableRecordingGateway([new Error("network timeout after acceptance")]);
    const coordinator = coordinatorFor("account-a", repository, delegate);

    const recovered = await coordinator.submitBracketOrder(plan(), risk());

    expect(recovered.orderId).toBe("entry-recovered");
    expect(delegate.calls).toHaveLength(1);
    expect(delegate.lookups).toHaveLength(1);
    const intent = (await repository.listByAccount("account-a"))[0];
    expect(intent?.status).toBe("PROTECTION_INCOMPLETE");
    expect(intent?.binanceEntryOrderId).toBe("entry-recovered");
  });

  it("looks up deterministic clientOrderId before retrying an ambiguous Binance response", async () => {
    const repository = new MemoryExecutionIntentRepository();
    const delegate = new RecoverableRecordingGateway([new Error("network timeout after acceptance"), new Error("should not retry")]);
    const coordinator = new ExecutionCoordinator({
      tradingAccountId: "account-a",
      mode: "DEMO",
      entryType: "market",
      repository,
      delegate,
      logger: fakeLogger(),
      retry: { maxAttempts: 3, baseDelayMs: 0 },
      runtimeReady: () => true
    });

    const recovered = await coordinator.submitBracketOrder(plan(), risk());

    expect(recovered.orderId).toBe("entry-recovered");
    expect(delegate.calls).toHaveLength(1);
    expect(delegate.lookups).toHaveLength(1);
  });

  it("does not resubmit after restart when an entry was already submitted", async () => {
    const repository = new MemoryExecutionIntentRepository();
    await coordinatorFor("account-a", repository, new RecordingGateway([{ orderId: "entry-1", mode: "testnet" }])).submitBracketOrder(plan(), risk());

    const afterRestartDelegate = new RecordingGateway();
    const afterRestart = await coordinatorFor("account-a", repository, afterRestartDelegate).submitBracketOrder(plan(), risk());

    expect(afterRestart.orderId).toBe("entry-1");
    expect(afterRestartDelegate.calls).toHaveLength(0);
  });

  it("does not mark an execution fully protected when TP is missing", async () => {
    const repository = new MemoryExecutionIntentRepository();
    const delegate = new RecordingGateway([{ orderId: "entry-1", stopLossOrderId: "stop-1", mode: "testnet" }]);
    const coordinator = coordinatorFor("account-a", repository, delegate);

    await coordinator.submitBracketOrder(plan(), risk());

    const intent = (await repository.listByAccount("account-a"))[0];
    expect(intent?.status).toBe("PROTECTION_INCOMPLETE");
    expect(intent?.binanceStopOrderId).toBe("stop-1");
    expect(intent?.binanceTakeProfitOrderId).toBeNull();
  });

  it("keeps executions isolated for two accounts trading the same symbol", async () => {
    const repository = new MemoryExecutionIntentRepository();
    const delegateA = new RecordingGateway();
    const delegateB = new RecordingGateway();

    await coordinatorFor("account-a", repository, delegateA).submitBracketOrder(plan(), risk());
    await coordinatorFor("account-b", repository, delegateB).submitBracketOrder(plan(), risk());

    expect(delegateA.calls).toHaveLength(1);
    expect(delegateB.calls).toHaveLength(1);
    expect(await repository.listByAccount("account-a")).toHaveLength(1);
    expect(await repository.listByAccount("account-b")).toHaveLength(1);
    expect((await repository.listByAccount("account-a"))[0]?.id).not.toBe((await repository.listByAccount("account-b"))[0]?.id);
  });

  it("keeps REAL execution locked", async () => {
    const repository = new MemoryExecutionIntentRepository();
    const delegate = new RecordingGateway();
    const coordinator = coordinatorFor("account-real", repository, delegate, "REAL");

    await expect(coordinator.submitBracketOrder(plan(), risk())).rejects.toThrow("REAL_EXECUTION_LOCKED");
    expect(delegate.calls).toHaveLength(0);
    expect(await repository.listByAccount("account-real")).toHaveLength(0);
    expect(isRecoverableExecutionGateway(new LockedRealExecutionGateway())).toBe(false);
  });

  it("keeps REAL locked before pre-trade validation and creates no intent", async () => {
    const repository = new MemoryExecutionIntentRepository();
    const delegate = new RecordingGateway();
    let validated = false;
    const coordinator = new ExecutionCoordinator({
      tradingAccountId: "account-real",
      mode: "REAL",
      entryType: "market",
      repository,
      delegate,
      logger: fakeLogger(),
      retry: { maxAttempts: 1, baseDelayMs: 0 },
      executionGate: () => ({ enabled: true, reason: "READY" }),
      preTradeValidation: () => {
        validated = true;
      }
    });

    await expect(coordinator.submitBracketOrder(plan(), risk())).rejects.toThrow("REAL_EXECUTION_LOCKED");
    expect(validated).toBe(false);
    expect(delegate.calls).toHaveLength(0);
    expect(await repository.listByAccount("account-real")).toHaveLength(0);
  });

  it("keeps REAL execution locked in production even when trading is enabled and runtime is ready", async () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const repository = new MemoryExecutionIntentRepository();
      const delegate = new RecordingGateway();
      const coordinator = new ExecutionCoordinator({
        tradingAccountId: "account-real",
        mode: "REAL",
        entryType: "market",
        repository,
        delegate,
        logger: fakeLogger(),
        retry: { maxAttempts: 3, baseDelayMs: 0 },
        runtimeReady: () => true
      });

      await expect(coordinator.submitBracketOrder(plan(), risk())).rejects.toThrow("REAL_EXECUTION_LOCKED");
      expect(delegate.calls).toHaveLength(0);
      expect(await repository.listByAccount("account-real")).toHaveLength(0);
    } finally {
      if (previous === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previous;
    }
  });

  it("blocks execution while runtime is not ready", async () => {
    const repository = new MemoryExecutionIntentRepository();
    const delegate = new RecordingGateway();
    const coordinator = new ExecutionCoordinator({
      tradingAccountId: "account-a",
      mode: "DEMO",
      entryType: "market",
      repository,
      delegate,
      logger: fakeLogger(),
      retry: { maxAttempts: 1, baseDelayMs: 0 },
      runtimeReady: () => false
    });

    await expect(coordinator.submitBracketOrder(plan(), risk())).rejects.toThrow("RECONCILIATION_REQUIRED");
    expect(delegate.calls).toHaveLength(0);
    expect(await repository.listByAccount("account-a")).toHaveLength(0);
  });

  it("prevents submit when trading is disabled and does not create an intent", async () => {
    const repository = new MemoryExecutionIntentRepository();
    const delegate = new RecordingGateway();
    const coordinator = coordinatorFor("account-a", repository, delegate, "DEMO", () => ({ enabled: false, reason: "TRADING_DISABLED" }));

    await expect(coordinator.submitBracketOrder(plan(), risk())).rejects.toThrow("TRADING_DISABLED");
    expect(delegate.calls).toHaveLength(0);
    expect(await repository.listByAccount("account-a")).toHaveLength(0);
  });

  it("prevents submit when kill switch is on and does not create an intent", async () => {
    const repository = new MemoryExecutionIntentRepository();
    const delegate = new RecordingGateway();
    const coordinator = coordinatorFor("account-a", repository, delegate, "DEMO", () => ({ enabled: false, reason: "KILL_SWITCH" }));

    await expect(coordinator.submitBracketOrder(plan(), risk())).rejects.toThrow("KILL_SWITCH");
    expect(delegate.calls).toHaveLength(0);
    expect(await repository.listByAccount("account-a")).toHaveLength(0);
  });

  it("evaluates execution gate on every submit so saved settings take effect without restart", async () => {
    const repository = new MemoryExecutionIntentRepository();
    const delegate = new RecordingGateway();
    let gate: ExecutionGateState = { enabled: false, reason: "TRADING_DISABLED" };
    const coordinator = coordinatorFor("account-a", repository, delegate, "DEMO", () => gate);

    await expect(coordinator.submitBracketOrder(plan(), risk())).rejects.toThrow("TRADING_DISABLED");
    gate = { enabled: true, reason: "READY" };

    await coordinator.submitBracketOrder(plan(), risk());

    expect(delegate.calls).toHaveLength(1);
    expect(await repository.listByAccount("account-a")).toHaveLength(1);
  });

  it("blocks symbol rule failures before creating an intent or submitting", async () => {
    const repository = new MemoryExecutionIntentRepository();
    const delegate = new RecordingGateway();
    const coordinator = new ExecutionCoordinator({
      tradingAccountId: "account-a",
      mode: "DEMO",
      entryType: "market",
      repository,
      delegate,
      logger: fakeLogger(),
      retry: { maxAttempts: 1, baseDelayMs: 0 },
      executionGate: () => ({ enabled: true, reason: "READY" }),
      preTradeValidation: () => {
        throw new Error("MIN_QTY");
      }
    });

    await expect(coordinator.submitBracketOrder(plan(), risk())).rejects.toThrow("MIN_QTY");
    expect(delegate.calls).toHaveLength(0);
    expect(await repository.listByAccount("account-a")).toHaveLength(0);
  });

  it("does not submit to Binance when the execution repository is unavailable", async () => {
    const delegate = new RecordingGateway();
    const coordinator = new ExecutionCoordinator({
      tradingAccountId: "account-a",
      mode: "DEMO",
      entryType: "market",
      repository: new FailingExecutionIntentRepository(),
      delegate,
      logger: fakeLogger(),
      retry: { maxAttempts: 1, baseDelayMs: 0 },
      runtimeReady: () => true
    });

    await expect(coordinator.submitBracketOrder(plan(), risk())).rejects.toThrow("DB_DOWN");
    expect(delegate.calls).toHaveLength(0);
  });
});

describe("Execution gate", () => {
  it("gives kill switch priority over trading enabled", () => {
    expect(
      resolveExecutionGate({
        shuttingDown: false,
        mode: "DEMO",
        runtimeState: "READY",
        reconciliationStatus: "OK",
        tradingEnabled: true,
        killSwitch: true,
        binanceConnected: true
      })
    ).toEqual({ enabled: false, reason: "KILL_SWITCH" });
  });

  it("keeps account-scoped disabled settings isolated from another account", async () => {
    const repository = new MemoryExecutionIntentRepository();
    const delegateA = new RecordingGateway();
    const delegateB = new RecordingGateway();
    const accountA = coordinatorFor("account-a", repository, delegateA, "DEMO", () => ({ enabled: false, reason: "TRADING_DISABLED" }));
    const accountB = coordinatorFor("account-b", repository, delegateB, "DEMO", () => ({ enabled: true, reason: "READY" }));

    await expect(accountA.submitBracketOrder(plan(), risk())).rejects.toThrow("TRADING_DISABLED");
    await accountB.submitBracketOrder(plan(), risk());

    expect(delegateA.calls).toHaveLength(0);
    expect(delegateB.calls).toHaveLength(1);
    expect(await repository.listByAccount("account-a")).toHaveLength(0);
    expect(await repository.listByAccount("account-b")).toHaveLength(1);
  });

  it("keeps REAL locked regardless of trading enabled and kill switch settings", async () => {
    const repository = new MemoryExecutionIntentRepository();
    const delegate = new RecordingGateway();
    const coordinator = coordinatorFor("account-real", repository, delegate, "REAL", () => ({ enabled: true, reason: "READY" }));

    await expect(coordinator.submitBracketOrder(plan(), risk())).rejects.toThrow("REAL_EXECUTION_LOCKED");
    expect(delegate.calls).toHaveLength(0);
    expect(await repository.listByAccount("account-real")).toHaveLength(0);
  });

  it("does not call Binance in blocked gate cases", async () => {
    const cases: ExecutionGateState[] = [
      { enabled: false, reason: "TRADING_DISABLED" },
      { enabled: false, reason: "KILL_SWITCH" },
      { enabled: false, reason: "BINANCE_DISCONNECTED" },
      { enabled: false, reason: "RUNTIME_NOT_READY" },
      { enabled: false, reason: "RECONCILIATION_REQUIRED" },
      { enabled: false, reason: "SHUTTING_DOWN" }
    ];

    for (const gate of cases) {
      const repository = new MemoryExecutionIntentRepository();
      const delegate = new RecordingGateway();
      const coordinator = coordinatorFor(`account-${gate.reason}`, repository, delegate, "DEMO", () => gate);

      await expect(coordinator.submitBracketOrder(plan(), risk())).rejects.toThrow(gate.reason);
      expect(delegate.calls).toHaveLength(0);
      expect(await repository.listByAccount(`account-${gate.reason}`)).toHaveLength(0);
    }
  });

  it("allows scanner analysis to run while execution is disabled", async () => {
    const marketData = {
      getClosedCandles: async () => []
    } as unknown as BinanceFuturesMarketData;
    const scanner = new MarketScanner(
      appConfig({ tradingEnabled: false, killSwitch: true, watchlist: ["BTCUSDT"], symbol: "BTCUSDT" }),
      new MemoryTradingRepository(),
      new ThrowingExecutionGateway(),
      fakeLogger(),
      marketData,
      null
    );

    await scanner.bootstrap();

    expect(scanner.getWatchlistStatus()[0]?.symbol).toBe("BTCUSDT");
  });
});

describe("RealExecutionProposalGateway", () => {
  it("keeps REAL default LOCKED mode from creating a proposal", async () => {
    const proposals = new MemoryRealExecutionProposalRepository();
    const gateway = realProposalGateway(proposals, { realExecutionMode: "LOCKED", tradingEnabled: true });

    await expect(gateway.submitBracketOrder(plan(), risk())).rejects.toThrow("REAL_EXECUTION_MODE_LOCKED");
    expect(await proposals.listByAccount("account-real")).toHaveLength(0);
  });

  it("creates a DRY_RUN proposal only and never returns a submitted order", async () => {
    const proposals = new MemoryRealExecutionProposalRepository();
    const gateway = realProposalGateway(proposals, { realExecutionMode: "DRY_RUN", tradingEnabled: true });

    await expect(gateway.submitBracketOrder(plan(), risk())).rejects.toThrow("REAL_DRY_RUN_CREATED");

    const saved = await proposals.listByAccount("account-real");
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ status: "DRY_RUN", normalizedQuantity: 10, normalizedStopLoss: 95, normalizedTakeProfit: 110 });
  });

  it("creates one PENDING proposal in APPROVAL_REQUIRED mode for duplicate setup", async () => {
    const proposals = new MemoryRealExecutionProposalRepository();
    const gateway = realProposalGateway(proposals, { realExecutionMode: "APPROVAL_REQUIRED", tradingEnabled: true });

    await expect(gateway.submitBracketOrder(plan(), risk())).rejects.toThrow("APPROVAL_REQUIRED");
    await expect(gateway.submitBracketOrder(plan(), risk())).rejects.toThrow("APPROVAL_REQUIRED");

    const saved = await proposals.listByAccount("account-real");
    expect(saved).toHaveLength(1);
    expect(saved[0]?.status).toBe("PENDING");
  });

  it("blocks proposals when Trading Enabled is off or Kill Switch is on", async () => {
    const disabled = new MemoryRealExecutionProposalRepository();
    await expect(realProposalGateway(disabled, { realExecutionMode: "DRY_RUN", tradingEnabled: false }).submitBracketOrder(plan(), risk())).rejects.toThrow("TRADING_DISABLED");
    expect(await disabled.listByAccount("account-real")).toHaveLength(0);

    const killed = new MemoryRealExecutionProposalRepository();
    await expect(realProposalGateway(killed, { realExecutionMode: "DRY_RUN", tradingEnabled: true, killSwitch: true }).submitBracketOrder(plan(), risk())).rejects.toThrow("KILL_SWITCH");
    expect(await killed.listByAccount("account-real")).toHaveLength(0);
  });

  it("legacy live gateway is locked unless server master lock is enabled", async () => {
    const gateway = createExecutionGateway(appConfig({ executionMode: "live", binanceApiKey: "KEY", binanceApiSecret: "SECRET", realLiveExecutionEnabled: false }));

    await expect(gateway.submitBracketOrder(plan(), risk())).rejects.toThrow("REAL_EXECUTION_LOCKED");
  });
});

describe("TradingReconciliationService", () => {
  it("detects external/manual positions without attaching them to bot intents", async () => {
    const repository = new MemoryExecutionIntentRepository();
    const service = new TradingReconciliationService(repository, fakeLogger());

    const result = await service.reconcile("account-a", async () => ({
      connected: true,
      positions: [
        {
          id: "binance:BTCUSDT:long",
          symbol: "BTCUSDT",
          side: "long",
          entryPrice: 100,
          entryTime: null,
          quantity: 1,
          notional: 100,
          leverage: 5,
          margin: 20,
          unrealizedProfit: 0,
          stopLoss: null,
          takeProfit: null
        }
      ],
      openOrders: [],
      orderHistory: [],
      tradeHistory: []
    }));

    expect(result.externalPositions).toBe(1);
    expect((await repository.listAuditEvents("account-a")).some((event) => event.type === "EXTERNAL_POSITION_DETECTED")).toBe(true);
    expect(await repository.listByAccount("account-a")).toHaveLength(0);
  });

  it("repairs only the missing take-profit protection order", async () => {
    const repository = new MemoryExecutionIntentRepository();
    const intent = await seedFilledIntent(repository, "account-a");
    const gateway = new RecoverableRecordingGateway();
    const service = new TradingReconciliationService(repository, fakeLogger());

    await service.reconcile("account-a", activityWithPosition(intent, [openOrder(intent, "STOP_MARKET", intent.clientStopOrderId, "stop-existing")]), gateway);

    expect(gateway.protectionRequests.map((request) => request.type)).toEqual(["TAKE_PROFIT_MARKET"]);
    const saved = (await repository.listByAccount("account-a"))[0];
    expect(saved?.status).toBe("PROTECTED");
    expect(saved?.binanceStopOrderId).toBe("stop-existing");
    expect(saved?.binanceTakeProfitOrderId).toBe("tp-repaired-1");
  });

  it("repairs only the missing stop-loss protection order", async () => {
    const repository = new MemoryExecutionIntentRepository();
    const intent = await seedFilledIntent(repository, "account-a");
    const gateway = new RecoverableRecordingGateway();
    const service = new TradingReconciliationService(repository, fakeLogger());

    await service.reconcile("account-a", activityWithPosition(intent, [openOrder(intent, "TAKE_PROFIT_MARKET", intent.clientTakeProfitOrderId, "tp-existing")]), gateway);

    expect(gateway.protectionRequests.map((request) => request.type)).toEqual(["STOP_MARKET"]);
    const saved = (await repository.listByAccount("account-a"))[0];
    expect(saved?.status).toBe("PROTECTED");
    expect(saved?.binanceStopOrderId).toBe("stop-repaired-1");
    expect(saved?.binanceTakeProfitOrderId).toBe("tp-existing");
  });

  it("does not duplicate protection orders when both already exist", async () => {
    const repository = new MemoryExecutionIntentRepository();
    const intent = await seedFilledIntent(repository, "account-a");
    const gateway = new RecoverableRecordingGateway();
    const service = new TradingReconciliationService(repository, fakeLogger());

    await service.reconcile(
      "account-a",
      activityWithPosition(intent, [
        openOrder(intent, "STOP_MARKET", intent.clientStopOrderId, "stop-existing"),
        openOrder(intent, "TAKE_PROFIT_MARKET", intent.clientTakeProfitOrderId, "tp-existing")
      ]),
      gateway
    );

    expect(gateway.protectionRequests).toHaveLength(0);
    const saved = (await repository.listByAccount("account-a"))[0];
    expect(saved?.status).toBe("PROTECTED");
  });

  it("closes intents when Binance position is gone and cancels only bot-owned stale protection", async () => {
    const repository = new MemoryExecutionIntentRepository();
    const intent = await seedFilledIntent(repository, "account-a");
    await repository.transitionStatus(intent.id, ["ENTRY_FILLED"], "PROTECTED", {
      binanceStopOrderId: "stop-existing",
      binanceTakeProfitOrderId: "tp-existing"
    });
    const gateway = new RecoverableRecordingGateway();
    const service = new TradingReconciliationService(repository, fakeLogger());

    await service.reconcile(
      "account-a",
      async () => ({
        connected: true,
        positions: [],
        openOrders: [
          openOrder(intent, "STOP_MARKET", intent.clientStopOrderId, "stop-existing"),
          openOrder(intent, "TAKE_PROFIT_MARKET", intent.clientTakeProfitOrderId, "tp-existing"),
          openOrder(intent, "STOP_MARKET", "manual-stop", "manual-stop-id")
        ],
        orderHistory: [],
        tradeHistory: []
      }),
      gateway
    );

    expect(gateway.cancelled).toEqual([intent.clientStopOrderId, intent.clientTakeProfitOrderId]);
    expect((await repository.listByAccount("account-a"))[0]?.status).toBe("CLOSED");
  });

  it("recovers an entry-submitting intent from known Binance order history without resubmitting", async () => {
    const repository = new MemoryExecutionIntentRepository();
    const intent = await seedIntent(repository, "account-a", "ENTRY_SUBMITTING");
    const gateway = new RecoverableRecordingGateway();
    const service = new TradingReconciliationService(repository, fakeLogger());

    await service.reconcile(
      "account-a",
      async () => ({
        connected: true,
        positions: [],
        openOrders: [],
        orderHistory: [{ ...openOrder(intent, "STOP_MARKET", intent.clientEntryOrderId, "entry-history"), type: "MARKET", reduceOnly: false, averagePrice: 100 }],
        tradeHistory: []
      }),
      gateway
    );

    const saved = (await repository.listByAccount("account-a"))[0];
    expect(saved?.status).toBe("ENTRY_SUBMITTED");
    expect(saved?.binanceEntryOrderId).toBe("entry-history");
    expect(gateway.protectionRequests).toHaveLength(0);
  });

  it("keeps reconciliation and protection repair isolated between two accounts on the same symbol", async () => {
    const repository = new MemoryExecutionIntentRepository();
    const accountAIntent = await seedFilledIntent(repository, "account-a");
    const accountBIntent = await seedFilledIntent(repository, "account-b");
    const gatewayA = new RecoverableRecordingGateway();
    const service = new TradingReconciliationService(repository, fakeLogger());

    await service.reconcile("account-a", activityWithPosition(accountAIntent, [openOrder(accountAIntent, "STOP_MARKET", accountAIntent.clientStopOrderId, "a-stop")]), gatewayA);

    const accountA = (await repository.listByAccount("account-a"))[0];
    const accountB = (await repository.listByAccount("account-b"))[0];
    expect(accountA?.status).toBe("PROTECTED");
    expect(accountB?.status).toBe("ENTRY_FILLED");
    expect(accountB?.binanceStopOrderId).toBeNull();
    expect(accountB?.binanceTakeProfitOrderId).toBeNull();
    expect(gatewayA.protectionRequests).toHaveLength(1);
    expect(gatewayA.protectionRequests[0]?.clientOrderId).toBe(accountAIntent.clientTakeProfitOrderId);
  });

  it("does not submit reconciliation repair orders when REAL gateway is locked", async () => {
    const repository = new MemoryExecutionIntentRepository();
    const intent = await seedFilledIntent(repository, "account-real");
    const service = new TradingReconciliationService(repository, fakeLogger());
    const lockedGateway = new LockedRealExecutionGateway();

    await service.reconcile("account-real", activityWithPosition(intent, []), isRecoverableExecutionGateway(lockedGateway) ? lockedGateway : undefined);

    const saved = (await repository.listByAccount("account-real"))[0];
    expect(saved?.status).toBe("RECONCILIATION_REQUIRED");
    expect(saved?.binanceStopOrderId).toBeNull();
    expect(saved?.binanceTakeProfitOrderId).toBeNull();
  });

  it("does not submit protection repair orders when execution gate blocks them", async () => {
    const repository = new MemoryExecutionIntentRepository();
    const intent = await seedFilledIntent(repository, "account-a");
    const gateway = new BlockingRecoverableGateway("KILL_SWITCH");
    const service = new TradingReconciliationService(repository, fakeLogger());

    await service.reconcile("account-a", activityWithPosition(intent, []), gateway);

    const saved = (await repository.listByAccount("account-a"))[0];
    expect(gateway.protectionRequests).toHaveLength(0);
    expect(saved?.status).toBe("RECONCILIATION_REQUIRED");
    expect(saved?.lastError).toBe("KILL_SWITCH");
    expect(saved?.binanceStopOrderId).toBeNull();
    expect(saved?.binanceTakeProfitOrderId).toBeNull();
  });
});

class RecordingGateway implements ExecutionGateway {
  calls: ExecutionOrderContext[] = [];
  private count = 0;

  constructor(private readonly responses: Array<SubmittedOrder | Error> = []) {}

  async submitBracketOrder(_plan: EntryPlan, _risk: RiskDecision, context?: ExecutionOrderContext): Promise<SubmittedOrder> {
    if (!context) throw new Error("Expected execution context");
    this.calls.push(context);
    const response = this.responses.shift();
    if (response instanceof Error) throw response;
    if (response) return response;
    this.count += 1;
    return {
      orderId: `entry-${this.count}`,
      stopLossOrderId: `stop-${this.count}`,
      takeProfitOrderId: `tp-${this.count}`,
      clientEntryOrderId: context.clientEntryOrderId,
      clientStopOrderId: context.clientStopOrderId,
      clientTakeProfitOrderId: context.clientTakeProfitOrderId,
      mode: "testnet"
    };
  }
}

class RecoverableRecordingGateway extends RecordingGateway implements RecoverableExecutionGateway {
  lookups: Array<{ symbol: string; clientOrderId: string }> = [];
  protectionRequests: ProtectionOrderRequest[] = [];
  cancelled: string[] = [];

  async findOrderByClientOrderId(symbol: string, clientOrderId: string): Promise<ExecutionOrderLookupResult | null> {
    this.lookups.push({ symbol, clientOrderId });
    return {
      orderId: "entry-recovered",
      clientOrderId,
      symbol,
      side: "BUY",
      type: "MARKET",
      status: "NEW",
      reduceOnly: false,
      originalQuantity: 10,
      executedQuantity: 0,
      averagePrice: null
    };
  }

  async submitProtectionOrder(request: ProtectionOrderRequest): Promise<ExecutionOrderLookupResult> {
    this.protectionRequests.push(request);
    const orderId = request.type === "STOP_MARKET" ? `stop-repaired-${this.protectionRequests.length}` : `tp-repaired-${this.protectionRequests.length}`;
    return {
      orderId,
      clientOrderId: request.clientOrderId,
      symbol: request.symbol,
      side: request.side,
      type: request.type,
      status: "NEW",
      reduceOnly: true,
      originalQuantity: request.quantity,
      executedQuantity: 0,
      averagePrice: null
    };
  }

  async cancelOrderByClientOrderId(_symbol: string, clientOrderId: string): Promise<void> {
    this.cancelled.push(clientOrderId);
  }
}

class BlockingRecoverableGateway extends RecoverableRecordingGateway {
  constructor(private readonly reason: string) {
    super();
  }

  override async submitProtectionOrder(): Promise<ExecutionOrderLookupResult> {
    throw new Error(this.reason);
  }
}

class FailingExecutionIntentRepository extends MemoryExecutionIntentRepository implements ExecutionIntentRepository {
  override async createOrGet(): Promise<{ intent: ExecutionIntent; created: boolean }> {
    throw new Error("DB_DOWN");
  }
}

function coordinatorFor(
  accountId: string,
  repository: MemoryExecutionIntentRepository,
  delegate: ExecutionGateway,
  mode: "DEMO" | "REAL" = "DEMO",
  executionGate?: () => ExecutionGateState
): ExecutionCoordinator {
  return new ExecutionCoordinator({
    tradingAccountId: accountId,
    mode,
    entryType: "market",
    repository,
    delegate,
    logger: fakeLogger(),
    retry: { maxAttempts: 1, baseDelayMs: 0 },
    executionGate,
    runtimeReady: () => true
  });
}

class ThrowingExecutionGateway implements ExecutionGateway {
  async submitBracketOrder(): Promise<SubmittedOrder> {
    throw new Error("Execution should not be called by scanner bootstrap");
  }
}

function appConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    ...defaultTradingSettings,
    nodeEnv: "test",
    port: 8787,
    executionMode: "testnet",
    logLevel: "error",
    corsOrigins: ["http://localhost:5173"],
    databaseUrl: undefined,
    sessionSecret: "test-session-secret-change-before-production",
    binanceCredentialEncryptionKey: "0000000000000000000000000000000000000000000000000000000000000000",
    binanceApiKey: undefined,
    binanceApiSecret: undefined,
    binanceTestnet: true,
    reconciliationIntervalMs: 30_000,
    binanceRetryMaxAttempts: 1,
    binanceRetryBaseDelayMs: 0,
    postgresPoolMax: 2,
    ...overrides
  };
}

function realProposalGateway(proposals: MemoryRealExecutionProposalRepository, overrides: Partial<AppConfig> = {}): RealExecutionProposalGateway {
  const config = appConfig({ executionMode: "live", marginMode: "ISOLATED", ...overrides });
  return new RealExecutionProposalGateway({
    tradingAccountId: "account-real",
    config: () => config,
    runtimeReady: () => true,
    reconciliationHealthy: () => true,
    binanceConnected: () => true,
    loadSymbolRules: async () => ({
      symbol: "BTCUSDT",
      status: "TRADING",
      contractType: "PERPETUAL",
      quoteAsset: "USDT",
      marginAsset: "USDT",
      pricePrecision: 1,
      quantityPrecision: 3,
      tickSize: 0.1,
      minPrice: 0.1,
      maxPrice: null,
      stepSize: 0.001,
      minQty: 0.001,
      maxQty: 100,
      minNotional: 5,
      maxLeverage: 125,
      supportedOrderTypes: ["MARKET", "LIMIT", "STOP_MARKET", "TAKE_PROFIT_MARKET"]
    }),
    loadAvailableBalance: async () => 10_000,
    proposalRepository: proposals,
    auditRepository: new MemoryExecutionIntentRepository(),
    logger: fakeLogger()
  });
}

function plan(): EntryPlan {
  return {
    direction: "bullish",
    entry: 100,
    stopLoss: 95,
    takeProfit: 110,
    riskReward: 2,
    reason: "test"
  };
}

function risk(): RiskDecision {
  return {
    accepted: true,
    reason: "Risk accepted",
    symbol: "BTCUSDT",
    margin: 200,
    leverage: 5,
    positionSize: 1000,
    quantity: 10,
    notional: 1000,
    entry: 100,
    stopLoss: 95,
    takeProfit: 110,
    estimatedLoss: 50,
    estimatedProfit: 100,
    riskReward: 2,
    createdAt: 1
  };
}

function fakeLogger(): DecisionLogger {
  return {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined
  };
}

async function seedFilledIntent(repository: MemoryExecutionIntentRepository, accountId: string): Promise<ExecutionIntent> {
  return seedIntent(repository, accountId, "ENTRY_FILLED");
}

async function seedIntent(repository: MemoryExecutionIntentRepository, accountId: string, status: "ENTRY_SUBMITTING" | "ENTRY_FILLED"): Promise<ExecutionIntent> {
  const created = await repository.createOrGet({
    id: `${accountId}-intent-1`,
    tradingAccountId: accountId,
    symbol: "BTCUSDT",
    side: "long",
    setupKey: `${accountId}:setup`,
    entryType: "market",
    requestedEntry: 100,
    requestedStopLoss: 95,
    requestedTakeProfit: 110,
    quantity: 10,
    clientEntryOrderId: `${accountId}-entry-client`,
    clientStopOrderId: `${accountId}-stop-client`,
    clientTakeProfitOrderId: `${accountId}-tp-client`
  });
  if (status === "ENTRY_SUBMITTING") {
    await repository.transitionStatus(created.intent.id, ["CREATED"], "RISK_APPROVED");
    await repository.transitionStatus(created.intent.id, ["RISK_APPROVED"], "ENTRY_SUBMITTING");
  } else {
    await repository.transitionStatus(created.intent.id, ["CREATED"], "ENTRY_FILLED", {
      binanceEntryOrderId: `${accountId}-entry-order`,
      lastError: null
    });
  }
  const intent = (await repository.listByAccount(accountId))[0];
  if (!intent) throw new Error("Missing seeded intent");
  return intent;
}

function activityWithPosition(intent: ExecutionIntent, openOrders: ReturnType<typeof openOrder>[]) {
  return async () => ({
    connected: true,
    positions: [
      {
        id: `binance:${intent.symbol}:${intent.side}`,
        symbol: intent.symbol,
        side: intent.side,
        entryPrice: intent.requestedEntry ?? 100,
        entryTime: null,
        quantity: intent.quantity ?? 10,
        notional: 1000,
        leverage: 5,
        margin: 200,
        unrealizedProfit: 0,
        stopLoss: null,
        takeProfit: null
      }
    ],
    openOrders,
    orderHistory: [],
    tradeHistory: []
  });
}

function openOrder(intent: ExecutionIntent, type: "STOP_MARKET" | "TAKE_PROFIT_MARKET", clientOrderId: string | null, orderId: string) {
  return {
    id: `binance:open-order:${intent.symbol}:${orderId}`,
    symbol: intent.symbol,
    orderId,
    clientOrderId,
    side: intent.side === "long" ? "SELL" : "BUY",
    type,
    price: null,
    stopPrice: type === "STOP_MARKET" ? intent.requestedStopLoss : intent.requestedTakeProfit,
    quantity: intent.quantity ?? 10,
    executedQuantity: 0,
    status: "NEW",
    reduceOnly: true,
    createdAt: null,
    updatedAt: null
  };
}
