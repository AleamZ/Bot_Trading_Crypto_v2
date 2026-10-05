import { fetchAccountActivity, fetchCandles, fetchOverlays } from "./api/ChartApi.js";
import { BOSRenderer } from "./renderer/BOSRenderer.js";
import { CandleRenderer } from "./renderer/CandleRenderer.js";
import { CHOCHRenderer } from "./renderer/CHOCHRenderer.js";
import { EMARenderer } from "./renderer/EMARenderer.js";
import { FVGRenderer } from "./renderer/FVGRenderer.js";
import { LiquidityRenderer } from "./renderer/LiquidityRenderer.js";
import { PositionRenderer } from "./renderer/PositionRenderer.js";
import { SwingRenderer } from "./renderer/SwingRenderer.js";
import { TradeRenderer } from "./renderer/TradeRenderer.js";

export class TradingChart {
  constructor({
    container,
    overlayRoot,
    statusElement,
    accountTableHead = null,
    positionsBody = null,
    positionsCount = null,
    openOrdersCount = null,
    orderHistoryCount = null,
    tradeHistoryCount = null,
    tabButtons = [],
    hideOtherSymbolsInput = null,
  }) {
    this.container = container;
    this.overlayRoot = overlayRoot;
    this.statusElement = statusElement;
    this.accountTableHead = accountTableHead;
    this.positionsBody = positionsBody;
    this.positionsCount = positionsCount;
    this.openOrdersCount = openOrdersCount;
    this.orderHistoryCount = orderHistoryCount;
    this.tradeHistoryCount = tradeHistoryCount;
    this.tabButtons = tabButtons;
    this.hideOtherSymbolsInput = hideOtherSymbolsInput;
    this.activeAccountTab = "positions";
    this.accountTables = {
      positions: [],
      openOrders: [],
      orderHistory: [],
      tradeHistory: [],
    };
    this.lastKey = null;
    this.lastLoadParams = null;
    this.loadSequence = 0;
    this.createChart();
    this.bindAccountTabs();
    this.bindActivityFilter();

    window.addEventListener("resize", () => this.resize());
    container.addEventListener(
      "wheel",
      (event) => {
        event.preventDefault();
        this.refreshDomOverlays();
      },
      { passive: false },
    );
    container.addEventListener("pointermove", () => this.refreshDomOverlays());
  }

  createChart() {
    this.chart = LightweightCharts.createChart(this.container, {
      height: 560,
      autoSize: true,
      layout: {
        background: { color: "transparent" },
        textColor: "#17202a",
      },
      grid: {
        vertLines: { color: "#edf1f6" },
        horzLines: { color: "#edf1f6" },
      },
      rightPriceScale: {
        borderColor: "#d7dee8",
        autoScale: true,
        scaleMargins: { top: 0.08, bottom: 0.18 },
      },
      timeScale: {
        borderColor: "#d7dee8",
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 12,
        barSpacing: 8,
        fixLeftEdge: false,
        fixRightEdge: false,
        tickMarkFormatter: formatUtc7Time,
      },
      localization: {
        timeFormatter: formatUtc7Time,
      },
      crosshair: {
        mode: LightweightCharts.CrosshairMode.Normal,
      },
      handleScroll: {
        mouseWheel: true,
        pressedMouseMove: true,
        horzTouchDrag: true,
        vertTouchDrag: true,
      },
      handleScale: {
        axisPressedMouseMove: { time: true, price: true },
        axisDoubleClickReset: { time: true, price: true },
        mouseWheel: true,
        pinch: true,
      },
    });

    this.candles = new CandleRenderer(this.chart);
    this.ema = new EMARenderer(this.chart);
    this.fvg = new FVGRenderer({
      chart: this.chart,
      priceSeries: this.candles.candleSeries,
      overlayRoot: this.overlayRoot,
    });
    this.bos = new BOSRenderer({
      chart: this.chart,
      priceSeries: this.candles.candleSeries,
      overlayRoot: this.overlayRoot,
    });
    this.choch = new CHOCHRenderer({
      chart: this.chart,
      priceSeries: this.candles.candleSeries,
      overlayRoot: this.overlayRoot,
    });
    this.liquidity = new LiquidityRenderer({
      chart: this.chart,
      priceSeries: this.candles.candleSeries,
      overlayRoot: this.overlayRoot,
    });
    this.swing = new SwingRenderer(this.candles.candleSeries);
    this.trade = new TradeRenderer(this.candles.candleSeries);
    this.position = new PositionRenderer({
      chart: this.chart,
      priceSeries: this.candles.candleSeries,
      overlayRoot: this.overlayRoot,
    });

    this.chart.timeScale().subscribeVisibleLogicalRangeChange(() => this.refreshDomOverlays());
    this.chart.subscribeCrosshairMove(() => this.refreshDomOverlays());
  }

