export type Action = 'KÖP' | 'SÄLJ' | 'BEHÅLL';
export type Confidence = 'låg' | 'medel' | 'hög';

export interface Holding {
  ticker: string;
  name: string;
  quantity: number;
  avgPrice?: number;
  currency?: string;
  /** If true, include this holding when running analysis (unless an explicit ticker filter is used). */
  analyze?: boolean;
}

export interface Strategy {
  text: string;
  updatedAt: string; // ISO
}

export interface Thesis {
  ticker: string;
  text: string;
  updatedAt: string; // ISO
}

export interface Recommendation {
  ticker: string;
  action: Action;
  confidence: Confidence;
  rationale: string;
  risks: string[];
}

export interface AnalysisReport {
  id: string;
  createdAt: string; // ISO
  status: 'success' | 'failed';
  error?: string;
  usage?: {
    inputTokensApprox: number;
    outputTokensApprox: number;
  provider?: 'openai' | 'mock';
    model?: string;
  strategyTruncated?: boolean;
  inputTruncated?: boolean;
  };
  portfolioSummary?: string;
  recommendations?: Recommendation[];
}
