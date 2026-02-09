import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { AnalysisReport, Holding, Strategy, Thesis } from './types.js';

const dataDir = path.join(process.cwd(), 'data');
const thesesDir = path.join(dataDir, 'theses');

async function ensureDataDir() {
  await fs.mkdir(dataDir, { recursive: true });
  await fs.mkdir(thesesDir, { recursive: true });
}

async function readJsonFile<T>(file: string, fallback: T): Promise<T> {
  await ensureDataDir();
  const full = path.join(dataDir, file);
  try {
    const raw = await fs.readFile(full, 'utf8');
    return JSON.parse(raw) as T;
  } catch (err: any) {
    if (err?.code === 'ENOENT') return fallback;
    throw err;
  }
}

async function writeJsonFile<T>(file: string, value: T): Promise<void> {
  await ensureDataDir();
  const full = path.join(dataDir, file);
  const tmp = full + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
  await fs.rename(tmp, full);
}

export async function getHoldings(): Promise<Holding[]> {
  return readJsonFile<Holding[]>('holdings.json', []);
}

export async function setHoldings(holdings: Holding[]): Promise<void> {
  await writeJsonFile('holdings.json', holdings);
}

export async function getStrategy(): Promise<Strategy> {
  return readJsonFile<Strategy>('strategy.json', { text: '', updatedAt: new Date(0).toISOString() });
}

export async function setStrategy(text: string): Promise<Strategy> {
  const s: Strategy = { text, updatedAt: new Date().toISOString() };
  await writeJsonFile('strategy.json', s);
  return s;
}

// --- Strategy digest (manual, recommended for cheaper LLM calls) ---
export type StrategyDigest = { text: string; updatedAt: string };

export async function getStrategyDigest(): Promise<StrategyDigest> {
  // Always read from disk (same behavior as getStrategy) to avoid any stale in-memory state.
  return readJsonFile<StrategyDigest>('strategy_digest.json', { text: '', updatedAt: new Date(0).toISOString() });
}

export async function setStrategyDigest(text: string): Promise<StrategyDigest> {
  const d: StrategyDigest = { text, updatedAt: new Date().toISOString() };
  await writeJsonFile('strategy_digest.json', d);
  return d;
}

// --- Structured portfolio strategy (optional) ---
export type PortfolioStrategyDoc = Record<string, unknown>;

export async function getPortfolioStrategyDoc(): Promise<PortfolioStrategyDoc | null> {
  return readJsonFile<PortfolioStrategyDoc | null>('portfolio_strategy.json', null);
}

export async function setPortfolioStrategyDoc(doc: PortfolioStrategyDoc): Promise<void> {
  await writeJsonFile('portfolio_strategy.json', doc);
}

export async function getTheses(): Promise<Thesis[]> {
  return readJsonFile<Thesis[]>('theses.json', []);
}

export async function upsertThesis(ticker: string, text: string): Promise<Thesis> {
  const theses = await getTheses();
  const now = new Date().toISOString();
  const next: Thesis = { ticker, text, updatedAt: now };
  const idx = theses.findIndex((t) => t.ticker.toUpperCase() === ticker.toUpperCase());
  if (idx >= 0) theses[idx] = next;
  else theses.push(next);
  await writeJsonFile('theses.json', theses);
  return next;
}

// --- Thesis documents (preferred) ---
export type ThesisDoc = Record<string, unknown>;

function safeFilePart(value: string): string {
  return value
    .trim()
    .replace(/\s+/g, '_')
    .replace(/[^A-Za-z0-9_.-]/g, '_')
    .slice(0, 80);
}

export async function listThesisDocs(): Promise<Array<{ ticker: string; file: string }>> {
  await ensureDataDir();
  const entries = await fs.readdir(thesesDir, { withFileTypes: true });
  const files = entries.filter((e) => e.isFile() && e.name.endsWith('.json')).map((e) => e.name);
  const items: Array<{ ticker: string; file: string }> = [];
  for (const f of files) {
    try {
      const raw = await fs.readFile(path.join(thesesDir, f), 'utf8');
      const doc = JSON.parse(raw) as any;
      const ticker = String(doc?.meta?.ticker ?? '').trim();
      if (ticker) items.push({ ticker, file: f });
    } catch {
      // ignore broken files
    }
  }
  return items.sort((a, b) => a.ticker.localeCompare(b.ticker));
}

export async function getThesisDoc(ticker: string): Promise<ThesisDoc | null> {
  await ensureDataDir();
  const items = await listThesisDocs();
  const hit = items.find((i) => i.ticker.toUpperCase() === ticker.toUpperCase());
  if (!hit) return null;
  const raw = await fs.readFile(path.join(thesesDir, hit.file), 'utf8');
  return JSON.parse(raw) as ThesisDoc;
}

export async function upsertThesisDoc(doc: ThesisDoc): Promise<void> {
  await ensureDataDir();
  const meta = (doc as any).meta ?? {};
  const ticker = String(meta.ticker ?? '').trim();
  if (!ticker) throw new Error('Thesis doc missing meta.ticker');

  const company = String(meta.company ?? '').trim();
  const base = company ? `${ticker}__${company}` : ticker;
  const fileName = `${safeFilePart(base)}.json`;
  const full = path.join(thesesDir, fileName);
  const tmp = full + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(doc, null, 2), 'utf8');
  await fs.rename(tmp, full);
}

export async function listAnalysisReports(): Promise<AnalysisReport[]> {
  return readJsonFile<AnalysisReport[]>('analysis.json', []);
}

export async function addAnalysisReport(report: Omit<AnalysisReport, 'id'>): Promise<AnalysisReport> {
  const existing = await listAnalysisReports();
  const created: AnalysisReport = {
    id: crypto.randomUUID(),
    ...report,
  };
  existing.unshift(created);
  await writeJsonFile('analysis.json', existing);
  return created;
}

// --- Analysis prompt config (editable without code changes) ---
export type AnalysisPromptConfig = {
  version: number;
  systemPreambleSv: string;
  decisionRulesSv: string;
};

const defaultAnalysisPromptConfig: AnalysisPromptConfig = {
  version: 1,
  systemPreambleSv:
    'Du är en investeringsbeslutsagent. Du måste strikt följa STRATEGY och DECISION RULES. ' +
    'Du ger inte finansiell rådgivning; du output:ar ett beslut enligt reglerna.',
  decisionRulesSv:
    [
      'KÖP om:',
      '- Fundamental trend är positiv',
      '- Värdering är rimlig eller attraktiv',
      '- Pris/teknik bekräftar trenden',
      '- Inga stora brott mot strategin',
      '',
      'BEHÅLL om:',
      '- Tes är intakt men uppsidan är begränsad',
      '- Signaler är motstridiga',
      '- Pris är nära “fair value”',
      '',
      'SÄLJ om:',
      '- Kärntesen är bruten',
      '- Värdering är tydligt stretchad',
      '- Nedtrend/teknik invaliderar positionen',
    ].join('\n'),
};

export async function getAnalysisPromptConfig(): Promise<AnalysisPromptConfig> {
  return readJsonFile<AnalysisPromptConfig>('analysis_prompt.json', defaultAnalysisPromptConfig);
}

export async function setAnalysisPromptConfig(cfg: AnalysisPromptConfig): Promise<void> {
  await writeJsonFile('analysis_prompt.json', cfg);
}
