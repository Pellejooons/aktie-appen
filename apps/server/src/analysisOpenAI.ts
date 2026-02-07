import { z } from 'zod';
import type { AnalysisReport, Confidence, Holding, Recommendation, Thesis } from './types.js';
import { getAnalysisPromptConfig } from './storage.js';
import { promises as fs } from 'node:fs';
import path from 'node:path';

function shouldLogOpenAI(): boolean {
  const v = String(process.env.OPENAI_LOG_PAYLOAD ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

function safeJsonStringify(value: unknown, maxChars: number): string {
  try {
    const s = JSON.stringify(value);
    if (typeof s !== 'string') return '';
    return s.length > maxChars ? s.slice(0, maxChars) + '…' : s;
  } catch {
    return '';
  }
}

async function appendOpenAILogLine(line: string): Promise<void> {
  // Log file lives in apps/server/data/openai.log (process.cwd() when running server is apps/server)
  const dataDir = path.join(process.cwd(), 'data');
  const file = path.join(dataDir, 'openai.log');
  await fs.mkdir(dataDir, { recursive: true });
  await fs.appendFile(file, line.endsWith('\n') ? line : line + '\n', 'utf8');
}

async function logOpenAI(event: 'request' | 'response', obj: unknown): Promise<void> {
  if (!shouldLogOpenAI()) return;
  const ts = new Date().toISOString();
  const line = `${ts}\t[openai]\t${event}\t${safeJsonStringify(obj, 24_000)}`;
  // Keep console output for quick iteration.
  console.log(line);
  // Best-effort file append (don’t break analysis if logging fails).
  try {
    await appendOpenAILogLine(line);
  } catch {
    // ignore
  }
}

const AnalysisOutputSchema = z.object({
  portfolioSummary: z.string().min(1).max(20_000),
  thesisHighlightsUsed: z
    .array(
      z.object({
        ticker: z.string().min(1).max(40),
        highlights: z.array(z.string().min(1).max(500)).min(1).max(12),
      })
    )
    .max(500)
    .default([]),
  recommendations: z
    .array(
      z.object({
        ticker: z.string().min(1).max(40),
        action: z.enum(['KÖP', 'SÄLJ', 'BEHÅLL']),
        confidence: z.enum(['låg', 'medel', 'hög']),
        rationale: z.string().min(1).max(20_000),
        thesisRefs: z.array(z.string().min(1).max(200)).max(12).default([]),
        risks: z.array(z.string().min(1).max(500)).max(50),
      })
    )
    .max(500),
});

function normalizeConfidence(value: Confidence): Confidence {
  if (value === 'låg' || value === 'medel' || value === 'hög') return value;
  return 'låg';
}

function normalizeRecommendations(args: {
  holdings: Holding[];
  modelRecs: Array<z.infer<typeof AnalysisOutputSchema>['recommendations'][number]>;
}): Recommendation[] {
  const { holdings, modelRecs } = args;
  const holdingTickers = new Set(holdings.map((h) => h.ticker.toUpperCase()));

  // Only keep recommendations for tickers that exist in holdings.
  const filtered = modelRecs.filter((r) => holdingTickers.has(r.ticker.toUpperCase()));

  // Ensure every holding has at least a BEHÅLL recommendation.
  const byTicker = new Map<string, Recommendation>();

  for (const r of filtered) {
    byTicker.set(r.ticker.toUpperCase(), {
      ticker: r.ticker,
      action: r.action,
      confidence: normalizeConfidence(r.confidence),
      rationale:
        r.thesisRefs && r.thesisRefs.length
          ? `${r.rationale}\n\n(Support från tes/PM: ${r.thesisRefs.join('; ')})`
          : r.rationale,
      risks: r.risks,
    });
  }

  for (const h of holdings) {
    const key = h.ticker.toUpperCase();
    if (!byTicker.has(key)) {
      byTicker.set(key, {
        ticker: h.ticker,
        action: 'BEHÅLL',
        confidence: 'låg',
        rationale: 'Ingen tydlig signal i modellen för detta innehav (fallback).',
        risks: ['Begränsad data i analysen'],
      });
    }
  }

  return [...byTicker.values()].sort((a, b) => a.ticker.localeCompare(b.ticker));
}

async function callOpenAIJson(args: { apiKey: string; model: string; payload: unknown }): Promise<unknown> {
  const { apiKey, model, payload } = args;

  const cfg = await getAnalysisPromptConfig();

  const schemaHint =
    '{"portfolioSummary": string, "thesisHighlightsUsed": [{"ticker": string, "highlights": string[]}], "recommendations": [{"ticker": string, "action": "KÖP"|"SÄLJ"|"BEHÅLL", "confidence": "låg"|"medel"|"hög", "rationale": string, "thesisRefs": string[], "risks": string[]}] }';

  const system =
    `${cfg.systemPreambleSv}\n\n` +
    `UPPGIFT (kontrakt):\n` +
    `- Baserat ENDAST på input nedan ska du ta ett beslut per ticker: KÖP, BEHÅLL eller SÄLJ.\n` +
    `- Du måste välja exakt ett beslut per ticker.\n` +
    `- Du måste följa STRATEGY och DECISION RULES.\n\n` +
    `OUTPUT (STRICT JSON):\n` +
    `- Svara ENDAST som JSON som matchar exakt detta schema:\n${schemaHint}\n\n` +
    `Kvalitetskrav:\n` +
    `- Rekommendera bara tickers som finns i holdings.\n` +
    `- För varje rekommendation: ange 2–3 konkreta "thesisRefs" från tes/PM/highlights eller strategi.\n` +
    `- Fyll "thesisHighlightsUsed" med 3–5 korta highlights per ticker du faktiskt använde (tomt om ingen tes/PM fanns).\n` +
    `- Ha max 5 riskpunkter per aktie.\n`;

  const requestBody = {
    model,
    input: [
      { role: 'system', content: system },
      {
        role: 'user',
        content: [
          {
            type: 'input_text',
            text:
              'STRATEGY (lag):\n' +
              String((payload as any)?.strategyText ?? '') +
              '\n\n' +
              'DECISION RULES:\n' +
              cfg.decisionRulesSv +
              '\n\n' +
              'STOCK DATA (rå fakta):\n' +
              JSON.stringify(
                {
                  holdings: (payload as any)?.holdings ?? [],
                  // Digests från tes/PM (om finns)
                  thesisDocs: (payload as any)?.thesisDocs ?? [],
                  // Legacy teser (om digests saknas)
                  theses: (payload as any)?.theses ?? [],
                  portfolioStrategyDoc: (payload as any)?.portfolioStrategyDoc ?? null,
                  asOf: (payload as any)?.asOf ?? null,
                },
                null,
                2
              ),
          },
        ],
      },
    ],
    // Keep it deterministic-ish.
    temperature: 0.2,
  };

  await logOpenAI('request', {
    url: 'https://api.openai.com/v1/responses',
    model,
    requestBody,
  });

  // Use the OpenAI Responses API when available. We avoid external SDK deps.
  const res = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(requestBody),
  });

  const responseText = await res.text().catch(() => '');

  await logOpenAI('response', { status: res.status, ok: res.ok, body: responseText });

  if (!res.ok) {
    throw new Error(`OpenAI API error ${res.status}: ${responseText.slice(0, 500)}`);
  }

  const json = (responseText ? JSON.parse(responseText) : {}) as any;

  // Try to extract the model text. Different responses may surface it in different fields.
  const text =
    (typeof json?.output_text === 'string' && json.output_text) ||
    (Array.isArray(json?.output)
      ? json.output
          .flatMap((o: any) => (Array.isArray(o?.content) ? o.content : []))
          .map((c: any) => (typeof c?.text === 'string' ? c.text : ''))
          .join('')
      : '');

  if (!text) throw new Error('OpenAI response missing output text');
  return JSON.parse(text);
}

