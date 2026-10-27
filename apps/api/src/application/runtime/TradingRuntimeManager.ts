import crypto from "node:crypto";
import type { AppConfig } from "../config/AppConfig.js";
import type { TradingAccountRepository } from "../trading-account/TradingAccountRepository.js";
import type { TradingRuntimeConfigRepository } from "../trading-account/TradingRuntimeConfigRepository.js";
import type { DecisionLogger } from "../ports/Logger.js";
import type { TradingRepository } from "../ports/Repositories.js";
import { MarketScanner, type ScannerProgress, type WatchlistStatus } from "../scanner/MarketScanner.js";
import { PostgresTradingRepository } from "../../infrastructure/persistence/PostgresTradingRepository.js";
import { MemoryTradingRepository } from "../../infrastructure/persistence/MemoryTradingRepository.js";
import { BinanceFuturesMarketData } from "../../infrastructure/market-data/BinanceFuturesMarketData.js";
import type { CredentialCipher } from "../../infrastructure/security/CredentialCipher.js";
import { BinanceFuturesExecutionGateway } from "../../infrastructure/execution/BinanceFuturesExecutionGateway.js";
import {
  BinanceFuturesAccountClient,
  type BinanceFuturesLeverageBracket,
  type BinanceFuturesOpenOrderStatus,
  type BinanceFuturesOrderHistoryStatus,
  type BinanceFuturesPositionStatus,
  type BinanceFuturesSymbolAccountState,
  type BinanceFuturesTradeHistoryStatus,
  type BinanceFuturesWalletStatus
} from "../../infrastructure/execution/BinanceFuturesAccountClient.js";
import { LockedRealExecutionGateway } from "../../infrastructure/execution/LockedRealExecutionGateway.js";
import { DisabledExecutionGateway } from "../../infrastructure/execution/DisabledExecutionGateway.js";
import type { ExecutionGateway, ExecutionOrderContext, ExecutionOrderLookupResult, ProtectionOrderRequest, RecoverableExecutionGateway, SubmittedOrder } from "../ports/ExecutionGateway.js";
import { isRecoverableExecutionGateway } from "../ports/ExecutionGateway.js";
import type { TradingEngine } from "../engine/TradingEngine.js";
import type { SetupDiagnostic } from "../engine/TradingEngine.js";
import type { TradingAccount } from "../../domain/trading-account/TradingAccount.js";
import type { EntryPlan } from "../../domain/entry/EntryCalculator.js";
import type { RiskDecision } from "../../domain/risk/RiskDecision.js";
import type { ExecutionIntentRepository } from "../execution/ExecutionIntentRepository.js";
import { ExecutionCoordinator, type ExecutionGateReason, type ExecutionGateState } from "../execution/ExecutionCoordinator.js";
import { TradingReconciliationService, type ReconciliationResult } from "../execution/TradingReconciliationService.js";
import { BinanceFuturesSymbolMetadataService } from "../../infrastructure/market-data/BinanceFuturesSymbolMetadataService.js";
import { validateAgainstSymbolRules, type FuturesSymbolRules } from "../../domain/symbol/SymbolRules.js";
import { RealExecutionProposalGateway } from "../execution/RealExecutionProposalGateway.js";
import type { RealExecutionProposalRepository } from "../execution/RealExecutionProposalRepository.js";
import { MemoryRealExecutionProposalRepository } from "../../infrastructure/execution/MemoryRealExecutionProposalRepository.js";
import { fingerprintProposal, type RealExecutionProposal } from "../execution/RealExecutionProposal.js";
import { UnsafeTradingAccountDeletionError } from "../trading-account/TradingAccountService.js";
import { calculateDailyRiskStatus, type DailyRiskStatus } from "../risk/DailyRiskService.js";
import { updateAccountProtectionState, type AccountProtectionStatus } from "../risk/AccountProtectionService.js";
import { withPostgresMigrationLock, withPostgresStartupRetry } from "../../infrastructure/persistence/PgPoolFactory.js";
import { resolveEffectiveExecutionPolicy, type EffectiveExecutionPolicy } from "./ExecutionPolicy.js";
import { AI_DECISION_AUDIT_TYPE, AiTradeAdvisor } from "../ai/AiTradeAdvisor.js";
import type { LlmClient } from "../ai/LocalLlmClient.js";
import { LiveUpdateHub } from "./LiveUpdateHub.js";
import { AiCallGate, DEFAULT_AI_MIN_CALL_INTERVAL_MS } from "../ai/AiCallGate.js";
import { AiChatOrderDesk, type ChatOrderMarket } from "../ai/AiChatOrders.js";
import { buildSetupKey } from "../execution/ExecutionIntent.js";

export interface AccountSnapshot {
  engine: unknown;
  store: unknown;
  watchlistStatus: WatchlistStatus[];
  /** Startup history replay, then live scans: AI only runs once the scanner is LIVE. */
  scannerProgress: ScannerProgress;
  runtimeHealth: RuntimeHealth;
  execution: ExecutionGateState;
  realReadiness: RealTradingReadinessResult | null;
  dailyRisk: DailyRiskStatus;
  accountProtection: AccountProtectionStatus | null;
  funnelMetrics: Record<string, import("../engine/TradingEngine.js").FunnelMetrics>;
}

/** The part of a snapshot that lives in memory (plus stored bot events): cheap enough to push on every change. */
export type LiveMonitorState = Pick<AccountSnapshot, "engine" | "store" | "watchlistStatus" | "scannerProgress" | "runtimeHealth" | "execution">;

export interface RuntimeHealth {
  state: "RECOVERING" | "READY" | "DEGRADED" | "DISCONNECTED" | "ERROR" | "SHUTTING_DOWN";
  lastScanAt: string | null;
  lastReconciliationAt: string | null;
  lastReconciliationError: string | null;
  reconciliationStatus: "PENDING" | "OK" | "DEGRADED" | "CONNECTION_LOST";
  executionEnabled: boolean;
  execution: ExecutionGateState;
  duplicatePrevented: number;
  executionAttempts: number;
  executionSucceeded: number;
  executionFailed: number;
  reconciliationSuccess: number;
  reconciliationFailure: number;
  protectionStatus: "OK" | "PROTECTION_INCOMPLETE";
  protectionLastError: string | null;
  protectionRepairAttempts: number;
  processReadOnlySoak: boolean;
  accountReadOnlySoak: boolean;
  effectiveReadOnlySoak: boolean;
  executionPolicy: EffectiveExecutionPolicy["executionPolicy"];
  executionCapability: EffectiveExecutionPolicy["executionCapability"];
}

export interface AccountActivitySnapshot {
  connected: boolean;
  authoritative?: boolean;
  source: "BINANCE_SIGNED_ACCOUNT";
  sourceEnvironment: "TESTNET" | "MAINNET";
  tradingAccountId: string;
  positions: BinanceFuturesPositionStatus[];
  openOrders: BinanceFuturesOpenOrderStatus[];
  orderHistory: BinanceFuturesOrderHistoryStatus[];
  tradeHistory: BinanceFuturesTradeHistoryStatus[];
}

export interface ReadinessCheck {
  ok: boolean;
  reason: string | null;
}

export interface RealTradingReadinessResult {
  accountReady: boolean;
  accountOperationalReady: boolean;
  mode: "DEMO" | "REAL";
  executionLocked: boolean;
  executionReason: "READY" | "REAL_EXECUTION_LOCKED";
  realExecutionPermission: {
    locked: boolean;
    reason: "READY" | "REAL_EXECUTION_LOCKED";
  };
  realExecutionMode: "LOCKED" | "DRY_RUN" | "APPROVAL_REQUIRED";
  masterLiveExecutionEnabled: boolean;
  symbol: string;
  configuredLeverage: number;
  symbolMaxLeverage: number | null;
  effectiveMaxLeverage: number;
  binanceLeverage: number | null;
  leverageMatch: boolean | null;
  configuredMarginMode: "CROSS" | "ISOLATED";
  binanceMarginMode: "CROSS" | "ISOLATED" | "UNKNOWN" | null;
  marginModeMatch: boolean | null;
  checks: {
    credentials: ReadinessCheck;
    futuresPermission: ReadinessCheck;
    accountReachable: ReadinessCheck;
    symbolRulesLoaded: ReadinessCheck;
    balanceAvailable: ReadinessCheck;
    marginAssetSupported: ReadinessCheck;
    leverageValid: ReadinessCheck;
    marginModeKnown: ReadinessCheck;
    tradingEnabled: ReadinessCheck;
    killSwitchOff: ReadinessCheck;
    runtimeReady: ReadinessCheck;
    reconciliationHealthy: ReadinessCheck;
    realExecutionLocked: ReadinessCheck;
  };
}

