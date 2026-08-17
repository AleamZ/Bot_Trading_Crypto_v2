import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { config as loadDotenv } from "dotenv";
import { z } from "zod";

for (const envFile of [resolve(process.cwd(), ".env"), resolve(process.cwd(), "../../.env")]) {
  if (existsSync(envFile)) {
    loadDotenv({ path: envFile, override: false });
  }
}

const schema = z.object({
  port: z.coerce.number().int().positive().default(8787),
  executionMode: z.enum(["paper", "testnet", "live"]).default("paper"),
  logLevel: z.enum(["debug", "info", "warn", "error"]).default("info"),
  corsOrigins: z.array(z.string()).default(["http://localhost:5173", "http://127.0.0.1:5173"]),
  symbol: z.string().default("BTCUSDT"),
  watchlist: z.array(z.string()).default(["BTCUSDT", "ETHUSDT", "BNBUSDT", "SOLUSDT", "XRPUSDT"]),
  positionSizingMode: z.literal("fixed-margin").default("fixed-margin"),
  marginPerTrade: z.coerce.number().positive().default(200),
  leverage: z.coerce.number().positive().default(5),
  maxLeverage: z.coerce.number().positive().default(125),
  entryMode: z.enum(["limit", "market"]).default("limit"),
  minNotional: z.coerce.number().positive().default(5),
  maxPositionSize: z.coerce.number().positive().default(100_000),
  maxOpenPositions: z.coerce.number().int().positive().default(1),
  maxPositionPerSymbol: z.coerce.number().int().positive().default(1),
  minimumRiskReward: z.coerce.number().positive().default(2),
  maxTradesPerDay: z.coerce.number().int().positive().default(5),
  maxDailyLossPercent: z.coerce.number().positive().default(3),
  maxConsecutiveLosses: z.coerce.number().int().positive().default(3),
  cooldownAfterTradeMinutes: z.coerce.number().int().nonnegative().default(30),
  maxDrawdownPercent: z.coerce.number().positive().default(10),
  tradingEnabled: z.coerce.boolean().default(false),
  killSwitch: z.coerce.boolean().default(false),
  emaPeriod: z.coerce.number().int().positive().default(50),
  swingLeft: z.coerce.number().int().positive().default(2),
  swingRight: z.coerce.number().int().positive().default(2),
  fvgMitigation: z.enum(["edge", "ce", "full"]).default("ce"),
  ltfFvgEntryMode: z.enum(["edge", "ce", "full"]).default("ce"),
  stopLossBufferMode: z.enum(["ticks", "percentage", "atr"]).default("ticks"),
  stopLossBufferTicks: z.coerce.number().nonnegative().default(5),
  stopLossBufferPercent: z.coerce.number().nonnegative().default(0.1),
  stopLossAtrPeriod: z.coerce.number().int().positive().default(14),
  stopLossAtrMultiplier: z.coerce.number().nonnegative().default(1),
  priceTickSize: z.coerce.number().positive().default(0.1),
  requireDisplacement: z.coerce.boolean().default(false),
  displacementBodyMultiplier: z.coerce.number().positive().default(1.5),
  displacementLookback: z.coerce.number().int().positive().default(20),
  takeProfitMode: z.enum(["external-liquidity", "fixed-rr"]).default("external-liquidity"),
  fixedRr: z.coerce.number().positive().default(2),
  databaseUrl: z.string().optional(),
  sessionSecret: z.string().min(32).optional(),
  binanceCredentialEncryptionKey: z.string().optional(),
  binanceApiKey: z.string().optional(),
  binanceApiSecret: z.string().optional(),
  binanceTestnet: z.coerce.boolean().default(true)
});

export type AppConfig = z.infer<typeof schema>;
export type TradingSettings = Omit<AppConfig, "port" | "executionMode" | "logLevel" | "corsOrigins" | "databaseUrl" | "sessionSecret" | "binanceCredentialEncryptionKey" | "binanceApiKey" | "binanceApiSecret" | "binanceTestnet">;

