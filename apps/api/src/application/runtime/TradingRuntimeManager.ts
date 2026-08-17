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
import type { TradingEngine } from "../engine/TradingEngine.js";
import type { TradingAccount } from "../../domain/trading-account/TradingAccount.js";

export interface AccountSnapshot {
  engine: unknown;
  store: unknown;
  watchlistStatus: WatchlistStatus[];
}

export interface AccountActivitySnapshot {
  connected: boolean;
  positions: BinanceFuturesPositionStatus[];
  openOrders: BinanceFuturesOpenOrderStatus[];
  orderHistory: BinanceFuturesOrderHistoryStatus[];
  tradeHistory: BinanceFuturesTradeHistoryStatus[];
}

export class TradingRuntimeManager {
  private readonly runtimes = new Map<string, AccountRuntime>();

  constructor(
    private readonly baseConfig: AppConfig,
    private readonly databaseUrl: string | undefined,
    private readonly accountRepository: TradingAccountRepository,
    private readonly configRepository: TradingRuntimeConfigRepository,
    private readonly cipher: CredentialCipher,
    private readonly marketData: BinanceFuturesMarketData,
    private readonly logger: DecisionLogger
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

    const account = await this.accountRepository.findTradingAccountById(accountId);
    if (!account) throw new Error("ACCOUNT_NOT_FOUND");
    await this.configRepository.ensureDefaults(account.id, this.baseConfig);
    const settings = (await this.configRepository.getSettings(account.id)) ?? this.baseConfig;
    const watchlist = await this.configRepository.getWatchlist(account.id);
    const config = { ...this.baseConfig, ...settings, watchlist, symbol: watchlist[0] ?? settings.symbol };
    const repository = this.databaseUrl ? new PostgresTradingRepository(this.databaseUrl, account.id) : new MemoryTradingRepository();
    if (this.databaseUrl && "migrate" in repository) await (repository as PostgresTradingRepository).migrate();
    await repository.saveTradingSettings(config);
    const execution = await this.createExecutionGateway(account, config.entryMode, config.leverage);
    const scanner = new MarketScanner(config, repository, execution, this.logger, this.marketData, null);
    const runtime = new AccountRuntime(account, scanner, repository);
    this.runtimes.set(account.id, runtime);
    await scanner.bootstrap().catch((error: unknown) => {
      this.logger.warn("[RUNTIME] bootstrap failed", { tradingAccountId: account.id, error: error instanceof Error ? error.message : String(error) });
    });
    scanner.start();
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
    this.runtimes.delete(accountId);
  }

  async getSnapshot(accountId: string): Promise<AccountSnapshot> {
    const runtime = await this.ensureRuntime(accountId);
    return {
      engine: runtime.scanner.getPrimaryEngine().getDashboardState(),
      store: await runtime.repository.getDashboardSnapshot(),
      watchlistStatus: runtime.scanner.getWatchlistStatus()
    };
  }

  async getManualPositions(accountId: string, symbol: string): Promise<BinanceFuturesPositionStatus[]> {
    const client = await this.createAccountClient(accountId);
    if (!client) return [];
    return readAccountRuntimeData("positions", () => client.getOpenPositions(symbol), this.logger);
  }

  async getAccountActivity(accountId: string, symbol: string, limit: number): Promise<AccountActivitySnapshot> {
    const client = await this.createAccountClient(accountId);
    if (!client) {
      return { connected: false, positions: [], openOrders: [], orderHistory: [], tradeHistory: [] };
    }

    const [positions, openOrders, orderHistory, tradeHistory] = await Promise.all([
      readAccountRuntimeData("positions", () => client.getOpenPositions(symbol), this.logger),
      readAccountRuntimeData("open orders", () => client.getOpenOrders(symbol), this.logger),
      readAccountRuntimeData("order history", () => client.getOrderHistory(symbol, limit), this.logger),
      readAccountRuntimeData("trade history", () => client.getTradeHistory(symbol, limit), this.logger)
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

  private async createAccountClient(accountId: string): Promise<BinanceFuturesAccountClient | null> {
    const account = await this.accountRepository.findTradingAccountById(accountId);
    if (!account) throw new Error("ACCOUNT_NOT_FOUND");
    const connection = await this.accountRepository.findBinanceConnection(account.id);
    if (!connection || connection.status !== "CONNECTED") return null;
    const apiKey = this.cipher.decrypt(connection.apiKeyEncrypted);
    const apiSecret = this.cipher.decrypt(connection.apiSecretEncrypted);
    return new BinanceFuturesAccountClient(apiKey, apiSecret, account.mode === "DEMO");
  }

  private async loadAllAccountsBestEffort(): Promise<TradingAccount[]> {
    // Phase 3 runtime is also initialized lazily by account-scoped API calls.
    return [];
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
  constructor(
    readonly account: TradingAccount,
    readonly scanner: MarketScanner,
    readonly repository: TradingRepository
  ) {}
}
