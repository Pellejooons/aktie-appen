import { z } from 'zod';

export type QuoteProvider = 'yahoo';

export type Quote = {
  provider: QuoteProvider;
  symbol: string;
  currency?: string;
  price: number;
  change?: number;
  changePercent?: number;
  timestamp?: string; // ISO
};

const YahooQuoteResponseSchema = z.object({
  quoteResponse: z
    .object({
      result: z
        .array(
          z.object({
            symbol: z.string().optional(),
            currency: z.string().optional(),
            regularMarketPrice: z.number().optional(),
            regularMarketChange: z.number().optional(),
            regularMarketChangePercent: z.number().optional(),
            regularMarketTime: z.number().optional(), // seconds
          })
        )
        .optional(),
    })
    .optional(),
});

function toIsoFromEpochSeconds(s?: number): string | undefined {
  if (!s || !Number.isFinite(s)) return undefined;
  return new Date(s * 1000).toISOString();
}

export async function fetchYahooQuote(args: {
  symbol: string;
}): Promise<Quote> {
  const { symbol } = args;

  // Public yahoo endpoint (no key) – may be rate limited.
  const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbol)}`;
  const res = await fetch(url, {
    headers: {
      // Some environments get blocked without a User-Agent.
      'User-Agent': 'aktie-bmad/0.0.1',
      Accept: 'application/json',
    },
  });
  const text = await res.text().catch(() => '');
  if (!res.ok) throw new Error(`Yahoo error ${res.status}: ${text.slice(0, 500)}`);
  const json = YahooQuoteResponseSchema.parse(text ? JSON.parse(text) : {});
  const first = json.quoteResponse?.result?.[0];
  const price = first?.regularMarketPrice;
  if (typeof price !== 'number' || !Number.isFinite(price)) {
    throw new Error('Yahoo response missing regularMarketPrice');
  }
  return {
    provider: 'yahoo',
    symbol: first?.symbol ?? symbol,
    currency: first?.currency,
    price,
    change: first?.regularMarketChange,
    changePercent: first?.regularMarketChangePercent,
    timestamp: toIsoFromEpochSeconds(first?.regularMarketTime),
  };
}

type CacheEntry = { value: Quote; expiresAt: number };
const cache = new Map<string, CacheEntry>();

export async function getQuote(args: {
  symbol: string;
  ttlMs?: number;
}): Promise<Quote> {
  const { symbol } = args;
  const provider: QuoteProvider = 'yahoo';
  const ttlMs = Math.max(0, Number(args.ttlMs ?? 15_000));
  const key = `${provider}:${symbol.toUpperCase()}`;
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && hit.expiresAt > now) return hit.value;

  const value = await fetchYahooQuote({ symbol });

  cache.set(key, { value, expiresAt: now + ttlMs });
  return value;
}

export async function getQuotes(args: { symbols: string[]; ttlMs?: number }): Promise<Quote[]> {
  const uniq = [...new Set(args.symbols.map((s) => String(s ?? '').trim()).filter(Boolean))];
  const out: Quote[] = [];
  for (const s of uniq) {
    out.push(await getQuote({ symbol: s, ttlMs: args.ttlMs }));
  }
  return out;
}
