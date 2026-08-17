import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthService } from "../src/application/auth/AuthService.js";
import { BinanceVerificationError, type BinanceAccountInfo, type BinanceAccountVerifier } from "../src/application/trading-account/BinanceAccountVerifier.js";
import { TradingAccountService } from "../src/application/trading-account/TradingAccountService.js";
import { defaultTradingSettings, type AppConfig } from "../src/application/config/AppConfig.js";
import { createHttpHandler } from "../src/presentation/http/Server.js";
import { MemoryAuthRepository } from "../src/infrastructure/auth/MemoryAuthRepository.js";
import { MemoryTradingRepository } from "../src/infrastructure/persistence/MemoryTradingRepository.js";
import { MemoryTradingAccountRepository } from "../src/infrastructure/trading-account/MemoryTradingAccountRepository.js";
import { MemoryTradingRuntimeConfigRepository } from "../src/infrastructure/trading-account/MemoryTradingRuntimeConfigRepository.js";
import { CredentialCipher } from "../src/infrastructure/security/CredentialCipher.js";
import { TradingRuntimeManager } from "../src/application/runtime/TradingRuntimeManager.js";
import { LockedRealExecutionGateway } from "../src/infrastructure/execution/LockedRealExecutionGateway.js";
import type { TradingEngine } from "../src/application/engine/TradingEngine.js";
import type { DecisionLogger } from "../src/application/ports/Logger.js";
import type { TradingAccountMode } from "../src/domain/trading-account/TradingAccount.js";

const sessionSecret = "test-session-secret-with-at-least-thirty-two-chars";
const encryptionKey = "1111111111111111111111111111111111111111111111111111111111111111";

describe("CredentialCipher", () => {
  it("encrypts and decrypts credentials", () => {
    const cipher = new CredentialCipher(encryptionKey);
    const encrypted = cipher.encrypt("secret-value");
    expect(encrypted).not.toContain("secret-value");
    expect(cipher.decrypt(encrypted)).toBe("secret-value");
  });

  it("rejects tampered ciphertext", () => {
    const cipher = new CredentialCipher(encryptionKey);
    const encrypted = cipher.encrypt("secret-value");
    expect(() => cipher.decrypt(`${encrypted.slice(0, -2)}xx`)).toThrow();
  });
});

describe("Phase 3 execution policy", () => {
  it("locks automatic REAL execution", async () => {
    const gateway = new LockedRealExecutionGateway();
    await expect(gateway.submitBracketOrder({} as never, {} as never)).rejects.toThrow("REAL_EXECUTION_LOCKED");
  });
});