interface AccountRuntimeClient {
  getWalletStatus?(): Promise<BinanceFuturesWalletStatus>;
  getOpenPositions(symbol?: string): Promise<BinanceFuturesPositionStatus[]>;
  getOpenOrders(symbol?: string): Promise<BinanceFuturesOpenOrderStatus[]>;
  getOrderHistory(symbol?: string, limit?: number): Promise<BinanceFuturesOrderHistoryStatus[]>;
  getTradeHistory(symbol?: string, limit?: number): Promise<BinanceFuturesTradeHistoryStatus[]>;
  getSymbolAccountState?(symbol: string): Promise<BinanceFuturesSymbolAccountState>;
  getLeverageBrackets?(symbol: string): Promise<BinanceFuturesLeverageBracket[]>;
}

type AccountRuntimeClientFactory = (apiKey: string, apiSecret: string, testnet: boolean) => AccountRuntimeClient;
type RuntimeMarketDataFactory = (testnet: boolean) => BinanceFuturesMarketData;

export interface ExecutionGateInput {
  shuttingDown: boolean;
  mode: "DEMO" | "REAL";
  runtimeState: RuntimeHealth["state"];
  reconciliationStatus: RuntimeHealth["reconciliationStatus"];
  tradingEnabled: boolean;
  killSwitch: boolean;
  binanceConnected: boolean;
  readOnlySoak: boolean;
}

interface RuntimeConfigRef {
  current: AppConfig;
  accountReadOnlySoak: boolean;
}

export class TradingRuntimeManager {
  /** Change notifications for live dashboard streams (scans, reconciliation, settings, AI steps). */
  readonly live = new LiveUpdateHub();
  private readonly runtimes = new Map<string, AccountRuntime>();
  private readonly runtimeLoads = new Map<string, Promise<AccountRuntime>>();
  private readonly realAuditThrottle = new Map<string, number>();
  private readonly deletingAccounts = new Set<string>();
  private shuttingDown = false;
  private readonly processReadOnlySoak: boolean;

  constructor(
    private readonly baseConfig: AppConfig,
    private readonly databaseUrl: string | undefined,
    private readonly accountRepository: TradingAccountRepository,
    private readonly configRepository: TradingRuntimeConfigRepository,
    private readonly executionIntentRepository: ExecutionIntentRepository,
    private readonly cipher: CredentialCipher,
    private readonly marketData: BinanceFuturesMarketData,
    private readonly logger: DecisionLogger,
    private readonly accountClientFactory: AccountRuntimeClientFactory = (apiKey, apiSecret, testnet) => new BinanceFuturesAccountClient(apiKey, apiSecret, testnet),
    private readonly symbolMetadata: BinanceFuturesSymbolMetadataService = new BinanceFuturesSymbolMetadataService(),
    private readonly realProposalRepository: RealExecutionProposalRepository = new MemoryRealExecutionProposalRepository(),
    private readonly runtimeMarketDataFactory: RuntimeMarketDataFactory = (testnet) => new BinanceFuturesMarketData(testnet),
    /** Local LLM for the AI advisor; null disables AI decisions for every account. */
    private readonly aiLlm: { client: LlmClient; defaultModel: string; minCallIntervalMs?: number } | null = null
  ) {
    this.processReadOnlySoak = baseConfig.readOnlySoak;
    this.aiCallGate = new AiCallGate(aiLlm?.minCallIntervalMs ?? DEFAULT_AI_MIN_CALL_INTERVAL_MS);
    this.chatOrders = new AiChatOrderDesk({
      loadMarket: (accountId, symbol) => this.loadChatOrderMarket(accountId, symbol),
      submit: (accountId, plan, risk) => this.submitChatOrder(accountId, plan, risk)
    });
  }

  /** Orders the dashboard chat proposes; placed only when the user confirms the card. */
  readonly chatOrders: AiChatOrderDesk;

  /** One gate for every account's advisor, so model calls never burst against the provider. */
  private readonly aiCallGate: AiCallGate;

  async start(): Promise<void> {
    if (this.shuttingDown) return;
    const accounts = await this.loadAllAccountsBestEffort();
    for (const account of accounts) {
      await this.ensureRuntime(account.id);
    }
  }

  async ensureRuntime(accountId: string): Promise<AccountRuntime> {
    if (this.baseConfig.nodeEnv === "development" && !this.baseConfig.localTradingRuntimeEnabled) throw new Error("LOCAL_TRADING_RUNTIME_DISABLED");
    if (this.deletingAccounts.has(accountId)) throw new Error("ACCOUNT_REMOVING");
    const existing = this.runtimes.get(accountId);
    if (existing) return existing;
    if (this.shuttingDown) throw new Error("SHUTTING_DOWN");
    const loading = this.runtimeLoads.get(accountId);
    if (loading) return loading;

    const loadingRuntime = this.createRuntime(accountId).finally(() => {
      this.runtimeLoads.delete(accountId);
    });
    this.runtimeLoads.set(accountId, loadingRuntime);
    return loadingRuntime;
  }

  private async createRuntime(accountId: string): Promise<AccountRuntime> {
    if (this.deletingAccounts.has(accountId)) throw new Error("ACCOUNT_REMOVING");
    const account = await this.retryDatabaseRead("account lookup", () => this.accountRepository.findTradingAccountById(accountId));
    if (!account) throw new Error("ACCOUNT_NOT_FOUND");
    await this.configRepository.ensureDefaults(account.id, { ...this.baseConfig, readOnlySoak: false });
    const storedSettings = await this.retryDatabaseRead("runtime settings lookup", () => this.configRepository.getSettings(account.id));
    const settings = storedSettings ?? this.baseConfig;
    const watchlist = await this.retryDatabaseRead("runtime watchlist lookup", () => this.configRepository.getWatchlist(account.id));
    const policy = resolveEffectiveExecutionPolicy(this.processReadOnlySoak, Boolean(storedSettings?.readOnlySoak));
    const config = { ...this.baseConfig, ...settings, readOnlySoak: policy.effectiveReadOnlySoak, watchlist, symbol: watchlist[0] ?? settings.symbol };
    const configRef: RuntimeConfigRef = { current: config, accountReadOnlySoak: policy.accountReadOnlySoak };
    const repository = await this.createRuntimeTradingRepository(account.id);
    await repository.saveTradingSettings(config);
    const health = createRecoveringHealth();
    const rawExecution = await this.createExecutionGateway(account, () => configRef.current.entryMode, config.maxLeverage, () => configRef.current.marginMode, config.readOnlySoak);
    const executionGate = () => this.resolveRuntimeExecutionGate(account, health, configRef.current, rawExecution);
    const execution =
      account.mode === "DEMO"
        ? new ExecutionCoordinator({
            tradingAccountId: account.id,
            mode: account.mode,
            entryType: () => configRef.current.entryMode,
            repository: this.executionIntentRepository,
            delegate: rawExecution,
            logger: this.logger,
            retry: { maxAttempts: this.baseConfig.binanceRetryMaxAttempts, baseDelayMs: this.baseConfig.binanceRetryBaseDelayMs },
            executionGate,
            preTradeValidation: (plan, risk) => this.validatePreTrade(account, configRef.current, plan, risk)
          })
        : new RealExecutionProposalGateway({
            tradingAccountId: account.id,
            config: () => configRef.current,
            runtimeReady: () => !this.shuttingDown && health.state === "READY",
            reconciliationHealthy: () => health.reconciliationStatus === "OK",
            binanceConnected: () => !(rawExecution instanceof DisabledExecutionGateway),
            loadSymbolRules: (symbol) => this.getSymbolRules(account.id, symbol),
            loadAvailableBalance: async () => {
              const client = await this.createAccountClient(account.id);
              const status = client?.getWalletStatus ? await client.getWalletStatus() : null;
              return status?.connected ? status.availableBalance : null;
            },
            assertAccountProtection: async () => {
              const accountProtection = await this.getAccountProtectionStatus(account.id, true);
              if (!accountProtection) throw new Error("ACCOUNT_PROTECTION_UNAVAILABLE");
              if (!accountProtection.newEntriesAllowed) throw new Error(accountProtection.blockReason ?? "ACCOUNT_PROTECTION_UNAVAILABLE");
            },
            proposalRepository: this.realProposalRepository,
            auditRepository: this.executionIntentRepository,
            logger: this.logger
          });
    // Repairing or fail-safe closing an open position must not wait for new entries to be allowed:
    // the automatic-trading switch only stops new entries (chat orders may exist while it is off).
    const protectionGate = () => this.resolveRuntimeExecutionGate(account, health, { ...configRef.current, tradingEnabled: true }, rawExecution);
    const reconciliationGateway = account.mode === "DEMO" && isRecoverableExecutionGateway(rawExecution) ? new GatedRecoverableExecutionGateway(rawExecution, protectionGate) : undefined;
    // AI orders go through the same gateway as the engine; on REAL accounts the advisor is advisory-only.
    const aiAdvisor = this.aiLlm
      ? new AiTradeAdvisor({
          tradingAccountId: account.id,
          accountMode: account.mode,
          llm: this.aiLlm.client,
          defaultModel: this.aiLlm.defaultModel,
          repository: this.executionIntentRepository,
          execution,
          logger: this.logger,
          onProgress: (step) => this.live.recordAiStep(account.id, step),
          callGate: this.aiCallGate
        })
      : null;
    const scanner = new MarketScanner(
      config,
      repository,
      execution,
      this.logger,
      this.runtimeMarketDataFactory(account.mode === "DEMO"),
      async () => {
        const client = await this.createAccountClient(account.id);
        const status = client?.getWalletStatus ? await client.getWalletStatus() : null;
        return status?.connected ? status.availableBalance : null;
      },
      (symbol) => this.getSymbolRules(account.id, symbol),
      async () => {
        const client = await this.createAccountClient(account.id);
        if (!client) return null;
        const positions = await client.getOpenPositions();
        const margins = positions.map((position) => position.margin);
        return margins.every((margin) => margin !== null && Number.isFinite(margin))
          ? margins.reduce<number>((total, margin) => total + (margin === null ? 0 : margin), 0)
          : null;
      },
      { accountId: account.id, runtimeId: account.id },
      aiAdvisor
    );
    scanner.onSymbolScanned((symbol) => this.live.publish(account.id, { topic: "scan", symbol }));
    const reconciliation = new TradingReconciliationService(this.executionIntentRepository, this.logger);
    const runtime = new AccountRuntime(account, scanner, repository, health, reconciliation, rawExecution, configRef, reconciliationGateway);
    this.runtimes.set(account.id, runtime);
    await this.reconcileRuntime(runtime);
    this.startScannerBootstrap(runtime);
    runtime.reconciliationTimer = setInterval(() => {
      this.reconcileRuntime(runtime).catch((error: unknown) => {
        runtime.health.state = "DEGRADED";
        runtime.health.reconciliationStatus = "DEGRADED";
        runtime.health.lastReconciliationError = error instanceof Error ? error.message : String(error);
        runtime.health.reconciliationFailure += 1;
        this.logger.warn("[RUNTIME] reconciliation failed", { tradingAccountId: account.id, error: error instanceof Error ? error.message : String(error) });
      });
    }, this.baseConfig.reconciliationIntervalMs);
    return runtime;
  }

