import type { BinanceAccountInfo, BinanceAccountVerifier } from "../../application/trading-account/BinanceAccountVerifier.js";
import { BinanceVerificationError } from "../../application/trading-account/BinanceAccountVerifier.js";
import type { TradingAccountMode } from "../../domain/trading-account/TradingAccount.js";
import { BinanceFuturesAccountClient } from "../execution/BinanceFuturesAccountClient.js";

export class BinanceFuturesAccountVerifier implements BinanceAccountVerifier {
  async verify(input: { mode: TradingAccountMode; apiKey: string; apiSecret: string }): Promise<BinanceAccountInfo> {
    const testnet = input.mode === "DEMO";
    const client = new BinanceFuturesAccountClient(input.apiKey, input.apiSecret, testnet);

    try {
      const status = await client.getWalletStatus();
      if (!status.connected) {
        throw normalizedBinanceError(status.label);
      }

      return {
        environment: testnet ? "TESTNET" : "MAINNET",
        connected: true,
        walletBalance: status.walletBalance,
        availableBalance: status.availableBalance,
        currency: "USDT",
        checkedAt: status.checkedAt
      };
    } catch (error) {
      if (error instanceof BinanceVerificationError) throw error;
      throw new BinanceVerificationError("BINANCE_UNAVAILABLE", "Binance Futures account verification is unavailable");
    }
  }
}

function normalizedBinanceError(label: string): BinanceVerificationError {
  const lower = label.toLowerCase();
  if (lower.includes("-2015") || lower.includes("invalid api-key") || lower.includes("signature")) {
    return new BinanceVerificationError("INVALID_CREDENTIALS", "Invalid Binance API key or secret");
  }
  if (lower.includes("permission") || lower.includes("restricted") || lower.includes("futures")) {
    return new BinanceVerificationError("FUTURES_PERMISSION_MISSING", "Binance Futures permission is missing for this API key");
  }
  return new BinanceVerificationError("BINANCE_UNAVAILABLE", "Binance Futures account verification is unavailable");
}
