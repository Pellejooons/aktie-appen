import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import { z } from 'zod';
import dotenv from 'dotenv';
import { parseAvanzaHoldingsCsv } from './avanzaCsv.js';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  addAnalysisReport,
  getHoldings,
  getPortfolioStrategyDoc,
  getStrategy,
  getStrategyDigest,
  getTheses,
  listThesisDocs,
  getThesisDoc,
  upsertThesisDoc,
  setPortfolioStrategyDoc,
  setHoldings,
  setStrategy,
  setStrategyDigest,
  upsertThesis,
  listAnalysisReports,
} from './storage.js';
import { runMockAnalysis } from './analysisMock.js';
import { runOpenAIAnalysis } from './analysisOpenAI.js';
import { getSchedulerStatus, startNightlyScheduler } from './scheduler.js';

// Load environment variables from .env (apps/server/.env) for local dev.
dotenv.config();

const app = Fastify({ logger: true });

app.log.info(
  {
    analysisProvider: (process.env.ANALYSIS_PROVIDER ?? 'auto').trim().toLowerCase(),
    openaiKeyPresent: !!process.env.OPENAI_API_KEY?.trim(),
    openaiModel: process.env.OPENAI_MODEL ?? 'gpt-4.1-mini',
  },
  'config'
);

type UsageTotals = {
  totalRequests: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  updatedAt: string;
};

const usageTotals: UsageTotals = {
  totalRequests: 0,
  totalInputTokens: 0,
  totalOutputTokens: 0,
  updatedAt: new Date(0).toISOString(),
};

function estimateTokens(text: string): number {
  // Rough estimate: ~4 chars/token for mixed Swedish/English.
  return Math.max(0, Math.ceil(text.length / 4));
}

function truncateText(text: string, maxChars: number): { text: string; truncated: boolean } {
  const s = String(text ?? '');
  if (s.length <= maxChars) return { text: s, truncated: false };
  return { text: s.slice(0, maxChars) + '…', truncated: true };
}

function timingSafeEqualStr(a: string, b: string): boolean {
  const aa = Buffer.from(a);
  const bb = Buffer.from(b);
  if (aa.length !== bb.length) return false;
  return crypto.timingSafeEqual(aa, bb);
}

function isAuthConfigured(): boolean {
  return !!process.env.APP_USER && !!process.env.APP_PASSWORD;
}

function parseBasicAuth(headerValue: string | undefined): { user: string; pass: string } | null {
  if (!headerValue) return null;
  const [scheme, token] = headerValue.split(' ');
  if (scheme?.toLowerCase() !== 'basic' || !token) return null;
  try {
    const decoded = Buffer.from(token, 'base64').toString('utf8');
    const idx = decoded.indexOf(':');
    if (idx < 0) return null;
    return { user: decoded.slice(0, idx), pass: decoded.slice(idx + 1) };
  } catch {
    return null;
  }
}

function unauthorized(reply: any) {
  reply.header('WWW-Authenticate', 'Basic realm="Aktie"');
  return reply.code(401).send({ error: 'Unauthorized' });
}

app.addHook('onRequest', async (req: any, reply: any) => {
  // Correlation id
  const existing = req.headers['x-request-id'];
  const requestId = typeof existing === 'string' && existing.trim() ? existing.trim() : crypto.randomUUID();
  reply.header('x-request-id', requestId);
  (req as any).requestId = requestId;

  // Basic auth if configured.
  if (!isAuthConfigured()) return;

  // Let health check bypass.
  if (req.url?.startsWith('/api/health')) return;

  // Let the UI shell be accessible without auth so the browser can show the login prompt once,
  // and to avoid repeated 401 loops when loading the single-file UI.
  if (req.url === '/' || req.url?.startsWith('/favicon.ico') || req.url?.startsWith('/apple-touch-icon')) {
    return;
  }

  const creds = parseBasicAuth(req.headers.authorization);
  const expectedUser = process.env.APP_USER ?? '';
  const expectedPass = process.env.APP_PASSWORD ?? '';

  const ok =
    creds !== null &&
    timingSafeEqualStr(creds.user, expectedUser) &&
    timingSafeEqualStr(creds.pass, expectedPass);

  if (!ok) {
    req.log.warn({ url: req.url, requestId }, 'unauthorized request');
    return unauthorized(reply);
  }
});

