import type { TradingSettings } from "./AppConfig.js";

export type SettingsMode = "simple" | "advanced";
export type RiskLevel = 1 | 2 | 3 | 4 | 5;

export const riskLevels: readonly RiskLevel[] = [1, 2, 3, 4, 5];

// Fields the user still controls in simple mode; everything else comes from the preset or the stored settings.
export const simpleModeUserFields = ["watchlist", "riskPerTradeUsdt", "tradingEnabled", "killSwitch", "aiTradingMode"] as const;

export type TradingPresetValues = Pick<
  TradingSettings,
  | "marginMode"
  | "positionSizingMode"
  | "maxPositionPerSymbol"
  | "stopLossBufferMode"
  | "emaPeriod"
  | "swingLeft"
  | "swingRight"
  | "stopLossBufferPercent"
  | "stopLossAtrPeriod"
  | "stopLossAtrMultiplier"
  | "displacementBodyMultiplier"
  | "displacementLookback"
  | "minimumRiskReward"
  | "maxLeverage"
  | "maxMarginUsagePercent"
  | "maxTotalMarginUsagePercent"
  | "maxOpenPositions"
  | "dailyLossLimitR"
  | "dailyProfitLimitR"
  | "maxDrawdownPercent"
  | "requireDisplacement"
  | "stopLossBufferTicks"
  | "liquidationSafetyBufferPercent"
  | "entryMode"
>;

export interface TradingPreset {
  level: RiskLevel;
  label: string;
  description: string;
  values: TradingPresetValues;
}

// Shared by every level so simple mode is fully determined by the chosen level.
const commonPresetValues = {
  marginMode: "ISOLATED",
  positionSizingMode: "risk-based",
  maxPositionPerSymbol: 1,
  stopLossBufferMode: "ticks",
  emaPeriod: 50,
  swingLeft: 2,
  swingRight: 2,
  stopLossBufferPercent: 0.1,
  stopLossAtrPeriod: 14,
  stopLossAtrMultiplier: 1,
  displacementBodyMultiplier: 1.5,
  displacementLookback: 20
} as const satisfies Partial<TradingPresetValues>;

export const tradingPresets: readonly TradingPreset[] = [
  {
    level: 1,
    label: "Rất an toàn",
    description: "Ưu tiên bảo toàn vốn: đòn bẩy thấp, chỉ 1 lệnh, RR tối thiểu 3, cần displacement, vào lệnh limit.",
    values: {
      ...commonPresetValues,
      minimumRiskReward: 3,
      maxLeverage: 5,
      maxMarginUsagePercent: 10,
      maxTotalMarginUsagePercent: 30,
      maxOpenPositions: 1,
      dailyLossLimitR: 1,
      dailyProfitLimitR: 3,
      maxDrawdownPercent: 5,
      requireDisplacement: true,
      stopLossBufferTicks: 10,
      liquidationSafetyBufferPercent: 1,
      entryMode: "limit"
    }
  },
  {
    level: 2,
    label: "An toàn",
    description: "Thận trọng: đòn bẩy vừa phải, RR tối thiểu 2.5, cần displacement, vào lệnh limit.",
    values: {
      ...commonPresetValues,
      minimumRiskReward: 2.5,
      maxLeverage: 10,
      maxMarginUsagePercent: 15,
      maxTotalMarginUsagePercent: 40,
      maxOpenPositions: 1,
      dailyLossLimitR: 2,
      dailyProfitLimitR: 5,
      maxDrawdownPercent: 8,
      requireDisplacement: true,
      stopLossBufferTicks: 8,
      liquidationSafetyBufferPercent: 0.75,
      entryMode: "limit"
    }
  },
  {
    level: 3,
    label: "Cân bằng",
    description: "Cân bằng giữa an toàn và cơ hội: RR tối thiểu 2, tối đa 2 lệnh, vào lệnh market.",
    values: {
      ...commonPresetValues,
      minimumRiskReward: 2,
      maxLeverage: 20,
      maxMarginUsagePercent: 20,
      maxTotalMarginUsagePercent: 60,
      maxOpenPositions: 2,
      dailyLossLimitR: 3,
      dailyProfitLimitR: 8,
      maxDrawdownPercent: 10,
      requireDisplacement: false,
      stopLossBufferTicks: 5,
      liquidationSafetyBufferPercent: 0.5,
      entryMode: "market"
    }
  },
  {
    level: 4,
    label: "Mạo hiểm",
    description: "Nhiều cơ hội hơn: RR tối thiểu 1.5, đòn bẩy cao, tối đa 3 lệnh cùng lúc.",
    values: {
      ...commonPresetValues,
      minimumRiskReward: 1.5,
      maxLeverage: 50,
      maxMarginUsagePercent: 30,
      maxTotalMarginUsagePercent: 70,
      maxOpenPositions: 3,
      dailyLossLimitR: 4,
      dailyProfitLimitR: 10,
      maxDrawdownPercent: 15,
      requireDisplacement: false,
      stopLossBufferTicks: 3,
      liquidationSafetyBufferPercent: 0.4,
      entryMode: "market"
    }
  },
  {
    level: 5,
    label: "Rất mạo hiểm",
    description: "Tối đa cơ hội, rủi ro cao: RR tối thiểu 1.2, đòn bẩy rất cao, tối đa 5 lệnh cùng lúc.",
    values: {
      ...commonPresetValues,
      minimumRiskReward: 1.2,
      maxLeverage: 75,
      maxMarginUsagePercent: 40,
      maxTotalMarginUsagePercent: 80,
      maxOpenPositions: 5,
      dailyLossLimitR: 5,
      dailyProfitLimitR: 15,
      maxDrawdownPercent: 20,
      requireDisplacement: false,
      stopLossBufferTicks: 2,
      liquidationSafetyBufferPercent: 0.3,
      entryMode: "market"
    }
  }
];

export function getTradingPreset(level: number): TradingPreset {
  const preset = tradingPresets.find((item) => item.level === level);
  if (!preset) throw new Error(`Invalid risk level: ${level}`);
  return preset;
}

// Overlays the preset of settings.riskLevel when the settings are in simple mode; advanced settings pass through.
export function applyTradingPreset<T extends TradingPresetValues & { settingsMode: SettingsMode; riskLevel: number }>(settings: T): T {
  if (settings.settingsMode !== "simple") return settings;
  return { ...settings, ...getTradingPreset(settings.riskLevel).values };
}

// Builds the settings to save from a request. In simple mode only the user-specific fields are taken from the
// request; every other field keeps its current value and the preset fields are derived later from riskLevel.
export function resolveSettingsInput(input: unknown, current: TradingSettings): unknown {
  if (typeof input !== "object" || input === null) return input;
  const source = input as Record<string, unknown>;
  if (source.settingsMode !== "simple") return input;
  const resolved: Record<string, unknown> = { ...current, settingsMode: "simple", riskLevel: "riskLevel" in source ? source.riskLevel : current.riskLevel };
  for (const field of simpleModeUserFields) {
    if (field in source) resolved[field] = source[field];
  }
  return resolved;
}
