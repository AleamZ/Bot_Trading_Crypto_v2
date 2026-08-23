export interface FuturesSymbolRules {
  symbol: string;
  status: string;
  contractType: string | null;
  quoteAsset: string | null;
  marginAsset: string | null;
  pricePrecision: number | null;
  quantityPrecision: number | null;
  tickSize: number;
  minPrice: number | null;
  maxPrice: number | null;
  stepSize: number;
  minQty: number;
  maxQty: number | null;
  minNotional: number | null;
  maxLeverage: number | null;
  supportedOrderTypes: string[];
}

export interface NormalizedOrderValues {
  quantity: number;
  price: number | null;
  stopPrice: number | null;
}

export interface SymbolRuleValidationInput {
  symbol: string;
  orderType: string;
  quantity: number;
  price?: number | null;
  stopPrice?: number | null;
  notional: number;
  leverage: number;
}

export interface SymbolRuleValidationResult {
  ok: boolean;
  reason: string | null;
  normalized: NormalizedOrderValues;
}

export function normalizeQuantity(quantity: number, stepSize: number): number {
  return normalizeDown(quantity, stepSize);
}

export function normalizePrice(price: number, tickSize: number): number {
  return normalizeDown(price, tickSize);
}

export function validateAgainstSymbolRules(rules: FuturesSymbolRules, input: SymbolRuleValidationInput): SymbolRuleValidationResult {
  const quantity = normalizeQuantity(input.quantity, rules.stepSize);
  const price = input.price === null || input.price === undefined ? null : normalizePrice(input.price, rules.tickSize);
  const stopPrice = input.stopPrice === null || input.stopPrice === undefined ? null : normalizePrice(input.stopPrice, rules.tickSize);
  const normalized = { quantity, price, stopPrice };

  if (input.symbol !== rules.symbol) return fail("SYMBOL_RULE_MISMATCH", normalized);
  if (rules.status !== "TRADING") return fail("SYMBOL_NOT_TRADING", normalized);
  if (!rules.supportedOrderTypes.includes(input.orderType)) return fail("UNSUPPORTED_ORDER_TYPE", normalized);
  if (input.quantity > 0 && input.quantity < rules.minQty) return fail("MIN_QTY", normalized);
  if (!Number.isFinite(quantity) || quantity <= 0) return fail("INVALID_QUANTITY", normalized);
  if (quantity < rules.minQty) return fail("MIN_QTY", normalized);
  if (rules.maxQty !== null && quantity > rules.maxQty) return fail("MAX_QTY", normalized);
  if (rules.minNotional !== null && input.notional < rules.minNotional) return fail("MIN_NOTIONAL", normalized);
  if (rules.maxLeverage !== null && input.leverage > rules.maxLeverage) return fail("MAX_LEVERAGE", normalized);
  if (price !== null && (!Number.isFinite(price) || price <= 0)) return fail("INVALID_PRICE", normalized);
  if (stopPrice !== null && (!Number.isFinite(stopPrice) || stopPrice <= 0)) return fail("INVALID_STOP_PRICE", normalized);
  if (price !== null && rules.minPrice !== null && price < rules.minPrice) return fail("MIN_PRICE", normalized);
  if (stopPrice !== null && rules.minPrice !== null && stopPrice < rules.minPrice) return fail("MIN_PRICE", normalized);
  if (price !== null && rules.maxPrice !== null && price > rules.maxPrice) return fail("MAX_PRICE", normalized);
  if (stopPrice !== null && rules.maxPrice !== null && stopPrice > rules.maxPrice) return fail("MAX_PRICE", normalized);

  return { ok: true, reason: null, normalized };
}

export function formatRuleNumber(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  const fixed = value.toFixed(Math.min(decimalPlaces(value), 12));
  return fixed.includes(".") ? fixed.replace(/\.?0+$/, "") : fixed;
}

function normalizeDown(value: number, increment: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  if (!Number.isFinite(increment) || increment <= 0) return Number(value.toFixed(8));
  const precision = decimalPlaces(increment);
  const scale = 10 ** precision;
  const normalized = Math.floor((value * scale) / (increment * scale)) * increment;
  return Number(normalized.toFixed(precision));
}

function decimalPlaces(value: number): number {
  const text = value.toString();
  if (text.includes("e-")) return Number(text.split("e-")[1] ?? 8);
  return text.includes(".") ? text.split(".")[1]?.length ?? 0 : 0;
}

function fail(reason: string, normalized: NormalizedOrderValues): SymbolRuleValidationResult {
  return { ok: false, reason, normalized };
}