app.addHook('onResponse', async (req: any, reply: any) => {
  const requestId = (req as any).requestId;
  req.log.info(
    {
      requestId,
      method: req.method,
      url: req.url,
      statusCode: reply.statusCode,
      responseTimeMs: reply.elapsedTime,
    },
    'request'
  );
});

await app.register(cors, {
  origin: true,
});

await app.register(multipart, {
  limits: {
    fileSize: 10 * 1024 * 1024,
  },
});

app.get('/api/health', async () => ({ ok: true }));

app.get('/api/usage', async () => ({ ok: true, usage: usageTotals }));

app.get('/api/scheduler', async () => ({ ok: true, scheduler: getSchedulerStatus() }));

app.get('/', async (_req: any, reply: any) => {
  const file = path.join(process.cwd(), 'src', 'ui.html');
  const html = await readFile(file, 'utf8');
  reply.type('text/html; charset=utf-8').send(html);
});

app.get('/api/portfolio', async () => {
  const holdings = await getHoldings();
  const strategy = await getStrategy();
  const strategyDigest = await getStrategyDigest();
  const theses = await getTheses();
  const portfolioStrategyDoc = await getPortfolioStrategyDoc();
  const thesisDocsIndex = await listThesisDocs();
  return { holdings, strategy, strategyDigest, portfolioStrategyDoc, theses, thesisDocsIndex };
});

app.put('/api/holdings', async (req: any, reply: any) => {
  const schema = z.object({
    holdings: z.array(
      z.object({
        ticker: z.string().min(1).max(40),
        name: z.string().optional().default(''),
        quantity: z.number().nonnegative(),
        avgPrice: z.number().optional(),
        currency: z.string().optional(),
        analyze: z.boolean().optional(),
      })
    ),
  });

  try {
    const body = schema.parse(req.body);
    await setHoldings(
      body.holdings.map((h) => ({
        ticker: h.ticker.toUpperCase(),
        name: h.name ?? '',
        quantity: h.quantity,
        avgPrice: h.avgPrice,
        currency: h.currency,
        analyze: h.analyze === true,
      }))
    );
    return { ok: true };
  } catch (err: any) {
    return reply.code(400).send({ ok: false, error: String(err?.message ?? err) });
  }
});

app.get('/api/thesis-docs', async () => {
  const items = await listThesisDocs();
  return { items };
});

app.get('/api/thesis-docs/:ticker', async (req: any, reply: any) => {
  const paramsSchema = z.object({ ticker: z.string().min(1).max(40) });
  const { ticker } = paramsSchema.parse(req.params);
  const doc = await getThesisDoc(ticker);
  if (!doc) return reply.code(404).send({ error: 'Not found' });
  return { doc };
});

app.put('/api/thesis-docs', async (req: any) => {
  const schema = z.unknown();
  const body = schema.parse(req.body);
  if (body === null || typeof body !== 'object') {
    return { ok: false, error: 'Body must be a JSON object' };
  }
  await upsertThesisDoc(body as any);
  return { ok: true };
});