  private async createRuntimeTradingRepository(accountId: string): Promise<TradingRepository> {
    if (!this.databaseUrl) return new MemoryTradingRepository();
    const repository = new PostgresTradingRepository(this.databaseUrl, accountId);
    await withPostgresMigrationLock(this.databaseUrl, () => withPostgresStartupRetry("runtime trading repository migration", () => repository.migrate()));
    return repository;
  }

  private startScannerBootstrap(runtime: AccountRuntime): void {
    if (runtime.scannerBootstrapStarted) return;
    runtime.scannerBootstrapStarted = true;
    let bootstrapSucceeded = false;
    runtime.scannerBootstrapInFlight = runtime.scanner
      .bootstrap()
      .then(() => {
        bootstrapSucceeded = true;
      })
      .catch((error: unknown) => {
        runtime.health.state = "DEGRADED";
        runtime.health.reconciliationStatus = "DEGRADED";
        runtime.health.lastReconciliationError = error instanceof Error ? error.message : String(error);
        this.logger.warn("[RUNTIME] bootstrap failed", { tradingAccountId: runtime.account.id, error: error instanceof Error ? error.message : String(error) });
      })
      .finally(() => {
        runtime.health.lastScanAt = new Date().toISOString();
        if (bootstrapSucceeded && !this.shuttingDown && runtime.reconciliationTimer !== null) {
          runtime.scanner.start();
        }
        runtime.scannerBootstrapInFlight = null;
        this.live.publish(runtime.account.id, { topic: "scanner" });
        // A failed bootstrap used to leave the scanner stopped forever; retry until it succeeds.
        if (!bootstrapSucceeded && !this.shuttingDown) {
          setTimeout(() => {
            if (this.shuttingDown || this.runtimes.get(runtime.account.id) !== runtime || runtime.reconciliationTimer === null) return;
            runtime.scannerBootstrapStarted = false;
            this.startScannerBootstrap(runtime);
          }, SCANNER_BOOTSTRAP_RETRY_MS).unref?.();
        }
      });
    this.live.publish(runtime.account.id, { topic: "scanner" });
  }

  async refreshRuntime(accountId: string): Promise<void> {
    const runtime = this.runtimes.get(accountId);
    if (!runtime) {
      await this.ensureRuntime(accountId);
      return;
    }

    const account = await this.accountRepository.findTradingAccountById(accountId);
    if (!account) return;
    const storedSettings = await this.configRepository.getSettings(accountId);
    const settings = storedSettings ?? this.baseConfig;
    const watchlist = await this.configRepository.getWatchlist(accountId);
    const policy = resolveEffectiveExecutionPolicy(this.processReadOnlySoak, Boolean(storedSettings?.readOnlySoak));
    const config = { ...this.baseConfig, ...settings, readOnlySoak: policy.effectiveReadOnlySoak, watchlist, symbol: watchlist[0] ?? settings.symbol };
    runtime.configRef.accountReadOnlySoak = policy.accountReadOnlySoak;
    runtime.configRef.current = config;
    await runtime.repository.saveTradingSettings(config);
    runtime.scanner.updateConfig(config);
    this.updateExecutionHealth(runtime);
    this.live.publish(accountId, { topic: "config" });
  }

  async disableExecution(accountId: string): Promise<void> {
    const runtime = this.runtimes.get(accountId);
    if (runtime) {
      runtime.scanner.stop();
      if (runtime.reconciliationTimer) clearInterval(runtime.reconciliationTimer);
      await Promise.allSettled([runtime.reconciliationInFlight, runtime.scannerBootstrapInFlight].filter((task): task is Promise<void> | Promise<ReconciliationResult> => task !== null));
    }
    this.runtimes.delete(accountId);
    this.runtimeLoads.delete(accountId);
    this.live.closeAccount(accountId);
  }

  async prepareAccountDeletion(accountId: string): Promise<void> {
    if (this.deletingAccounts.has(accountId)) throw new UnsafeTradingAccountDeletionError("Trading account is already being removed");
    this.deletingAccounts.add(accountId);
    try {
      const runtime = await this.getLoadedRuntime(accountId);
      await this.assertAccountDeletionIsSafe(accountId, runtime);
      if (runtime) {
        runtime.health.state = "SHUTTING_DOWN";
        runtime.health.execution = { enabled: false, reason: "SHUTTING_DOWN" };
        runtime.health.executionEnabled = false;
        if (runtime.reconciliationTimer) clearInterval(runtime.reconciliationTimer);
        runtime.reconciliationTimer = null;
        runtime.scanner.stop();
        await Promise.allSettled([runtime.reconciliationInFlight, runtime.scannerBootstrapInFlight].filter((task): task is Promise<void> | Promise<ReconciliationResult> => task !== null));
      }
      this.runtimeLoads.delete(accountId);
    } catch (error) {
      this.deletingAccounts.delete(accountId);
      throw error;
    }
  }

  async completeAccountDeletion(accountId: string): Promise<void> {
    await this.executionIntentRepository.deleteAccountData?.(accountId);
    await this.realProposalRepository.deleteAccountData?.(accountId);
    this.runtimes.delete(accountId);
    this.runtimeLoads.delete(accountId);
    this.deletingAccounts.delete(accountId);
    this.live.closeAccount(accountId);
  }

  cancelAccountDeletion(accountId: string): void {
    this.deletingAccounts.delete(accountId);
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    // Open streams would otherwise keep server.close() waiting.
    this.live.closeAll();
    for (const runtime of this.runtimes.values()) {
      runtime.health.state = "SHUTTING_DOWN";
      runtime.health.execution = { enabled: false, reason: "SHUTTING_DOWN" };
      runtime.health.executionEnabled = false;
      if (runtime.reconciliationTimer) clearInterval(runtime.reconciliationTimer);
      runtime.reconciliationTimer = null;
      runtime.scanner.stop();
    }
    await Promise.allSettled(
      [...this.runtimes.values()].flatMap((runtime) => [runtime.reconciliationInFlight, runtime.scannerBootstrapInFlight].filter((task): task is Promise<void> | Promise<ReconciliationResult> => task !== null))
    );
    this.runtimes.clear();
    this.runtimeLoads.clear();
  }

