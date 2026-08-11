import crypto from "node:crypto";

export interface BinanceFuturesWalletStatus {
  connected: boolean;
  environment: "testnet" | "live";
  label: string;
  walletBalance: number | null;
  availableBalance: number | null;
  asset: "USDT";
  checkedAt: string;
}

export interface BinanceFuturesPositionStatus {
  id: string;
  symbol: string;
  side: "long" | "short";
  entryPrice: number;
  entryTime: number | null;
  quantity: number;
  notional: number;
  leverage: number;
  margin: number | null;
  unrealizedProfit: number;
  stopLoss: number | null;
  takeProfit: number | null;
}

export interface BinanceFuturesOpenOrderStatus {
  id: string;
  symbol: string;
  orderId: string;
  side: string;
  type: string;
  price: number | null;
  stopPrice: number | null;
  quantity: number;
  executedQuantity: number;
  status: string;
  reduceOnly: boolean;
  createdAt: number | null;
  updatedAt: number | null;
}

export interface BinanceFuturesOrderHistoryStatus extends BinanceFuturesOpenOrderStatus {
  averagePrice: number | null;
}

export interface BinanceFuturesTradeHistoryStatus {
  id: string;
  symbol: string;
  tradeId: string;
  orderId: string;
  side: string;
  price: number;
  quantity: number;
  quoteQuantity: number;
  realizedPnl: number;
  commission: number;
  commissionAsset: string | null;
  createdAt: number | null;
}

type BinanceExitSide = "BUY" | "SELL";

export class BinanceFuturesAccountClient {
  private readonly baseUrl: string;

  constructor(
    private readonly apiKey: string,
    private readonly apiSecret: string,
    private readonly testnet: boolean
  ) {
    this.baseUrl = testnet ? "https://testnet.binancefuture.com" : "https://fapi.binance.com";
  }

  async getWalletStatus(): Promise<BinanceFuturesWalletStatus> {
    const timestamp = Date.now();
    const query = new URLSearchParams({ timestamp: String(timestamp), recvWindow: "5000" });
    query.set("signature", this.sign(query.toString()));

    const response = await fetch(`${this.baseUrl}/fapi/v2/account?${query.toString()}`, {
      headers: { "X-MBX-APIKEY": this.apiKey }
    });

    if (!response.ok) {
      const text = await response.text();
      return {
        connected: false,
        environment: this.testnet ? "testnet" : "live",
        label: `Binance account check failed: ${response.status} ${text.slice(0, 180)}`,
        walletBalance: null,
        availableBalance: null,
        asset: "USDT",
        checkedAt: new Date().toISOString()
      };
    }

    const body = (await response.json()) as {
      totalWalletBalance?: string;
      availableBalance?: string;
      assets?: Array<{ asset: string; walletBalance?: string; availableBalance?: string }>;
    };
    const usdt = body.assets?.find((asset) => asset.asset === "USDT");

    return {
      connected: true,
      environment: this.testnet ? "testnet" : "live",
      label: "Binance Futures account verified",
      walletBalance: Number(usdt?.walletBalance ?? body.totalWalletBalance ?? 0),
      availableBalance: Number(usdt?.availableBalance ?? body.availableBalance ?? 0),
      asset: "USDT",
      checkedAt: new Date().toISOString()
    };
  }

  async getOpenPositions(symbol?: string): Promise<BinanceFuturesPositionStatus[]> {
    const [account, openOrders, openAlgoOrders] = await Promise.all([
      this.signedGet<AccountResponse>("/fapi/v2/account"),
      this.signedGet<OpenOrder[]>("/fapi/v1/openOrders", symbol ? { symbol } : {}),
      this.signedGet<OpenAlgoOrder[]>("/fapi/v1/openAlgoOrders", symbol ? { symbol } : {}).catch(() => [])
    ]);
    const ordersBySymbol = groupOrdersBySymbol([...openOrders, ...openAlgoOrders.map(toOpenOrder)]);
    const tradesBySymbol = await this.getTradesBySymbol(symbol, account.positions ?? []);

    return (account.positions ?? [])
      .filter((position) => !symbol || position.symbol === symbol)
      .map((position) => {
        const amount = Number(position.positionAmt ?? 0);
        const entryPrice = Number(position.entryPrice ?? 0);
        const notional = Math.abs(Number(position.notional ?? amount * entryPrice));
        if (amount === 0 || entryPrice <= 0) return null;
        const orders = ordersBySymbol.get(position.symbol) ?? [];
        const side = amount > 0 ? "long" : "short";
        const exitSide = side === "long" ? "SELL" : "BUY";
        const entryTime = findPositionEntryTime(tradesBySymbol.get(position.symbol) ?? [], amount);
        return {
          id: `binance:${position.symbol}:${side}`,
          symbol: position.symbol,
          side,
          entryPrice,
          entryTime,
          quantity: Math.abs(amount),
          notional,
          leverage: Number(position.leverage ?? 0),
          margin: Number(position.initialMargin ?? 0) || null,
          unrealizedProfit: Number(position.unrealizedProfit ?? 0),
          stopLoss: findTriggerPrice(orders, "STOP_MARKET", exitSide),
          takeProfit: findTriggerPrice(orders, "TAKE_PROFIT_MARKET", exitSide)
        };
      })
      .filter((position): position is BinanceFuturesPositionStatus => position !== null);
  }