app.post('/api/thesis-docs/:ticker/ingest', async (req: any, reply: any) => {
  const paramsSchema = z.object({ ticker: z.string().min(1).max(40) });
  const bodySchema = z.object({
    documentText: z.string().min(1).max(200_000),
    docHint: z.string().max(2_000).optional().default(''),
    mode: z.enum(['merge', 'replace']).optional().default('merge'),
  });

  const requestId = String(req.id ?? '').trim();
  let stage = 'parse';

  try {
    const { ticker } = paramsSchema.parse(req.params);
    const body = bodySchema.parse(req.body);

    stage = 'load_existing';
    const existing = await getThesisDoc(ticker);
    const apiKey = process.env.OPENAI_API_KEY?.trim();
    const model = process.env.OPENAI_MODEL ?? 'gpt-4.1-mini';

    const existingStr = existing ? JSON.stringify(existing, null, 2) : '';

    const system =
      'Du är en investering/portfolio-assistent. Du får två inputs: (1) ett befintligt tes-dokument (JSON) och (2) en ny källtext (dokument). ' +
      'Din uppgift är att analysera det nya dokumentet och endast uppdatera tes-dokumentet om dokumentet innehåller relevanta, explicita fakta som ändrar/kompletterar tesen (t.ex. siffror, nya risker, nya triggers, ändrade förutsättningar). ' +
      'HITTA INTE PÅ fakta. Om något inte går att verifiera från NEW_DOCUMENT_TEXT ska det inte skrivas som fakta; lägg det som en fråga istället. ' +
      'Om inget behöver ändras: returnera tes-dokumentet i princip oförändrat (förutom meta.updatedAt). ' +
      'Returnera STRICT JSON och inget annat.';

    const schemaHint =
      '{"meta": {"ticker": string, "company"?: string, "date"?: string, "updatedAt"?: string}, "summary"?: string, "highlights"?: string[], "bullCase"?: string[], "bearCase"?: string[], "risks"?: string[], "questions"?: string[], "sources"?: string[] }';

    const userText =
      `TICKER: ${String(ticker).toUpperCase()}\n` +
      `MODE: ${body.mode}\n` +
      (body.docHint ? `DOC_HINT: ${body.docHint}\n` : '') +
      '\n' +
      'EXISTING_THESIS_DOC_JSON (source of truth unless updated):\n' +
      (existingStr || '(none)') +
      '\n\n' +
      'NEW_DOCUMENT_TEXT (analysera för eventuella uppdateringar):\n' +
      body.documentText +
      '\n\n' +
      'INSTRUCTIONS (viktigt):\n' +
      '- Identifiera endast information i NEW_DOCUMENT_TEXT som påverkar tes-dokumentet.\n' +
      '- Uppdatera tes-dokumentet (merge) med dessa förändringar.\n' +
      '- Om MODE=replace: skapa en helt ny tes baserat på NEW_DOCUMENT_TEXT, men håll samma JSON-format.\n' +
      '- Om NEW_DOCUMENT_TEXT inte innehåller något som kräver ändring: returnera samma dokument med oförändrade fält (förutom meta.updatedAt).\n' +
      '- Behåll punkter korta. Lägg bara till "sources"-rad för den nya filen om du faktiskt använde info därifrån.\n' +
      '- Svara ENDAST som JSON som matchar ungefär detta schema: ' +
      schemaHint;

    const makeMock = () => {
      const now = new Date().toISOString();
      const updated = {
        ...(existing || {}),
        meta: {
          ...(existing?.meta || {}),
          ticker: String(ticker).toUpperCase(),
          updatedAt: now,
        },
        sources: Array.from(
          new Set(
            [
              ...((existing as any)?.sources || []),
              body.docHint || 'ingested-document',
            ].filter(Boolean)
          )
        ),
        questions: Array.from(
          new Set(
            [
              ...((existing as any)?.questions || []),
              'OPENAI_API_KEY saknas: kunde inte analysera dokumentet automatiskt. Vad i dokumentet ska uppdatera tesen?',
            ].filter(Boolean)
          )
        ),
      };

      return {
        ok: true,
        provider: 'mock',
        model: 'mock',
        doc: updated,
        note: 'OPENAI_API_KEY saknas; returnerade en minimal uppdatering av meta.updatedAt + en fråga i tesen.',
      };
    };

    if (!apiKey) {
      const mock = makeMock();
      await upsertThesisDoc(mock.doc as any);
      return mock;
    }

    const requestBody = {
      model,
      input: [
        { role: 'system', content: system },
        { role: 'user', content: [{ type: 'input_text', text: userText }] },
      ],
      temperature: 0.2,
    };

    stage = 'openai_fetch';
    const res = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
    });

    stage = 'openai_read';
    const responseText = await res.text().catch(() => '');
    if (!res.ok) {
      return reply.code(502).send({
        ok: false,
        error: `OpenAI API error ${res.status}: ${responseText.slice(0, 500)}`,
        requestId,
        stage,
      });
    }

    stage = 'openai_parse_outer';
    const json = (responseText ? JSON.parse(responseText) : {}) as any;
    const text =
      (typeof json?.output_text === 'string' && json.output_text) ||
      (Array.isArray(json?.output)
        ? json.output
            .flatMap((o: any) => (Array.isArray(o?.content) ? o.content : []))
            .map((c: any) => (typeof c?.text === 'string' ? c.text : ''))
            .join('')
        : '');

    if (!text) {
      return reply
        .code(502)
        .send({ ok: false, error: 'OpenAI response missing output text', requestId, stage });
    }

    stage = 'openai_parse_json';
    let updated: any;
    try {
      updated = JSON.parse(text);
    } catch {
      return reply
        .code(502)
        .send({ ok: false, error: 'OpenAI response was not valid JSON', requestId, stage });
    }

    if (!updated || typeof updated !== 'object') {
      return reply
        .code(502)
        .send({ ok: false, error: 'OpenAI returned non-object JSON', requestId, stage });
    }
    if (!updated.meta || typeof updated.meta !== 'object') updated.meta = {};
    updated.meta.ticker = String(ticker).toUpperCase();
    updated.meta.updatedAt = new Date().toISOString();

    stage = 'persist';
    await upsertThesisDoc(updated);
    return { ok: true, provider: 'openai', model, doc: updated };
  } catch (err: any) {
    // Zod validation errors should be client errors (400) with a clear message.
    // In particular, large documentText commonly triggers "too_big".
    if (err && typeof err === 'object' && err.name === 'ZodError') {
      const issues = Array.isArray((err as any).issues) ? (err as any).issues : [];
      const docIssue = issues.find(
        (i: any) => Array.isArray(i?.path) && i.path.join('.') === 'documentText'
      );
      const max = docIssue?.maximum;
      const code = docIssue?.code;
      const friendly =
        code === 'too_big' && typeof max === 'number'
          ? `Dokument-texten är för lång. Max är ${max} tecken. (Tips: använd kortare utdrag eller låt UI trimma)`
          : 'Ogiltig input.';
      return reply.code(400).send({
        ok: false,
        error: friendly,
        requestId,
        stage,
        details: issues,
      });
    }

    const msg = String(err?.message ?? err);
    req.log?.error?.({ err, requestId, stage }, 'thesis-doc ingest failed');
    return reply.code(500).send({ ok: false, error: msg, requestId, stage });
  }
});
app.get('/api/portfolio-strategy', async () => {
  const doc = await getPortfolioStrategyDoc();
  return { doc };
});

