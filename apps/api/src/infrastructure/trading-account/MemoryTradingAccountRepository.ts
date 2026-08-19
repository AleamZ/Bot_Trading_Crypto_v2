import type { TradingAccountRepository, CreateTradingAccountInput } from "../../application/trading-account/TradingAccountRepository.js";
import type { BinanceConnection, TradingAccount, TradingAccountStatus } from "../../domain/trading-account/TradingAccount.js";

export class MemoryTradingAccountRepository implements TradingAccountRepository {
  private readonly accounts = new Map<string, TradingAccount>();
  private readonly connections = new Map<string, BinanceConnection>();

  async createTradingAccount(input: CreateTradingAccountInput): Promise<TradingAccount> {
    this.accounts.set(input.id, input);
    return input;
  }

  async listTradingAccounts(userId: string): Promise<TradingAccount[]> {
    return [...this.accounts.values()].filter((account) => account.userId === userId).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async listAllTradingAccounts(): Promise<TradingAccount[]> {
    return [...this.accounts.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async findTradingAccountById(id: string): Promise<TradingAccount | null> {
    return this.accounts.get(id) ?? null;
  }

  async updateTradingAccountStatus(id: string, status: TradingAccountStatus, updatedAt: string): Promise<void> {
    const account = this.accounts.get(id);
    if (account) this.accounts.set(id, { ...account, status, updatedAt });
  }

  async upsertBinanceConnection(connection: BinanceConnection): Promise<BinanceConnection> {
    this.connections.set(connection.tradingAccountId, connection);
    return connection;
  }

  async findBinanceConnection(tradingAccountId: string): Promise<BinanceConnection | null> {
    return this.connections.get(tradingAccountId) ?? null;
  }

  async deleteBinanceConnection(tradingAccountId: string): Promise<void> {
    this.connections.delete(tradingAccountId);
  }

  async hardDeleteTradingAccount(id: string, userId: string): Promise<boolean> {
    const account = this.accounts.get(id);
    if (!account || account.userId !== userId) return false;
    this.connections.delete(id);
    this.accounts.delete(id);
    return true;
  }
}