  async getOpenOrders(symbol?: string): Promise<BinanceFuturesOpenOrderStatus[]> {
    const orders = await this.signedGet<OpenOrder[]>("/fapi/v1/openOrders", symbol ? { symbol } : {});
    return orders.map(toOpenOrderStatus);
  }

  async getOrderHistory(symbol: string, limit = 100): Promise<BinanceFuturesOrderHistoryStatus[]> {
    const orders = await this.signedGet<OrderHistoryItem[]>("/fapi/v1/allOrders", {
      symbol,
      limit: String(limit)
    });
    return orders.map(toOrderHistoryStatus).sort((a, b) => Number(b.updatedAt ?? 0) - Number(a.updatedAt ?? 0));
  }

  async getTradeHistory(symbol: string, limit = 100): Promise<BinanceFuturesTradeHistoryStatus[]> {
    const trades = await this.signedGet<UserTrade[]>("/fapi/v1/userTrades", {
      symbol,
      limit: String(limit)
    });
    return trades.map(toTradeHistoryStatus).sort((a, b) => Number(b.createdAt ?? 0) - Number(a.createdAt ?? 0));
  }

  private async signedGet<T>(path: string, queryParams: Record<string, string> = {}): Promise<T> {
    const query = new URLSearchParams({ ...queryParams, timestamp: String(Date.now()), recvWindow: "5000" });
    query.set("signature", this.sign(query.toString()));
    const response = await fetch(`${this.baseUrl}${path}?${query.toString()}`, {
      headers: { "X-MBX-APIKEY": this.apiKey }
    });

    if (!response.ok) {
      throw new Error(`Binance signed GET ${path} failed ${response.status}: ${(await response.text()).slice(0, 180)}`);
    }

    return (await response.json()) as T;
  }

  private sign(payload: string): string {
    return crypto.createHmac("sha256", this.apiSecret).update(payload).digest("hex");
  }

  private async getTradesBySymbol(symbol: string | undefined, positions: AccountResponse["positions"]): Promise<Map<string, UserTrade[]>> {
    const symbols =
      symbol !== undefined
        ? [symbol]
        : [...new Set((positions ?? []).filter((position) => Number(position.positionAmt ?? 0) !== 0).map((position) => position.symbol))];
    const entries = await Promise.all(
      symbols.map(async (item) => {
        const trades = await this.signedGet<UserTrade[]>("/fapi/v1/userTrades", { symbol: item, limit: "1000" }).catch(() => []);
        return [item, trades] as const;
      })
    );
    return new Map(entries);
  }
}

interface AccountResponse {
  positions?: Array<{
    symbol: string;
    positionAmt?: string;
    entryPrice?: string;
    notional?: string;
    leverage?: string;
    initialMargin?: string;
    unrealizedProfit?: string;
  }>;
}

interface OpenOrder {
  symbol: string;
  orderId?: number | string;
  clientOrderId?: string;
  side?: BinanceExitSide;
  type?: string;
  origQty?: string;
  executedQty?: string;
  stopPrice?: string;
  price?: string;
  status?: string;
  reduceOnly?: boolean | string;
  closePosition?: boolean | string;
  time?: number;
  updateTime?: number;
}

interface OrderHistoryItem extends OpenOrder {
  avgPrice?: string;
}

interface OpenAlgoOrder {
  symbol: string;
  side?: BinanceExitSide;
  orderType?: string;
  triggerPrice?: string;
  price?: string;
  reduceOnly?: boolean | string;
  closePosition?: boolean | string;
}

interface UserTrade {
  symbol: string;
  id?: number | string;
  orderId?: number | string;
  side?: "BUY" | "SELL";
  price?: string;
  qty?: string;
  quoteQty?: string;
  realizedPnl?: string;
  commission?: string;
  commissionAsset?: string;
  time?: number;
}