app.put('/api/portfolio-strategy', async (req: any) => {
  // Accept any JSON; we'll later add a strict schema once the doc stabilizes.
  const schema = z.unknown();
  const body = schema.parse(req.body);
  if (body === null || typeof body !== 'object') {
    return { ok: false, error: 'Body must be a JSON object' };
  }
  await setPortfolioStrategyDoc(body as any);
  return { ok: true };
});

app.post('/api/import/avanza', async (req: any, reply: any) => {
  const file = await req.file();
  if (!file) return reply.code(400).send({ error: 'Missing file field' });

  const buf = await file.toBuffer();
  const text = buf.toString('utf8');

  const holdings = parseAvanzaHoldingsCsv(text);
  if (!holdings.length) {
    return reply.code(400).send({ error: 'No holdings found. CSV columns may not match expected Avanza export.' });
  }

  const prev = await getHoldings();

  const toMap = (arr: any[]) => {
    const m = new Map<string, any>();
    for (const h of arr || []) {
      const t = String(h?.ticker ?? '').toUpperCase().trim();
      if (!t) continue;
      m.set(t, h);
    }
    return m;
  };
  const prevMap = toMap(prev);
  const nextMap = toMap(holdings);

  const added: any[] = [];
  const removed: any[] = [];
  const changed: any[] = [];

  for (const [ticker, nextH] of nextMap.entries()) {
    if (!prevMap.has(ticker)) {
      added.push({
        ticker,
        name: nextH?.name ?? '',
        quantity: nextH?.quantity ?? 0,
        currency: nextH?.currency,
      });
      continue;
    }
    const prevH = prevMap.get(ticker);
    const prevQty = Number(prevH?.quantity ?? 0);
    const nextQty = Number(nextH?.quantity ?? 0);
    if (Number.isFinite(prevQty) && Number.isFinite(nextQty) && prevQty !== nextQty) {
      changed.push({
        ticker,
        name: nextH?.name ?? prevH?.name ?? '',
        from: prevQty,
        to: nextQty,
        delta: nextQty - prevQty,
      });
    }
  }
  for (const [ticker, prevH] of prevMap.entries()) {
    if (!nextMap.has(ticker)) {
      removed.push({
        ticker,
        name: prevH?.name ?? '',
        quantity: prevH?.quantity ?? 0,
        currency: prevH?.currency,
      });
    }
  }

  await setHoldings(holdings);
  return {
    ok: true,
    imported: holdings.length,
    diff: {
      added,
      removed,
      changed,
      prevCount: prev?.length ?? 0,
      nextCount: holdings.length,
    },
  };
});

