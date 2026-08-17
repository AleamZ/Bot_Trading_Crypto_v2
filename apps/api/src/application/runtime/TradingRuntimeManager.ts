import type { AppConfig } from "../config/AppConfig.js";
import type { TradingAccountRepository } from "../trading-account/TradingAccountRepository.js";
import type { TradingRuntimeConfigRepository } from "../trading-account/TradingRuntimeConfigRepository.js";
import type { DecisionLogger } from "../ports/Logger.js";
import type { TradingRepository } from "../ports/Repositories.js";
import { MarketScanner, type WatchlistStatus } from "../scanner/MarketScanner.js";
import { PostgresTradingRepository } from "../../infrastructure/persistence/PostgresTradingRepository.js";
import { MemoryTradingRepository } from "../../infrastructure/persistence/MemoryTradingRepository.js";
import type { BinanceFuturesMarketData } from "../../infrastructure/market-data/BinanceFuturesMarketData.js";
import type { CredentialCipher } from "../../infrastructure/security/CredentialCipher.js";
import { BinanceFuturesExecutionGateway } from "../../infrastructure/execution/BinanceFuturesExecutionGateway.js";
import {
  BinanceFuturesAccountClient,
  type BinanceFuturesOpenOrderStatus,
  type BinanceFuturesOrderHistoryStatus,
  type BinanceFuturesPositionStatus,
  type BinanceFuturesTradeHistoryStatus
} from "../../infrastructure/execution/BinanceFuturesAccountClient.js";
import { LockedRealExecutionGateway } from "../../infrastructure/execution/LockedRealExecutionGateway.js";
import { DisabledExecutionGateway } from "../../infrastructure/execution/DisabledExecutionGateway.js";
import type { ExecutionGateway } from "../ports/ExecutionGateway.js";
import { isRecoverableExecutionGateway } from "../ports/ExecutionGateway.js";
import type { TradingEngine } from "../engine/TradingEngine.js";
import type { TradingAccount } from "../../domain/trading-account/TradingAccount.js";
import type { ExecutionIntentRepository } from "../execution/ExecutionIntentRepository.js";
import { ExecutionCoordinator } from "../execution/ExecutionCoordinator.js";
import { TradingReconciliationService, type ReconciliationResult } from "../execution/TradingReconciliationService.js";

export interface AccountSnapshot {
  engine: unknown;
  store: unknown;
  watchlistStatus: WatchlistStatus[];
  runtimeHealth: RuntimeHealth;
}

export interface RuntimeHealth {
  state: "RECOVERING" | "READY" | "DEGRADED" | "DISCONNECTED" | "ERROR";
  lastScanAt: string | null;
  lastReconciliationAt: string | null;
  lastReconciliationError: string | null;
  reconciliationStatus: "PENDING" | "OK" | "DEGRADED" | "CONNECTION_LOST";
  executionEnabled: boolean;
  duplicatePrevented: number;
  executionAttempts: number;
  executionSucceeded: number;
  executionFailed: number;
  reconciliationSuccess: number;
  reconciliationFailure: number;
}

export interface AccountActivitySnapshot {
  connected: boolean;
  positions: BinanceFuturesPositionStatus[];
  openOrders: BinanceFuturesOpenOrderStatus[];
  orderHistory: BinanceFuturesOrderHistoryStatus[];
  tradeHistory: BinanceFuturesTradeHistoryStatus[];
}

interface AccountRuntimeClient {
  getOpenPositions(symbol?: string): Promise<BinanceFuturesPositionStatus[]>;
  getOpenOrders(symbol?: string): Promise<BinanceFuturesOpenOrderStatus[]>;
  getOrderHistory(symbol?: string, limit?: number): Promise<BinanceFuturesOrderHistoryStatus[]>;
  getTradeHistory(symbol?: string, limit?: number): Promise<BinanceFuturesTradeHistoryStatus[]>;
}

type AccountRuntimeClientFactory = (apiKey: string, apiSecret: string, testnet: boolean) => AccountRuntimeClient;

export class TradingRuntimeManager {
  private readonly runtimes = new Map<string, AccountRuntime>();
  private readonly runtimeLoads = new Map<string, Promise<AccountRuntime>>();

  constructor(
    private readonly baseConfig: AppConfig,
    private readonly databaseUrl: string | undefined,
    private readonly accountRepository: TradingAccountRepository,
    private readonly configRepository: TradingRuntimeConfigRepository,
    private readonly executionIntentRepository: ExecutionIntentRepository,
    private readonly cipher: CredentialCipher,
    private readonly marketData: BinanceFuturesMarketData,
    private readonly logger: DecisionLogger,
    private readonly accountClientFactory: AccountRuntimeClientFactory = (apiKey, apiSecret, testnet) => new BinanceFuturesAccountClient(apiKey, apiSecret, testnet)
  ) {}

  async start(): Promise<void> {
    const accounts = await this.loadAllAccountsBestEffort();
    for (const account of accounts) {
      await this.ensureRuntime(account.id);
    }
  }

