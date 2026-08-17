export type TradingAccountMode = "DEMO" | "REAL";
export type TradingAccountStatus = "PENDING" | "CONNECTED" | "DISCONNECTED" | "ERROR";
export type BinanceConnectionStatus = "NOT_CONFIGURED" | "CONNECTED" | "ERROR";

export interface TradingAccount {
  id: string;
  userId: string;
  name: string;
  mode: TradingAccountMode;
  status: TradingAccountStatus;
  createdAt: string;
  updatedAt: string;
}

export interface BinanceConnection {
  id: string;
  tradingAccountId: string;
  apiKeyEncrypted: string;
  apiSecretEncrypted: string;
  credentialVersion: number;
  status: BinanceConnectionStatus;
  lastVerifiedAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TradingAccountContext {
  userId: string;
  tradingAccountId: string;
  mode: TradingAccountMode;
}

export interface SafeTradingAccount {
  id: string;
  name: string;
  mode: TradingAccountMode;
  status: TradingAccountStatus;
  createdAt: string;
  updatedAt: string;
}

export interface SafeBinanceConnection {
  id: string | null;
  status: BinanceConnectionStatus;
  apiKeyMasked: string | null;
  lastVerifiedAt: string | null;
  lastError: string | null;
}

export interface SafeBinanceAccount {
  environment: "TESTNET" | "MAINNET";
  connected: boolean;
  walletBalance: number | null;
  availableBalance: number | null;
  currency: "USDT";
  checkedAt: string;
}

export function toSafeTradingAccount(account: TradingAccount): SafeTradingAccount {
  return {
    id: account.id,
    name: account.name,
    mode: account.mode,
    status: account.status,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt
  };
}

export function modeEnvironment(mode: TradingAccountMode): "TESTNET" | "MAINNET" {
  return mode === "DEMO" ? "TESTNET" : "MAINNET";
}

export function maskApiKey(apiKey: string): string {
  const trimmed = apiKey.trim();
  if (trimmed.length <= 8) return `${trimmed.slice(0, 2)}****${trimmed.slice(-2)}`;
  return `${trimmed.slice(0, 4)}****${trimmed.slice(-4)}`;
}