app.put('/api/strategy', async (req: any) => {
  const schema = z.object({ text: z.string().max(20_000) });
  const body = schema.parse(req.body);
  const strategy = await setStrategy(body.text);
  return { ok: true, strategy };
});

app.get('/api/strategy-digest', async () => {
  const digest = await getStrategyDigest();
  return { ok: true, digest };
});

app.put('/api/strategy-digest', async (req: any) => {
  const schema = z.object({ text: z.string().max(20_000) });
  const body = schema.parse(req.body);
  const digest = await setStrategyDigest(body.text);
  return { ok: true, digest };
});

function heuristicDigestFromStrategyText(strategyText: string): string {
  const text = String(strategyText ?? '').trim();
  if (!text) return '';

  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const bullets = lines
    .filter((l) => l.startsWith('-') || l.startsWith('*') || l.startsWith('•'))
    .map((l) => l.replace(/^[-*•]\s*/, '').trim());

  const picked = (bullets.length ? bullets : lines).slice(0, 18);
  return (
    'Digest (heuristik):\n' +
    picked.map((l) => `- ${l}`).join('\n') +
    (picked.length < (bullets.length ? bullets.length : lines.length) ? '\n- …' : '')
  );
}

async function generateDigestWithOpenAI(args: {
  apiKey: string;
  model: string;
  strategyText: string;
}): Promise<string> {
  const { apiKey, model, strategyText } = args;
  const system =
    'Du skriver en kort svensk “strategy digest” för en privat portföljstrategi. ' +
    'Svara ENDAST som ren text (ingen JSON).';
  const user =
    'Gör en strategy digest av texten nedan. Krav:\n' +
    '- 10–20 korta bullets\n' +
    '- Fokusera på beslutsregler (köp/sälj/behåll), riskstyrning och signaler\n' +
    '- Inga utsvävningar, inga disclaimers\n' +
    '- Max 1200 tecken\n\n' +
    strategyText;

  const res = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      input: [
        { role: 'system', content: system },
        {
          role: 'user',
          content: [{ type: 'input_text', text: user }],
        },
      ],
      temperature: 0.2,
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`OpenAI API error ${res.status}: ${text.slice(0, 500)}`);
  }
  const json = (await res.json()) as any;
  const out =
    (typeof json?.output_text === 'string' && json.output_text) ||
    (Array.isArray(json?.output)
      ? json.output
          .flatMap((o: any) => (Array.isArray(o?.content) ? o.content : []))
          .map((c: any) => (typeof c?.text === 'string' ? c.text : ''))
          .join('')
      : '');
  return String(out ?? '').trim();
}

app.post('/api/strategy-digest/generate', async (req: any, reply: any) => {
  const bodySchema = z.object({ strategyText: z.string().max(50_000).optional() }).optional();
  const body = bodySchema.parse(req.body ?? undefined);

  const strategy = await getStrategy();
  const baseText = (body?.strategyText ?? strategy.text ?? '').trim();
  if (!baseText) return reply.code(400).send({ ok: false, error: 'Strategi saknas' });

  const apiKey = process.env.OPENAI_API_KEY?.trim();
  const model = process.env.OPENAI_MODEL ?? 'gpt-4.1-mini';

  const { text: truncatedStrategy, truncated } = truncateText(baseText, Number(process.env.OPENAI_MAX_STRATEGY_CHARS ?? 8_000));

  let digestText = '';
  let provider: 'openai' | 'heuristic' = 'heuristic';

  if (apiKey) {
    try {
      digestText = await generateDigestWithOpenAI({ apiKey, model, strategyText: truncatedStrategy });
      provider = 'openai';
    } catch (err: any) {
      app.log.warn({ err: String(err?.message ?? err) }, 'digest generation via openai failed; falling back to heuristic');
    }
  }

  if (!digestText) {
    digestText = heuristicDigestFromStrategyText(truncatedStrategy);
    provider = 'heuristic';
  }

  // Hard cap to keep it small
  digestText = truncateText(digestText, 2000).text;
  const digest = await setStrategyDigest(digestText);
  return { ok: true, digest, meta: { provider, strategyTruncated: truncated ? true : undefined } };
});

