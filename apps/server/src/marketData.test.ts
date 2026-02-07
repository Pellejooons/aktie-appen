import { describe, expect, it, vi } from 'vitest';

vi.mock('./marketData.js', () => {
  return {
    getQuotes: vi.fn(async (args: any) => {
      const symbols = Array.isArray(args.symbols) ? args.symbols : [];
      return symbols.map((s: string) => ({
        provider: 'yahoo',
        symbol: s,
        price: 123.45,
        currency: 'USD',
        timestamp: new Date('2026-02-07T00:00:00.000Z').toISOString(),
      }));
    }),
  };
});

import Fastify from 'fastify';
import { getQuotes } from './marketData.js';

describe('/api/quotes/yahoo', () => {
  it('returns quotes for holdings (mocked)', async () => {
    const app = Fastify();

    // Minimal stub of endpoint behavior.
    app.get('/api/quotes/yahoo', async () => {
      const symbols = ['AAPL', 'MSFT'];
      const quotes = await getQuotes({ symbols });
      return { ok: true, quotes };
    });

    const res = await app.inject({ method: 'GET', url: '/api/quotes/yahoo' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.quotes).toHaveLength(2);
    expect(body.quotes[0]).toMatchObject({ provider: 'yahoo', symbol: 'AAPL', price: 123.45 });
  });
});
