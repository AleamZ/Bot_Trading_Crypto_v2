import crypto from "node:crypto";
import type { AppConfig } from "../config/AppConfig.js";
import type { TradingAccountRepository } from "../trading-account/TradingAccountRepository.js";
import type { TradingRuntimeConfigRepository } from "../trading-account/TradingRuntimeConfigRepository.js";
import type { DecisionLogger } from "../ports/Logger.js";
import type { TradingRepository } from "../ports/Repositories.js";
import { MarketScanner, type WatchlistStatus } from "../scanner/MarketScanner.js";
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

export interface AccountSnapshot {
  engine: unknown;
  store: unknown;
  watchlistStatus: WatchlistStatus[];
  runtimeHealth: RuntimeHealth;
  execution: ExecutionGateState;
  realReadiness: RealTradingReadinessResult | null;
  dailyRisk: DailyRiskStatus;
  accountProtection: AccountProtectionStatus | null;
}

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
}

export interface AccountActivitySnapshot {
  connected: boolean;
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
  mode: "DEMO" | "REAL";
  executionLocked: boolean;
  executionReason: "READY" | "REAL_EXECUTION_LOCKED";
  realExecutionMode: "LOCKED" | "DRY_RUN" | "APPROVAL_REQUIRED";
  masterLiveExecutionEnabled: boolean;
  symbol: string;
  configuredLeverage: number;
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
}

interface RuntimeConfigRef {
  current: AppConfig;
}