  async load({ accountId = null, symbol, interval, limit }) {
    this.lastLoadParams = { accountId, symbol, interval, limit };
    const sequence = ++this.loadSequence;
    const key = `${accountId ?? "legacy"}:${symbol}:${interval}`;
    const resetRange = this.lastKey !== key;
    if (resetRange && this.lastKey !== null) {
      this.resetChart();
      this.clearAccountTables();
    }
    const visibleRange = resetRange ? null : this.chart.timeScale().getVisibleLogicalRange();
    const [candlePayload, overlayPayload, accountActivity] = await Promise.all([
      fetchCandles({ symbol, interval, limit }),
      fetchOverlays({ accountId, symbol, interval, limit: 200 }),
      fetchAccountActivity({
        accountId,
        symbol: this.hideOtherSymbolsInput?.checked === false ? null : symbol,
        limit: 100,
      }),
    ]);
    if (sequence !== this.loadSequence) return;

    const candles = (candlePayload.klines ?? []).map((kline) => ({
      id: `${candlePayload.symbol}:${candlePayload.interval}:${kline.openTime}`,
      symbol: candlePayload.symbol,
      timeframe: candlePayload.interval,
      time: kline.time,
      open: kline.open,
      high: kline.high,
      low: kline.low,
      close: kline.close,
      volume: kline.volume,
      createdAt: kline.time,
      updatedAt: kline.time,
      status: "closed",
    }));

    this.candles.render(candles);
    this.fvg.setTimeline(candles);
    this.liquidity.setTimeline(candles);
    this.bos.setTimeline(candles);
    this.choch.setTimeline(candles);
    this.position.setTimeline(candles);
    this.ema.render(overlayPayload.ema ?? []);
    this.fvg.render(overlayPayload.fvg ?? []);
    this.bos.render(overlayPayload.bos ?? []);
    this.choch.render(overlayPayload.choch ?? []);
    this.liquidity.render(overlayPayload.externalLiquidity ?? []);
    this.position.render(overlayPayload.positions ?? []);
    this.setAccountTables(accountActivity);
    this.swing.render(this.trade.render(overlayPayload.trades ?? []));

    if (visibleRange) {
      this.chart.timeScale().setVisibleLogicalRange(visibleRange);
    } else {
      this.chart.timeScale().fitContent();
    }

    this.lastKey = key;
    const visibleTotal =
      (overlayPayload.fvg ?? []).length +
      (overlayPayload.bos ?? []).length +
      (overlayPayload.choch ?? []).length +
      (overlayPayload.positions ?? []).length +
      this.liquidity.visibleCount();
    this.statusElement.textContent = `${symbol} · ${interval} · ${candles.length} candles · ${visibleTotal} overlays`;
    this.refreshDomOverlays();
  }

  cancelPendingLoad() {
    this.loadSequence += 1;
    this.clearAccountTables();
  }

  resetChart() {
    this.chart.remove();
    this.overlayRoot.replaceChildren();
    this.createChart();
  }

  resize() {
    this.chart.applyOptions({ width: this.container.clientWidth });
    this.refreshDomOverlays();
  }

  refreshDomOverlays() {
    this.fvg.refresh();
    this.liquidity.refresh();
    this.bos.refresh();
    this.choch.refresh();
    this.position.refresh();
  }

  bindAccountTabs() {
    for (const button of this.tabButtons) {
      button.addEventListener("click", () => {
        this.activeAccountTab = button.dataset.accountTab ?? "positions";
        this.renderAccountTable();
      });
    }
  }

  bindActivityFilter() {
    this.hideOtherSymbolsInput?.addEventListener("change", () => {
      if (this.lastLoadParams) this.load(this.lastLoadParams);
    });
  }

