import { describe, test, expect } from "bun:test";
import { withReasoningDisabled } from "./reasoning-disable.ts";

describe("withReasoningDisabled", () => {
  const baseBody = {
    model: "test-model",
    messages: [{ role: "user", content: "hello" }],
    stream: false,
    max_tokens: 1,
  };

  test("openai-completions: injects reasoning_effort none", () => {
    const result = withReasoningDisabled(baseBody, "openai-completions");
    expect(result).toEqual({
      ...baseBody,
      reasoning_effort: "none",
    });
    // does not mutate original
    expect(baseBody).not.toHaveProperty("reasoning_effort");
  });

  test("openai-responses: injects reasoning.effort none", () => {
    const result = withReasoningDisabled(baseBody, "openai-responses");
    expect(result).toEqual({
      ...baseBody,
      reasoning: { effort: "none" },
    });
  });

  test("anthropic-messages: returns body unchanged", () => {
    const result = withReasoningDisabled(baseBody, "anthropic-messages");
    expect(result).toEqual(baseBody);
  });

  test("google-generative-ai: injects thinkingConfig with thinkingBudget 0", () => {
    const result = withReasoningDisabled(baseBody, "google-generative-ai");
    expect(result).toEqual({
      ...baseBody,
      generationConfig: {
        thinkingConfig: { thinkingBudget: 0 },
      },
    });
  });

  test("google-generative-ai: preserves existing generationConfig", () => {
    const bodyWithConfig = {
      ...baseBody,
      generationConfig: { maxOutputTokens: 100, temperature: 0.5 },
    };
    const result = withReasoningDisabled(bodyWithConfig, "google-generative-ai");
    expect(result).toEqual({
      ...bodyWithConfig,
      generationConfig: {
        maxOutputTokens: 100,
        temperature: 0.5,
        thinkingConfig: { thinkingBudget: 0 },
      },
    });
  });

  test("google-generative-ai: handles null generationConfig", () => {
    const bodyWithNull = { ...baseBody, generationConfig: null };
    const result = withReasoningDisabled(bodyWithNull, "google-generative-ai");
    expect(result).toEqual({
      ...baseBody,
      generationConfig: {
        thinkingConfig: { thinkingBudget: 0 },
      },
    });
  });

  test("ollama: injects think false", () => {
    const result = withReasoningDisabled(baseBody, "ollama");
    expect(result).toEqual({
      ...baseBody,
      think: false,
    });
  });

  test("bedrock-converse-stream: returns body unchanged", () => {
    const result = withReasoningDisabled(baseBody, "bedrock-converse-stream");
    expect(result).toEqual(baseBody);
  });

  test("unknown apiType: returns body unchanged", () => {
    const result = withReasoningDisabled(baseBody, "some-unknown-type");
    expect(result).toEqual(baseBody);
  });

  test("openai-completions: does not override existing reasoning_effort", () => {
    const bodyWithEffort = { ...baseBody, reasoning_effort: "high" };
    const result = withReasoningDisabled(bodyWithEffort, "openai-completions");
    // withReasoningDisabled always sets to "none"
    expect(result.reasoning_effort).toBe("none");
  });

  test("ollama: overrides existing think to false", () => {
    const bodyWithThink = { ...baseBody, think: true };
    const result = withReasoningDisabled(bodyWithThink, "ollama");
    expect(result.think).toBe(false);
  });
});
