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

/** Dimension name → weight mapping. Weights should sum to ~1.0. */
export type ScoringWeights = Record<string, number>;

/** Full scoring configuration with overridable defaults. */
export type ScoringConfig = {
  weights: ScoringWeights;
  boundaries: { lightMedium: number; mediumHeavy: number };
  confidenceThreshold: number;
};

export type Tier = "LIGHT" | "MEDIUM" | "HEAVY";

export type RoutingDecision = {
  tier: Tier;
  model: string;
  confidence: number;
  overrideReason?: string;
};

export type ClassificationTier = "LIGHT" | "MEDIUM" | "HEAVY";

export type ClassificationResult = {
  tier: ClassificationTier;
  confidence: number;
  reasoning?: string;
  error?: string;
};

/** A single message in the Anthropic messages format. */
export type Message = {
  role: string;
  content: string | ReadonlyArray<ContentBlock>;
};

/** A content block within an array-format message. */
export type ContentBlock = {
  type: string;
  text?: string;
};