  clearAccountTables() {
    this.accountTables = {
      positions: [],
      openOrders: [],
      orderHistory: [],
      tradeHistory: [],
    };
    if (this.positionsCount) this.positionsCount.textContent = "0";
    if (this.openOrdersCount) this.openOrdersCount.textContent = "0";
    if (this.orderHistoryCount) this.orderHistoryCount.textContent = "0";
    if (this.tradeHistoryCount) this.tradeHistoryCount.textContent = "0";
    this.renderAccountTable();
  }

  setAccountTables(accountActivity) {
    const originBySymbol = botOriginBySymbol([...(accountActivity?.openOrders ?? []), ...(accountActivity?.orderHistory ?? [])]);
    this.accountTables = {
      positions: (accountActivity?.positions ?? []).map((position) => ({ ...toAccountPositionRow(position), origin: originBySymbol.get(position.symbol) ?? null })),
      openOrders: accountActivity?.openOrders ?? [],
      orderHistory: accountActivity?.orderHistory ?? [],
      tradeHistory: accountActivity?.tradeHistory ?? [],
    };

    if (this.positionsCount) this.positionsCount.textContent = String(this.accountTables.positions.length);
    if (this.openOrdersCount) this.openOrdersCount.textContent = String(this.accountTables.openOrders.length);
    if (this.orderHistoryCount) this.orderHistoryCount.textContent = String(this.accountTables.orderHistory.length);
    if (this.tradeHistoryCount) this.tradeHistoryCount.textContent = String(this.accountTables.tradeHistory.length);
    this.renderAccountTable();
  }

  renderAccountTable() {
    if (!this.positionsBody) return;
    for (const button of this.tabButtons) {
      button.classList.toggle("active", button.dataset.accountTab === this.activeAccountTab);
    }

    if (this.activeAccountTab === "positions") {
      this.renderPositions(this.accountTables.positions);
      return;
    }

    if (this.activeAccountTab === "openOrders") {
      this.renderOpenOrders(this.accountTables.openOrders);
      return;
    }

    if (this.activeAccountTab === "orderHistory") {
      this.renderOrderHistory(this.accountTables.orderHistory);
      return;
    }

    this.renderTradeHistory(this.accountTables.tradeHistory);
  }

  renderPositions(positions) {
    this.renderHeader(["Symbol", "Size", "Entry Price", "Stop Loss", "Take Profit", "Margin", "PNL", "Risk/Reward", "Source"]);

    const rows = positions
      .filter((position) => position.state === "active")
      .sort((a, b) => sourceRank(a.source) - sourceRank(b.source));

    if (rows.length === 0) {
      this.renderEmpty("No positions", 9);
      return;
    }

    this.positionsBody.replaceChildren(
      ...rows.map((position) => {
        const row = document.createElement("tr");
        row.className = `position-row ${position.side ?? ""} ${position.state ?? ""}`;

        row.append(
          positionSymbolCell(position),
          positionSizeCell(position),
          textCell(formatPrice(position.entry)),
          priceCell(position.stopLoss, "danger"),
          priceCell(position.takeProfit, "profit"),
          textCell(formatMargin(position)),
          pnlCell(position),
          textCell(formatRatio(position.riskReward)),
          sourceCell(position, position.origin),
        );
        return row;
      }),
    );
  }

  renderOpenOrders(orders) {
    this.renderHeader(["Symbol", "Order", "Side", "Price", "Stop Price", "Quantity", "Filled", "Reduce Only", "Updated"]);

    if (orders.length === 0) {
      this.renderEmpty("No open orders", 9);
      return;
    }

    this.positionsBody.replaceChildren(
      ...orders.map((order) => {
        const row = document.createElement("tr");
        row.className = `position-row ${sideClass(order.side)}`;
        row.append(
          withOriginBadge(stackedCell(order.symbol, order.status), orderOrigin(order)),
          stackedCell(order.type, `#${order.orderId}`),
          toneCell(order.side, sideClass(order.side)),
          textCell(formatNullablePrice(order.price)),
          textCell(formatNullablePrice(order.stopPrice)),
          textCell(formatQuantity(order.quantity)),
          textCell(formatQuantity(order.executedQuantity)),
          textCell(order.reduceOnly ? "Yes" : "No"),
          textCell(formatTime(order.updatedAt)),
        );
        return row;
      }),
    );
  }