export const defaultTradingSettings: TradingSettings = {
  symbol: "BTCUSDT",
  watchlist: ["BTCUSDT", "ETHUSDT", "BNBUSDT", "SOLUSDT", "XRPUSDT"],
  positionSizingMode: "fixed-margin",
  marginPerTrade: 200,
  leverage: 5,
  maxLeverage: 125,
  entryMode: "market",
  minNotional: 5,
  maxPositionSize: 100_000,
  maxOpenPositions: 1,
  maxPositionPerSymbol: 1,
  minimumRiskReward: 2,
  maxTradesPerDay: 5,
  maxDailyLossPercent: 3,
  maxConsecutiveLosses: 3,
  cooldownAfterTradeMinutes: 30,
  maxDrawdownPercent: 10,
  tradingEnabled: false,
  killSwitch: false,
  emaPeriod: 50,
  swingLeft: 2,
  swingRight: 2,
  fvgMitigation: "ce",
  ltfFvgEntryMode: "ce",
  stopLossBufferMode: "ticks",
  stopLossBufferTicks: 5,
  stopLossBufferPercent: 0.1,
  stopLossAtrPeriod: 14,
  stopLossAtrMultiplier: 1,
  priceTickSize: 0.1,
  requireDisplacement: false,
  displacementBodyMultiplier: 1.5,
  displacementLookback: 20,
  takeProfitMode: "external-liquidity",
  fixedRr: 2
};

const tradingSettingsSchema = schema.omit({
  port: true,
  executionMode: true,
  logLevel: true,
  corsOrigins: true,
  databaseUrl: true,
  sessionSecret: true,
  binanceCredentialEncryptionKey: true,
  binanceApiKey: true,
  binanceApiSecret: true,
  binanceTestnet: true
});

export function validateTradingSettings(input: unknown): TradingSettings {
  const parsed = tradingSettingsSchema.parse({
    ...defaultTradingSettings,
    ...(typeof input === "object" && input !== null ? input : {}),
    watchlist: normalizeWatchlist((input as { watchlist?: unknown } | null)?.watchlist ?? defaultTradingSettings.watchlist)
  });
  if (parsed.leverage > parsed.maxLeverage) {
    throw new Error("Leverage must be less than or equal to max leverage");
  }
  if (parsed.watchlist.length === 0 && parsed.tradingEnabled) {
    throw new Error("Watchlist cannot be empty when trading is enabled");
  }
  return parsed;
}

export function applyTradingSettings(config: AppConfig, settings: TradingSettings): AppConfig {
  return schema.parse({ ...config, ...settings });
}

export function loadConfig(): AppConfig {
  return schema.parse({
    ...defaultTradingSettings,
    port: process.env.PORT,
    executionMode: process.env.EXECUTION_MODE,
    logLevel: process.env.LOG_LEVEL,
    corsOrigins: normalizeCsv(process.env.CORS_ORIGINS ?? "http://localhost:5173,http://127.0.0.1:5173"),
    symbol: normalizeWatchlist(process.env.DEFAULT_WATCHLIST ?? defaultTradingSettings.watchlist)[0],
    watchlist: normalizeWatchlist(process.env.DEFAULT_WATCHLIST ?? defaultTradingSettings.watchlist),
    databaseUrl: process.env.DATABASE_URL,
    sessionSecret: process.env.SESSION_SECRET || (process.env.NODE_ENV === "production" ? undefined : "development-session-secret-change-before-production"),
    binanceCredentialEncryptionKey:
      process.env.BINANCE_CREDENTIAL_ENCRYPTION_KEY || (process.env.NODE_ENV === "production" ? undefined : "0000000000000000000000000000000000000000000000000000000000000000"),
    binanceApiKey: process.env.BINANCE_API_KEY,
    binanceApiSecret: process.env.BINANCE_API_SECRET,
    binanceTestnet: process.env.BINANCE_TESTNET
  });
}

function normalizeWatchlist(value: unknown): string[] {
  const source = Array.isArray(value) ? value.join(",") : String(value ?? "");
  const parsed = source
    .split(",")
    .map((symbol) => symbol.trim().toUpperCase())
    .filter((symbol) => /^[A-Z0-9]{5,20}$/.test(symbol));
  return [...new Set(parsed)];
}

function normalizeCsv(value: unknown): string[] {
  const source = Array.isArray(value) ? value.join(",") : String(value ?? "");
  return [...new Set(source.split(",").map((item) => item.trim()).filter(Boolean))];
}
