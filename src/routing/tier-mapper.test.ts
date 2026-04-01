import { describe, expect, it } from "bun:test";
import { mapScoreToTier, selectModel, routeRequest } from "./tier-mapper.ts";
import type { ScoringResult, Tier } from "./types.ts";
import { DEFAULT_BOUNDARIES, DEFAULT_CONFIDENCE_THRESHOLD } from "./keywords.ts";

describe("mapScoreToTier", () => {
  it("score=-0.5, conf=0.9 → LIGHT", () => {
    const result = mapScoreToTier(-0.5, 0.9, DEFAULT_BOUNDARIES, DEFAULT_CONFIDENCE_THRESHOLD);
    expect(result.tier).toBe("LIGHT");
    expect(result.overrideReason).toBeUndefined();
  });

  it("score=0.15, conf=0.9 → MEDIUM", () => {
    const result = mapScoreToTier(0.15, 0.9, DEFAULT_BOUNDARIES, DEFAULT_CONFIDENCE_THRESHOLD);
    expect(result.tier).toBe("MEDIUM");
    expect(result.overrideReason).toBeUndefined();
  });

  it("score=0.5, conf=0.9 → HEAVY", () => {
    const result = mapScoreToTier(0.5, 0.9, DEFAULT_BOUNDARIES, DEFAULT_CONFIDENCE_THRESHOLD);
    expect(result.tier).toBe("HEAVY");
    expect(result.overrideReason).toBeUndefined();
  });

  it("score=-0.5, conf=0.3 → MEDIUM (low confidence fallback)", () => {
    const result = mapScoreToTier(-0.5, 0.3, DEFAULT_BOUNDARIES, DEFAULT_CONFIDENCE_THRESHOLD);
    expect(result.tier).toBe("MEDIUM");
    expect(result.overrideReason).toBe("Low confidence fallback");
  });

  it("score=0.5, conf=0.3 → MEDIUM (low confidence overrides even HEAVY)", () => {
    const result = mapScoreToTier(0.5, 0.3, DEFAULT_BOUNDARIES, DEFAULT_CONFIDENCE_THRESHOLD);
    expect(result.tier).toBe("MEDIUM");
    expect(result.overrideReason).toBe("Low confidence fallback");
  });

  it("boundary edge: score exactly at lightMedium (0.0) → MEDIUM", () => {
    const result = mapScoreToTier(0.0, 0.9, DEFAULT_BOUNDARIES, DEFAULT_CONFIDENCE_THRESHOLD);
    expect(result.tier).toBe("MEDIUM");
  });

  it("boundary edge: score exactly at mediumHeavy (0.35) → HEAVY", () => {
    const result = mapScoreToTier(0.35, 0.9, DEFAULT_BOUNDARIES, DEFAULT_CONFIDENCE_THRESHOLD);
    expect(result.tier).toBe("HEAVY");
  });
});

describe("selectModel", () => {
  const models: Record<Tier, string> = {
    LIGHT: "claude-3-haiku-20240307",
    MEDIUM: "claude-3-5-sonnet-20241022",
    HEAVY: "claude-3-opus-20240229",
  };

  it("returns correct model for LIGHT", () => {
    expect(selectModel("LIGHT", models)).toBe("claude-3-haiku-20240307");
  });

  it("returns correct model for MEDIUM", () => {
    expect(selectModel("MEDIUM", models)).toBe("claude-3-5-sonnet-20241022");
  });

  it("returns correct model for HEAVY", () => {
    expect(selectModel("HEAVY", models)).toBe("claude-3-opus-20240229");
  });
});

describe("routeRequest", () => {
  const models: Record<Tier, string> = {
    LIGHT: "claude-3-haiku-20240307",
    MEDIUM: "claude-3-5-sonnet-20241022",
    HEAVY: "claude-3-opus-20240229",
  };

  it("routes simple high-confidence request to LIGHT", () => {
    const scoringResult: ScoringResult = {
      score: -0.5,
      confidence: 0.95,
      dimensions: {},
      textExcerpt: "hello",
    };

    const decision = routeRequest(scoringResult, { models });
    expect(decision.tier).toBe("LIGHT");
    expect(decision.model).toBe("claude-3-haiku-20240307");
    expect(decision.confidence).toBe(0.95);
    expect(decision.overrideReason).toBeUndefined();
  });

  it("routes complex high-confidence request to HEAVY", () => {
    const scoringResult: ScoringResult = {
      score: 0.6,
      confidence: 0.9,
      dimensions: {},
      textExcerpt: "complex task",
    };

    const decision = routeRequest(scoringResult, { models });
    expect(decision.tier).toBe("HEAVY");
    expect(decision.model).toBe("claude-3-opus-20240229");
  });

  it("low confidence fallback to MEDIUM with override reason", () => {
    const scoringResult: ScoringResult = {
      score: 0.8,
      confidence: 0.3,
      dimensions: {},
      textExcerpt: "something",
    };

    const decision = routeRequest(scoringResult, { models });
    expect(decision.tier).toBe("MEDIUM");
    expect(decision.model).toBe("claude-3-5-sonnet-20241022");
    expect(decision.overrideReason).toBe("Low confidence fallback");
  });

  it("uses default boundaries when not provided in config", () => {
    const scoringResult: ScoringResult = {
      score: 0.15,
      confidence: 0.9,
      dimensions: {},
      textExcerpt: "medium task",
    };

    const decision = routeRequest(scoringResult, { models });
    expect(decision.tier).toBe("MEDIUM");
  });

  it("uses custom boundaries when provided in config", () => {
    const scoringResult: ScoringResult = {
      score: 0.2,
      confidence: 0.9,
      dimensions: {},
      textExcerpt: "custom boundary test",
    };

    const decision = routeRequest(scoringResult, {
      models,
      scoring: {
        boundaries: { lightMedium: 0.1, mediumHeavy: 0.15 },
        confidenceThreshold: 0.7,
      },
    });
    expect(decision.tier).toBe("HEAVY");
  });
});