describe("trading account HTTP flow", () => {
  let server: Server;
  let baseUrl: string;
  let accountRepository: MemoryTradingAccountRepository;
  let configRepository: MemoryTradingRuntimeConfigRepository;
  let verifier: MockVerifier;
  let runtimeManager: TradingRuntimeManager;

  beforeEach(async () => {
    accountRepository = new MemoryTradingAccountRepository();
    configRepository = new MemoryTradingRuntimeConfigRepository();
    verifier = new MockVerifier();
    const auth = new AuthService(new MemoryAuthRepository(), sessionSecret);
    const cipher = new CredentialCipher(encryptionKey);
    const tradingAccounts = new TradingAccountService(accountRepository, cipher, verifier, configRepository, testConfig());
    runtimeManager = new TradingRuntimeManager(testConfig(), undefined, accountRepository, configRepository, cipher, new FakeMarketData(), fakeLogger());
    server = createServer(
      createHttpHandler({
        port: 0,
        config: testConfig(),
        engine: fakeEngine(),
        repository: new MemoryTradingRepository(),
        logger: fakeLogger(),
        auth,
        tradingAccounts,
        runtimeManager
      })
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP server address");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  it("requires auth to create accounts", async () => {
    const response = await postJson("/api/trading-accounts", { name: "My Testnet", mode: "DEMO" });
    expect(response.status).toBe(401);
  });

  it("lets a user create and list own accounts", async () => {
    const cookie = await register("a@example.com");
    const created = await postJson("/api/trading-accounts", { name: "My Testnet", mode: "DEMO" }, cookie);
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({ account: { name: "My Testnet", mode: "DEMO", status: "PENDING" } });

    const list = await fetch(`${baseUrl}/api/trading-accounts`, { headers: { cookie } });
    expect(list.status).toBe(200);
    expect((await list.json()).accounts).toHaveLength(1);
  });

  it("does not let user A read user B account", async () => {
    const cookieA = await register("a@example.com");
    const cookieB = await register("b@example.com");
    const accountB = (await (await postJson("/api/trading-accounts", { name: "B", mode: "REAL" }, cookieB)).json()).account;

    const response = await fetch(`${baseUrl}/api/trading-accounts/${accountB.id}`, { headers: { cookie: cookieA } });
    expect(response.status).toBe(404);
  });

  it("does not let user A connect Binance credentials to user B account", async () => {
    const cookieA = await register("a@example.com");
    const cookieB = await register("b@example.com");
    const accountB = (await (await postJson("/api/trading-accounts", { name: "B", mode: "REAL" }, cookieB)).json()).account;

    const response = await putJson(`/api/trading-accounts/${accountB.id}/binance-connection`, credentials(), cookieA);
    expect(response.status).toBe(404);
  });

  it("saves connected credentials encrypted and never returns secrets", async () => {
    const cookie = await register("a@example.com");
    const account = (await (await postJson("/api/trading-accounts", { name: "Demo", mode: "DEMO" }, cookie)).json()).account;
    const response = await putJson(`/api/trading-accounts/${account.id}/binance-connection`, credentials(), cookie);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.connection).toMatchObject({ status: "CONNECTED", apiKeyMasked: "ABCD****WXYZ" });
    expect(JSON.stringify(body)).not.toContain("secret-value");
    expect(JSON.stringify(body)).not.toContain("apiSecret");

    const saved = await accountRepository.findBinanceConnection(account.id);
    expect(saved?.apiKeyEncrypted).not.toContain("ABCD1234WXYZ");
    expect(saved?.apiSecretEncrypted).not.toContain("secret-value");
  });

  it("maps DEMO to Testnet and REAL to Mainnet", async () => {
    const cookie = await register("a@example.com");
    const demo = (await (await postJson("/api/trading-accounts", { name: "Demo", mode: "DEMO" }, cookie)).json()).account;
    const real = (await (await postJson("/api/trading-accounts", { name: "Real", mode: "REAL" }, cookie)).json()).account;

    await putJson(`/api/trading-accounts/${demo.id}/binance-connection`, credentials(), cookie);
    await putJson(`/api/trading-accounts/${real.id}/binance-connection`, credentials(), cookie);

    expect(verifier.calls.map((call) => call.mode)).toEqual(["DEMO", "REAL"]);
    expect((await (await fetch(`${baseUrl}/api/trading-accounts/${demo.id}/binance-account`, { headers: { cookie } })).json()).account.environment).toBe("TESTNET");
    expect((await (await fetch(`${baseUrl}/api/trading-accounts/${real.id}/binance-account`, { headers: { cookie } })).json()).account.environment).toBe("MAINNET");
  });

  it("normalizes invalid credentials, missing futures permission, and unavailable Binance", async () => {
    const cookie = await register("a@example.com");
    const account = (await (await postJson("/api/trading-accounts", { name: "Demo", mode: "DEMO" }, cookie)).json()).account;

    verifier.nextError = new BinanceVerificationError("INVALID_CREDENTIALS", "Invalid Binance API key or secret");
    expect((await postJson(`/api/trading-accounts/${account.id}/binance-connection/test`, credentials(), cookie)).status).toBe(422);

    verifier.nextError = new BinanceVerificationError("FUTURES_PERMISSION_MISSING", "Binance Futures permission is missing for this API key");
    expect((await postJson(`/api/trading-accounts/${account.id}/binance-connection/test`, credentials(), cookie)).status).toBe(422);

    verifier.nextError = new BinanceVerificationError("BINANCE_UNAVAILABLE", "Binance Futures account verification is unavailable");
    expect((await postJson(`/api/trading-accounts/${account.id}/binance-connection/test`, credentials(), cookie)).status).toBe(503);
  });

  it("keeps settings and watchlists isolated by account", async () => {
    const cookieA = await register("a@example.com");
    const cookieB = await register("b@example.com");
    const accountA = (await (await postJson("/api/trading-accounts", { name: "A", mode: "DEMO" }, cookieA)).json()).account;
    const accountB = (await (await postJson("/api/trading-accounts", { name: "B", mode: "DEMO" }, cookieB)).json()).account;

    const settingsA = { ...testConfig(), marginPerTrade: 100, watchlist: ["BTCUSDT"] };
    const settingsB = { ...testConfig(), marginPerTrade: 300, watchlist: ["ETHUSDT"] };
    expect((await putJson(`/api/trading-accounts/${accountA.id}/settings`, settingsA, cookieA)).status).toBe(200);
    expect((await putJson(`/api/trading-accounts/${accountB.id}/settings`, settingsB, cookieB)).status).toBe(200);

    expect((await (await fetch(`${baseUrl}/api/trading-accounts/${accountA.id}/settings`, { headers: { cookie: cookieA } })).json()).marginPerTrade).toBe(100);
    expect((await (await fetch(`${baseUrl}/api/trading-accounts/${accountB.id}/watchlist`, { headers: { cookie: cookieB } })).json()).watchlist).toEqual(["ETHUSDT"]);
    expect((await putJson(`/api/trading-accounts/${accountB.id}/settings`, settingsA, cookieA)).status).toBe(404);
  });

  it("keeps settings isolated between accounts owned by the same user", async () => {
    const cookie = await register("a@example.com");
    const accountA = (await (await postJson("/api/trading-accounts", { name: "TC bot", mode: "DEMO" }, cookie)).json()).account;
    const accountB = (await (await postJson("/api/trading-accounts", { name: "test2", mode: "DEMO" }, cookie)).json()).account;

    const settingsA = { ...testConfig(), marginPerTrade: 10000, leverage: 100, watchlist: ["BTCUSDT"] };
    const settingsB = { ...testConfig(), marginPerTrade: 200, leverage: 5, watchlist: ["ETHUSDT"] };
    expect((await putJson(`/api/trading-accounts/${accountA.id}/settings`, settingsA, cookie)).status).toBe(200);
    expect((await putJson(`/api/trading-accounts/${accountB.id}/settings`, settingsB, cookie)).status).toBe(200);

    const loadedA = await (await fetch(`${baseUrl}/api/trading-accounts/${accountA.id}/settings`, { headers: { cookie } })).json();
    const loadedB = await (await fetch(`${baseUrl}/api/trading-accounts/${accountB.id}/settings`, { headers: { cookie } })).json();
    expect(loadedA.marginPerTrade).toBe(10000);
    expect(loadedA.leverage).toBe(100);
    expect(loadedB.marginPerTrade).toBe(200);
    expect(loadedB.leverage).toBe(5);

    expect((await putJson(`/api/trading-accounts/${accountB.id}/settings`, { ...settingsB, marginPerTrade: 333, leverage: 3 }, cookie)).status).toBe(200);
    const reloadedA = await (await fetch(`${baseUrl}/api/trading-accounts/${accountA.id}/settings`, { headers: { cookie } })).json();
    const reloadedB = await (await fetch(`${baseUrl}/api/trading-accounts/${accountB.id}/settings`, { headers: { cookie } })).json();
    expect(reloadedA.marginPerTrade).toBe(10000);
    expect(reloadedA.leverage).toBe(100);
    expect(reloadedB.marginPerTrade).toBe(333);
    expect(reloadedB.leverage).toBe(3);
  });

  it("does not share engine instances for the same symbol across accounts", async () => {
    const cookieA = await register("a@example.com");
    const cookieB = await register("b@example.com");
    const accountA = (await (await postJson("/api/trading-accounts", { name: "A", mode: "DEMO" }, cookieA)).json()).account;
    const accountB = (await (await postJson("/api/trading-accounts", { name: "B", mode: "DEMO" }, cookieB)).json()).account;
    await putJson(`/api/trading-accounts/${accountA.id}/settings`, { ...testConfig(), watchlist: ["BTCUSDT"] }, cookieA);
    await putJson(`/api/trading-accounts/${accountB.id}/settings`, { ...testConfig(), watchlist: ["BTCUSDT"] }, cookieB);

    await runtimeManager.ensureRuntime(accountA.id);
    await runtimeManager.ensureRuntime(accountB.id);

    expect(runtimeManager.getEngineForTest(accountA.id, "BTCUSDT")).toBeTruthy();
    expect(runtimeManager.getEngineForTest(accountA.id, "BTCUSDT")).not.toBe(runtimeManager.getEngineForTest(accountB.id, "BTCUSDT"));
  });

  async function register(email: string): Promise<string> {
    const response = await postJson("/api/auth/register", { email, password: "password123" });
    const cookie = response.headers.get("set-cookie");
    if (!cookie) throw new Error("Expected cookie");
    return cookie;
  }

  function postJson(path: string, body: unknown, cookie?: string): Promise<Response> {
    return fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
      body: JSON.stringify(body)
    });
  }

  function putJson(path: string, body: unknown, cookie: string): Promise<Response> {
    return fetch(`${baseUrl}${path}`, {
      method: "PUT",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify(body)
    });
  }
});

