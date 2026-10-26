import { afterEach, describe, expect, it, vi } from "vitest";
import { BinanceFuturesAccountVerifier } from "../src/infrastructure/trading-account/BinanceFuturesAccountVerifier.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("BinanceFuturesAccountVerifier error diagnosis", () => {
  it("tells the user when a DEMO key belongs to the legacy Futures Testnet", async () => {
    stubBinance({ demo: rejected(401, -2015, "Invalid API-key, IP, or permissions for action."), legacyOk: true });

    await expect(verify()).rejects.toThrow("legacy Futures Testnet");
  });

  it("tells the user when a DEMO account was given a mainnet key", async () => {
    stubBinance({ demo: rejected(401, -2015, "Invalid API-key, IP, or permissions for action."), legacyOk: false, mainnetOk: true });

    await expect(verify()).rejects.toThrow("real (Mainnet) Binance API key");
  });

  it("explains the -2015 causes when the key works nowhere", async () => {
    stubBinance({ demo: rejected(401, -2015, "Invalid API-key, IP, or permissions for action."), legacyOk: false });

    await expect(verify()).rejects.toThrow("IP whitelist");
  });

  it("reports a secret that does not match the key (-1022)", async () => {
    stubBinance({ demo: rejected(400, -1022, "Signature for this request is not valid."), legacyOk: false });

    await expect(verify()).rejects.toThrow("API secret does not match");
  });
});

function verify() {
  return new BinanceFuturesAccountVerifier().verify({ mode: "DEMO", apiKey: "k".repeat(64), apiSecret: "s".repeat(64) });
}

function rejected(status: number, code: number, msg: string): Response {
  return new Response(JSON.stringify({ code, msg }), { status, headers: { "content-type": "application/json" } });
}

function stubBinance(options: { demo: Response; legacyOk: boolean; mainnetOk?: boolean }): void {
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => {
    const url = String(input);
    if (url.startsWith("https://fapi.binance.com")) return new Response(options.mainnetOk ? "[]" : '{"code":-2015}', { status: options.mainnetOk ? 200 : 401 });
    if (url.startsWith("https://testnet.binancefuture.com")) return new Response(options.legacyOk ? "[]" : '{"code":-2015}', { status: options.legacyOk ? 200 : 401 });
    return options.demo.clone();
  }));
}