  async getSnapshot(accountId: string): Promise<AccountSnapshot> {
    const runtime = await this.ensureRuntime(accountId);
    const execution = this.updateExecutionHealth(runtime);
    const realReadiness = runtime.account.mode === "REAL" ? await this.getRealReadiness(accountId) : null;
    const dailyRisk = await this.getDailyRiskStatus(accountId);
    const accountProtection = await this.getAccountProtectionStatus(accountId);
    return {
      engine: runtime.scanner.getPrimaryEngine().getDashboardState(),
      store: await this.retryDatabaseRead("runtime dashboard snapshot", () => runtime.repository.getDashboardSnapshot()),
      watchlistStatus: reconcileWatchlistStatus(runtime.scanner.getWatchlistStatus(), runtime.lastPositions, runtime.configRef.current.executionMode),
      scannerProgress: runtime.scanner.getProgress(),
      runtimeHealth: { ...runtime.health },
      execution,
      realReadiness,
      dailyRisk,
      accountProtection,
      funnelMetrics: runtime.scanner.getFunnelMetrics()
    };
  }

  /** Monitor state for live streams: no Binance calls, unlike getSnapshot (daily risk, protection, readiness). */
  async getLiveState(accountId: string): Promise<LiveMonitorState> {
    const runtime = await this.ensureRuntime(accountId);
    const execution = this.updateExecutionHealth(runtime);
    return {
      engine: runtime.scanner.getPrimaryEngine().getDashboardState(),
      store: await this.retryDatabaseRead("runtime live snapshot", () => runtime.repository.getDashboardSnapshot()),
      watchlistStatus: reconcileWatchlistStatus(runtime.scanner.getWatchlistStatus(), runtime.lastPositions, runtime.configRef.current.executionMode),
      scannerProgress: runtime.scanner.getProgress(),
      runtimeHealth: { ...runtime.health },
      execution
    };
  }

  async getDailyRiskStatus(accountId: string, now = new Date(), strict = false): Promise<DailyRiskStatus> {
    const runtime = await this.ensureRuntime(accountId);
    const settings = runtime.configRef.current;
    const intents = await this.executionIntentRepository.listByAccount(accountId, 1000);
    const symbols = [...new Set([...settings.watchlist, ...intents.map((intent) => intent.symbol)])];
    const client = await this.createAccountClient(accountId);
    if (!client) {
      if (strict) throw new Error("DAILY_RISK_UNAVAILABLE");
      return calculateDailyRiskStatus({ tradingAccountId: accountId, settings, intents, trades: [], now });
    }
    let tradeResults: BinanceFuturesTradeHistoryStatus[][];
    try {
      tradeResults = await Promise.all(symbols.map((symbol) => client.getTradeHistory(symbol, 1000)));
    } catch (error) {
      if (strict) throw error;
      tradeResults = [];
    }
    return calculateDailyRiskStatus({
      tradingAccountId: accountId,
      settings,
      intents,
      trades: tradeResults.flat(),
      now
    });
  }

  async getAccountProtectionStatus(accountId: string, strict = false, now = new Date()): Promise<AccountProtectionStatus | null> {
    const runtime = await this.ensureRuntime(accountId);
    const client = await this.createAccountClient(accountId);
    try {
      if (!client?.getWalletStatus) throw new Error("ACCOUNT_PROTECTION_UNAVAILABLE");
      const [wallet, positions] = await Promise.all([client.getWalletStatus(), client.getOpenPositions()]);
      if (!wallet.connected || wallet.walletBalance === null) throw new Error("ACCOUNT_PROTECTION_UNAVAILABLE");
      const currentEquityUsdt = wallet.walletBalance + positions.reduce((sum, position) => sum + position.unrealizedProfit, 0);
      const currentState = this.configRepository.getAccountProtectionState ? await this.configRepository.getAccountProtectionState(accountId) : null;
      const update = updateAccountProtectionState({
        tradingAccountId: accountId,
        currentEquityUsdt,
        maxDrawdownPercent: runtime.configRef.current.maxDrawdownPercent,
        state: currentState,
        now
      });
      if (update.changed) await this.configRepository.saveAccountProtectionState?.(update.state);
      return update.status;
    } catch (error) {
      if (strict) throw error;
      this.logger.warn("[ACCOUNT PROTECTION] status unavailable", { tradingAccountId: accountId, error: error instanceof Error ? error.message : String(error) });
      return null;
    }
  }

  async getSymbolRules(accountId: string, symbol: string): Promise<FuturesSymbolRules> {
    const account = await this.accountRepository.findTradingAccountById(accountId);
    if (!account) throw new Error("ACCOUNT_NOT_FOUND");
    const client = await this.createAccountClient(accountId);
    const environment = account.mode === "DEMO" ? "testnet" : "live";
    const rules = await this.symbolMetadata.getSymbolRules(symbol, environment, client?.getLeverageBrackets ? () => client.getLeverageBrackets?.(symbol) ?? Promise.resolve([]) : undefined);
    if (account.mode === "REAL") {
      await this.auditRealEvent(account.id, symbol, "REAL_SYMBOL_RULES_LOADED", { status: rules.status, maxLeverage: rules.maxLeverage });
    }
    return rules;
  }

  async getRiskInputs(accountId: string, symbol: string): Promise<{
    availableBalance: number;
    currentUsedMargin: number;
    positions: BinanceFuturesPositionStatus[];
    symbolRules: FuturesSymbolRules;
  } | null> {
    const client = await this.createAccountClient(accountId);
    if (!client?.getWalletStatus) return null;
    const [wallet, positions, symbolRules] = await Promise.all([
      client.getWalletStatus(),
      client.getOpenPositions(),
      this.getSymbolRules(accountId, symbol)
    ]);
    if (!wallet.connected || wallet.availableBalance === null) return null;
    const margins = positions.map((position) => position.margin);
    if (margins.some((margin) => margin === null || !Number.isFinite(margin))) return null;
    return {
      availableBalance: wallet.availableBalance,
      currentUsedMargin: margins.reduce<number>((total, margin) => total + (margin === null ? 0 : margin), 0),
      positions,
      symbolRules
    };
  }