function toOpenOrderStatus(order: OpenOrder): BinanceFuturesOpenOrderStatus {
  const orderId = String(order.orderId ?? order.clientOrderId ?? `${order.symbol}:${order.side ?? "-"}:${order.type ?? "-"}:${order.time ?? 0}`);
  return {
    id: `binance:open-order:${order.symbol}:${orderId}`,
    symbol: order.symbol,
    orderId,
    side: order.side ?? "-",
    type: order.type ?? "-",
    price: numberOrNull(order.price),
    stopPrice: numberOrNull(order.stopPrice),
    quantity: Number(order.origQty ?? 0),
    executedQuantity: Number(order.executedQty ?? 0),
    status: order.status ?? "OPEN",
    reduceOnly: isTrue(order.reduceOnly) || isTrue(order.closePosition),
    createdAt: toSecondsOrNull(order.time),
    updatedAt: toSecondsOrNull(order.updateTime ?? order.time)
  };
}

function toOrderHistoryStatus(order: OrderHistoryItem): BinanceFuturesOrderHistoryStatus {
  return {
    ...toOpenOrderStatus(order),
    id: `binance:order-history:${order.symbol}:${String(order.orderId ?? order.clientOrderId ?? order.time ?? 0)}`,
    averagePrice: numberOrNull(order.avgPrice)
  };
}

function toTradeHistoryStatus(trade: UserTrade): BinanceFuturesTradeHistoryStatus {
  const tradeId = String(trade.id ?? `${trade.symbol}:${trade.orderId ?? "-"}:${trade.time ?? 0}`);
  return {
    id: `binance:trade-history:${trade.symbol}:${tradeId}`,
    symbol: trade.symbol,
    tradeId,
    orderId: String(trade.orderId ?? "-"),
    side: trade.side ?? "-",
    price: Number(trade.price ?? 0),
    quantity: Number(trade.qty ?? 0),
    quoteQuantity: Number(trade.quoteQty ?? 0),
    realizedPnl: Number(trade.realizedPnl ?? 0),
    commission: Number(trade.commission ?? 0),
    commissionAsset: trade.commissionAsset ?? null,
    createdAt: toSecondsOrNull(trade.time)
  };
}

function groupOrdersBySymbol(orders: OpenOrder[]): Map<string, OpenOrder[]> {
  const map = new Map<string, OpenOrder[]>();
  for (const order of orders) {
    const list = map.get(order.symbol) ?? [];
    list.push(order);
    map.set(order.symbol, list);
  }
  return map;
}

function findTriggerPrice(orders: OpenOrder[], type: "STOP_MARKET" | "TAKE_PROFIT_MARKET", exitSide: BinanceExitSide): number | null {
  const candidates = orders.filter((order) => order.type === type && order.side === exitSide);
  const protectedCandidates = candidates.filter((order) => isTrue(order.reduceOnly) || isTrue(order.closePosition));
  const order = protectedCandidates[0] ?? candidates[0] ?? orders.find((item) => item.type === type);
  const price = Number(order?.stopPrice ?? order?.price ?? 0);
  return price > 0 ? price : null;
}

function isTrue(value: boolean | string | undefined): boolean {
  return value === true || value === "true";
}

function numberOrNull(value: string | undefined): number | null {
  const number = Number(value ?? 0);
  return number > 0 ? number : null;
}

function toSecondsOrNull(value: number | undefined): number | null {
  if (!value || !Number.isFinite(value)) return null;
  return Math.floor(value / 1000);
}

function toOpenOrder(order: OpenAlgoOrder): OpenOrder {
  const mapped: OpenOrder = { symbol: order.symbol };
  if (order.side !== undefined) mapped.side = order.side;
  if (order.orderType !== undefined) mapped.type = order.orderType;
  if (order.triggerPrice !== undefined) mapped.stopPrice = order.triggerPrice;
  if (order.price !== undefined) mapped.price = order.price;
  if (order.reduceOnly !== undefined) mapped.reduceOnly = order.reduceOnly;
  if (order.closePosition !== undefined) mapped.closePosition = order.closePosition;
  return mapped;
}

function findPositionEntryTime(trades: UserTrade[], positionAmount: number): number | null {
  const target = Math.abs(positionAmount);
  if (target <= 0) return null;

  const sorted = [...trades].filter((trade) => trade.time !== undefined).sort((a, b) => Number(b.time) - Number(a.time));
  let accumulated = 0;
  let entryTime: number | null = null;

  for (const trade of sorted) {
    const quantity = Number(trade.qty ?? 0);
    if (quantity <= 0) continue;
    const signedQuantity = trade.side === "SELL" ? -quantity : quantity;
    accumulated += signedQuantity;
    entryTime = Number(trade.time);

    if (positionAmount > 0 && accumulated >= target) return Math.floor(entryTime / 1000);
    if (positionAmount < 0 && accumulated <= -target) return Math.floor(entryTime / 1000);
  }

  return entryTime === null ? null : Math.floor(entryTime / 1000);
}