  renderOrderHistory(orders) {
    this.renderHeader(["Symbol", "Order", "Side", "Avg Price", "Price", "Quantity", "Filled", "Status", "Updated"]);

    if (orders.length === 0) {
      this.renderEmpty("No order history", 9);
      return;
    }

    this.positionsBody.replaceChildren(
      ...orders.map((order) => {
        const row = document.createElement("tr");
        row.className = `position-row ${sideClass(order.side)}`;
        row.append(
          withOriginBadge(stackedCell(order.symbol, order.type), orderOrigin(order)),
          textCell(`#${order.orderId}`),
          toneCell(order.side, sideClass(order.side)),
          textCell(formatNullablePrice(order.averagePrice)),
          textCell(formatNullablePrice(order.price)),
          textCell(formatQuantity(order.quantity)),
          textCell(formatQuantity(order.executedQuantity)),
          textCell(order.status ?? "-"),
          textCell(formatTime(order.updatedAt)),
        );
        return row;
      }),
    );
  }

  renderTradeHistory(trades) {
    this.renderHeader(["Symbol", "Trade", "Side", "Price", "Quantity", "Quote", "Realized PNL", "Commission", "Time"]);

    if (trades.length === 0) {
      this.renderEmpty("No trade history", 9);
      return;
    }

    this.positionsBody.replaceChildren(
      ...trades.map((trade) => {
        const row = document.createElement("tr");
        row.className = `position-row ${sideClass(trade.side)}`;
        row.append(
          stackedCell(trade.symbol, `Order #${trade.orderId}`),
          textCell(`#${trade.tradeId}`),
          toneCell(trade.side, sideClass(trade.side)),
          textCell(formatPrice(trade.price)),
          textCell(formatQuantity(trade.quantity)),
          textCell(formatUsdt(trade.quoteQuantity)),
          pnlValueCell(trade.realizedPnl),
          textCell(`${formatQuantity(trade.commission)} ${trade.commissionAsset ?? ""}`.trim()),
          textCell(formatTime(trade.createdAt)),
        );
        return row;
      }),
    );
  }

  renderHeader(labels) {
    if (!this.accountTableHead) return;
    const row = document.createElement("tr");
    row.append(...labels.map((label) => {
      const cell = document.createElement("th");
      cell.textContent = label;
      return cell;
    }));
    this.accountTableHead.replaceChildren(row);
  }

  renderEmpty(message, colSpan) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.className = "empty-position";
    cell.colSpan = colSpan;
    cell.textContent = message;
    row.append(cell);
    this.positionsBody.replaceChildren(row);
  }
}

function formatUtc7Time(time) {
  const timestamp = typeof time === "number" ? time : Date.parse(`${time.year}-${time.month}-${time.day}T00:00:00Z`) / 1000;
  const date = new Date((timestamp + 7 * 60 * 60) * 1000);
  const day = String(date.getUTCDate()).padStart(2, "0");
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const hour = String(date.getUTCHours()).padStart(2, "0");
  const minute = String(date.getUTCMinutes()).padStart(2, "0");
  return `${day}/${month} ${hour}:${minute}`;
}

function sourceRank(source) {
  if (source === "binance") return 0;
  if (source === "manual") return 0;
  if (source === "bot") return 1;
  return 2;
}

function toAccountPositionRow(position) {
  return {
    ...position,
    state: "active",
    source: position.source ?? "binance",
    entry: position.entryPrice,
    positionSize: position.notional,
    pnl: position.unrealizedProfit,
    riskReward: null,
  };
}

function positionSymbolCell(position) {
  const cell = document.createElement("td");
  const symbol = document.createElement("strong");
  const meta = document.createElement("span");
  symbol.textContent = position.symbol ?? "-";
  meta.textContent = `${formatSide(position.side)} · ${formatState(position.state)} · ${formatLeverage(position.leverage)}`;
  cell.append(symbol, meta);
  return cell;
}

function textCell(value) {
  const cell = document.createElement("td");
  cell.textContent = value;
  return cell;
}