  async getRealReadiness(accountId: string, requestedSymbol?: string): Promise<RealTradingReadinessResult> {
    const runtime = await this.ensureRuntime(accountId);
    const account = runtime.account;
    const settings = runtime.configRef.current;
    const symbol = requestedSymbol ?? settings.symbol;
    const connection = await this.accountRepository.findBinanceConnection(account.id);
    const client = await this.createAccountClient(account.id);
    const checks = createReadinessChecks();
    checks.credentials = connection?.status === "CONNECTED" && client ? ok() : fail("CREDENTIALS_INVALID");

    let wallet: BinanceFuturesWalletStatus | null = null;
    if (client?.getWalletStatus) {
      wallet = await client.getWalletStatus().catch(() => null);
    }
    checks.accountReachable = wallet?.connected ? ok() : fail("BINANCE_UNREACHABLE");
    checks.futuresPermission = wallet?.connected && wallet.canTrade !== false ? ok() : fail("FUTURES_PERMISSION_MISSING");

    let rules: FuturesSymbolRules | null = null;
    let effectiveMaxLeverage = settings.maxLeverage;
    try {
      rules = await this.getSymbolRules(account.id, symbol);
      effectiveMaxLeverage = Math.min(settings.maxLeverage, rules.maxLeverage ?? settings.maxLeverage);
      checks.symbolRulesLoaded = ok();
      checks.marginAssetSupported = rules.marginAsset === "USDT" || rules.marginAsset === null ? ok() : fail("MARGIN_ASSET_UNSUPPORTED");
      checks.leverageValid = effectiveMaxLeverage > 0 ? ok() : fail("LEVERAGE_EXCEEDS_BINANCE_MAX");
    } catch {
      checks.symbolRulesLoaded = fail("SYMBOL_RULES_UNAVAILABLE");
      checks.marginAssetSupported = fail("SYMBOL_RULES_UNAVAILABLE");
      checks.leverageValid = fail("SYMBOL_RULES_UNAVAILABLE");
    }

    const symbolState = client?.getSymbolAccountState ? await client.getSymbolAccountState(symbol).catch(() => null) : null;
    const binanceLeverage = symbolState?.leverage ?? null;
    const binanceMarginMode = symbolState?.marginType ?? null;
    const leverageMatch = binanceLeverage === null ? null : binanceLeverage === settings.maxLeverage;
    const marginModeMatch = binanceMarginMode === null || binanceMarginMode === "UNKNOWN" ? null : binanceMarginMode === settings.marginMode;
    checks.marginModeKnown = marginModeMatch === null ? fail("MARGIN_MODE_UNKNOWN") : marginModeMatch ? ok() : fail("MARGIN_MODE_MISMATCH");

    checks.balanceAvailable =
      wallet?.availableBalance !== null && wallet?.availableBalance !== undefined && wallet.availableBalance >= settings.riskPerTradeUsdt ? ok() : fail("INSUFFICIENT_AVAILABLE_BALANCE");
    checks.tradingEnabled = settings.tradingEnabled ? ok() : fail("TRADING_DISABLED");
    checks.killSwitchOff = settings.killSwitch ? fail("KILL_SWITCH") : ok();
    checks.runtimeReady = runtime.health.state === "READY" ? ok() : fail("RUNTIME_NOT_READY");
    checks.reconciliationHealthy = runtime.health.reconciliationStatus === "OK" ? ok() : fail("RECONCILIATION_REQUIRED");
    checks.realExecutionLocked = account.mode === "REAL" ? fail("REAL_EXECUTION_LOCKED") : ok();

    const accountReady = Object.entries(checks)
      .filter(([key]) => key !== "realExecutionLocked")
      .every(([, check]) => check.ok);

    const readiness: RealTradingReadinessResult = {
      accountReady,
      accountOperationalReady: accountReady,
      mode: account.mode,
      executionLocked: account.mode === "REAL",
      executionReason: account.mode === "REAL" ? "REAL_EXECUTION_LOCKED" : "READY",
      realExecutionPermission: {
        locked: account.mode === "REAL",
        reason: account.mode === "REAL" ? "REAL_EXECUTION_LOCKED" : "READY"
      },
      realExecutionMode: settings.realExecutionMode,
      masterLiveExecutionEnabled: this.baseConfig.realLiveExecutionEnabled,
      symbol,
      configuredLeverage: settings.maxLeverage,
      symbolMaxLeverage: rules?.maxLeverage ?? null,
      effectiveMaxLeverage,
      binanceLeverage,
      leverageMatch,
      configuredMarginMode: settings.marginMode,
      binanceMarginMode,
      marginModeMatch,
      checks
    };
    if (account.mode === "REAL") {
      await this.auditRealEvent(account.id, symbol, readiness.accountReady ? "REAL_READINESS_CHECKED" : "REAL_READINESS_FAILED", {
        accountReady: readiness.accountReady,
        executionReason: readiness.executionReason,
        failedChecks: Object.entries(checks)
          .filter(([, check]) => !check.ok)
          .map(([name, check]) => ({ name, reason: check.reason }))
      });
      if (leverageMatch === false) await this.auditRealEvent(account.id, symbol, "REAL_LEVERAGE_MISMATCH", { configured: settings.maxLeverage, binance: binanceLeverage });
      if (marginModeMatch === false) await this.auditRealEvent(account.id, symbol, "REAL_MARGIN_MODE_MISMATCH", { configured: settings.marginMode, binance: binanceMarginMode });
    }
    return readiness;
  }

  async listRealExecutionProposals(accountId: string, limit = 100): Promise<RealExecutionProposal[]> {
    await this.realProposalRepository.expireOpen(new Date().toISOString());
    return this.realProposalRepository.listByAccount(accountId, limit);
  }

  async getRealExecutionProposal(accountId: string, proposalId: string): Promise<RealExecutionProposal | null> {
    await this.realProposalRepository.expireOpen(new Date().toISOString());
    return this.realProposalRepository.findById(accountId, proposalId);
  }

  async approveRealExecutionProposal(accountId: string, proposalId: string, userId: string): Promise<RealExecutionProposal> {
    const proposal = await this.getRealExecutionProposal(accountId, proposalId);
    if (!proposal) throw new Error("PROPOSAL_NOT_FOUND");
    if (proposal.expiresAt <= new Date().toISOString()) throw new Error("PROPOSAL_EXPIRED");
    await this.assertProposalFingerprintCurrent(proposal);
    const approved = await this.realProposalRepository.transitionStatus(accountId, proposalId, ["PENDING"], "APPROVED", {
      approvedAt: new Date().toISOString(),
      approvedByUserId: userId
    });
    if (!approved) throw new Error("APPROVAL_STATUS");
    await this.auditRealEvent(accountId, proposal.symbol, "REAL_PROPOSAL_APPROVED", { proposalId, setupKey: proposal.setupKey });
    if (!this.baseConfig.realLiveExecutionEnabled) {
      await this.auditRealEvent(accountId, proposal.symbol, "REAL_EXECUTION_MASTER_LOCKED", { proposalId, setupKey: proposal.setupKey });
    }
    return approved;
  }

  async rejectRealExecutionProposal(accountId: string, proposalId: string): Promise<RealExecutionProposal> {
    const rejected = await this.realProposalRepository.transitionStatus(accountId, proposalId, ["PENDING", "APPROVED"], "REJECTED", { rejectedAt: new Date().toISOString() });
    if (!rejected) throw new Error("APPROVAL_STATUS");
    await this.auditRealEvent(accountId, rejected.symbol, "REAL_PROPOSAL_REJECTED", { proposalId, setupKey: rejected.setupKey });
    return rejected;
  }

  async cancelRealExecutionProposal(accountId: string, proposalId: string): Promise<RealExecutionProposal> {
    const cancelled = await this.realProposalRepository.transitionStatus(accountId, proposalId, ["PENDING", "APPROVED"], "CANCELLED", { cancelledAt: new Date().toISOString() });
    if (!cancelled) throw new Error("APPROVAL_STATUS");
    await this.auditRealEvent(accountId, cancelled.symbol, "REAL_PROPOSAL_CANCELLED", { proposalId, setupKey: cancelled.setupKey });
    return cancelled;
  }

  private async assertProposalFingerprintCurrent(proposal: RealExecutionProposal): Promise<void> {
    const rules = await this.getSymbolRules(proposal.tradingAccountId, proposal.symbol);
    const currentHash = fingerprintProposal({
      ...proposal,
      symbolTickSize: rules.tickSize,
      symbolStepSize: rules.stepSize,
      symbolMinQty: rules.minQty,
      symbolMinNotional: rules.minNotional
    });
    if (currentHash !== proposal.proposalHash) {
      await this.realProposalRepository.transitionStatus(proposal.tradingAccountId, proposal.id, ["PENDING"], "EXECUTION_BLOCKED");
      await this.auditRealEvent(proposal.tradingAccountId, proposal.symbol, "REAL_EXECUTION_PARAMETER_CHANGED", { proposalId: proposal.id, setupKey: proposal.setupKey });
      throw new Error("REAL_EXECUTION_PARAMETER_CHANGED");
    }
  }

  private async validatePreTrade(account: TradingAccount, config: AppConfig, plan: EntryPlan, risk: RiskDecision): Promise<void> {
    const dailyRisk = await this.getDailyRiskStatus(account.id, new Date(), true);
    if (!dailyRisk.newEntriesAllowed) throw new Error(dailyRisk.blockReason ?? "DAILY_RISK_UNAVAILABLE");
    const accountProtection = await this.getAccountProtectionStatus(account.id, true);
    if (!accountProtection) throw new Error("ACCOUNT_PROTECTION_UNAVAILABLE");
    if (!accountProtection.newEntriesAllowed) throw new Error(accountProtection.blockReason ?? "ACCOUNT_PROTECTION_UNAVAILABLE");
    const client = await this.createAccountClient(account.id);
    const wallet = client?.getWalletStatus ? await client.getWalletStatus() : null;
    if (!wallet?.connected || wallet.availableBalance === null) throw new Error("BINANCE_DISCONNECTED");
    if (config.riskPerTradeUsdt > wallet.availableBalance) throw new Error("INSUFFICIENT_AVAILABLE_BALANCE");

    const rules = await this.getSymbolRules(account.id, risk.symbol);
    const entryOrderType = config.entryMode.toUpperCase();
    const result = validateAgainstSymbolRules(rules, {
      symbol: risk.symbol,
      orderType: entryOrderType,
      quantity: risk.quantity,
      price: config.entryMode === "limit" ? plan.entry : null,
      notional: risk.notional,
      leverage: risk.leverage
    });
    if (!result.ok) throw new Error(result.reason ?? "SYMBOL_RULE_VALIDATION_FAILED");
  }

