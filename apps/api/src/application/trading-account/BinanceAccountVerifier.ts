import type { TradingAccountMode } from "../../domain/trading-account/TradingAccount.js";

export type BinanceVerificationErrorCode =
  | "INVALID_CREDENTIALS"
  | "FUTURES_PERMISSION_MISSING"
  | "BINANCE_UNAVAILABLE"
  | "INVALID_ACCOUNT_MODE";

export interface BinanceAccountInfo {
  environment: "TESTNET" | "MAINNET";
  connected: boolean;
  walletBalance: number | null;
  availableBalance: number | null;
  currency: "USDT";
  checkedAt: string;
}

export class BinanceVerificationError extends Error {
  constructor(
    readonly code: BinanceVerificationErrorCode,
    message: string
  ) {
    super(message);
  }
}

export interface BinanceAccountVerifier {
  verify(input: { mode: TradingAccountMode; apiKey: string; apiSecret: string }): Promise<BinanceAccountInfo>;
}