class MockVerifier implements BinanceAccountVerifier {
  calls: Array<{ mode: TradingAccountMode; apiKey: string }> = [];
  nextError: Error | null = null;

  async verify(input: { mode: TradingAccountMode; apiKey: string; apiSecret: string }): Promise<BinanceAccountInfo> {
    this.calls.push({ mode: input.mode, apiKey: input.apiKey });
    if (this.nextError) {
      const error = this.nextError;
      this.nextError = null;
      throw error;
    }
    return {
      environment: input.mode === "DEMO" ? "TESTNET" : "MAINNET",
      connected: true,
      walletBalance: 5000,
      availableBalance: 4900,
      currency: "USDT",
      checkedAt: "2026-08-17T00:00:00.000Z"
    };
  }
}

class FakeMarketData {
  async getClosedCandles(symbol: string, timeframe: "H1" | "M5", limit: number) {
    return [];
  }
}

function credentials(): { apiKey: string; apiSecret: string } {
  return { apiKey: "ABCD1234WXYZ", apiSecret: "secret-value" };
}

function testConfig(): AppConfig {
  return {
    ...defaultTradingSettings,
    port: 8787,
    executionMode: "paper",
    logLevel: "info",
    corsOrigins: ["http://localhost:5173"],
    databaseUrl: undefined,
    sessionSecret,
    binanceCredentialEncryptionKey: encryptionKey,
    binanceApiKey: undefined,
    binanceApiSecret: undefined,
    binanceTestnet: true
  };
}

function fakeEngine(): TradingEngine {
  return {
    getDashboardState: () => ({
      setupState: "WaitingTrend",
      trend: "neutral",
      balance: 10_000,
      candleCounts: { H1: 0, M5: 0 },
      pendingSetup: null,
      activeRisk: null
    })
  } as unknown as TradingEngine;
}

function fakeLogger(): DecisionLogger {
  return {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined
  };
}