  private async loadChatOrderMarket(accountId: string, symbol: string): Promise<ChatOrderMarket> {
    const runtime = await this.ensureRuntime(accountId);
    const config = runtime.configRef.current;
    const [inputs, livePrice] = await Promise.all([
      runtime.account.mode === "DEMO" ? this.getRiskInputs(accountId, symbol) : Promise.resolve(null),
      this.runtimeMarketDataFactory(runtime.account.mode === "DEMO").getLastPrice(symbol).catch(() => null)
    ]);
    if (runtime.account.mode === "DEMO" && !inputs) throw new Error("BINANCE_DISCONNECTED: balance, positions or symbol rules are unavailable");
    const open = (inputs?.positions ?? []).filter((position) => position.quantity > 0);
    // Same gate the chat coordinator uses, so a blocked account is reported before the card exists.
    const gate = this.resolveRuntimeExecutionGate(runtime.account, runtime.health, { ...config, tradingEnabled: true }, runtime.rawExecution);
    return {
      mode: runtime.account.mode,
      executionBlocked: gate.enabled ? null : gate.reason,
      config,
      livePrice,
      availableBalance: inputs?.availableBalance ?? 0,
      currentUsedMargin: inputs?.currentUsedMargin ?? 0,
      openPositions: open.length,
      symbolOpenPositions: open.filter((position) => position.symbol === symbol).length,
      symbolRules: inputs?.symbolRules ?? (await this.getSymbolRules(accountId, symbol)),
      drawdownPercent: runtime.scanner.getEngine(symbol)?.getState().drawdownPercent ?? 0
    };
  }

  /**
   * Places a confirmed chat order: a MARKET entry through its own coordinator, so the automatic
   * trading switch does not block it while the kill switch, readiness and pre-trade checks still do.
   */
  private async submitChatOrder(accountId: string, plan: EntryPlan, risk: RiskDecision): Promise<{ executionIntentId: string | null }> {
    const runtime = await this.ensureRuntime(accountId);
    if (runtime.account.mode !== "DEMO") throw new Error("REAL_EXECUTION_LOCKED");
    // Built per order (it is rare and user-initiated) so a reconnected Binance key is always used.
    const execution = await this.createChatExecution(runtime);
    const findIntent = () => this.executionIntentRepository.findBySetupKey(accountId, buildSetupKey(accountId, plan, risk)).catch(() => null);
    try {
      await execution.submitBracketOrder(plan, risk);
    } catch (error) {
      // The coordinator rethrows only the error class; Binance's code and message are on the intent.
      const intent = await findIntent();
      throw new Error(intent?.lastError || (error instanceof Error ? error.message : String(error)));
    }
    runtime.scanner.markEntryPlaced(risk.symbol);
    this.logger.info("[AI CHAT] order submitted", { tradingAccountId: accountId, symbol: risk.symbol, direction: plan.direction, quantity: risk.quantity });
    return { executionIntentId: (await findIntent())?.id ?? null };
  }

  private async createChatExecution(runtime: AccountRuntime): Promise<ExecutionCoordinator> {
    const { account, health, configRef } = runtime;
    const rawExecution = await this.createExecutionGateway(account, "market", configRef.current.maxLeverage, () => configRef.current.marginMode, configRef.current.readOnlySoak);
    return new ExecutionCoordinator({
      tradingAccountId: account.id,
      mode: account.mode,
      entryType: "market",
      repository: this.executionIntentRepository,
      delegate: rawExecution,
      logger: this.logger,
      retry: { maxAttempts: this.baseConfig.binanceRetryMaxAttempts, baseDelayMs: this.baseConfig.binanceRetryBaseDelayMs },
      executionGate: () => this.resolveRuntimeExecutionGate(account, health, { ...configRef.current, tradingEnabled: true }, rawExecution),
      preTradeValidation: (plan, risk) => this.validatePreTrade(account, { ...configRef.current, entryMode: "market" }, plan, risk)
    });
  }

  async listExecutions(accountId: string, limit = 100): Promise<unknown[]> {
    return this.executionIntentRepository.listByAccount(accountId, limit);
  }

  async listExecutionAuditEvents(accountId: string, executionIntentId?: string, limit = 100): Promise<unknown[]> {
    return this.executionIntentRepository.listAuditEvents(accountId, executionIntentId, limit);
  }

  /** Recent AI advisor decisions (AI_DECISION audit events), newest first. */
  async listAiDecisions(accountId: string, limit = 50): Promise<Array<Record<string, unknown>>> {
    const events = await this.executionIntentRepository.listAuditEvents(accountId, undefined, limit, AI_DECISION_AUDIT_TYPE);
    return events.map((event) => ({ ...event.metadata, id: event.id, symbol: event.symbol, executionIntentId: event.executionIntentId, createdAt: event.createdAt }));
  }

  getOperationalStatus(): {
    runtimeCount: number;
    readyAccounts: number;
    degradedAccounts: number;
    disconnectedAccounts: number;
    recoveringAccounts: number;
    shuttingDown: boolean;
    reconciliationSuccess: number;
    reconciliationFailure: number;
  } {
    const runtimes = [...this.runtimes.values()];
    return {
      runtimeCount: runtimes.length,
      readyAccounts: runtimes.filter((runtime) => runtime.health.state === "READY").length,
      degradedAccounts: runtimes.filter((runtime) => runtime.health.state === "DEGRADED" || runtime.health.state === "ERROR").length,
      disconnectedAccounts: runtimes.filter((runtime) => runtime.health.state === "DISCONNECTED").length,
      recoveringAccounts: runtimes.filter((runtime) => runtime.health.state === "RECOVERING").length,
      shuttingDown: this.shuttingDown,
      reconciliationSuccess: runtimes.reduce((sum, runtime) => sum + runtime.health.reconciliationSuccess, 0),
      reconciliationFailure: runtimes.reduce((sum, runtime) => sum + runtime.health.reconciliationFailure, 0)
    };
  }

  async getManualPositions(accountId: string, symbol: string): Promise<BinanceFuturesPositionStatus[]> {
    const account = await this.accountRepository.findTradingAccountById(accountId);
    if (!account) throw new Error("ACCOUNT_NOT_FOUND");
    const client = await this.createAccountClient(accountId);
    if (!client) return [];
    const positions = await readAccountRuntimeData("positions", () => client.getOpenPositions(symbol), this.logger);
    return withActivitySource(positions, account);
  }

  async getAccountActivity(accountId: string, symbol: string | undefined, limit: number): Promise<AccountActivitySnapshot> {
    const account = await this.accountRepository.findTradingAccountById(accountId);
    if (!account) throw new Error("ACCOUNT_NOT_FOUND");
    const metadata = accountActivityMetadata(account);
    const client = await this.createAccountClient(accountId);
    if (!client) {
      return { connected: false, ...metadata, positions: [], openOrders: [], orderHistory: [], tradeHistory: [] };
    }

    const [positions, openOrders] = await Promise.all([
      readAccountRuntimeData("positions", () => client.getOpenPositions(symbol), this.logger),
      readAccountRuntimeData("open orders", () => client.getOpenOrders(symbol), this.logger)
    ]);
    const historySymbols = symbol ? [symbol] : [...new Set(positions.map((position) => position.symbol))];
    const histories = await Promise.all(
      historySymbols.map(async (historySymbol) => {
        const [orderHistory, tradeHistory] = await Promise.all([
          readAccountRuntimeData(`order history ${historySymbol}`, () => client.getOrderHistory(historySymbol, limit), this.logger),
          readAccountRuntimeData(`trade history ${historySymbol}`, () => client.getTradeHistory(historySymbol, limit), this.logger)
        ]);
        return { orderHistory, tradeHistory };
      })
    );

    return {
      connected: true,
      authoritative: true,
      ...metadata,
      positions: withActivitySource(positions, account),
      openOrders: withActivitySource(openOrders, account),
      orderHistory: withActivitySource(histories.flatMap((history) => history.orderHistory), account),
      tradeHistory: withActivitySource(histories.flatMap((history) => history.tradeHistory), account)
    };
  }

  getEngineForTest(accountId: string, symbol: string): TradingEngine | null {
    return this.runtimes.get(accountId)?.scanner.getEngine(symbol) ?? null;
  }

  async getSetupDiagnostic(accountId: string, symbol: string): Promise<SetupDiagnostic | null> {
    const runtime = await this.ensureRuntime(accountId);
    return runtime.scanner.getSetupDiagnostic(symbol);
  }