export class TradingRuntimeManager {
  private readonly runtimes = new Map<string, AccountRuntime>();
  private readonly runtimeLoads = new Map<string, Promise<AccountRuntime>>();
  private readonly realAuditThrottle = new Map<string, number>();
  private readonly deletingAccounts = new Set<string>();
  private shuttingDown = false;

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
    private readonly runtimeMarketDataFactory: RuntimeMarketDataFactory = (testnet) => new BinanceFuturesMarketData(testnet)
  ) {}

  async start(): Promise<void> {
    if (this.shuttingDown) return;
    const accounts = await this.loadAllAccountsBestEffort();
    for (const account of accounts) {
      await this.ensureRuntime(account.id);
    }
  }

  async ensureRuntime(accountId: string): Promise<AccountRuntime> {
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
    const account = await this.accountRepository.findTradingAccountById(accountId);
    if (!account) throw new Error("ACCOUNT_NOT_FOUND");
    await this.configRepository.ensureDefaults(account.id, this.baseConfig);
    const settings = (await this.configRepository.getSettings(account.id)) ?? this.baseConfig;
    const watchlist = await this.configRepository.getWatchlist(account.id);
    const config = { ...this.baseConfig, ...settings, watchlist, symbol: watchlist[0] ?? settings.symbol };
    const configRef: RuntimeConfigRef = { current: config };
    const repository = this.databaseUrl ? new PostgresTradingRepository(this.databaseUrl, account.id) : new MemoryTradingRepository();
    if (this.databaseUrl && "migrate" in repository) await (repository as PostgresTradingRepository).migrate();
    await repository.saveTradingSettings(config);
    const health = createRecoveringHealth();
    const rawExecution = await this.createExecutionGateway(account, config.entryMode, config.maxLeverage);
    const executionGate = () => this.resolveRuntimeExecutionGate(account, health, configRef.current, rawExecution);
    const execution =
      account.mode === "DEMO"
        ? new ExecutionCoordinator({
            tradingAccountId: account.id,
            mode: account.mode,
            entryType: config.entryMode,
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
    const reconciliationGateway = account.mode === "DEMO" && isRecoverableExecutionGateway(rawExecution) ? new GatedRecoverableExecutionGateway(rawExecution, executionGate) : undefined;
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
      (symbol) => this.getSymbolRules(account.id, symbol)
    );
    const reconciliation = new TradingReconciliationService(this.executionIntentRepository, this.logger);
    const runtime = new AccountRuntime(account, scanner, repository, health, reconciliation, rawExecution, configRef, reconciliationGateway);
    this.runtimes.set(account.id, runtime);
    await this.reconcileRuntime(runtime);
    await scanner.bootstrap().catch((error: unknown) => {
      this.logger.warn("[RUNTIME] bootstrap failed", { tradingAccountId: account.id, error: error instanceof Error ? error.message : String(error) });
    });
    runtime.health.lastScanAt = new Date().toISOString();
    scanner.start();
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

  async refreshRuntime(accountId: string): Promise<void> {
    const runtime = this.runtimes.get(accountId);
    if (!runtime) {
      await this.ensureRuntime(accountId);
      return;
    }

    const account = await this.accountRepository.findTradingAccountById(accountId);
    if (!account) return;
    const settings = (await this.configRepository.getSettings(accountId)) ?? this.baseConfig;
    const watchlist = await this.configRepository.getWatchlist(accountId);
    const config = { ...this.baseConfig, ...settings, watchlist, symbol: watchlist[0] ?? settings.symbol };
    runtime.configRef.current = config;
    await runtime.repository.saveTradingSettings(config);
    runtime.scanner.updateConfig(config);
    this.updateExecutionHealth(runtime);
  }

  async disableExecution(accountId: string): Promise<void> {
    const runtime = this.runtimes.get(accountId);
    if (runtime?.reconciliationTimer) clearInterval(runtime.reconciliationTimer);
    this.runtimes.delete(accountId);
    this.runtimeLoads.delete(accountId);
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
  }

  cancelAccountDeletion(accountId: string): void {
    this.deletingAccounts.delete(accountId);
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    for (const runtime of this.runtimes.values()) {
      runtime.health.state = "SHUTTING_DOWN";
      runtime.health.execution = { enabled: false, reason: "SHUTTING_DOWN" };
      runtime.health.executionEnabled = false;
      if (runtime.reconciliationTimer) clearInterval(runtime.reconciliationTimer);
      runtime.reconciliationTimer = null;
      runtime.scanner.stop();
    }
    await Promise.allSettled([...this.runtimes.values()].map((runtime) => runtime.reconciliationInFlight));
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
      store: await runtime.repository.getDashboardSnapshot(),
      watchlistStatus: runtime.scanner.getWatchlistStatus(),
      runtimeHealth: { ...runtime.health },
      execution,
      realReadiness,
      dailyRisk,
      accountProtection
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
    checks.futuresPermission = wallet?.connected ? ok() : fail("FUTURES_PERMISSION_MISSING");

    let rules: FuturesSymbolRules | null = null;
    try {
      rules = await this.getSymbolRules(account.id, symbol);
      checks.symbolRulesLoaded = ok();
      checks.marginAssetSupported = rules.marginAsset === "USDT" || rules.marginAsset === null ? ok() : fail("MARGIN_ASSET_UNSUPPORTED");
      checks.leverageValid = rules.maxLeverage === null || settings.maxLeverage <= rules.maxLeverage ? ok() : fail("LEVERAGE_EXCEEDS_BINANCE_MAX");
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
    if (leverageMatch === false) checks.leverageValid = fail("LEVERAGE_MISMATCH");
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
      mode: account.mode,
      executionLocked: account.mode === "REAL",
      executionReason: account.mode === "REAL" ? "REAL_EXECUTION_LOCKED" : "READY",
      realExecutionMode: settings.realExecutionMode,
      masterLiveExecutionEnabled: this.baseConfig.realLiveExecutionEnabled,
      symbol,
      configuredLeverage: settings.maxLeverage,
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

  async listExecutions(accountId: string, limit = 100): Promise<unknown[]> {
    return this.executionIntentRepository.listByAccount(accountId, limit);
  }

  async listExecutionAuditEvents(accountId: string, executionIntentId?: string, limit = 100): Promise<unknown[]> {
    return this.executionIntentRepository.listAuditEvents(accountId, executionIntentId, limit);
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

    const [positions, openOrders, orderHistory, tradeHistory] = await Promise.all([
      readAccountRuntimeData("positions", () => client.getOpenPositions(symbol), this.logger),
      readAccountRuntimeData("open orders", () => client.getOpenOrders(symbol), this.logger),
      symbol ? readAccountRuntimeData("order history", () => client.getOrderHistory(symbol, limit), this.logger) : Promise.resolve([]),
      symbol ? readAccountRuntimeData("trade history", () => client.getTradeHistory(symbol, limit), this.logger) : Promise.resolve([])
    ]);

    return {
      connected: true,
      ...metadata,
      positions: withActivitySource(positions, account),
      openOrders: withActivitySource(openOrders, account),
      orderHistory: withActivitySource(orderHistory, account),
      tradeHistory: withActivitySource(tradeHistory, account)
    };
  }

  getEngineForTest(accountId: string, symbol: string): TradingEngine | null {
    return this.runtimes.get(accountId)?.scanner.getEngine(symbol) ?? null;
  }

  async getSetupDiagnostic(accountId: string, symbol: string): Promise<SetupDiagnostic | null> {
    const runtime = await this.ensureRuntime(accountId);
    return runtime.scanner.getSetupDiagnostic(symbol);
  }

  private async createExecutionGateway(account: TradingAccount, entryMode: "limit" | "market", leverage: number): Promise<ExecutionGateway> {
    if (account.mode === "REAL") return new LockedRealExecutionGateway();
    const connection = await this.accountRepository.findBinanceConnection(account.id);
    if (!connection || connection.status !== "CONNECTED") return new DisabledExecutionGateway("BINANCE_NOT_CONNECTED");
    const apiKey = this.cipher.decrypt(connection.apiKeyEncrypted);
    const apiSecret = this.cipher.decrypt(connection.apiSecretEncrypted);
    return new BinanceFuturesExecutionGateway(apiKey, apiSecret, "testnet", entryMode, leverage);
  }

  private async createAccountClient(accountId: string): Promise<AccountRuntimeClient | null> {
    const account = await this.accountRepository.findTradingAccountById(accountId);
    if (!account) throw new Error("ACCOUNT_NOT_FOUND");
    const connection = await this.accountRepository.findBinanceConnection(account.id);
    if (!connection || connection.status !== "CONNECTED") return null;
    const apiKey = this.cipher.decrypt(connection.apiKeyEncrypted);
    const apiSecret = this.cipher.decrypt(connection.apiSecretEncrypted);
    return this.accountClientFactory(apiKey, apiSecret, account.mode === "DEMO");
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
    runtime.scanner.syncPositions(activity.positions);
    runtime.health.lastReconciliationAt = result.checkedAt;
    runtime.health.lastReconciliationError = result.error;
    runtime.health.reconciliationStatus = result.status;
    if (result.status === "OK") {
      runtime.health.state = "READY";
      runtime.health.reconciliationSuccess += 1;
    } else if (result.status === "CONNECTION_LOST") {
      runtime.health.state = "DISCONNECTED";
      runtime.health.reconciliationFailure += 1;
    } else {
      runtime.health.state = "DEGRADED";
      runtime.health.reconciliationFailure += 1;
    }
    this.updateExecutionHealth(runtime);
    return result;
  }

  private resolveRuntimeExecutionGate(account: TradingAccount, health: RuntimeHealth, config: AppConfig, rawExecution: ExecutionGateway): ExecutionGateState {
    return resolveExecutionGate({
      shuttingDown: this.shuttingDown,
      mode: account.mode,
      runtimeState: health.state,
      reconciliationStatus: health.reconciliationStatus,
      tradingEnabled: config.tradingEnabled,
      killSwitch: config.killSwitch,
      binanceConnected: !(rawExecution instanceof DisabledExecutionGateway)
    });
  }

  private updateExecutionHealth(runtime: AccountRuntime): ExecutionGateState {
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
    return [];
  }
}

class AccountRuntime {
  reconciliationTimer: NodeJS.Timeout | null = null;
  reconciliationInFlight: Promise<ReconciliationResult> | null = null;

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

  async cancelOrderByClientOrderId(symbol: string, clientOrderId: string): Promise<void> {
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
    reconciliationFailure: 0
  };
}
