import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthService } from "../src/application/auth/AuthService.js";
import { BinanceVerificationError, type BinanceAccountInfo, type BinanceAccountVerifier } from "../src/application/trading-account/BinanceAccountVerifier.js";
import { TradingAccountService } from "../src/application/trading-account/TradingAccountService.js";
import { defaultTradingSettings, validateTradingSettings, type AppConfig } from "../src/application/config/AppConfig.js";
import { createHttpHandler } from "../src/presentation/http/Server.js";
import { MemoryAuthRepository } from "../src/infrastructure/auth/MemoryAuthRepository.js";
import { MemoryTradingRepository } from "../src/infrastructure/persistence/MemoryTradingRepository.js";
import { MemoryTradingAccountRepository } from "../src/infrastructure/trading-account/MemoryTradingAccountRepository.js";
import { MemoryTradingRuntimeConfigRepository } from "../src/infrastructure/trading-account/MemoryTradingRuntimeConfigRepository.js";
import { MemoryExecutionIntentRepository } from "../src/infrastructure/execution/MemoryExecutionIntentRepository.js";
import { MemoryRealExecutionProposalRepository } from "../src/infrastructure/execution/MemoryRealExecutionProposalRepository.js";
import { BinanceFuturesAccountClient, type BinanceFuturesOpenOrderStatus, type BinanceFuturesPositionStatus } from "../src/infrastructure/execution/BinanceFuturesAccountClient.js";
import { fingerprintProposal, type CreateRealExecutionProposalInput } from "../src/application/execution/RealExecutionProposal.js";
import { CredentialCipher } from "../src/infrastructure/security/CredentialCipher.js";
import { TradingRuntimeManager } from "../src/application/runtime/TradingRuntimeManager.js";
import { LockedRealExecutionGateway } from "../src/infrastructure/execution/LockedRealExecutionGateway.js";
import type { TradingEngine } from "../src/application/engine/TradingEngine.js";
import type { DecisionLogger } from "../src/application/ports/Logger.js";
import type { TradingAccountMode } from "../src/domain/trading-account/TradingAccount.js";
import type { FuturesSymbolRules } from "../src/domain/symbol/SymbolRules.js";

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

describe("Binance signed account source routing", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("routes DEMO signed account reads to demo-fapi and REAL reads to fapi", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      urls.push(String(input));
      return new Response(JSON.stringify([]), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    await new BinanceFuturesAccountClient("DEMO_KEY", "DEMO_SECRET", true).getOpenOrders("BTCUSDT");
    await new BinanceFuturesAccountClient("REAL_KEY", "REAL_SECRET", false).getOpenOrders("BTCUSDT");

    expect(urls.some((url) => url.includes("https://demo-fapi.binance.com/fapi/v1/openOrders"))).toBe(true);
    expect(urls.some((url) => url.includes("https://demo-fapi.binance.com/fapi/v1/openAlgoOrders"))).toBe(true);
    expect(urls.some((url) => url.includes("https://fapi.binance.com/fapi/v1/openOrders"))).toBe(true);
    expect(urls.some((url) => url.includes("https://fapi.binance.com/fapi/v1/openAlgoOrders"))).toBe(true);
  });

  it("fails closed when open algo orders cannot be read", async () => {
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/fapi/v1/openAlgoOrders")) return new Response('{"code":-1021,"msg":"Timestamp outside recvWindow"}', { status: 400 });
      return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    await expect(new BinanceFuturesAccountClient("DEMO_KEY", "DEMO_SECRET", true).getOpenOrders("LTCUSDT")).rejects.toThrow("-1021");
  });
});

describe("DEMO and REAL settings schema/UI parity", () => {
  it("normalizes DEMO and REAL settings through the same supported schema and validation", () => {
    const demoSettings = validateTradingSettings({
      ...defaultTradingSettings,
      riskPerTradeUsdt: 11,
      maxLeverage: 30,
      marginMode: "CROSS",
      watchlist: ["BTCUSDT"]
    });
    const realSettings = validateTradingSettings({
      ...defaultTradingSettings,
      riskPerTradeUsdt: 22,
      maxLeverage: 40,
      marginMode: "ISOLATED",
      positionSizingMode: "fixed-margin",
      marginPerTrade: 500,
      leverage: 12,
      fixedRr: 9,
      fvgMitigation: "full",
      ltfFvgEntryMode: "edge",
      localTradingRuntimeEnabled: true,
      watchlist: ["ethusdt", "ETHUSDT"]
    } as never);

    expect(supportedSettingKeys(demoSettings)).toEqual(supportedSettingKeys(realSettings));
    expect(demoSettings).toMatchObject({ riskPerTradeUsdt: 11, maxLeverage: 30, marginMode: "CROSS", watchlist: ["BTCUSDT"] });
    expect(realSettings).toMatchObject({ riskPerTradeUsdt: 22, maxLeverage: 40, marginMode: "ISOLATED", positionSizingMode: "risk-based", watchlist: ["ETHUSDT"] });
    expect(realSettings).not.toHaveProperty("marginPerTrade");
    expect(realSettings).not.toHaveProperty("leverage");
    expect(realSettings).not.toHaveProperty("fixedRr");
    expect(realSettings).not.toHaveProperty("fvgMitigation");
    expect(realSettings).not.toHaveProperty("ltfFvgEntryMode");
    expect(realSettings).not.toHaveProperty("localTradingRuntimeEnabled");

    const invalidDrafts = [
      { maxPositionPerSymbol: 2 },
      { tradingEnabled: true, watchlist: [] },
      { maxLeverage: 0 },
      { marginMode: "PORTFOLIO" }
    ];
    for (const draft of invalidDrafts) {
      expect(() => validateTradingSettings({ ...defaultTradingSettings, ...draft })).toThrow();
      expect(() => validateTradingSettings({ ...defaultTradingSettings, ...draft, realExecutionMode: "LOCKED" })).toThrow();
    }
  });

  it("renders the same normal settings fields while keeping REAL-only safety separate", () => {
    const html = readFileSync(new URL("../../web/index.html", import.meta.url), "utf8");
    const app = readFileSync(new URL("../../web/app.js", import.meta.url), "utf8");
    const normalInputIds = [
      "setting-symbol-search",
      "setting-risk-per-trade",
      "setting-max-leverage",
      "setting-max-margin-usage",
      "setting-liquidation-safety-buffer",
      "setting-max-open-positions",
      "setting-max-position-per-symbol",
      "setting-ema-period",
      "setting-swing-left",
      "setting-swing-right",
      "setting-displacement-body",
      "setting-displacement-lookback",
      "setting-minimum-rr",
      "setting-sl-buffer-ticks",
      "setting-sl-buffer-percent",
      "setting-sl-atr-period",
      "setting-sl-atr-multiplier",
      "setting-daily-profit-limit-r",
      "setting-daily-loss-limit-r",
      "setting-max-drawdown"
    ];
    const normalSegmentGroups = [
      "marginMode",
      "requireDisplacement",
      "entryMode",
      "stopLossBufferMode",
      "tradingEnabled",
      "killSwitch"
    ];

    for (const id of normalInputIds) expect(html).toContain(`id="${id}"`);
    for (const group of normalSegmentGroups) expect(html).toContain(`data-setting-group="${group}"`);
    expect(app).toContain('marginMode: "ISOLATED"');
    expect(app).toContain("marginMode: String(settings.marginMode ?? defaultSettings.marginMode)");
    expect(app).toContain("marginMode: settingsState.marginMode");
    expect(app).toContain("Actual Risk");
    expect(app).toContain("Stop Loss");
    expect(app).toContain("Safety Buffer");
    expect(app).toContain("CROSS_MARGIN_LIQUIDATION_SAFETY_UNSUPPORTED");
    expect(app).toContain("Cross-margin liquidation safety is not supported for automated execution because account-wide cross collateral exposure is not fully modeled");

    expect(html).toContain('id="real-execution-safety" hidden');
    expect(html).toContain('id="real-execution-mode-control"');
    expect(html).toContain("data-real-execution-mode=\"LOCKED\"");
    expect(app).toContain('const isReal = accountState.activeAccount?.mode === "REAL";');
    expect(app).toContain('$("real-execution-safety").hidden = !isReal;');
    expect(app).toContain('$("real-proposals-section").hidden = !isReal;');
    expect(app).toContain('if (!account || account.mode !== "REAL") return;');
  });
});

