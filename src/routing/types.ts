export type ScoringResult = {
  /** Normalized score (-1.0 to 1.0 range). Negative = simple, positive = complex. */
  score: number;
  /** Confidence in the score (0.0–1.0) via sigmoid of |score|. */
  confidence: number;
  /** Per-dimension raw scores before weighting. */
  dimensions: Record<string, number>;
  /** First 50 characters of the scored text for debugging. */
  textExcerpt: string;
};

export type Tier = "LIGHT" | "MEDIUM" | "HEAVY";

export type RoutingDecision = {
  tier: Tier;
  model: string;
  confidence: number;
  overrideReason?: string;
};

/** A single message. Matches Anthropic array-content or OpenAI string-content, with `null` allowed for assistant messages that carry only tool_calls. */
export type Message = {
  role: string;
  content: string | ReadonlyArray<ContentBlock> | null;
};

/** A content block within an array-format message. */
export type ContentBlock = {
  type: string;
  text?: string;
};
