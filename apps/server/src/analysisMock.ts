import type { AnalysisReport, Holding, Thesis } from './types.js';

export function runMockAnalysis(args: {
  holdings: Holding[];
  strategyText: string;
  theses: Thesis[];
  hasStrategyDoc?: boolean;
}): Omit<AnalysisReport, 'id'> {
  const { holdings, strategyText, theses, hasStrategyDoc } = args;

  const thesisByTicker = new Map(theses.map((t) => [t.ticker.toUpperCase(), t.text]));

  const recommendations = holdings.map((h) => {
    const hasThesis = thesisByTicker.has(h.ticker.toUpperCase());
    return {
      ticker: h.ticker,
      action: 'BEHÅLL' as const,
      confidence: hasThesis ? ('medel' as const) : ('låg' as const),
      rationale: hasThesis
        ? 'Mock: Tes finns. Rekommendation kräver riktiga marknadsdata + LLM.'
        : 'Mock: Saknar investeringstes. Lägg till tes för bättre analys.',
      risks: ['Mock: Ingen marknadsdata', 'Mock: Ingen riktig LLM-analys'],
    };
  });

  const portfolioSummary =
    `Mock-analys (ingen OpenAI anropad). ` +
    `Holdings: ${holdings.length}. ` +
  `Strategy length: ${strategyText?.length ?? 0} tecken.` +
  (hasStrategyDoc ? ' Structured strategy doc: yes.' : ' Structured strategy doc: no.');

  return {
    createdAt: new Date().toISOString(),
    status: 'success',
    portfolioSummary,
    recommendations,
  };
}