describe("trading account HTTP flow", () => {
  let server: Server;
  let baseUrl: string;
  let accountRepository: MemoryTradingAccountRepository;
  let configRepository: MemoryTradingRuntimeConfigRepository;
  let executionIntentRepository: MemoryExecutionIntentRepository;
  let realProposalRepository: MemoryRealExecutionProposalRepository;
  let verifier: MockVerifier;
  let runtimeManager: TradingRuntimeManager;
  let accountClientFactoryCalls: Array<{ apiKey: string; apiSecret: string; testnet: boolean }>;

  beforeEach(async () => {
    accountRepository = new MemoryTradingAccountRepository();
    configRepository = new MemoryTradingRuntimeConfigRepository();
    executionIntentRepository = new MemoryExecutionIntentRepository();
    realProposalRepository = new MemoryRealExecutionProposalRepository();
    verifier = new MockVerifier();
    accountClientFactoryCalls = [];
    FakeAccountClient.nextLeverage = 20;
    FakeAccountClient.nextMarginType = "ISOLATED";
    FakeAccountClient.positionsByApiKey.clear();
    FakeAccountClient.openOrdersByApiKey.clear();
    FakeAccountClient.walletBalanceByApiKey.clear();
    FakeAccountClient.maxLeverageBySymbol.clear();
    const auth = new AuthService(new MemoryAuthRepository(), sessionSecret);
    const cipher = new CredentialCipher(encryptionKey);
    const tradingAccounts = new TradingAccountService(accountRepository, cipher, verifier, configRepository, testConfig());
    runtimeManager = new TradingRuntimeManager(
      testConfig(),
      undefined,
      accountRepository,
      configRepository,
      executionIntentRepository,
      cipher,
      new FakeMarketData(),
      fakeLogger(),
      (apiKey, apiSecret, testnet) => {
        accountClientFactoryCalls.push({ apiKey, apiSecret, testnet });
        return new FakeAccountClient(apiKey, testnet);
      },
      new FakeSymbolMetadataService(),
      realProposalRepository,
      () => new FakeMarketData() as never
    );
    server = createServer(
      createHttpHandler({
        port: 0,
        config: testConfig(),
        engine: fakeEngine(),
        repository: new MemoryTradingRepository(),
        logger: fakeLogger(),
        auth,
        tradingAccounts,
        runtimeManager,
        marketData: new FakeMarketData() as never
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

  it("permanently deletes an inactive DEMO account and account-scoped data", async () => {
    const cookie = await register("delete-demo@example.com");
    const account = (await (await postJson("/api/trading-accounts", { name: "Demo Delete", mode: "DEMO" }, cookie)).json()).account;
    await putJson(`/api/trading-accounts/${account.id}/settings`, { ...testConfig(), riskPerTradeUsdt: 333, watchlist: ["ETHUSDT"] }, cookie);
    await putJson(`/api/trading-accounts/${account.id}/binance-connection`, { apiKey: "DELETE_DEMO_KEY", apiSecret: "DELETE_SECRET" }, cookie);
    await runtimeManager.ensureRuntime(account.id);

    const response = await fetch(`${baseUrl}/api/trading-accounts/${account.id}`, { method: "DELETE", headers: { cookie } });

    expect(response.status).toBe(204);
    expect(await accountRepository.findTradingAccountById(account.id)).toBeNull();
    expect(await accountRepository.findBinanceConnection(account.id)).toBeNull();
    expect(await configRepository.getSettings(account.id)).toBeNull();
    expect(await configRepository.getWatchlist(account.id)).toEqual([]);
    expect(await executionIntentRepository.listByAccount(account.id)).toEqual([]);
    expect(runtimeManager.getEngineForTest(account.id, "ETHUSDT")).toBeNull();
    expect((await fetch(`${baseUrl}/api/trading-accounts/${account.id}/settings`, { headers: { cookie } })).status).toBe(404);
    await expect(runtimeManager.ensureRuntime(account.id)).rejects.toThrow("ACCOUNT_NOT_FOUND");
  });

  it("permanently deletes an inactive REAL account without unlocking execution", async () => {
    const cookie = await register("delete-real@example.com");
    const account = (await (await postJson("/api/trading-accounts", { name: "Real Delete", mode: "REAL" }, cookie)).json()).account;
    await putJson(`/api/trading-accounts/${account.id}/binance-connection`, { apiKey: "DELETE_REAL_KEY", apiSecret: "DELETE_SECRET" }, cookie);
    await seedProposal(account.id, "delete-real");

    const response = await fetch(`${baseUrl}/api/trading-accounts/${account.id}`, { method: "DELETE", headers: { cookie } });

    expect(response.status).toBe(204);
    expect(await accountRepository.findTradingAccountById(account.id)).toBeNull();
    expect(await accountRepository.findBinanceConnection(account.id)).toBeNull();
    expect(await realProposalRepository.listByAccount(account.id)).toEqual([]);
  });

  it("returns 404 when deleting another user's or nonexistent trading account", async () => {
    const cookieA = await register("delete-a@example.com");
    const cookieB = await register("delete-b@example.com");
    const accountB = (await (await postJson("/api/trading-accounts", { name: "B", mode: "DEMO" }, cookieB)).json()).account;

    expect((await fetch(`${baseUrl}/api/trading-accounts/${accountB.id}`, { method: "DELETE", headers: { cookie: cookieA } })).status).toBe(404);
    expect((await fetch(`${baseUrl}/api/trading-accounts/00000000-0000-4000-8000-000000000000`, { method: "DELETE", headers: { cookie: cookieA } })).status).toBe(404);
    expect(await accountRepository.findTradingAccountById(accountB.id)).toBeTruthy();
  });

  it("blocks deletion when Binance has an active position", async () => {
    const cookie = await register("delete-position@example.com");
    const account = (await (await postJson("/api/trading-accounts", { name: "Position", mode: "DEMO" }, cookie)).json()).account;
    await putJson(`/api/trading-accounts/${account.id}/binance-connection`, { apiKey: "POSITION_DELETE_KEY", apiSecret: "DELETE_SECRET" }, cookie);
    FakeAccountClient.positionsByApiKey.set("POSITION_DELETE_KEY", [fakePosition("BTCUSDT", "long")]);

    const response = await fetch(`${baseUrl}/api/trading-accounts/${account.id}`, { method: "DELETE", headers: { cookie } });
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.code).toBe("ACCOUNT_HAS_ACTIVE_TRADING_STATE");
    expect(await accountRepository.findTradingAccountById(account.id)).toBeTruthy();
  });

  it("blocks deletion when Binance has a bot-owned open order", async () => {
    const cookie = await register("delete-order@example.com");
    const account = (await (await postJson("/api/trading-accounts", { name: "Order", mode: "DEMO" }, cookie)).json()).account;
    await putJson(`/api/trading-accounts/${account.id}/binance-connection`, { apiKey: "ORDER_DELETE_KEY", apiSecret: "DELETE_SECRET" }, cookie);
    FakeAccountClient.openOrdersByApiKey.set("ORDER_DELETE_KEY", [fakeOpenOrder("BTCUSDT", "smc_existing_E")]);

    const response = await fetch(`${baseUrl}/api/trading-accounts/${account.id}`, { method: "DELETE", headers: { cookie } });
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.code).toBe("ACCOUNT_HAS_ACTIVE_TRADING_STATE");
    expect(await accountRepository.findTradingAccountById(account.id)).toBeTruthy();
  });

  it("blocks deletion when an execution intent is unsafe", async () => {
    const cookie = await register("delete-intent@example.com");
    const account = (await (await postJson("/api/trading-accounts", { name: "Intent", mode: "DEMO" }, cookie)).json()).account;
    await seedExecutionIntent(account.id);

    const response = await fetch(`${baseUrl}/api/trading-accounts/${account.id}`, { method: "DELETE", headers: { cookie } });
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.code).toBe("ACCOUNT_HAS_ACTIVE_TRADING_STATE");
    expect((await executionIntentRepository.listByAccount(account.id)).length).toBe(1);
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

  it("recovers stale trading account ERROR status after successful Binance account auth", async () => {
    const cookie = await register("stale-status@example.com");
    const account = (await (await postJson("/api/trading-accounts", { name: "Demo", mode: "DEMO" }, cookie)).json()).account;
    await putJson(`/api/trading-accounts/${account.id}/binance-connection`, credentials(), cookie);
    await accountRepository.updateTradingAccountStatus(account.id, "ERROR", new Date().toISOString());

    const response = await fetch(`${baseUrl}/api/trading-accounts/${account.id}/binance-account`, { headers: { cookie } });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.account.connected).toBe(true);
    expect((await accountRepository.findTradingAccountById(account.id))?.status).toBe("CONNECTED");
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

  it("reports account-scoped market-data environment without inheriting global BINANCE_TESTNET", async () => {
    const cookie = await register("market-env@example.com");
    const demo = (await (await postJson("/api/trading-accounts", { name: "Demo", mode: "DEMO" }, cookie)).json()).account;
    const real = (await (await postJson("/api/trading-accounts", { name: "Real", mode: "REAL" }, cookie)).json()).account;
    await putJson(`/api/trading-accounts/${demo.id}/binance-connection`, { apiKey: "DEMO_MARKET_KEY", apiSecret: "DEMO_SECRET" }, cookie);
    await putJson(`/api/trading-accounts/${real.id}/binance-connection`, { apiKey: "REAL_MARKET_KEY", apiSecret: "REAL_SECRET" }, cookie);

    const demoSnapshot = await (await fetch(`${baseUrl}/api/trading-accounts/${demo.id}/snapshot`, { headers: { cookie } })).json();
    const realSnapshot = await (await fetch(`${baseUrl}/api/trading-accounts/${real.id}/snapshot`, { headers: { cookie } })).json();

    expect(testConfig().binanceTestnet).toBe(true);
    expect(demoSnapshot.runtime.marketData).toMatchObject({
      environment: "TESTNET",
      label: "Binance Futures Testnet market data"
    });
    expect(realSnapshot.runtime.marketData).toMatchObject({
      environment: "MAINNET",
      label: "Binance Futures Mainnet market data"
    });
    expect(accountClientFactoryCalls).toContainEqual({ apiKey: "DEMO_MARKET_KEY", apiSecret: "DEMO_SECRET", testnet: true });
    expect(accountClientFactoryCalls).toContainEqual({ apiKey: "REAL_MARKET_KEY", apiSecret: "REAL_SECRET", testnet: false });
  });

  it("reports REAL readiness while execution remains locked and never returns secrets", async () => {
    const cookie = await register("real-ready@example.com");
    const account = (await (await postJson("/api/trading-accounts", { name: "Real", mode: "REAL" }, cookie)).json()).account;
    await putJson(`/api/trading-accounts/${account.id}/binance-connection`, credentials(), cookie);
    await putJson(`/api/trading-accounts/${account.id}/settings`, { ...testConfig(), tradingEnabled: true, killSwitch: false, maxLeverage: 20, marginMode: "ISOLATED", watchlist: ["BTCUSDT"] }, cookie);

    const response = await fetch(`${baseUrl}/api/trading-accounts/${account.id}/readiness?symbol=BTCUSDT`, { headers: { cookie } });
    expect(response.status).toBe(200);
    const bodyText = await response.text();
    const body = JSON.parse(bodyText);

    expect(body.readiness).toMatchObject({
      accountReady: true,
      accountOperationalReady: true,
      mode: "REAL",
      executionLocked: true,
      executionReason: "REAL_EXECUTION_LOCKED",
      realExecutionPermission: { locked: true, reason: "REAL_EXECUTION_LOCKED" },
      checks: { realExecutionLocked: { ok: false, reason: "REAL_EXECUTION_LOCKED" } }
    });
    expect(bodyText).not.toContain("secret-value");
    expect(bodyText).not.toContain("apiSecret");
    expect(accountClientFactoryCalls).toContainEqual({ apiKey: "ABCD1234WXYZ", apiSecret: "secret-value", testnet: false });
  });

  it("reports REAL leverage as diagnostic and margin mode mismatch as an operational blocker", async () => {
    FakeAccountClient.nextLeverage = 10;
    FakeAccountClient.nextMarginType = "CROSS";
    const cookie = await register("real-mismatch@example.com");
    const account = (await (await postJson("/api/trading-accounts", { name: "Real", mode: "REAL" }, cookie)).json()).account;
    await putJson(`/api/trading-accounts/${account.id}/binance-connection`, credentials(), cookie);
    await putJson(`/api/trading-accounts/${account.id}/settings`, { ...testConfig(), tradingEnabled: true, killSwitch: false, maxLeverage: 20, marginMode: "ISOLATED", watchlist: ["BTCUSDT"] }, cookie);

    const body = await (await fetch(`${baseUrl}/api/trading-accounts/${account.id}/readiness?symbol=BTCUSDT`, { headers: { cookie } })).json();

    expect(body.readiness).toMatchObject({
      accountReady: false,
      accountOperationalReady: false,
      binanceLeverage: 10,
      leverageMatch: false,
      binanceMarginMode: "CROSS",
      marginModeMatch: false
    });
    expect(body.readiness.checks.leverageValid).toEqual({ ok: true, reason: null });
    expect(body.readiness.checks.marginModeKnown.reason).toBe("MARGIN_MODE_MISMATCH");
  });

  it("allows REAL operational readiness when only current Binance leverage differs from dynamic bot leverage", async () => {
    FakeAccountClient.nextLeverage = 10;
    FakeAccountClient.nextMarginType = "ISOLATED";
    const cookie = await register("real-dynamic-leverage@example.com");
    const account = (await (await postJson("/api/trading-accounts", { name: "Real", mode: "REAL" }, cookie)).json()).account;
    await putJson(`/api/trading-accounts/${account.id}/binance-connection`, credentials(), cookie);
    await putJson(`/api/trading-accounts/${account.id}/settings`, { ...testConfig(), tradingEnabled: true, killSwitch: false, maxLeverage: 20, marginMode: "ISOLATED", watchlist: ["BTCUSDT"] }, cookie);

    const body = await (await fetch(`${baseUrl}/api/trading-accounts/${account.id}/readiness?symbol=BTCUSDT`, { headers: { cookie } })).json();

    expect(body.readiness).toMatchObject({
      accountReady: true,
      accountOperationalReady: true,
      executionLocked: true,
      executionReason: "REAL_EXECUTION_LOCKED",
      binanceLeverage: 10,
      configuredLeverage: 20,
      symbolMaxLeverage: 125,
      effectiveMaxLeverage: 20,
      leverageMatch: false,
      marginModeMatch: true,
      realExecutionPermission: { locked: true, reason: "REAL_EXECUTION_LOCKED" }
    });
    expect(body.readiness.checks.leverageValid).toEqual({ ok: true, reason: null });
    expect(body.readiness.checks.realExecutionLocked).toEqual({ ok: false, reason: "REAL_EXECUTION_LOCKED" });
  });

  it("uses symbol effective max leverage without turning lower symbol max into a global REAL readiness failure", async () => {
    FakeAccountClient.nextLeverage = 10;
    FakeAccountClient.nextMarginType = "CROSS";
    FakeAccountClient.maxLeverageBySymbol.set("BNBUSDT", 75);
    FakeAccountClient.maxLeverageBySymbol.set("BTCUSDT", 125);
    const cookie = await register("real-effective-leverage@example.com");
    const account = (await (await postJson("/api/trading-accounts", { name: "Real", mode: "REAL" }, cookie)).json()).account;
    await putJson(`/api/trading-accounts/${account.id}/binance-connection`, credentials(), cookie);
    await putJson(`/api/trading-accounts/${account.id}/settings`, { ...testConfig(), tradingEnabled: true, killSwitch: false, maxLeverage: 125, marginMode: "CROSS", watchlist: ["BNBUSDT", "BTCUSDT"] }, cookie);

    const bnb = await (await fetch(`${baseUrl}/api/trading-accounts/${account.id}/readiness?symbol=BNBUSDT`, { headers: { cookie } })).json();
    const btc = await (await fetch(`${baseUrl}/api/trading-accounts/${account.id}/readiness?symbol=BTCUSDT`, { headers: { cookie } })).json();

    expect(bnb.readiness).toMatchObject({
      accountOperationalReady: true,
      configuredLeverage: 125,
      symbolMaxLeverage: 75,
      effectiveMaxLeverage: 75
    });
    expect(bnb.readiness.checks.leverageValid).toEqual({ ok: true, reason: null });
    expect(btc.readiness).toMatchObject({
      accountOperationalReady: true,
      configuredLeverage: 125,
      symbolMaxLeverage: 125,
      effectiveMaxLeverage: 125
    });
    expect(btc.readiness.checks.leverageValid).toEqual({ ok: true, reason: null });
  });

  it("keeps zero REAL balance not ready even when symbol configuration is otherwise valid", async () => {
    FakeAccountClient.nextLeverage = 10;
    FakeAccountClient.nextMarginType = "CROSS";
    FakeAccountClient.walletBalanceByApiKey.set("ZERO_REAL_KEY", 0);
    const cookie = await register("real-zero-balance@example.com");
    const account = (await (await postJson("/api/trading-accounts", { name: "Real", mode: "REAL" }, cookie)).json()).account;
    await putJson(`/api/trading-accounts/${account.id}/binance-connection`, { apiKey: "ZERO_REAL_KEY", apiSecret: "ZERO_SECRET" }, cookie);
    await putJson(`/api/trading-accounts/${account.id}/settings`, { ...testConfig(), tradingEnabled: true, killSwitch: false, marginMode: "CROSS", watchlist: ["BTCUSDT"] }, cookie);

    const body = await (await fetch(`${baseUrl}/api/trading-accounts/${account.id}/readiness?symbol=BTCUSDT`, { headers: { cookie } })).json();

    expect(body.readiness.accountOperationalReady).toBe(false);
    expect(body.readiness.checks.balanceAvailable).toEqual({ ok: false, reason: "INSUFFICIENT_AVAILABLE_BALANCE" });
    expect(body.readiness.checks.realExecutionLocked).toEqual({ ok: false, reason: "REAL_EXECUTION_LOCKED" });
  });

  it("keeps two REAL readiness checks isolated on the same symbol", async () => {
    const cookie = await register("two-real@example.com");
    const accountA = (await (await postJson("/api/trading-accounts", { name: "Real A", mode: "REAL" }, cookie)).json()).account;
    const accountB = (await (await postJson("/api/trading-accounts", { name: "Real B", mode: "REAL" }, cookie)).json()).account;
    await putJson(`/api/trading-accounts/${accountA.id}/binance-connection`, { apiKey: "ACCOUNT_A_KEY", apiSecret: "ACCOUNT_A_SECRET" }, cookie);
    await putJson(`/api/trading-accounts/${accountB.id}/binance-connection`, { apiKey: "ACCOUNT_B_KEY", apiSecret: "ACCOUNT_B_SECRET" }, cookie);

    await fetch(`${baseUrl}/api/trading-accounts/${accountA.id}/symbol-rules?symbol=BTCUSDT`, { headers: { cookie } });
    await fetch(`${baseUrl}/api/trading-accounts/${accountB.id}/readiness?symbol=BTCUSDT`, { headers: { cookie } });

    expect(accountClientFactoryCalls).toContainEqual({ apiKey: "ACCOUNT_A_KEY", apiSecret: "ACCOUNT_A_SECRET", testnet: false });
    expect(accountClientFactoryCalls).toContainEqual({ apiKey: "ACCOUNT_B_KEY", apiSecret: "ACCOUNT_B_SECRET", testnet: false });
  });

  it("keeps REAL execution proposals account-scoped and approval auditable", async () => {
    const cookieA = await register("proposal-a@example.com");
    const cookieB = await register("proposal-b@example.com");
    const accountA = (await (await postJson("/api/trading-accounts", { name: "Real A", mode: "REAL" }, cookieA)).json()).account;
    const accountB = (await (await postJson("/api/trading-accounts", { name: "Real B", mode: "REAL" }, cookieB)).json()).account;
    const proposalA = await seedProposal(accountA.id, "setup-a");
    const proposalB = await seedProposal(accountB.id, "setup-b");

    const readBFromA = await fetch(`${baseUrl}/api/trading-accounts/${accountB.id}/execution-proposals/${proposalB.id}`, { headers: { cookie: cookieA } });
    expect(readBFromA.status).toBe(404);

    const approveA = await fetch(`${baseUrl}/api/trading-accounts/${accountA.id}/execution-proposals/${proposalA.id}/approve`, { method: "POST", headers: { cookie: cookieA } });
    expect(approveA.status).toBe(200);
    const approved = (await approveA.json()).proposal;
    expect(approved.status).toBe("APPROVED");
    expect(approved.approvedByUserId).toBeTruthy();

    const accountBProposals = await (await fetch(`${baseUrl}/api/trading-accounts/${accountB.id}/execution-proposals`, { headers: { cookie: cookieB } })).json();
    expect(accountBProposals.proposals).toHaveLength(1);
    expect(accountBProposals.proposals[0].id).toBe(proposalB.id);
  });

  it("manages REAL execution mode through account-scoped API only", async () => {
    const cookieA = await register("mode-a@example.com");
    const cookieB = await register("mode-b@example.com");
    const realA = (await (await postJson("/api/trading-accounts", { name: "Real A", mode: "REAL" }, cookieA)).json()).account;
    const realB = (await (await postJson("/api/trading-accounts", { name: "Real B", mode: "REAL" }, cookieA)).json()).account;
    const demo = (await (await postJson("/api/trading-accounts", { name: "Demo", mode: "DEMO" }, cookieA)).json()).account;
    const otherReal = (await (await postJson("/api/trading-accounts", { name: "Other", mode: "REAL" }, cookieB)).json()).account;

    expect((await (await fetch(`${baseUrl}/api/trading-accounts/${realA.id}/real-execution-mode`, { headers: { cookie: cookieA } })).json()).mode).toBe("LOCKED");
    expect((await putJson(`/api/trading-accounts/${realA.id}/real-execution-mode`, { mode: "DRY_RUN" }, cookieA)).status).toBe(200);
    expect((await (await fetch(`${baseUrl}/api/trading-accounts/${realA.id}/real-execution-mode`, { headers: { cookie: cookieA } })).json()).mode).toBe("DRY_RUN");
    expect((await (await fetch(`${baseUrl}/api/trading-accounts/${realB.id}/real-execution-mode`, { headers: { cookie: cookieA } })).json()).mode).toBe("LOCKED");

    expect((await putJson(`/api/trading-accounts/${realA.id}/real-execution-mode`, { mode: "AUTO_LIVE" }, cookieA)).status).toBe(400);
    expect((await putJson(`/api/trading-accounts/${demo.id}/real-execution-mode`, { mode: "DRY_RUN" }, cookieA)).status).toBe(400);
    expect((await putJson(`/api/trading-accounts/${otherReal.id}/real-execution-mode`, { mode: "DRY_RUN" }, cookieA)).status).toBe(404);

    const modeBody = await (await fetch(`${baseUrl}/api/trading-accounts/${realA.id}/real-execution-mode`, { headers: { cookie: cookieA } })).json();
    expect(modeBody).toMatchObject({ masterLiveExecutionEnabled: false, liveExecutionLocked: true });
    expect(JSON.stringify(modeBody)).not.toContain("secret-value");
  });

  it("supports REAL proposal aliases with filtering, reject, and cross-user approval denial", async () => {
    const cookieA = await register("proposal-alias-a@example.com");
    const cookieB = await register("proposal-alias-b@example.com");
    const accountA = (await (await postJson("/api/trading-accounts", { name: "Real A", mode: "REAL" }, cookieA)).json()).account;
    const accountB = (await (await postJson("/api/trading-accounts", { name: "Real B", mode: "REAL" }, cookieB)).json()).account;
    const pending = await seedProposal(accountA.id, "setup-pending");
    const rejected = await seedProposal(accountA.id, "setup-reject");
    const other = await seedProposal(accountB.id, "setup-other");

    const pendingList = await (await fetch(`${baseUrl}/api/trading-accounts/${accountA.id}/real-execution-proposals?status=PENDING`, { headers: { cookie: cookieA } })).json();
    expect(pendingList.proposals.map((proposal: { id: string }) => proposal.id).sort()).toEqual([pending.id, rejected.id].sort());

    expect((await fetch(`${baseUrl}/api/trading-accounts/${accountB.id}/real-execution-proposals/${other.id}/approve`, { method: "POST", headers: { cookie: cookieA } })).status).toBe(404);
    const rejectResponse = await fetch(`${baseUrl}/api/trading-accounts/${accountA.id}/real-execution-proposals/${rejected.id}/reject`, { method: "POST", headers: { cookie: cookieA } });
    expect(rejectResponse.status).toBe(200);
    expect((await rejectResponse.json()).proposal.status).toBe("REJECTED");

    const detail = await (await fetch(`${baseUrl}/api/trading-accounts/${accountA.id}/real-execution-proposals/${pending.id}`, { headers: { cookie: cookieA } })).text();
    expect(detail).not.toContain("secret-value");
    expect(detail).not.toContain("apiSecret");
  });

  it("does not approve already approved or expired REAL proposals", async () => {
    const cookie = await register("proposal-status@example.com");
    const account = (await (await postJson("/api/trading-accounts", { name: "Real", mode: "REAL" }, cookie)).json()).account;
    const pending = await seedProposal(account.id, "setup-approve-once");
    const expired = await seedProposal(account.id, "setup-expired", true);

    expect((await fetch(`${baseUrl}/api/trading-accounts/${account.id}/real-execution-proposals/${pending.id}/approve`, { method: "POST", headers: { cookie } })).status).toBe(200);
    expect((await fetch(`${baseUrl}/api/trading-accounts/${account.id}/real-execution-proposals/${pending.id}/approve`, { method: "POST", headers: { cookie } })).status).toBe(400);
    expect((await fetch(`${baseUrl}/api/trading-accounts/${account.id}/real-execution-proposals/${expired.id}/approve`, { method: "POST", headers: { cookie } })).status).toBe(400);
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

    const settingsA = { ...testConfig(), riskPerTradeUsdt: 100, watchlist: ["BTCUSDT"] };
    const settingsB = { ...testConfig(), riskPerTradeUsdt: 300, watchlist: ["ETHUSDT"] };
    expect((await putJson(`/api/trading-accounts/${accountA.id}/settings`, settingsA, cookieA)).status).toBe(200);
    expect((await putJson(`/api/trading-accounts/${accountB.id}/settings`, settingsB, cookieB)).status).toBe(200);

    expect((await (await fetch(`${baseUrl}/api/trading-accounts/${accountA.id}/settings`, { headers: { cookie: cookieA } })).json()).riskPerTradeUsdt).toBe(100);
    expect((await (await fetch(`${baseUrl}/api/trading-accounts/${accountB.id}/watchlist`, { headers: { cookie: cookieB } })).json()).watchlist).toEqual(["ETHUSDT"]);
    expect((await putJson(`/api/trading-accounts/${accountB.id}/settings`, settingsA, cookieA)).status).toBe(404);
  });

  it("keeps settings isolated between accounts owned by the same user", async () => {
    const cookie = await register("a@example.com");
    const accountA = (await (await postJson("/api/trading-accounts", { name: "TC bot", mode: "DEMO" }, cookie)).json()).account;
    const accountB = (await (await postJson("/api/trading-accounts", { name: "test2", mode: "DEMO" }, cookie)).json()).account;

    const settingsA = { ...testConfig(), riskPerTradeUsdt: 10000, maxLeverage: 100, watchlist: ["BTCUSDT"] };
    const settingsB = { ...testConfig(), riskPerTradeUsdt: 200, maxLeverage: 5, watchlist: ["ETHUSDT"] };
    expect((await putJson(`/api/trading-accounts/${accountA.id}/settings`, settingsA, cookie)).status).toBe(200);
    expect((await putJson(`/api/trading-accounts/${accountB.id}/settings`, settingsB, cookie)).status).toBe(200);

    const loadedA = await (await fetch(`${baseUrl}/api/trading-accounts/${accountA.id}/settings`, { headers: { cookie } })).json();
    const loadedB = await (await fetch(`${baseUrl}/api/trading-accounts/${accountB.id}/settings`, { headers: { cookie } })).json();
    expect(loadedA.riskPerTradeUsdt).toBe(10000);
    expect(loadedA.maxLeverage).toBe(100);
    expect(loadedB.riskPerTradeUsdt).toBe(200);
    expect(loadedB.maxLeverage).toBe(5);

    expect((await putJson(`/api/trading-accounts/${accountB.id}/settings`, { ...settingsB, riskPerTradeUsdt: 333, maxLeverage: 3 }, cookie)).status).toBe(200);
    const reloadedA = await (await fetch(`${baseUrl}/api/trading-accounts/${accountA.id}/settings`, { headers: { cookie } })).json();
    const reloadedB = await (await fetch(`${baseUrl}/api/trading-accounts/${accountB.id}/settings`, { headers: { cookie } })).json();
    expect(reloadedA.riskPerTradeUsdt).toBe(10000);
    expect(reloadedA.maxLeverage).toBe(100);
    expect(reloadedB.riskPerTradeUsdt).toBe(333);
    expect(reloadedB.maxLeverage).toBe(3);
  });

  it("keeps TC bot DEMO and REAL222 settings isolated while exposing matching normalized keys", async () => {
    const cookie = await register("tc-real222@example.com");
    const tcBot = (await (await postJson("/api/trading-accounts", { name: "TC bot", mode: "DEMO" }, cookie)).json()).account;
    const real222 = (await (await postJson("/api/trading-accounts", { name: "REAL222", mode: "REAL" }, cookie)).json()).account;
    const tcBotSettings = {
      ...testConfig(),
      riskPerTradeUsdt: 101,
      maxLeverage: 25,
      marginMode: "CROSS",
      minimumRiskReward: 2.5,
      watchlist: ["BTCUSDT"]
    };
    const real222Settings = {
      ...testConfig(),
      riskPerTradeUsdt: 202,
      maxLeverage: 40,
      marginMode: "ISOLATED",
      minimumRiskReward: 3.5,
      watchlist: ["ETHUSDT"]
    };

    expect((await putJson(`/api/trading-accounts/${tcBot.id}/settings`, tcBotSettings, cookie)).status).toBe(200);
    expect((await putJson(`/api/trading-accounts/${real222.id}/settings`, real222Settings, cookie)).status).toBe(200);

    const loadedTcBot = await (await fetch(`${baseUrl}/api/trading-accounts/${tcBot.id}/settings`, { headers: { cookie } })).json();
    const loadedReal222 = await (await fetch(`${baseUrl}/api/trading-accounts/${real222.id}/settings`, { headers: { cookie } })).json();
    expect(supportedSettingKeys(loadedTcBot)).toEqual(supportedSettingKeys(loadedReal222));
    expect(loadedTcBot).toMatchObject({ riskPerTradeUsdt: 101, maxLeverage: 25, marginMode: "CROSS", minimumRiskReward: 2.5, watchlist: ["BTCUSDT"] });
    expect(loadedReal222).toMatchObject({ riskPerTradeUsdt: 202, maxLeverage: 40, marginMode: "ISOLATED", minimumRiskReward: 3.5, watchlist: ["ETHUSDT"] });

    expect((await putJson(`/api/trading-accounts/${tcBot.id}/settings`, { ...tcBotSettings, riskPerTradeUsdt: 303, marginMode: "ISOLATED" }, cookie)).status).toBe(200);
    const realAfterTcChange = await (await fetch(`${baseUrl}/api/trading-accounts/${real222.id}/settings`, { headers: { cookie } })).json();
    expect(realAfterTcChange).toMatchObject({ riskPerTradeUsdt: 202, maxLeverage: 40, marginMode: "ISOLATED", watchlist: ["ETHUSDT"] });

    expect((await putJson(`/api/trading-accounts/${real222.id}/settings`, { ...real222Settings, riskPerTradeUsdt: 404, marginMode: "CROSS" }, cookie)).status).toBe(200);
    const tcAfterRealChange = await (await fetch(`${baseUrl}/api/trading-accounts/${tcBot.id}/settings`, { headers: { cookie } })).json();
    const realAfterRealChange = await (await fetch(`${baseUrl}/api/trading-accounts/${real222.id}/settings`, { headers: { cookie } })).json();
    expect(tcAfterRealChange).toMatchObject({ riskPerTradeUsdt: 303, maxLeverage: 25, marginMode: "ISOLATED", watchlist: ["BTCUSDT"] });
    expect(realAfterRealChange).toMatchObject({ riskPerTradeUsdt: 404, maxLeverage: 40, marginMode: "CROSS", watchlist: ["ETHUSDT"] });
  });

  it("normalizes legacy fixed-margin settings without resetting valid current settings", async () => {
    const cookie = await register("legacy-settings@example.com");
    const account = (await (await postJson("/api/trading-accounts", { name: "Legacy", mode: "REAL" }, cookie)).json()).account;
    await configRepository.saveSettings(account.id, {
      ...testConfig(),
      positionSizingMode: "fixed-margin",
      marginPerTrade: 500,
      leverage: 7,
      fixedRr: 9,
      fvgMitigation: "full",
      ltfFvgEntryMode: "edge",
      riskPerTradeUsdt: 42,
      minimumRiskReward: 3,
      maxOpenPositions: 4,
      realExecutionMode: "DRY_RUN",
      watchlist: ["btcusdt", "ETHUSDT", "btcusdt"]
    } as never);

    const loaded = await (await fetch(`${baseUrl}/api/trading-accounts/${account.id}/settings`, { headers: { cookie } })).json();
    const runtime = await runtimeManager.ensureRuntime(account.id);
    const snapshot = await runtimeManager.getSnapshot(account.id);
    const snapshotSettings = readSnapshotSettings(snapshot.store);

    expect(loaded).toMatchObject({
      positionSizingMode: "risk-based",
      riskPerTradeUsdt: 42,
      minimumRiskReward: 3,
      maxOpenPositions: 4,
      realExecutionMode: "DRY_RUN",
      watchlist: ["BTCUSDT", "ETHUSDT"]
    });
    expect(loaded).not.toHaveProperty("marginPerTrade");
    expect(loaded).not.toHaveProperty("leverage");
    expect(loaded).not.toHaveProperty("fixedRr");
    expect(loaded).not.toHaveProperty("fvgMitigation");
    expect(loaded).not.toHaveProperty("ltfFvgEntryMode");
    expect(snapshotSettings.positionSizingMode).toBe("risk-based");
    expect(snapshotSettings.riskPerTradeUsdt).toBe(42);
    expect(runtime.scanner.getPrimaryEngine().constructor.name).toBe("TradingEngine");
  });

  it("rejects cross-user access to account-scoped runtime routes", async () => {
    const cookieA = await register("a@example.com");
    const cookieB = await register("b@example.com");
    const accountB = (await (await postJson("/api/trading-accounts", { name: "B", mode: "DEMO" }, cookieB)).json()).account;

    expect((await fetch(`${baseUrl}/api/trading-accounts/${accountB.id}/snapshot`, { headers: { cookie: cookieA } })).status).toBe(404);
    expect((await fetch(`${baseUrl}/api/trading-accounts/${accountB.id}/settings`, { headers: { cookie: cookieA } })).status).toBe(404);
    expect((await fetch(`${baseUrl}/api/trading-accounts/${accountB.id}/watchlist`, { headers: { cookie: cookieA } })).status).toBe(404);
    expect((await fetch(`${baseUrl}/api/trading-accounts/${accountB.id}/watchlist/status`, { headers: { cookie: cookieA } })).status).toBe(404);
    expect((await fetch(`${baseUrl}/api/trading-accounts/${accountB.id}/chart/overlays?symbol=BTCUSDT&timeframe=M5`, { headers: { cookie: cookieA } })).status).toBe(404);
    expect((await fetch(`${baseUrl}/api/trading-accounts/${accountB.id}/chart/account-activity?symbol=BTCUSDT`, { headers: { cookie: cookieA } })).status).toBe(404);
  });

  it("keeps same-user runtimes and snapshots isolated for the same symbol", async () => {
    const cookie = await register("a@example.com");
    const accountA = (await (await postJson("/api/trading-accounts", { name: "TC bot", mode: "DEMO" }, cookie)).json()).account;
    const accountB = (await (await postJson("/api/trading-accounts", { name: "test2", mode: "DEMO" }, cookie)).json()).account;

    await putJson(`/api/trading-accounts/${accountA.id}/settings`, { ...testConfig(), riskPerTradeUsdt: 900, maxLeverage: 9, watchlist: ["BTCUSDT"] }, cookie);
    await putJson(`/api/trading-accounts/${accountB.id}/settings`, { ...testConfig(), riskPerTradeUsdt: 200, maxLeverage: 5, watchlist: ["BTCUSDT"] }, cookie);

    await runtimeManager.ensureRuntime(accountA.id);
    await runtimeManager.ensureRuntime(accountB.id);
    const engineA = runtimeManager.getEngineForTest(accountA.id, "BTCUSDT");
    const engineB = runtimeManager.getEngineForTest(accountB.id, "BTCUSDT");
    const snapshotA = await runtimeManager.getSnapshot(accountA.id);
    const snapshotB = await runtimeManager.getSnapshot(accountB.id);

    expect(engineA).toBeTruthy();
    expect(engineB).toBeTruthy();
    expect(engineA).not.toBe(engineB);
    expect(readSnapshotSettings(snapshotA.store).riskPerTradeUsdt).toBe(900);
    expect(readSnapshotSettings(snapshotA.store).maxLeverage).toBe(9);
    expect(readSnapshotSettings(snapshotB.store).riskPerTradeUsdt).toBe(200);
    expect(readSnapshotSettings(snapshotB.store).maxLeverage).toBe(5);

    await putJson(`/api/trading-accounts/${accountB.id}/settings`, { ...testConfig(), riskPerTradeUsdt: 333, maxLeverage: 3, watchlist: ["BTCUSDT"] }, cookie);
    const reloadedA = await runtimeManager.getSnapshot(accountA.id);
    const reloadedB = await runtimeManager.getSnapshot(accountB.id);
    expect(readSnapshotSettings(reloadedA.store).riskPerTradeUsdt).toBe(900);
    expect(readSnapshotSettings(reloadedA.store).maxLeverage).toBe(9);
    expect(readSnapshotSettings(reloadedB.store).riskPerTradeUsdt).toBe(333);
    expect(readSnapshotSettings(reloadedB.store).maxLeverage).toBe(3);
  });

  it("persists account drawdown peak and locked protection state across runtime restart", async () => {
    const cookie = await register("drawdown@example.com");
    const accountA = (await (await postJson("/api/trading-accounts", { name: "A", mode: "DEMO" }, cookie)).json()).account;
    const accountB = (await (await postJson("/api/trading-accounts", { name: "B", mode: "DEMO" }, cookie)).json()).account;
    await putJson(`/api/trading-accounts/${accountA.id}/binance-connection`, { apiKey: "DRAW_A_KEY", apiSecret: "DRAW_A_SECRET" }, cookie);
    await putJson(`/api/trading-accounts/${accountB.id}/binance-connection`, { apiKey: "DRAW_B_KEY", apiSecret: "DRAW_B_SECRET" }, cookie);
    await putJson(`/api/trading-accounts/${accountA.id}/settings`, { ...testConfig(), maxDrawdownPercent: 10, watchlist: ["BTCUSDT"] }, cookie);
    await putJson(`/api/trading-accounts/${accountB.id}/settings`, { ...testConfig(), maxDrawdownPercent: 10, watchlist: ["BTCUSDT"] }, cookie);

    FakeAccountClient.walletBalanceByApiKey.set("DRAW_A_KEY", 10_000);
    FakeAccountClient.walletBalanceByApiKey.set("DRAW_B_KEY", 10_000);
    expect((await runtimeManager.getAccountProtectionStatus(accountA.id))?.newEntriesAllowed).toBe(true);
    FakeAccountClient.walletBalanceByApiKey.set("DRAW_A_KEY", 8_900);
    const blocked = await runtimeManager.getAccountProtectionStatus(accountA.id);
    const accountBStatus = await runtimeManager.getAccountProtectionStatus(accountB.id);

    expect(blocked).toMatchObject({ peakEquityUsdt: 10_000, drawdownPercent: 11, newEntriesAllowed: false, blockReason: "MAX_DRAWDOWN_REACHED" });
    expect(accountBStatus).toMatchObject({ peakEquityUsdt: 10_000, drawdownPercent: 0, newEntriesAllowed: true });

    const restartedRuntimeManager = new TradingRuntimeManager(
      testConfig(),
      undefined,
      accountRepository,
      configRepository,
      executionIntentRepository,
      new CredentialCipher(encryptionKey),
      new FakeMarketData(),
      fakeLogger(),
      (apiKey, _apiSecret, testnet) => new FakeAccountClient(apiKey, testnet),
      new FakeSymbolMetadataService(),
      realProposalRepository,
      () => new FakeMarketData() as never
    );
    FakeAccountClient.walletBalanceByApiKey.set("DRAW_A_KEY", 10_500);
    const afterRestart = await restartedRuntimeManager.getAccountProtectionStatus(accountA.id);

    expect(afterRestart).toMatchObject({ newEntriesAllowed: false, blockReason: "MAX_DRAWDOWN_REACHED" });
    expect(afterRestart?.maxDrawdownReachedAt).toBe(blocked?.maxDrawdownReachedAt);
    await restartedRuntimeManager.shutdown();
  });

  it("exposes recovered snapshot after initial reconciliation even when scanner bootstrap is still waiting on market data", async () => {
    const cookie = await register("restart-bootstrap@example.com");
    const account = (await (await postJson("/api/trading-accounts", { name: "Restart", mode: "DEMO" }, cookie)).json()).account;
    await putJson(`/api/trading-accounts/${account.id}/binance-connection`, { apiKey: "RESTART_KEY", apiSecret: "RESTART_SECRET" }, cookie);
    await putJson(`/api/trading-accounts/${account.id}/settings`, { ...testConfig(), tradingEnabled: true, killSwitch: false, watchlist: ["XRPUSDT"], symbol: "XRPUSDT" }, cookie);
    await accountRepository.updateTradingAccountStatus(account.id, "ERROR", new Date().toISOString());
    FakeAccountClient.positionsByApiKey.set("RESTART_KEY", [{ ...fakePosition("XRPUSDT", "long"), stopLoss: 590, takeProfit: 620 }]);
    FakeAccountClient.openOrdersByApiKey.set("RESTART_KEY", [
      fakeProtectionOrder("XRPUSDT", "STOP_MARKET", "smc_restart_S", "stop-1"),
      fakeProtectionOrder("XRPUSDT", "TAKE_PROFIT_MARKET", "smc_restart_T", "tp-1")
    ]);

    const restartedRuntimeManager = new TradingRuntimeManager(
      testConfig(),
      undefined,
      accountRepository,
      configRepository,
      executionIntentRepository,
      new CredentialCipher(encryptionKey),
      new HangingMarketData(),
      fakeLogger(),
      (apiKey, apiSecret, testnet) => {
        accountClientFactoryCalls.push({ apiKey, apiSecret, testnet });
        return new FakeAccountClient(apiKey, testnet);
      },
      new FakeSymbolMetadataService(),
      realProposalRepository,
      () => new HangingMarketData() as never
    );

    const snapshot = await Promise.race([
      restartedRuntimeManager.getSnapshot(account.id),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("SNAPSHOT_BLOCKED_BY_BOOTSTRAP")), 500))
    ]);

    expect(snapshot.runtimeHealth).toMatchObject({ state: "READY", reconciliationStatus: "OK" });
    expect(snapshot.watchlistStatus[0]).toMatchObject({ symbol: "XRPUSDT", state: "ManagingTrade", position: "LONG", status: "Position Open", positionSource: "binance" });
    expect((await accountRepository.findTradingAccountById(account.id))?.status).toBe("CONNECTED");
    expect(accountClientFactoryCalls.filter((call) => call.apiKey === "RESTART_KEY" && call.testnet).length).toBeGreaterThan(0);

    await restartedRuntimeManager.shutdown();
  });

  it("uses credentials from the requested account for chart account activity", async () => {
    const cookie = await register("a@example.com");
    const accountA = (await (await postJson("/api/trading-accounts", { name: "TC bot", mode: "DEMO" }, cookie)).json()).account;
    const accountB = (await (await postJson("/api/trading-accounts", { name: "test2", mode: "DEMO" }, cookie)).json()).account;
    await putJson(`/api/trading-accounts/${accountB.id}/binance-connection`, { apiKey: "ACCOUNT_B_KEY", apiSecret: "ACCOUNT_B_SECRET" }, cookie);
    await new Promise((resolve) => setTimeout(resolve, 10));
    accountClientFactoryCalls = [];

    const response = await fetch(`${baseUrl}/api/trading-accounts/${accountB.id}/chart/account-activity?symbol=BTCUSDT`, { headers: { cookie } });
    expect(response.status).toBe(200);
    expect(accountClientFactoryCalls).toContainEqual({ apiKey: "ACCOUNT_B_KEY", apiSecret: "ACCOUNT_B_SECRET", testnet: true });
    expect(accountA.id).not.toBe(accountB.id);
  });

  it("returns only signed Binance account activity for REAL accounts, not DEMO positions", async () => {
    const cookie = await register("real-source@example.com");
    const demo = (await (await postJson("/api/trading-accounts", { name: "Demo", mode: "DEMO" }, cookie)).json()).account;
    const real = (await (await postJson("/api/trading-accounts", { name: "Real", mode: "REAL" }, cookie)).json()).account;
    await putJson(`/api/trading-accounts/${demo.id}/binance-connection`, { apiKey: "DEMO_POSITION_KEY", apiSecret: "DEMO_SECRET" }, cookie);
    await putJson(`/api/trading-accounts/${real.id}/binance-connection`, { apiKey: "REAL_EMPTY_KEY", apiSecret: "REAL_SECRET" }, cookie);
    FakeAccountClient.positionsByApiKey.set("DEMO_POSITION_KEY", [fakePosition("BTCUSDT", "long")]);
    FakeAccountClient.positionsByApiKey.set("REAL_EMPTY_KEY", []);

    const body = await (await fetch(`${baseUrl}/api/trading-accounts/${real.id}/chart/account-activity?symbol=BTCUSDT`, { headers: { cookie } })).json();

    expect(body).toMatchObject({
      connected: true,
      source: "BINANCE_SIGNED_ACCOUNT",
      sourceEnvironment: "MAINNET",
      tradingAccountId: real.id,
      positions: []
    });
    expect(accountClientFactoryCalls).toContainEqual({ apiKey: "REAL_EMPTY_KEY", apiSecret: "REAL_SECRET", testnet: false });
  });

  it("does not expose REAL execution proposals or execution intents as chart positions", async () => {
    const cookie = await register("real-proposal-source@example.com");
    const account = (await (await postJson("/api/trading-accounts", { name: "Real", mode: "REAL" }, cookie)).json()).account;
    await putJson(`/api/trading-accounts/${account.id}/binance-connection`, { apiKey: "REAL_NO_POSITION_KEY", apiSecret: "REAL_SECRET" }, cookie);
    FakeAccountClient.positionsByApiKey.set("REAL_NO_POSITION_KEY", []);
    await seedProposal(account.id, "btc-real-pending-source");
    await executionIntentRepository.createOrGet({
      id: "11111111-2222-4333-8444-555555555555",
      tradingAccountId: account.id,
      symbol: "BTCUSDT",
      side: "short",
      setupKey: "real-intent-source-key",
      entryType: "limit",
      requestedEntry: 603.74,
      requestedStopLoss: 610,
      requestedTakeProfit: 590,
      quantity: 0.01,
      clientEntryOrderId: "entry-real-intent-source-key",
      clientStopOrderId: "stop-real-intent-source-key",
      clientTakeProfitOrderId: "take-real-intent-source-key"
    });

    const body = await (await fetch(`${baseUrl}/api/trading-accounts/${account.id}/chart/account-activity?symbol=BTCUSDT`, { headers: { cookie } })).json();

    expect(body.positions).toEqual([]);
    expect(JSON.stringify(body)).not.toContain("603.74");
    expect(JSON.stringify(body)).not.toContain("btc-real-pending-source");
    expect(JSON.stringify(body)).not.toContain("real-intent-source-key");
  });

  it("keeps signed account activity isolated for two REAL accounts on the same symbol", async () => {
    const cookie = await register("two-real-source@example.com");
    const accountA = (await (await postJson("/api/trading-accounts", { name: "Real A", mode: "REAL" }, cookie)).json()).account;
    const accountB = (await (await postJson("/api/trading-accounts", { name: "Real B", mode: "REAL" }, cookie)).json()).account;
    await putJson(`/api/trading-accounts/${accountA.id}/binance-connection`, { apiKey: "REAL_A_KEY", apiSecret: "A_SECRET" }, cookie);
    await putJson(`/api/trading-accounts/${accountB.id}/binance-connection`, { apiKey: "REAL_B_KEY", apiSecret: "B_SECRET" }, cookie);
    FakeAccountClient.positionsByApiKey.set("REAL_A_KEY", [fakePosition("BTCUSDT", "short")]);
    FakeAccountClient.positionsByApiKey.set("REAL_B_KEY", []);

    const accountAActivity = await (await fetch(`${baseUrl}/api/trading-accounts/${accountA.id}/chart/account-activity?symbol=BTCUSDT`, { headers: { cookie } })).json();
    const accountBActivity = await (await fetch(`${baseUrl}/api/trading-accounts/${accountB.id}/chart/account-activity?symbol=BTCUSDT`, { headers: { cookie } })).json();

    expect(accountAActivity.positions).toHaveLength(1);
    expect(accountAActivity.positions[0]).toMatchObject({ source: "binance", sourceEnvironment: "MAINNET", tradingAccountId: accountA.id });
    expect(accountBActivity.positions).toEqual([]);
    expect(accountBActivity.tradingAccountId).toBe(accountB.id);
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

  it("uses the same strategy engine implementation for DEMO and REAL runtimes while REAL execution stays locked", async () => {
    const cookie = await register("same-strategy@example.com");
    const demo = (await (await postJson("/api/trading-accounts", { name: "Demo", mode: "DEMO" }, cookie)).json()).account;
    const real = (await (await postJson("/api/trading-accounts", { name: "Real", mode: "REAL" }, cookie)).json()).account;
    await putJson(`/api/trading-accounts/${demo.id}/settings`, { ...testConfig(), watchlist: ["BTCUSDT"] }, cookie);
    await putJson(`/api/trading-accounts/${real.id}/settings`, { ...testConfig(), tradingEnabled: true, killSwitch: false, realExecutionMode: "DRY_RUN", watchlist: ["BTCUSDT"] }, cookie);
    await putJson(`/api/trading-accounts/${demo.id}/binance-connection`, { apiKey: "SAME_DEMO_KEY", apiSecret: "DEMO_SECRET" }, cookie);
    await putJson(`/api/trading-accounts/${real.id}/binance-connection`, { apiKey: "SAME_REAL_KEY", apiSecret: "REAL_SECRET" }, cookie);

    await runtimeManager.ensureRuntime(demo.id);
    await runtimeManager.ensureRuntime(real.id);
    const demoEngine = runtimeManager.getEngineForTest(demo.id, "BTCUSDT");
    const realEngine = runtimeManager.getEngineForTest(real.id, "BTCUSDT");
    const realSnapshot = await runtimeManager.getSnapshot(real.id);

    expect(demoEngine).toBeTruthy();
    expect(realEngine).toBeTruthy();
    expect(demoEngine?.constructor).toBe(realEngine?.constructor);
    expect(realSnapshot.execution).toEqual({ enabled: false, reason: "REAL_EXECUTION_LOCKED" });
    await expect(new LockedRealExecutionGateway().submitBracketOrder({} as never, {} as never)).rejects.toThrow("REAL_EXECUTION_LOCKED");
  });

  async function register(email: string): Promise<string> {
    const response = await postJson("/api/auth/register", { email, password: "password123" });
    const cookie = response.headers.get("set-cookie");
    if (!cookie) throw new Error("Expected cookie");
    return cookie;
  }

  async function seedProposal(tradingAccountId: string, setupKey: string, expired = false) {
    const base = {
      id: `${tradingAccountId.slice(0, 8)}-${setupKey.includes("reject") ? "2222" : setupKey.includes("other") ? "3333" : setupKey.includes("expired") ? "4444" : "1111"}-4111-8111-111111111111`,
      tradingAccountId,
      setupKey,
      symbol: "BTCUSDT",
      direction: "bullish" as const,
      status: "PENDING" as const,
      requestedEntryType: "market" as const,
      requestedEntryPrice: 100,
      normalizedEntryPrice: null,
      requestedQuantity: 10,
      normalizedQuantity: 10,
      requestedStopLoss: 95,
      normalizedStopLoss: 95,
      requestedTakeProfit: 110,
      normalizedTakeProfit: 110,
      estimatedNotional: 1000,
      estimatedMargin: 200,
      configuredLeverage: 20,
      configuredMarginMode: "ISOLATED" as const,
      symbolTickSize: 0.1,
      symbolStepSize: 0.001,
      symbolMinQty: 0.001,
      symbolMinNotional: 5,
      strategySnapshot: {},
      riskSnapshot: {},
      expiresAt: new Date(Date.now() + (expired ? -60_000 : 30 * 60_000)).toISOString()
    } satisfies Omit<CreateRealExecutionProposalInput, "proposalHash">;
    return (await realProposalRepository.createOrGet({ ...base, proposalHash: fingerprintProposal(base) })).proposal;
  }

  async function seedExecutionIntent(tradingAccountId: string) {
    return executionIntentRepository.createOrGet({
      id: "11111111-2222-4333-8444-555555555555",
      tradingAccountId,
      symbol: "BTCUSDT",
      side: "long",
      setupKey: "unsafe-delete-intent",
      entryType: "market",
      requestedEntry: 100,
      requestedStopLoss: 95,
      requestedTakeProfit: 110,
      quantity: 1,
      clientEntryOrderId: "smc_unsafe_E",
      clientStopOrderId: "smc_unsafe_S",
      clientTakeProfitOrderId: "smc_unsafe_T"
    });
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
  async getKlines(symbol: string, interval: string, limit: number) {
    return Array.from({ length: Math.min(limit, 5) }, (_, index) => ({
      openTime: 1_000 + index * 60_000,
      closeTime: 1_000 + (index + 1) * 60_000,
      time: 1_000 + index * 60_000,
      open: 100 + index,
      high: 102 + index,
      low: 99 + index,
      close: 101 + index,
      volume: 10
    }));
  }

  async getClosedCandles(symbol: string, timeframe: "H1" | "M5", limit: number) {
    return [];
  }

  async getFuturesSymbols() {
    return [{ symbol: "BTCUSDT" }, { symbol: "ETHUSDT" }];
  }
}

class HangingMarketData extends FakeMarketData {
  override async getClosedCandles(): Promise<never> {
    return new Promise<never>(() => undefined);
  }
}

class FakeAccountClient {
  static nextLeverage = 20;
  static nextMarginType: "CROSS" | "ISOLATED" = "ISOLATED";
  static positionsByApiKey = new Map<string, BinanceFuturesPositionStatus[]>();
  static openOrdersByApiKey = new Map<string, BinanceFuturesOpenOrderStatus[]>();
  static walletBalanceByApiKey = new Map<string, number>();
  static maxLeverageBySymbol = new Map<string, number>();

  constructor(
    private readonly apiKey: string,
    private readonly testnet: boolean
  ) {}

  async getWalletStatus() {
    const walletBalance = FakeAccountClient.walletBalanceByApiKey.get(this.apiKey) ?? 10_000;
    return {
      connected: true,
      environment: this.testnet ? "testnet" as const : "live" as const,
      label: "Binance Futures account verified",
      walletBalance,
      availableBalance: walletBalance,
      asset: "USDT" as const,
      checkedAt: new Date().toISOString()
    };
  }

  async getOpenPositions(symbol?: string) {
    const positions = FakeAccountClient.positionsByApiKey.get(this.apiKey) ?? [];
    return positions.filter((position) => !symbol || position.symbol === symbol);
  }

  async getOpenOrders(symbol?: string) {
    const openOrders = FakeAccountClient.openOrdersByApiKey.get(this.apiKey) ?? [];
    return openOrders.filter((order) => !symbol || order.symbol === symbol);
  }

  async getOrderHistory() {
    return [];
  }

  async getTradeHistory() {
    return [];
  }

  async getSymbolAccountState(symbol: string) {
    return {
      symbol,
      leverage: FakeAccountClient.nextLeverage,
      marginType: FakeAccountClient.nextMarginType,
      positionSide: "BOTH"
    };
  }

  async getLeverageBrackets(symbol: string) {
    return [{ symbol, maxInitialLeverage: FakeAccountClient.maxLeverageBySymbol.get(symbol) ?? 125 }];
  }
}

class FakeSymbolMetadataService {
  async getSymbolRules(symbol: string, _environment: "testnet" | "live", loadLeverageBrackets?: () => Promise<Array<{ symbol: string; maxInitialLeverage: number | null }>>): Promise<FuturesSymbolRules> {
    const brackets = await loadLeverageBrackets?.();
    return {
      symbol,
      status: "TRADING",
      contractType: "PERPETUAL",
      quoteAsset: "USDT",
      marginAsset: "USDT",
      pricePrecision: 1,
      quantityPrecision: 3,
      tickSize: 0.1,
      minPrice: 0.1,
      maxPrice: null,
      stepSize: 0.001,
      minQty: 0.001,
      maxQty: 100,
      minNotional: 5,
      maxLeverage: brackets?.find((item) => item.symbol === symbol)?.maxInitialLeverage ?? 125,
      maintenanceMarginBrackets: [
        { bracket: 1, notionalFloor: 0, notionalCap: 5_000, maintenanceMarginRatio: 0.004, cumulativeMaintenanceAmount: 0, initialLeverage: 125 },
        { bracket: 2, notionalFloor: 5_000, notionalCap: 25_000, maintenanceMarginRatio: 0.005, cumulativeMaintenanceAmount: 5, initialLeverage: 75 }
      ],
      supportedOrderTypes: ["MARKET", "LIMIT", "STOP_MARKET", "TAKE_PROFIT_MARKET"]
    };
  }
}

function readSnapshotSettings(store: unknown): AppConfig {
  const settings = (store as { tradingSettings?: AppConfig }).tradingSettings;
  if (!settings) throw new Error("Expected snapshot trading settings");
  return settings;
}

function supportedSettingKeys(settings: Record<string, unknown>): string[] {
  return Object.keys(settings).sort();
}

function credentials(): { apiKey: string; apiSecret: string } {
  return { apiKey: "ABCD1234WXYZ", apiSecret: "secret-value" };
}

function fakePosition(symbol: string, side: "long" | "short"): BinanceFuturesPositionStatus {
  return {
    id: `binance:${symbol}:${side}`,
    symbol,
    side,
    entryPrice: 603.74,
    entryTime: null,
    quantity: 0.01,
    notional: 6.0374,
    maxLeverage: 5,
    margin: 1.20748,
    unrealizedProfit: 0,
    stopLoss: null,
    takeProfit: null
  };
}

function fakeOpenOrder(symbol: string, clientOrderId: string): BinanceFuturesOpenOrderStatus {
  return {
    id: `binance:${symbol}:${clientOrderId}`,
    symbol,
    orderId: "12345",
    clientOrderId,
    side: "BUY",
    type: "LIMIT",
    price: 100,
    stopPrice: null,
    quantity: 1,
    executedQuantity: 0,
    status: "NEW",
    reduceOnly: false,
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
}

function fakeProtectionOrder(symbol: string, type: "STOP_MARKET" | "TAKE_PROFIT_MARKET", clientOrderId: string, orderId: string): BinanceFuturesOpenOrderStatus {
  return {
    ...fakeOpenOrder(symbol, clientOrderId),
    id: `binance:open-order:${symbol}:${orderId}`,
    orderId,
    side: "SELL",
    type,
    price: null,
    stopPrice: type === "STOP_MARKET" ? 590 : 620,
    quantity: 1,
    reduceOnly: true
  };
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
