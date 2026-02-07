import Papa from 'papaparse';
import type { Holding } from './types.js';

/**
 * Very tolerant CSV parser.
 * You can adjust column detection once you paste a real Avanza CSV sample.
 */
export function parseAvanzaHoldingsCsv(csvText: string): Holding[] {
  const firstLine = csvText.split(/\r?\n/, 1)[0] ?? '';
  const delimiter = firstLine.includes(';') ? ';' : ',';

  const parsed = Papa.parse<Record<string, unknown>>(csvText, {
    header: true,
    skipEmptyLines: true,
    delimiter,
  });

  if (parsed.errors?.length) {
    const first = parsed.errors[0];
    throw new Error(`CSV parse error: ${first.message}`);
  }

  const rows = parsed.data ?? [];

  // Column detection (best-effort)
  const pick = (row: Record<string, unknown>, keys: string[]) => {
    for (const k of keys) {
      if (row[k] !== undefined && row[k] !== null && String(row[k]).trim() !== '') return String(row[k]).trim();
    }
    return undefined;
  };

  const toNumber = (v: unknown): number | undefined => {
    if (v === undefined || v === null) return undefined;
    const s = String(v).trim().replace(/\s/g, '').replace(',', '.');
    if (!s) return undefined;
    const n = Number(s);
    return Number.isFinite(n) ? n : undefined;
  };

  const holdings: Holding[] = [];

  for (const row of rows) {
    const name = pick(row, ['Namn', 'Instrument', 'Värdepapper', 'Name']) ?? '';
  const ticker = pick(row, ['Kortnamn', 'Ticker', 'Symbol', 'ISIN']) ?? name;
  const quantity = toNumber(pick(row, ['Volym', 'Antal', 'Qty', 'Quantity'])) ?? 0;
  // NOTE: We ignore GAV entirely. We compute a per-share price as Marknadsvrde / Volym.
    const marketValue = toNumber(
      pick(row, [
        'Marknadsvärde',
        'Marknadsvarde',
        'Marknadsvärde (SEK)',
        'Marknadsvarde (SEK)',
        'Marknadsvärde (kr)',
        'Marknadsvarde (kr)',
        'Marknadsvärde (SEK)'.toUpperCase(),
        'Market value',
        'Market Value',
      ])
    );
    const currency = pick(row, ['Valuta', 'Currency']);

  const computedAvgPrice = marketValue !== undefined && quantity > 0 ? marketValue / quantity : undefined;

    if (!ticker || !name) continue;
    if (!quantity || quantity <= 0) continue;

    holdings.push({
      ticker: ticker.toUpperCase(),
      name,
      quantity,
  avgPrice: computedAvgPrice,
      currency,
    });
  }

  // Deduplicate by ticker
  const byTicker = new Map<string, Holding>();
  for (const h of holdings) {
    const key = h.ticker.toUpperCase();
    const prev = byTicker.get(key);
    if (!prev) {
      byTicker.set(key, h);
    } else {
      byTicker.set(key, {
        ...prev,
        quantity: prev.quantity + h.quantity,
        // keep avgPrice if present, otherwise take new
        avgPrice: prev.avgPrice ?? h.avgPrice,
        currency: prev.currency ?? h.currency,
      });
    }
  }

  return [...byTicker.values()].sort((a, b) => a.ticker.localeCompare(b.ticker));
}