app.put('/api/thesis/:ticker', async (req: any) => {
  const paramsSchema = z.object({ ticker: z.string().min(1).max(20) });
  const bodySchema = z.object({ text: z.string().max(20_000) });

  const { ticker } = paramsSchema.parse(req.params);
  const { text } = bodySchema.parse(req.body);

  const thesis = await upsertThesis(ticker.toUpperCase(), text);
  return { ok: true, thesis };
});

app.get('/api/analysis/history', async () => {
  const history = await listAnalysisReports();
  return { history };
});

app.get('/api/analysis/latest', async () => {
  const history = await listAnalysisReports();
  return { latest: history[0] ?? null };
});

app.post('/api/analyze', async (req: any) => {
  const querySchema = z
    .object({
      ticker: z.string().min(1).max(40).optional(),
      onlyWithAnalysis: z
        .union([z.literal('1'), z.literal('true'), z.literal('yes'), z.literal('0'), z.literal('false'), z.literal('no')])
        .optional(),
    })
    .partial();

  const query = querySchema.parse(req.query ?? {});
  const tickerFilter = (query.ticker ?? '').trim();
  const onlyWithAnalysis = (() => {
    const v = String(query.onlyWithAnalysis ?? '').trim().toLowerCase();
    if (!v) return false;
    return v === '1' || v === 'true' || v === 'yes';
  })();

  const holdingsAll = await getHoldings();
  const strategy = await getStrategy();
  const strategyDigest = await getStrategyDigest();
  const theses = await getTheses();
  const portfolioStrategyDoc = await getPortfolioStrategyDoc();

  // If we need to filter holdings based on available thesis docs (investment analysis),
  // read the index once and build a set.
  const thesisDocsIndex = await listThesisDocs();
  const tickersWithDocs = new Set(thesisDocsIndex.map((i) => i.ticker.toUpperCase()));

  // Decide which holdings to analyze.
  let holdings = holdingsAll;
  if (tickerFilter) {
    holdings = holdingsAll.filter((h) => h.ticker.toUpperCase() === tickerFilter.toUpperCase());
  } else {
    // Default: only analyze holdings that the user has explicitly marked.
    holdings = holdingsAll.filter((h: any) => h?.analyze === true);

    // Optional extra filter: only include those that also have thesis docs.
    if (onlyWithAnalysis) {
      holdings = holdings.filter((h) => tickersWithDocs.has(h.ticker.toUpperCase()));
    }
  }

  if (!holdings.length) {
    const failed = await addAnalysisReport({
      createdAt: new Date().toISOString(),
      status: 'failed',
      error: tickerFilter
        ? `Ticker not found in holdings: ${tickerFilter}`
        : onlyWithAnalysis
          ? 'Inga markerade innehav har tes/PM (thesis docs). Markera innehav i listan först.'
          : 'Inga markerade innehav. Markera innehav i listan först.',
    });
    return { ok: false, report: failed };
  }

  const apiKey = process.env.OPENAI_API_KEY?.trim();
  const timeoutMs = Number(process.env.ANALYSIS_TIMEOUT_MS ?? 60_000);
  const model = process.env.OPENAI_MODEL ?? 'gpt-4.1-mini';
  const providerRaw = (process.env.ANALYSIS_PROVIDER ?? 'auto').trim().toLowerCase();
  const provider: 'auto' | 'openai' | 'mock' =
    providerRaw === 'openai' || providerRaw === 'mock' ? (providerRaw as any) : 'auto';

  const maxStrategyChars = Number(process.env.OPENAI_MAX_STRATEGY_CHARS ?? 8_000);
  const maxJsonChars = Number(process.env.OPENAI_MAX_INPUT_JSON_CHARS ?? 48_000);

  function compactJson(value: unknown, maxLen: number): string {
    try {
      const s = JSON.stringify(value);
      if (typeof s !== 'string') return '';
      return s.length > maxLen ? s.slice(0, maxLen) + '…' : s;
    } catch {
      return '';
    }
  }

  function buildThesisDocDigest(args: { ticker: string; doc: any }): { ticker: string; highlights: string[] } {
    const { ticker, doc } = args;
    const highlights: string[] = [];

    // Heuristic digest: prefer explicit fields if present, otherwise fallback to a compact JSON snippet.
    const pushStr = (s: unknown) => {
      if (typeof s === 'string' && s.trim()) highlights.push(s.trim());
    };
    const pushArr = (arr: unknown) => {
      if (!Array.isArray(arr)) return;
      for (const v of arr) pushStr(v);
    };

    pushStr(doc?.meta?.title);
    pushStr(doc?.summary);
    pushArr(doc?.highlights);
    pushArr(doc?.bullCase);
    pushArr(doc?.bearCase);
    pushArr(doc?.risks);

    if (!highlights.length) {
      const snippet = compactJson(doc, 1200);
      if (snippet) highlights.push(`Utdrag: ${snippet}`);
    }

    // Keep it small: max 8 bullets
    return { ticker, highlights: highlights.slice(0, 8) };
  }

  function buildPortfolioStrategyDocDigest(doc: any): string {
    if (!doc) return '';
    const parts: string[] = [];

    const push = (label: string, value: unknown) => {
      if (value === null || value === undefined) return;
      const s = typeof value === 'string' ? value.trim() : '';
      if (s) parts.push(`${label}: ${s}`);
    };

    const pushArr = (label: string, value: unknown, maxItems: number) => {
      if (!Array.isArray(value)) return;
      const items = value
        .map((v) => (typeof v === 'string' ? v.trim() : ''))
        .filter(Boolean)
        .slice(0, maxItems);
      if (items.length) parts.push(`${label}: ${items.map((x) => `- ${x}`).join(' ')}`);
    };

    // Best-effort extraction across versions.
    push('Namn', doc?.meta?.name ?? doc?.name);
    push('Mål', doc?.objectives?.primary ?? doc?.goals?.primary);
    push('Allokering', doc?.allocation?.policy ?? doc?.allocationPolicy);
    pushArr('Regler', doc?.rules ?? doc?.decisionRules, 10);
    pushArr('Risk', doc?.risk?.rules ?? doc?.riskRules ?? doc?.risk?.principles, 10);
    pushArr('Signaler', doc?.signals ?? doc?.indicators, 10);

    if (!parts.length) {
      const snippet = compactJson(doc, 1200);
      if (snippet) parts.push(`Utdrag: ${snippet}`);
    }

    return truncateText(parts.join('\n'), 1800).text;
  }

  let reportInput: Parameters<typeof addAnalysisReport>[0] | undefined;

  const analyzePromise: Promise<void> = (async () => {
    const shouldUseOpenAI = provider === 'openai' || (provider === 'auto' && !!apiKey);

    const preferredStrategyText = (strategyDigest.text || '').trim() ? strategyDigest.text : strategy.text;
    const usedDigest = preferredStrategyText === strategyDigest.text;

    const runMock = () => {
      const { text: strategyText, truncated: strategyTruncated } = truncateText(preferredStrategyText, maxStrategyChars);

      const minimalHoldings = holdings.map((h) => {
        const avgPrice = h.avgPrice;
        const quantity = h.quantity;
        const marketValue =
          typeof avgPrice === 'number' && Number.isFinite(avgPrice) && typeof quantity === 'number' && Number.isFinite(quantity)
            ? avgPrice * quantity
            : undefined;

        return {
          ticker: h.ticker,
          name: h.name,
          quantity,
          avgPrice,
          currency: h.currency,
          marketValue,
        };
      });

  const portfolioStrategyDocDigest = buildPortfolioStrategyDocDigest(portfolioStrategyDoc);

      const approxInput =
        JSON.stringify(
          {
            holdings: minimalHoldings,
            strategyText,
            usedDigest,
            strategyTruncated,
    portfolioStrategyDocDigest,
            theses,
            thesisDocDigests: [],
          },
          null,
          2
        ) ?? '';

      reportInput = runMockAnalysis({
        holdings,
        strategyText,
        theses,
        hasStrategyDoc: !!portfolioStrategyDoc,
      });

      reportInput.usage = {
        inputTokensApprox: estimateTokens(approxInput),
        outputTokensApprox: estimateTokens(
          JSON.stringify({
            portfolioSummary: reportInput.portfolioSummary,
            recommendations: reportInput.recommendations,
          })
        ),
  provider: 'mock',
        model: 'mock',
      };
    };

    if (!shouldUseOpenAI) {
      runMock();
      return;
    }

    if (!apiKey) {
      throw new Error('ANALYSIS_PROVIDER=openai set but OPENAI_API_KEY is missing');
    }

    try {
      // Load thesis docs only for tickers that are present in the current holdings set.
      const holdingTickers = new Set(holdings.map((h) => h.ticker.toUpperCase()));
      const wantedDocTickers = thesisDocsIndex
        .map((i) => i.ticker)
        .filter((t) => holdingTickers.has(t.toUpperCase()));

      const docs = await Promise.all(
        wantedDocTickers.map(async (ticker) => ({ ticker, doc: await getThesisDoc(ticker) }))
      );

      // Build a compact digest to reduce token usage.
      const thesisDocDigests = docs
        .filter((d) => d.doc !== null)
        .map((d) => buildThesisDocDigest({ ticker: d.ticker, doc: d.doc }));

  const { text: strategyText, truncated: strategyTruncated } = truncateText(preferredStrategyText, maxStrategyChars);

      const minimalHoldings = holdings.map((h) => {
        const avgPrice = h.avgPrice;
        const quantity = h.quantity;
        const marketValue =
          typeof avgPrice === 'number' && Number.isFinite(avgPrice) && typeof quantity === 'number' && Number.isFinite(quantity)
            ? avgPrice * quantity
            : undefined;

        return {
          ticker: h.ticker,
          name: h.name,
          quantity,
          avgPrice,
          currency: h.currency,
          marketValue,
        };
      });

      const thesesForPayload = thesisDocDigests.length ? [] : theses;

  const portfolioStrategyDocDigest = buildPortfolioStrategyDocDigest(portfolioStrategyDoc);

      const approxInputRaw =
        JSON.stringify(
          {
            holdings: minimalHoldings,
            strategyText,
            usedDigest,
            strategyTruncated,
            portfolioStrategyDocDigest,
            theses: thesesForPayload,
            thesisDocDigests,
          },
          null,
          2
        ) ?? '';

      const { text: approxInput, truncated: inputTruncated } = truncateText(approxInputRaw, maxJsonChars);

  reportInput = await runOpenAIAnalysis({
        apiKey,
        model,
        holdings,
  strategyText,
  portfolioStrategyDoc: portfolioStrategyDocDigest || undefined,
        theses,
  thesisDocs: thesisDocDigests,
      });

      // Token usage counter: best-effort estimate unless/until we read exact usage from the API response.
      const inputTokensApprox = estimateTokens(approxInput);
      const outputTokensApprox = estimateTokens(
        JSON.stringify({
          portfolioSummary: reportInput.portfolioSummary,
          recommendations: reportInput.recommendations,
        })
      );

      usageTotals.totalRequests += 1;
      usageTotals.totalInputTokens += inputTokensApprox;
      usageTotals.totalOutputTokens += outputTokensApprox;
      usageTotals.updatedAt = new Date().toISOString();

      reportInput.usage = {
        inputTokensApprox,
        outputTokensApprox,
  provider: 'openai',
        model,
  strategyTruncated: strategyTruncated ? true : undefined,
  inputTruncated: inputTruncated ? true : undefined,
      };
      return;
    } catch (err: any) {
      const message = String(err?.message ?? err);
      const isOpenAiAccessOrQuotaError =
        message.includes('OpenAI API error 403') ||
        message.includes('OpenAI API error 429') ||
        message.includes('model_not_found') ||
        message.includes('insufficient_quota');

      // In auto mode, fall back to mock for common “not ready yet” OpenAI errors.
      if (provider === 'auto' && isOpenAiAccessOrQuotaError) {
        app.log.warn({ err: message }, 'openai failed; falling back to mock analysis (ANALYSIS_PROVIDER=auto)');
        runMock();
        return;
      }

      throw err;
    }
  })();

  const timeoutPromise = new Promise<void>((_, reject) => {
    const t = setTimeout(() => {
      clearTimeout(t);
      reject(new Error(`Analysis timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    await Promise.race([analyzePromise, timeoutPromise]);
  } catch (err: any) {
    const failed = await addAnalysisReport({
      createdAt: new Date().toISOString(),
      status: 'failed',
      error: String(err?.message ?? err),
    });
    return { ok: false, report: failed };
  }

  if (!reportInput) {
    const failed = await addAnalysisReport({
      createdAt: new Date().toISOString(),
      status: 'failed',
      error: 'Analysis produced no report',
    });
    return { ok: false, report: failed };
  }

  const report = await addAnalysisReport(reportInput);

  return { ok: true, report };
});

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '0.0.0.0';

app.listen({ port, host });

startNightlyScheduler(app);
