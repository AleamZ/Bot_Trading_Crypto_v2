import type { BinanceConnection, TradingAccount, TradingAccountMode, TradingAccountStatus } from "../../domain/trading-account/TradingAccount.js";

export interface CreateTradingAccountInput {
  id: string;
  userId: string;
  name: string;
  mode: TradingAccountMode;
  status: TradingAccountStatus;
  createdAt: string;
  updatedAt: string;
}

export interface TradingAccountRepository {
  createTradingAccount(input: CreateTradingAccountInput): Promise<TradingAccount>;
  listTradingAccounts(userId: string): Promise<TradingAccount[]>;
  findTradingAccountById(id: string): Promise<TradingAccount | null>;
  updateTradingAccountStatus(id: string, status: TradingAccountStatus, updatedAt: string): Promise<void>;
  upsertBinanceConnection(connection: BinanceConnection): Promise<BinanceConnection>;
  findBinanceConnection(tradingAccountId: string): Promise<BinanceConnection | null>;
  deleteBinanceConnection(tradingAccountId: string): Promise<void>;
}