  private async createExecutionGateway(
    account: TradingAccount,
    entryMode: "limit" | "market" | (() => "limit" | "market"),
    leverage: number,
    marginMode: "CROSS" | "ISOLATED" | (() => "CROSS" | "ISOLATED"),
    readOnlySoak: boolean
  ): Promise<ExecutionGateway> {
    if (account.mode === "REAL") return new LockedRealExecutionGateway();
    const connection = await this.retryDatabaseRead("Binance connection lookup", () => this.accountRepository.findBinanceConnection(account.id));
    if (!connection || connection.status !== "CONNECTED") return new DisabledExecutionGateway("BINANCE_NOT_CONNECTED");
    const apiKey = this.cipher.decrypt(connection.apiKeyEncrypted);
    const apiSecret = this.cipher.decrypt(connection.apiSecretEncrypted);
    return new BinanceFuturesExecutionGateway(apiKey, apiSecret, "testnet", entryMode, leverage, marginMode, readOnlySoak && account.mode === "DEMO");
  }

  private async createAccountClient(accountId: string): Promise<AccountRuntimeClient | null> {
    const account = await this.retryDatabaseRead("account client lookup", () => this.accountRepository.findTradingAccountById(accountId));
    if (!account) throw new Error("ACCOUNT_NOT_FOUND");
    const connection = await this.retryDatabaseRead("account Binance connection lookup", () => this.accountRepository.findBinanceConnection(account.id));
    if (!connection || connection.status !== "CONNECTED") return null;
    const apiKey = this.cipher.decrypt(connection.apiKeyEncrypted);
    const apiSecret = this.cipher.decrypt(connection.apiSecretEncrypted);
    return this.accountClientFactory(apiKey, apiSecret, account.mode === "DEMO");
  }

  private async retryDatabaseRead<T>(label: string, operation: () => Promise<T>): Promise<T> {
    if (!this.databaseUrl) return operation();
    return withPostgresStartupRetry(label, operation);
  }

  private async getLoadedRuntime(accountId: string): Promise<AccountRuntime | null> {
    const loading = this.runtimeLoads.get(accountId);
    if (loading) return loading;
    return this.runtimes.get(accountId) ?? null;
  }

  private async assertAccountDeletionIsSafe(accountId: string, runtime: AccountRuntime | null): Promise<void> {
    if (runtime?.reconciliationInFlight || runtime?.health.reconciliationStatus === "PENDING" || runtime?.health.state === "RECOVERING") {
      throw new UnsafeTradingAccountDeletionError("Trading account reconciliation is currently active");
    }

    const intents = await this.executionIntentRepository.listOpenByAccount(accountId);
    if (intents.length > 0) {
      throw new UnsafeTradingAccountDeletionError("Trading account has active execution intents");
    }

    const client = await this.createAccountClient(accountId);
    if (!client) return;

    let positions: BinanceFuturesPositionStatus[];
    let openOrders: BinanceFuturesOpenOrderStatus[];
    try {
      [positions, openOrders] = await Promise.all([client.getOpenPositions(), client.getOpenOrders()]);
    } catch {
      throw new UnsafeTradingAccountDeletionError("Unable to verify Binance active trading state");
    }
    if (positions.some((position) => position.quantity !== 0)) {
      throw new UnsafeTradingAccountDeletionError("Trading account has an active Binance Futures position");
    }

    const hasBotOwnedOpenOrder = openOrders.some((order) => (order.clientOrderId ?? "").startsWith("smc_"));
    if (hasBotOwnedOpenOrder) {
      throw new UnsafeTradingAccountDeletionError("Trading account has an active bot-owned Binance order");
    }
  }

  private async loadAllAccountsBestEffort(): Promise<TradingAccount[]> {
    try {
      return await this.accountRepository.listAllTradingAccounts();
    } catch (error) {
      this.logger.warn("[RUNTIME] eager account loading failed", { error: error instanceof Error ? error.message : String(error) });
      return [];
    }
  }

  private async reconcileRuntime(runtime: AccountRuntime): Promise<ReconciliationResult> {
    if (runtime.reconciliationInFlight) return runtime.reconciliationInFlight;
    const reconciliation = this.performReconcileRuntime(runtime).finally(() => {
      if (runtime.reconciliationInFlight === reconciliation) runtime.reconciliationInFlight = null;
      // Positions, protection and health may have changed either way.
      this.live.publish(runtime.account.id, { topic: "reconcile" });
    });
    runtime.reconciliationInFlight = reconciliation;
    return reconciliation;
  }

  private async performReconcileRuntime(runtime: AccountRuntime): Promise<ReconciliationResult> {
    runtime.health.state = "RECOVERING";
    runtime.health.reconciliationStatus = "PENDING";
    const result = await runtime.reconciliation.reconcile(
      runtime.account.id,
      () => this.getAccountActivity(runtime.account.id, undefined, 100),
      runtime.reconciliationGateway
    );
    const activity = await this.getAccountActivity(runtime.account.id, undefined, 100);
    runtime.lastPositions = activity.positions;
    runtime.scanner.syncPositions(activity.positions, pendingBotEntrySymbols(activity.openOrders));
    runtime.health.lastReconciliationAt = result.checkedAt;
    runtime.health.lastReconciliationError = result.error;
    runtime.health.reconciliationStatus = result.status;
    runtime.health.protectionStatus = result.unprotectedPositions > 0 ? "PROTECTION_INCOMPLETE" : "OK";
    runtime.health.protectionLastError = result.unprotectedPositions > 0 ? result.error : null;
    runtime.health.protectionRepairAttempts = result.protectionRepairAttempts;
    if (result.status === "OK") {
      runtime.health.state = "READY";
      runtime.health.reconciliationSuccess += 1;
      if (runtime.account.status !== "CONNECTED") {
        await this.accountRepository.updateTradingAccountStatus(runtime.account.id, "CONNECTED", result.checkedAt);
        runtime.account.status = "CONNECTED";
        runtime.account.updatedAt = result.checkedAt;
      }
    } else if (result.status === "CONNECTION_LOST") {
      runtime.health.state = "DISCONNECTED";
      runtime.health.reconciliationFailure += 1;
      await this.accountRepository.updateTradingAccountStatus(runtime.account.id, "ERROR", result.checkedAt);
      runtime.account.status = "ERROR";
      runtime.account.updatedAt = result.checkedAt;
    } else {
      runtime.health.state = "DEGRADED";
      runtime.health.reconciliationFailure += 1;
    }
    this.updateExecutionHealth(runtime);
    return result;
  }

  private resolveRuntimeExecutionGate(account: TradingAccount, health: RuntimeHealth, config: AppConfig, rawExecution: ExecutionGateway): ExecutionGateState {
    const policy = resolveEffectiveExecutionPolicy(this.processReadOnlySoak, config.readOnlySoak || false);
    return resolveExecutionGate({
      shuttingDown: this.shuttingDown,
      mode: account.mode,
      runtimeState: health.state,
      reconciliationStatus: health.reconciliationStatus,
      tradingEnabled: config.tradingEnabled,
      killSwitch: config.killSwitch,
      binanceConnected: !(rawExecution instanceof DisabledExecutionGateway),
      readOnlySoak: policy.effectiveReadOnlySoak && account.mode === "DEMO"
    });
  }

  private updateExecutionHealth(runtime: AccountRuntime): ExecutionGateState {
    const policy = resolveEffectiveExecutionPolicy(this.processReadOnlySoak, runtime.configRef.accountReadOnlySoak);
    runtime.health.processReadOnlySoak = policy.processReadOnlySoak;
    runtime.health.accountReadOnlySoak = policy.accountReadOnlySoak;
    runtime.health.effectiveReadOnlySoak = policy.effectiveReadOnlySoak;
    runtime.health.executionPolicy = policy.executionPolicy;
    runtime.health.executionCapability = policy.executionCapability;
    const execution = this.resolveRuntimeExecutionGate(runtime.account, runtime.health, runtime.configRef.current, runtime.rawExecution);
    runtime.health.execution = execution;
    runtime.health.executionEnabled = execution.enabled;
    return execution;
  }

  private async auditRealEvent(tradingAccountId: string, symbol: string | null, type: string, metadata: Record<string, unknown>): Promise<void> {
    const key = `${tradingAccountId}:${symbol ?? "-"}:${type}`;
    const now = Date.now();
    const previous = this.realAuditThrottle.get(key) ?? 0;
    if (now - previous < 15 * 60 * 1000) return;
    this.realAuditThrottle.set(key, now);
    await this.executionIntentRepository.saveAuditEvent({
      id: crypto.randomUUID(),
      tradingAccountId,
      executionIntentId: null,
      symbol,
      type,
      metadata,
      createdAt: new Date().toISOString()
    });
  }
}

