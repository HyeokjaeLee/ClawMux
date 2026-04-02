// Legacy keyword-based scorer — used as emergency fallback when LLM classifier is unavailable.
// The primary classification method is now LLM-based (see llm-classifier.ts).
import type { Message, ScoringConfig, ScoringResult } from "./types.ts";
import {
  AGENTIC_KEYWORDS,
  CODE_KEYWORDS,
  CONSTRAINT_KEYWORDS,
  CREATIVE_KEYWORDS,
  DEFAULT_BOUNDARIES,
  DEFAULT_CONFIDENCE_THRESHOLD,
  DEFAULT_WEIGHTS,
  DOMAIN_KEYWORDS,
  FORMAT_KEYWORDS,
  IMPERATIVE_KEYWORDS,
  MULTI_STEP_LITERAL_PATTERNS,
  MULTI_STEP_REGEX_PATTERNS,
  REASONING_KEYWORDS,
  RELAY_KEYWORDS,
  SIMPLE_KEYWORDS,
  TECHNICAL_KEYWORDS,
} from "./keywords.ts";

const EMPTY_RESULT: ScoringResult = {
  score: 0.0,
  confidence: 0.5,
  dimensions: {
    tokenCount: 0, codePresence: 0, reasoningMarkers: 0, technicalTerms: 0,
    creativeMarkers: 0, simpleIndicators: 0, multiStepPatterns: 0,
    questionComplexity: 0, imperativeVerbs: 0, constraints: 0,
    outputFormat: 0, domainSpecificity: 0, agenticTasks: 0, relayIndicators: 0,
  },
  textExcerpt: "",
};

function extractUserText(messages: ReadonlyArray<Message>): string {
  const recent = messages.slice(-3);
  let text = "";
  for (const msg of recent) {
    if (msg.role !== "user") continue;
    if (typeof msg.content === "string") {
      text += msg.content + " ";
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === "text" && block.text) {
          text += block.text + " ";
        }
      }
    }
  }
  return text;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function scoreTokenCount(tokens: number): number {
  if (tokens >= 1000) return 1.0;
  if (tokens <= 100) return 0.0;
  return (tokens - 100) / 900;
}

function matchesKeyword(text: string, keyword: string): boolean {
  const kw = keyword.toLowerCase();
  if (kw.length <= 3) {
    return new RegExp(`\\b${kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(text);
  }
  return text.includes(kw);
}

function countKeywordMatches(text: string, keywords: ReadonlyArray<string>): number {
  let count = 0;
  for (const kw of keywords) {
    if (matchesKeyword(text, kw)) count++;
  }
  return count;
}

function scoreKeywords(
  text: string,
  keywords: ReadonlyArray<string>,
  threshLow: number,
  threshHigh: number,
  scoreLow: number,
  scoreHigh: number,
): number {
  const matches = countKeywordMatches(text, keywords);
  if (matches >= threshHigh) return scoreHigh;
  if (matches >= threshLow) return scoreLow;
  return 0;
}

function scoreMultiStep(text: string): number {
  for (const pattern of MULTI_STEP_REGEX_PATTERNS) {
    if (new RegExp(pattern, "i").test(text)) return 0.5;
  }
  for (const literal of MULTI_STEP_LITERAL_PATTERNS) {
    if (text.includes(literal)) return 0.5;
  }
  return 0;
}

function scoreQuestionComplexity(text: string): number {
  const questionMarks = text.split("?").length - 1;
  const hasCompound = text.includes("and also") || text.includes("additionally");
  if (questionMarks > 3) return 0.5;
  if (questionMarks > 1 && hasCompound) return 0.3;
  return 0;
}

function buildConfig(partial?: Partial<ScoringConfig>): ScoringConfig {
  return {
    weights: { ...DEFAULT_WEIGHTS, ...partial?.weights },
    boundaries: { ...DEFAULT_BOUNDARIES, ...partial?.boundaries },
    confidenceThreshold: partial?.confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD,
  };
}

export function scoreComplexity(
  messages: ReadonlyArray<Message>,
  config?: Partial<ScoringConfig>,
): ScoringResult {
  const text = extractUserText(messages);
  if (text.trim().length === 0) return EMPTY_RESULT;

  const cfg = buildConfig(config);
  const lower = text.toLowerCase();
  const tokens = estimateTokens(text);

  const dimensions: Record<string, number> = {
    tokenCount: scoreTokenCount(tokens),
    codePresence: scoreKeywords(lower, CODE_KEYWORDS, 1, 3, 0.5, 1.0),
    reasoningMarkers: scoreKeywords(lower, REASONING_KEYWORDS, 1, 2, 0.6, 1.0),
    technicalTerms: scoreKeywords(lower, TECHNICAL_KEYWORDS, 2, 4, 0.5, 1.0),
    creativeMarkers: scoreKeywords(lower, CREATIVE_KEYWORDS, 1, 2, 0.4, 0.7),
    simpleIndicators: scoreKeywords(lower, SIMPLE_KEYWORDS, 1, 2, -0.8, -1.0),
    multiStepPatterns: scoreMultiStep(lower),
    questionComplexity: scoreQuestionComplexity(text),
    imperativeVerbs: scoreKeywords(lower, IMPERATIVE_KEYWORDS, 1, 2, 0.3, 0.5),
    constraints: scoreKeywords(lower, CONSTRAINT_KEYWORDS, 1, 3, 0.3, 0.7),
    outputFormat: scoreKeywords(lower, FORMAT_KEYWORDS, 1, 2, 0.4, 0.7),
    domainSpecificity: scoreKeywords(lower, DOMAIN_KEYWORDS, 1, 2, 0.5, 0.8),
    agenticTasks: scoreKeywords(lower, AGENTIC_KEYWORDS, 2, 4, 0.4, 0.8),
    relayIndicators: scoreKeywords(lower, RELAY_KEYWORDS, 1, 2, -0.9, -1.0),
  };

  let score = 0;
  for (const [name, dimScore] of Object.entries(dimensions)) {
    const weight = cfg.weights[name] ?? 0;
    score += dimScore * weight;
  }

  const confidence = 1 / (1 + Math.exp(-Math.abs(score) * 10));

  return {
    score,
    confidence,
    dimensions,
    textExcerpt: text.slice(0, 50),
  };
}
