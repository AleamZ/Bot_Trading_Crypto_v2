/** Public RSS feeds the chat reads for market news; no API key needed. */
export const DEFAULT_NEWS_FEEDS: readonly NewsFeed[] = [
  { source: "Cointelegraph", url: "https://cointelegraph.com/rss" },
  { source: "CoinDesk", url: "https://www.coindesk.com/arc/outboundfeeds/rss/" },
  { source: "Decrypt", url: "https://decrypt.co/feed" }
];

export const NEWS_CACHE_MS = 5 * 60_000;
export const NEWS_FETCH_TIMEOUT_MS = 8_000;
export const NEWS_MAX_ITEMS = 15;

export interface NewsFeed {
  source: string;
  url: string;
}

export interface NewsItem {
  title: string;
  source: string;
  link: string;
  publishedAt: string | null;
  summary: string;
}

export interface NewsResult {
  fetchedAt: string;
  query: { coin: string | null; keywords: string[] };
  items: NewsItem[];
  /** Feeds that failed this time, so the model says the picture may be incomplete. */
  unavailable: string[];
}

/** Common names per base asset; any other coin is matched by its ticker and the caller's keywords. */
const COIN_KEYWORDS: Record<string, string[]> = {
  BTC: ["bitcoin", "btc"],
  ETH: ["ethereum", "ether", "eth"],
  BNB: ["bnb", "binance coin", "bnb chain"],
  SOL: ["solana", "sol"],
  XRP: ["xrp", "ripple"],
  DOGE: ["dogecoin", "doge"],
  ADA: ["cardano", "ada"],
  AVAX: ["avalanche", "avax"],
  LINK: ["chainlink"],
  DOT: ["polkadot"],
  TON: ["toncoin", "ton"],
  TRX: ["tron", "trx"],
  LTC: ["litecoin", "ltc"],
  SUI: ["sui"],
  PEPE: ["pepe"],
  SHIB: ["shiba inu", "shib"]
};

/** Latest crypto headlines from public RSS feeds, cached per feed and filtered by coin. */
export class CryptoNewsService {
  private readonly cache = new Map<string, { expiresAt: number; items: NewsItem[] }>();
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(
    private readonly options: { feeds?: readonly NewsFeed[]; fetchImpl?: typeof fetch; now?: () => number; cacheMs?: number; timeoutMs?: number } = {}
  ) {
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.now = options.now ?? Date.now;
  }

  async latest(params: { coin?: string | null; keywords?: readonly string[]; limit?: number } = {}): Promise<NewsResult> {
    const coin = normalizeCoin(params.coin);
    const keywords = [...new Set([...(coin ? COIN_KEYWORDS[coin] ?? [coin.toLowerCase()] : []), ...(params.keywords ?? []).map((word) => word.trim().toLowerCase()).filter((word) => word.length >= 2)])];
    const limit = Math.min(Math.max(Math.floor(params.limit ?? 8), 1), NEWS_MAX_ITEMS);
    const unavailable: string[] = [];
    const feeds = await Promise.all(
      (this.options.feeds ?? DEFAULT_NEWS_FEEDS).map(async (feed) => {
        try {
          return await this.feedItems(feed);
        } catch {
          unavailable.push(feed.source);
          return [];
        }
      })
    );
    const matchers = keywords.map((word) => new RegExp(`(^|[^a-z0-9])${escapeRegExp(word)}([^a-z0-9]|$)`, "i"));
    const items = feeds
      .flat()
      .filter((item) => matchers.length === 0 || matchers.some((matcher) => matcher.test(`${item.title} ${item.summary}`)))
      .sort((a, b) => Date.parse(b.publishedAt ?? "") - Date.parse(a.publishedAt ?? "") || 0)
      .filter((item, index, all) => all.findIndex((other) => other.title === item.title) === index)
      .slice(0, limit);
    return { fetchedAt: new Date(this.now()).toISOString(), query: { coin, keywords }, items, unavailable };
  }

  private async feedItems(feed: NewsFeed): Promise<NewsItem[]> {
    const cached = this.cache.get(feed.url);
    if (cached && cached.expiresAt > this.now()) return cached.items;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? NEWS_FETCH_TIMEOUT_MS);
    try {
      const response = await this.fetchImpl(feed.url, { headers: { accept: "application/rss+xml, application/xml, text/xml" }, signal: controller.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const items = parseRssItems(await response.text(), feed.source);
      this.cache.set(feed.url, { expiresAt: this.now() + (this.options.cacheMs ?? NEWS_CACHE_MS), items });
      return items;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Minimal RSS 2.0 reader: title, link, pubDate and a plain-text description per <item>. */
export function parseRssItems(xml: string, source: string): NewsItem[] {
  const items: NewsItem[] = [];
  for (const match of xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)) {
    const block = match[1] ?? "";
    const title = plainText(tagText(block, "title"));
    const link = plainText(tagText(block, "link")) || plainText(/<guid\b[^>]*>([\s\S]*?)<\/guid>/i.exec(block)?.[1] ?? "");
    if (!title) continue;
    const published = Date.parse(plainText(tagText(block, "pubDate")));
    items.push({
      title,
      source,
      link,
      publishedAt: Number.isFinite(published) ? new Date(published).toISOString() : null,
      summary: truncate(plainText(tagText(block, "description")), 280)
    });
  }
  return items;
}

function tagText(block: string, tag: string): string {
  return new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "i").exec(block)?.[1] ?? "";
}

function plainText(text: string): string {
  return decodeEntities(
    text
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/\s+/g, " ")
    .trim();
}

function decodeEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

function normalizeCoin(coin: string | null | undefined): string | null {
  const value = String(coin ?? "").trim().toUpperCase().replace(/USDT$/, "");
  return /^[A-Z0-9]{2,15}$/.test(value) ? value : null;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
