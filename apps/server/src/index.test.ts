import { describe, expect, it } from 'vitest';
import { parseAvanzaHoldingsCsv } from './avanzaCsv.js';
import { getStrategyDigest, listThesisDocs, setStrategyDigest, upsertThesisDoc } from './storage.js';
import Fastify from 'fastify';
import { getSchedulerStatus } from './scheduler.js';

describe('parseAvanzaHoldingsCsv', () => {
  it('parses a minimal csv with Name/Ticker/Antal', () => {
    const csv = `Namn,Ticker,Antal\nInvestor,INVE,10\n`;
    const holdings = parseAvanzaHoldingsCsv(csv);
    expect(holdings).toHaveLength(1);
    expect(holdings[0]).toMatchObject({ ticker: 'INVE', name: 'Investor', quantity: 10 });
  });

  it('parses Avanza export (semicolon, Swedish headers)', () => {
    const csv =
      'Namn;Kortnamn;Volym;Marknadsvärde;GAV (SEK);Valuta\n' +
      'Atlas Copco B;ATCO B;159;25917,00;141,92;SEK\n';
    const holdings = parseAvanzaHoldingsCsv(csv);
    expect(holdings).toHaveLength(1);
    expect(holdings[0]).toMatchObject({
      ticker: 'ATCO B',
      name: 'Atlas Copco B',
      quantity: 159,
  // Always computed as Marknadsvrde / Volym (GAV ignored)
  avgPrice: 25917 / 159,
      currency: 'SEK',
    });
  });

  it('deduplicates tickers', () => {
    const csv = `Namn,Ticker,Antal\nInvestor,INVE,10\nInvestor,INVE,2\n`;
    const holdings = parseAvanzaHoldingsCsv(csv);
    expect(holdings).toHaveLength(1);
    expect(holdings[0].quantity).toBe(12);
  });

  it('computes avgPrice as market value / quantity when GAV is missing, and keeps currency', () => {
    const csv =
      'Namn;Kortnamn;Volym;Marknadsvärde;Valuta\n' +
      'Apple;AAPL;10;2500;USD\n';
    const holdings = parseAvanzaHoldingsCsv(csv);
    expect(holdings).toHaveLength(1);
    expect(holdings[0]).toMatchObject({ ticker: 'AAPL', currency: 'USD', quantity: 10 });
    expect(holdings[0].avgPrice).toBeCloseTo(250, 8);
  });
});

describe('thesis docs', () => {
  it('can upsert and list thesis docs by meta.ticker', async () => {
    await upsertThesisDoc({ meta: { ticker: 'TEST', company: 'Test AB' }, investment_thesis: { summary: 'x' } });
    const items = await listThesisDocs();
    expect(items.some((i) => i.ticker === 'TEST')).toBe(true);
  });
});

describe('strategy digest', () => {
  it('can set and get strategy digest', async () => {
    await setStrategyDigest('Kort digest');
    const d = await getStrategyDigest();
    expect(d.text).toBe('Kort digest');
    expect(typeof d.updatedAt).toBe('string');
  });
});

describe('scheduler status', () => {
  it('exposes a stable shape via getSchedulerStatus()', async () => {
    const s = getSchedulerStatus();
    expect(typeof s.enabled).toBe('boolean');
    expect(typeof s.running).toBe('boolean');
    expect(typeof s.hour).toBe('number');
    expect(typeof s.minute).toBe('number');
  });

  it('can serve /api/scheduler from a tiny fastify instance', async () => {
    const app = Fastify();
    app.get('/api/scheduler', async () => ({ ok: true, scheduler: getSchedulerStatus() }));
    const res = await app.inject({ method: 'GET', url: '/api/scheduler' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.scheduler).toBeTruthy();
  });
});

describe('analyze query params', () => {
  it('accepts ticker and onlyWithAnalysis boolean-ish strings', async () => {
    // Mirrors the schema in index.ts
    const { z } = await import('zod');
    const querySchema = z
      .object({
        ticker: z.string().min(1).max(40).optional(),
        onlyWithAnalysis: z
          .union([
            z.literal('1'),
            z.literal('true'),
            z.literal('yes'),
            z.literal('0'),
            z.literal('false'),
            z.literal('no'),
          ])
          .optional(),
      })
      .partial();

    expect(querySchema.parse({ ticker: 'MEKO' })).toEqual({ ticker: 'MEKO' });
    expect(querySchema.parse({ onlyWithAnalysis: '1' })).toEqual({ onlyWithAnalysis: '1' });
    expect(querySchema.parse({ onlyWithAnalysis: 'false' })).toEqual({ onlyWithAnalysis: 'false' });
  });
});
