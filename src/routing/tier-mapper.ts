import type { ScoringResult, Tier, RoutingDecision } from "./types.ts";

const DEFAULT_BOUNDARIES = {
  lightMedium: 0.0,
  mediumHeavy: 0.35,
} as const;

const DEFAULT_CONFIDENCE_THRESHOLD = 0.7;

export function mapScoreToTier(
  score: number,
  confidence: number,
  boundaries: { lightMedium: number; mediumHeavy: number },
  confidenceThreshold: number,
): { tier: Tier; overrideReason?: string } {
  if (confidence < confidenceThreshold) {
    return { tier: "MEDIUM", overrideReason: "Low confidence fallback" };
  }

  if (score < boundaries.lightMedium) {
    return { tier: "LIGHT" };
  }
  if (score < boundaries.mediumHeavy) {
    return { tier: "MEDIUM" };
  }
  return { tier: "HEAVY" };
}

export function selectModel(
  tier: Tier,
  models: { LIGHT: string; MEDIUM: string; HEAVY: string },
): string {
  return models[tier];
}

export function routeRequest(
  scoringResult: ScoringResult,
  config: {
    models: { LIGHT: string; MEDIUM: string; HEAVY: string };
    scoring?: {
      boundaries?: { lightMedium: number; mediumHeavy: number };
      confidenceThreshold?: number;
    };
  },
): RoutingDecision {
  const boundaries = config.scoring?.boundaries ?? DEFAULT_BOUNDARIES;
  const confidenceThreshold = config.scoring?.confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD;

  const { tier, overrideReason } = mapScoreToTier(
    scoringResult.score,
    scoringResult.confidence,
    boundaries,
    confidenceThreshold,
  );

  return {
    tier,
    model: selectModel(tier, config.models),
    confidence: scoringResult.confidence,
    overrideReason,
  };
}