  async ensureRuntime(accountId: string): Promise<AccountRuntime> {
    const existing = this.runtimes.get(accountId);
    if (existing) return existing;
    const loading = this.runtimeLoads.get(accountId);
    if (loading) return loading;

    const loadingRuntime = this.createRuntime(accountId).finally(() => {
      this.runtimeLoads.delete(accountId);
    });
    this.runtimeLoads.set(accountId, loadingRuntime);
    return loadingRuntime;
  }

  private async createRuntime(accountId: string): Promise<AccountRuntime> {
    const account = await this.accountRepository.findTradingAccountById(accountId);
    if (!account) throw new Error("ACCOUNT_NOT_FOUND");
    await this.configRepository.ensureDefaults(account.id, this.baseConfig);
    const settings = (await this.configRepository.getSettings(account.id)) ?? this.baseConfig;
    const watchlist = await this.configRepository.getWatchlist(account.id);
    const config = { ...this.baseConfig, ...settings, watchlist, symbol: watchlist[0] ?? settings.symbol };
    const repository = this.databaseUrl ? new PostgresTradingRepository(this.databaseUrl, account.id) : new MemoryTradingRepository();
    if (this.databaseUrl && "migrate" in repository) await (repository as PostgresTradingRepository).migrate();
    await repository.saveTradingSettings(config);
    const health = createRecoveringHealth();
    const rawExecution = await this.createExecutionGateway(account, config.entryMode, config.leverage);
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
            runtimeReady: () => health.state === "READY" && config.tradingEnabled && !config.killSwitch
          })
        : rawExecution;
    const scanner = new MarketScanner(config, repository, execution, this.logger, this.marketData, null);
    const reconciliation = new TradingReconciliationService(this.executionIntentRepository, this.logger);
    const runtime = new AccountRuntime(account, scanner, repository, health, reconciliation, rawExecution);
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
    await runtime.repository.saveTradingSettings(config);
    runtime.scanner.updateConfig(config);
  }

  async disableExecution(accountId: string): Promise<void> {
    const runtime = this.runtimes.get(accountId);
    if (runtime?.reconciliationTimer) clearInterval(runtime.reconciliationTimer);
    this.runtimes.delete(accountId);
    this.runtimeLoads.delete(accountId);
  }

  async getSnapshot(accountId: string): Promise<AccountSnapshot> {
    const runtime = await this.ensureRuntime(accountId);
    return {
      engine: runtime.scanner.getPrimaryEngine().getDashboardState(),
      store: await runtime.repository.getDashboardSnapshot(),
      watchlistStatus: runtime.scanner.getWatchlistStatus(),
      runtimeHealth: { ...runtime.health }
    };
  }

  async listExecutions(accountId: string, limit = 100): Promise<unknown[]> {
    return this.executionIntentRepository.listByAccount(accountId, limit);
  }

  async listExecutionAuditEvents(accountId: string, executionIntentId?: string, limit = 100): Promise<unknown[]> {
    return this.executionIntentRepository.listAuditEvents(accountId, executionIntentId, limit);
  }

  async getManualPositions(accountId: string, symbol: string): Promise<BinanceFuturesPositionStatus[]> {
    const client = await this.createAccountClient(accountId);
    if (!client) return [];
    return readAccountRuntimeData("positions", () => client.getOpenPositions(symbol), this.logger);
  }

  async getAccountActivity(accountId: string, symbol: string | undefined, limit: number): Promise<AccountActivitySnapshot> {
    const client = await this.createAccountClient(accountId);
    if (!client) {
      return { connected: false, positions: [], openOrders: [], orderHistory: [], tradeHistory: [] };
    }

    const [positions, openOrders, orderHistory, tradeHistory] = await Promise.all([
      readAccountRuntimeData("positions", () => client.getOpenPositions(symbol), this.logger),
      readAccountRuntimeData("open orders", () => client.getOpenOrders(symbol), this.logger),
      symbol ? readAccountRuntimeData("order history", () => client.getOrderHistory(symbol, limit), this.logger) : Promise.resolve([]),
      symbol ? readAccountRuntimeData("trade history", () => client.getTradeHistory(symbol, limit), this.logger) : Promise.resolve([])
    ]);

    return { connected: true, positions, openOrders, orderHistory, tradeHistory };
  }

  getEngineForTest(accountId: string, symbol: string): TradingEngine | null {
    return this.runtimes.get(accountId)?.scanner.getEngine(symbol) ?? null;
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
      isRecoverableExecutionGateway(runtime.rawExecution) ? runtime.rawExecution : undefined
    );
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
    runtime.health.executionEnabled = runtime.account.mode === "DEMO" && runtime.health.state === "READY";
    return result;
  }
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
    readonly rawExecution: ExecutionGateway
  ) {}
}

function createRecoveringHealth(): RuntimeHealth {
  return {
    state: "RECOVERING",
    lastScanAt: null,
    lastReconciliationAt: null,
    lastReconciliationError: null,
    reconciliationStatus: "PENDING",
    executionEnabled: false,
    duplicatePrevented: 0,
    executionAttempts: 0,
    executionSucceeded: 0,
    executionFailed: 0,
    reconciliationSuccess: 0,
    reconciliationFailure: 0
  };
}