export function resolveExecutionGate(input: ExecutionGateInput): ExecutionGateState {
  if (input.shuttingDown || input.runtimeState === "SHUTTING_DOWN") return disabled("SHUTTING_DOWN");
  if (input.readOnlySoak && input.mode === "DEMO") return disabled("READ_ONLY_SOAK_EXECUTION_BLOCKED");
  if (input.killSwitch) return disabled("KILL_SWITCH");
  if (!input.tradingEnabled) return disabled("TRADING_DISABLED");
  if (input.runtimeState === "RECOVERING") return disabled("RUNTIME_NOT_READY");
  if (input.runtimeState === "DISCONNECTED") return disabled("BINANCE_DISCONNECTED");
  if (input.runtimeState !== "READY") return disabled("RECONCILIATION_REQUIRED");
  if (!input.binanceConnected) return disabled("BINANCE_DISCONNECTED");
  if (input.reconciliationStatus !== "OK") return disabled("RECONCILIATION_REQUIRED");
  if (input.mode === "REAL") return disabled("REAL_EXECUTION_LOCKED");
  return { enabled: true, reason: "READY" };
}

function disabled(reason: ExecutionGateReason): ExecutionGateState {
  return { enabled: false, reason };
}

function createReadinessChecks(): RealTradingReadinessResult["checks"] {
  return {
    credentials: fail("NOT_CHECKED"),
    futuresPermission: fail("NOT_CHECKED"),
    accountReachable: fail("NOT_CHECKED"),
    symbolRulesLoaded: fail("NOT_CHECKED"),
    balanceAvailable: fail("NOT_CHECKED"),
    marginAssetSupported: fail("NOT_CHECKED"),
    leverageValid: fail("NOT_CHECKED"),
    marginModeKnown: fail("NOT_CHECKED"),
    tradingEnabled: fail("NOT_CHECKED"),
    killSwitchOff: fail("NOT_CHECKED"),
    runtimeReady: fail("NOT_CHECKED"),
    reconciliationHealthy: fail("NOT_CHECKED"),
    realExecutionLocked: fail("REAL_EXECUTION_LOCKED")
  };
}

function ok(): ReadinessCheck {
  return { ok: true, reason: null };
}

function fail(reason: string): ReadinessCheck {
  return { ok: false, reason };
}

function accountActivityMetadata(account: TradingAccount): Pick<AccountActivitySnapshot, "source" | "sourceEnvironment" | "tradingAccountId"> {
  return {
    source: "BINANCE_SIGNED_ACCOUNT",
    sourceEnvironment: account.mode === "DEMO" ? "TESTNET" : "MAINNET",
    tradingAccountId: account.id
  };
}

function withActivitySource<T extends object>(
  items: T[],
  account: TradingAccount
): Array<T & { source: "binance"; sourceEnvironment: "TESTNET" | "MAINNET"; tradingAccountId: string }> {
  const metadata = accountActivityMetadata(account);
  return items.map((item) => ({
    ...item,
    source: "binance",
    sourceEnvironment: metadata.sourceEnvironment,
    tradingAccountId: metadata.tradingAccountId
  }));
}

async function readAccountRuntimeData<T>(label: string, read: () => Promise<T[]>, logger: DecisionLogger): Promise<T[]> {
  try {
    return await read();
  } catch (error) {
    logger.warn(`Account runtime ${label} sync failed`, { error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}

const SCANNER_BOOTSTRAP_RETRY_MS = 60_000;

/** Symbols with a resting bot entry order (client id `smc_<intent>_E`). */
function pendingBotEntrySymbols(openOrders: readonly { symbol: string; clientOrderId: string | null; type: string }[]): string[] {
  return openOrders.filter((order) => order.clientOrderId?.startsWith("smc_") && order.clientOrderId.endsWith("_E") && order.type === "LIMIT").map((order) => order.symbol);
}

class AccountRuntime {
  reconciliationTimer: NodeJS.Timeout | null = null;
  reconciliationInFlight: Promise<ReconciliationResult> | null = null;
  scannerBootstrapStarted = false;
  scannerBootstrapInFlight: Promise<void> | null = null;
  lastPositions: BinanceFuturesPositionStatus[] = [];

  constructor(
    readonly account: TradingAccount,
    readonly scanner: MarketScanner,
    readonly repository: TradingRepository,
    readonly health: RuntimeHealth,
    readonly reconciliation: TradingReconciliationService,
    readonly rawExecution: ExecutionGateway,
    readonly configRef: RuntimeConfigRef,
    readonly reconciliationGateway: RecoverableExecutionGateway | undefined
  ) {}
}

function reconcileWatchlistStatus(
  rows: WatchlistStatus[],
  positions: readonly BinanceFuturesPositionStatus[],
  executionMode: AppConfig["executionMode"]
): WatchlistStatus[] {
  const positionsBySymbol = new Map(positions.filter((position) => position.quantity > 0).map((position) => [position.symbol, position]));
  return rows.map((row) => {
    const position = positionsBySymbol.get(row.symbol);
    if (position) {
      return {
        ...row,
        state: "ManagingTrade",
        conditions: "—",
        rr: null,
        position: position.side === "short" ? "SHORT" : "LONG",
        status: "Position Open",
        positionSource: "binance"
      };
    }

    if (row.position !== "Open" && row.position !== "Paper") {
      return { ...row, position: "None", positionSource: "binance" };
    }

    if (executionMode === "paper") {
      return { ...row, rr: null, position: "Paper", status: "Simulated", positionSource: "paper" };
    }

    return { ...row, rr: null, position: "None", status: "Unsynced", positionSource: "engine" };
  });
}

class GatedRecoverableExecutionGateway implements RecoverableExecutionGateway {
  constructor(
    private readonly delegate: RecoverableExecutionGateway,
    private readonly executionGate: () => ExecutionGateState
  ) {}

  async submitBracketOrder(plan: Parameters<ExecutionGateway["submitBracketOrder"]>[0], risk: Parameters<ExecutionGateway["submitBracketOrder"]>[1], context?: ExecutionOrderContext): Promise<SubmittedOrder> {
    this.assertEnabled();
    return this.delegate.submitBracketOrder(plan, risk, context);
  }

  async findOrderByClientOrderId(symbol: string, clientOrderId: string): Promise<ExecutionOrderLookupResult | null> {
    return this.delegate.findOrderByClientOrderId(symbol, clientOrderId);
  }

  async submitProtectionOrder(request: ProtectionOrderRequest): Promise<ExecutionOrderLookupResult> {
    this.assertEnabled();
    return this.delegate.submitProtectionOrder(request);
  }

  async findProtectionOrder(symbol: string, type: ProtectionOrderRequest["type"], side: ProtectionOrderRequest["side"], clientOrderId: string): Promise<ExecutionOrderLookupResult | null> {
    return this.delegate.findProtectionOrder ? this.delegate.findProtectionOrder(symbol, type, side, clientOrderId) : null;
  }

  async closePosition(request: import("../ports/ExecutionGateway.js").EmergencyCloseRequest): Promise<ExecutionOrderLookupResult> {
    this.assertEnabled();
    if (!this.delegate.closePosition) throw new Error("FAIL_SAFE_CLOSE_UNAVAILABLE");
    return this.delegate.closePosition(request);
  }

  async cancelOrderByClientOrderId(symbol: string, clientOrderId: string): Promise<void> {
    this.assertEnabled();
    return this.delegate.cancelOrderByClientOrderId(symbol, clientOrderId);
  }

  private assertEnabled(): void {
    const gate = this.executionGate();
    if (!gate.enabled) throw new Error(gate.reason);
  }
}

function createRecoveringHealth(): RuntimeHealth {
  return {
    state: "RECOVERING",
    lastScanAt: null,
    lastReconciliationAt: null,
    lastReconciliationError: null,
    reconciliationStatus: "PENDING",
    executionEnabled: false,
    execution: { enabled: false, reason: "RUNTIME_NOT_READY" },
    duplicatePrevented: 0,
    executionAttempts: 0,
    executionSucceeded: 0,
    executionFailed: 0,
    reconciliationSuccess: 0,
    reconciliationFailure: 0,
    protectionStatus: "OK",
    protectionLastError: null,
    protectionRepairAttempts: 0,
    processReadOnlySoak: false,
    accountReadOnlySoak: false,
    effectiveReadOnlySoak: false,
    executionPolicy: "NORMAL",
    executionCapability: "CONFIGURED"
  };
}