function stackedCell(title, detail) {
  const cell = document.createElement("td");
  const strong = document.createElement("strong");
  const small = document.createElement("span");
  strong.textContent = title ?? "-";
  small.textContent = detail ?? "-";
  cell.append(strong, small);
  return cell;
}

function toneCell(value, tone) {
  const cell = document.createElement("td");
  cell.className = tone;
  cell.textContent = value ?? "-";
  return cell;
}

function positionSizeCell(position) {
  const cell = document.createElement("td");
  const notional = document.createElement("strong");
  const quantity = document.createElement("span");
  notional.textContent = formatUsdt(position.positionSize);
  quantity.textContent = `Qty ${formatQuantity(position.quantity)}`;
  cell.append(notional, quantity);
  return cell;
}

function priceCell(value, tone) {
  const cell = document.createElement("td");
  cell.className = tone;
  cell.textContent = value === null || value === undefined ? "--" : formatPrice(value);
  return cell;
}

function pnlCell(position) {
  const cell = document.createElement("td");
  const pnl = Number(position.pnl ?? 0);
  const estimatedProfit = Number(position.estimatedProfit ?? 0);
  const value = position.pnl === null || position.pnl === undefined ? estimatedProfit : pnl;
  cell.className = value >= 0 ? "profit" : "danger";
  cell.textContent = formatUsdt(value);
  return cell;
}

function pnlValueCell(value) {
  const cell = document.createElement("td");
  const number = Number(value ?? 0);
  cell.className = number >= 0 ? "profit" : "danger";
  cell.textContent = formatUsdt(number);
  return cell;
}

function sourceCell(position, origin = null) {
  const cell = document.createElement("td");
  const badge = document.createElement("span");
  badge.className = `source-badge ${position.source ?? "unknown"}`;
  badge.textContent = position.source === "binance" || position.source === "manual" ? "Binance" : "Bot";
  cell.append(badge);
  return withOriginBadge(cell, origin);
}

// Bot client order ids: `smc_ai<22 hex>_E/_S/_T` for AI decisions, `smc_<24 hex>_*` for the strategy engine.
function orderOrigin(order) {
  const clientOrderId = String(order?.clientOrderId ?? "");
  if (clientOrderId.startsWith("smc_ai")) return "AI";
  if (clientOrderId.startsWith("smc_")) return "BOT";
  return null;
}

// A position carries no client id; its bot SL/TP or entry orders on the same symbol tell who opened it.
function botOriginBySymbol(orders) {
  const origins = new Map();
  for (const order of orders) {
    const origin = orderOrigin(order);
    if (origin && !origins.has(order.symbol)) origins.set(order.symbol, origin);
  }
  return origins;
}

function withOriginBadge(cell, origin) {
  if (!origin) return cell;
  const badge = document.createElement("span");
  badge.className = `origin-badge ${origin.toLowerCase()}`;
  badge.textContent = origin;
  badge.title = origin === "AI" ? "Lệnh do AI quyết định" : "Lệnh do bot (strategy engine) đặt";
  cell.append(badge);
  return cell;
}

function sideClass(side) {
  if (side === "BUY" || side === "long") return "long";
  if (side === "SELL" || side === "short") return "short";
  return "";
}

function formatMargin(position) {
  const margin = position.margin;
  if (margin === null || margin === undefined) return "-";
  return `${formatUsdt(margin)} (${formatLeverage(position.leverage)})`;
}

function formatSide(side) {
  if (side === "short") return "Short";
  if (side === "long") return "Long";
  return "-";
}

function formatState(state) {
  if (state === "pending") return "Pending";
  if (state === "active") return "Active";
  if (state === "closed") return "Closed";
  return "-";
}

function formatLeverage(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return "-";
  return `${number.toLocaleString("en-US", { maximumFractionDigits: 0 })}x`;
}

function formatPrice(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "-";
  return number.toLocaleString("en-US", { maximumFractionDigits: 4 });
}

function formatNullablePrice(value) {
  return value === null || value === undefined ? "--" : formatPrice(value);
}

function formatQuantity(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "-";
  return number.toLocaleString("en-US", { maximumFractionDigits: 6 });
}

function formatUsdt(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "-";
  return `${number.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USDT`;
}

function formatRatio(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return "-";
  return number.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

function formatTime(value) {
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return "-";
  return formatUtc7Time(timestamp);
}
