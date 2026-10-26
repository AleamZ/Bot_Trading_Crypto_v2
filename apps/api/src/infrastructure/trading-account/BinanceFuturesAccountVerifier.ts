import crypto from "node:crypto";
import type { BinanceAccountInfo, BinanceAccountVerifier } from "../../application/trading-account/BinanceAccountVerifier.js";
import { BinanceVerificationError } from "../../application/trading-account/BinanceAccountVerifier.js";
import type { TradingAccountMode } from "../../domain/trading-account/TradingAccount.js";
import { BinanceFuturesAccountClient } from "../execution/BinanceFuturesAccountClient.js";

const LEGACY_FUTURES_TESTNET_URL = "https://testnet.binancefuture.com";
const MAINNET_FUTURES_URL = "https://fapi.binance.com";

export class BinanceFuturesAccountVerifier implements BinanceAccountVerifier {
  constructor(private readonly fetchFn: typeof fetch = fetch) {}

  async verify(input: { mode: TradingAccountMode; apiKey: string; apiSecret: string }): Promise<BinanceAccountInfo> {
    const testnet = input.mode === "DEMO";
    const client = new BinanceFuturesAccountClient(input.apiKey, input.apiSecret, testnet);

    try {
      const status = await client.getWalletStatus();
      if (!status.connected) {
        // -2015 hides three causes; the most common one for DEMO is a key from the legacy Futures
        // Testnet, which demo-fapi does not accept. Probe it so the user gets an actionable message.
        if (testnet && isInvalidKeyLabel(status.label)) {
          if (await this.keyWorksOn(LEGACY_FUTURES_TESTNET_URL, input.apiKey, input.apiSecret)) {
            throw new BinanceVerificationError(
              "INVALID_CREDENTIALS",
              "This API key is from the legacy Futures Testnet (testnet.binancefuture.com). DEMO accounts use Binance Demo Trading: create the key at binance.com > Demo Trading > API Management."
            );
          }
          if (await this.keyWorksOn(MAINNET_FUTURES_URL, input.apiKey, input.apiSecret)) {
            throw new BinanceVerificationError(
              "INVALID_CREDENTIALS",
              "This is a real (Mainnet) Binance API key. DEMO accounts need a Binance Demo Trading key: binance.com > Demo Trading > API Management. Use a REAL account for mainnet keys."
            );
          }
        }
        throw normalizedBinanceError(status.label, testnet);
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

  // Read-only signed balance request: identifies which environment the key belongs to without trading.
  private async keyWorksOn(baseUrl: string, apiKey: string, apiSecret: string): Promise<boolean> {
    try {
      const query = new URLSearchParams({ timestamp: String(Date.now()), recvWindow: "5000" });
      query.set("signature", crypto.createHmac("sha256", apiSecret).update(query.toString()).digest("hex"));
      const response = await this.fetchFn(`${baseUrl}/fapi/v2/balance?${query.toString()}`, { headers: { "X-MBX-APIKEY": apiKey } });
      return response.ok;
    } catch {
      return false;
    }
  }
}

function isInvalidKeyLabel(label: string): boolean {
  const lower = label.toLowerCase();
  return lower.includes("-2015") || lower.includes("invalid api-key");
}

function normalizedBinanceError(label: string, testnet: boolean): BinanceVerificationError {
  const lower = label.toLowerCase();
  if (lower.includes("-1022") || lower.includes("signature")) {
    return new BinanceVerificationError("INVALID_CREDENTIALS", "Binance rejected the request signature (-1022): the API secret does not match this API key");
  }
  if (lower.includes("-2014") || lower.includes("api-key format")) {
    return new BinanceVerificationError("INVALID_CREDENTIALS", "Binance API key format is invalid (-2014): check the key was copied completely");
  }
  if (isInvalidKeyLabel(label)) {
    const environment = testnet ? "Binance Demo Trading (demo-fapi.binance.com)" : "Binance Mainnet";
    return new BinanceVerificationError(
      "INVALID_CREDENTIALS",
      `Binance rejected the API key (-2015) on ${environment}: the key is from another environment, its IP whitelist excludes this server, or Futures is not enabled for it`
    );
  }
  if (lower.includes("permission") || lower.includes("restricted") || lower.includes("futures")) {
    return new BinanceVerificationError("FUTURES_PERMISSION_MISSING", "Binance Futures permission is missing for this API key");
  }
  return new BinanceVerificationError("BINANCE_UNAVAILABLE", "Binance Futures account verification is unavailable");
}
