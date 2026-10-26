import { describe, expect, it } from "vitest";
import { loadConfig, parseFlag, validateTradingSettings } from "../src/application/config/AppConfig.js";

describe("boolean flags", () => {
  it("reads the text of true/false values instead of their truthiness", () => {
    for (const value of ["true", "TRUE", " True ", "1", "yes", "on", true, 1]) expect(parseFlag(value)).toBe(true);
    for (const value of ["false", "FALSE", " false ", "0", "no", "off", false, 0]) expect(parseFlag(value)).toBe(false);
  });

  it("treats empty or missing as unset, and leaves unknown values for validation to reject", () => {
    for (const value of ["", "   ", undefined, null]) expect(parseFlag(value)).toBeUndefined();
    expect(parseFlag("enabled")).toBe("enabled");
    expect(parseFlag(2)).toBe(2);
  });
});

describe("loadConfig env flags", () => {
  it("READ_ONLY_SOAK=false keeps read-only soak off (it used to switch it on)", () => {
    withEnv({ READ_ONLY_SOAK: "false" }, () => expect(loadConfig().readOnlySoak).toBe(false));
    withEnv({ READ_ONLY_SOAK: "true" }, () => expect(loadConfig().readOnlySoak).toBe(true));
    withEnv({ READ_ONLY_SOAK: undefined }, () => expect(loadConfig().readOnlySoak).toBe(false));
  });

  it("LOCAL_TRADING_RUNTIME_ENABLED=false keeps the development runtime off", () => {
    withEnv({ LOCAL_TRADING_RUNTIME_ENABLED: "false" }, () => expect(loadConfig().localTradingRuntimeEnabled).toBe(false));
    withEnv({ LOCAL_TRADING_RUNTIME_ENABLED: "0" }, () => expect(loadConfig().localTradingRuntimeEnabled).toBe(false));
    withEnv({ LOCAL_TRADING_RUNTIME_ENABLED: "true" }, () => expect(loadConfig().localTradingRuntimeEnabled).toBe(true));
  });

  it("BINANCE_TESTNET=false selects mainnet, and an empty value keeps the testnet default", () => {
    withEnv({ BINANCE_TESTNET: "false", READ_ONLY_SOAK: undefined }, () => expect(loadConfig().binanceTestnet).toBe(false));
    withEnv({ BINANCE_TESTNET: "" }, () => expect(loadConfig().binanceTestnet).toBe(true));
  });

  it("rejects a value that is neither true nor false instead of guessing", () => {
    withEnv({ READ_ONLY_SOAK: "enabled" }, () => expect(() => loadConfig()).toThrow());
    withEnv({ REAL_LIVE_EXECUTION_ENABLED: "maybe" }, () => expect(() => loadConfig()).toThrow());
  });

  it("still refuses read-only soak on mainnet", () => {
    withEnv({ READ_ONLY_SOAK: "true", BINANCE_TESTNET: "false" }, () => expect(() => loadConfig()).toThrow("READ_ONLY_SOAK_REQUIRES_TESTNET"));
  });

  it("production still requires REAL_LIVE_EXECUTION_ENABLED to be exactly true", () => {
    const production = {
      NODE_ENV: "production",
      PORT: "8787",
      DATABASE_URL: "postgres://user:pass@example.com:5432/db",
      SESSION_SECRET: "production-session-secret-with-more-than-32-chars",
      BINANCE_CREDENTIAL_ENCRYPTION_KEY: "1111111111111111111111111111111111111111111111111111111111111111",
      CORS_ORIGINS: "https://bot.example.com",
      RECONCILIATION_INTERVAL_MS: "30000",
      BINANCE_RETRY_MAX_ATTEMPTS: "3",
      BINANCE_RETRY_BASE_DELAY_MS: "500",
      POSTGRES_POOL_MAX: "2",
      READ_ONLY_SOAK: "false"
    };
    withEnv({ ...production, REAL_LIVE_EXECUTION_ENABLED: "1" }, () => expect(() => loadConfig()).toThrow(/REAL_LIVE_EXECUTION_ENABLED=true/));
    withEnv({ ...production, REAL_LIVE_EXECUTION_ENABLED: "false" }, () => expect(loadConfig().realLiveExecutionEnabled).toBe(false));
    withEnv({ ...production, REAL_LIVE_EXECUTION_ENABLED: "true" }, () => expect(loadConfig().realLiveExecutionEnabled).toBe(true));
  });
});

describe("trading settings flags", () => {
  it("accepts string booleans from API input by their text", () => {
    const settings = validateTradingSettings({ tradingEnabled: "false", killSwitch: "true", requireDisplacement: "0", readOnlySoak: "no" });
    expect(settings).toMatchObject({ tradingEnabled: false, killSwitch: true, requireDisplacement: false, readOnlySoak: false });
  });

  it("keeps real booleans and defaults as before", () => {
    expect(validateTradingSettings({ tradingEnabled: true, killSwitch: false })).toMatchObject({ tradingEnabled: true, killSwitch: false });
    expect(validateTradingSettings({})).toMatchObject({ tradingEnabled: false, killSwitch: false, requireDisplacement: false, readOnlySoak: false });
    expect(() => validateTradingSettings({ killSwitch: "sometimes" })).toThrow();
  });
});

function withEnv(values: Record<string, string | undefined>, run: () => void): void {
  const previous = new Map(Object.keys(values).map((key) => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}