export async function runOpenAIAnalysis(args: {
  apiKey: string;
  model?: string;
  holdings: Holding[];
  strategyText: string;
  portfolioStrategyDoc?: unknown;
  theses: Thesis[];
  thesisDocs?: Array<{ ticker: string; highlights: string[] }>;
}): Promise<Omit<AnalysisReport, 'id'>> {
  const {
    apiKey,
    model = process.env.OPENAI_MODEL ?? 'gpt-4.1-mini',
    holdings,
    strategyText,
    portfolioStrategyDoc,
    theses,
    thesisDocs,
  } = args;

  const minimalHoldings = holdings.map((h) => ({
    ticker: h.ticker,
    quantity: h.quantity,
    avgPrice: h.avgPrice,
    currency: h.currency,
  }));

  const hasThesisDigests = Array.isArray(thesisDocs) && thesisDocs.length > 0;

  const payload = {
    holdings: minimalHoldings,
    strategyText,
    portfolioStrategyDoc: portfolioStrategyDoc ?? null,
    theses: hasThesisDigests ? [] : theses,
    thesisDocs: thesisDocs ?? [],
    asOf: new Date().toISOString(),
  };

  const parsed = AnalysisOutputSchema.parse(await callOpenAIJson({ apiKey, model, payload }));
  const recommendations = normalizeRecommendations({ holdings, modelRecs: parsed.recommendations });
  return {
    createdAt: new Date().toISOString(),
    status: 'success',
    portfolioSummary:
      parsed.thesisHighlightsUsed && parsed.thesisHighlightsUsed.length
        ?
          `${parsed.portfolioSummary}\n\nTes/PM highlights som användes:\n` +
          parsed.thesisHighlightsUsed
            .map((x) => `- ${x.ticker}: ${x.highlights.join(' | ')}`)
            .join('\n')
        : parsed.portfolioSummary,
    recommendations,
  };
}
