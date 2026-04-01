import { describe, expect, test } from "bun:test";
import { scoreComplexity } from "./scorer.ts";
import type { Message } from "./types.ts";

describe("scoreComplexity", () => {
  test("trivial greeting scores negative (LIGHT)", () => {
    const messages: Message[] = [{ role: "user", content: "hello" }];
    const result = scoreComplexity(messages);
    expect(result.score).toBeLessThan(0.0);
    expect(result.textExcerpt).toBe("hello ");
  });

  test("simple question scores negative (LIGHT)", () => {
    const messages: Message[] = [
      { role: "user", content: "what is 2+2?" },
    ];
    const result = scoreComplexity(messages);
    expect(result.score).toBeLessThan(0.0);
  });

  test("medium complexity task scores between 0.0 and 0.35", () => {
    const messages: Message[] = [
      {
        role: "user",
        content:
          "Create a TypeScript function that validates email addresses",
      },
    ];
    const result = scoreComplexity(messages);
    expect(result.score).toBeGreaterThanOrEqual(0.0);
    expect(result.score).toBeLessThan(0.35);
  });

  test("heavy reasoning task scores above 0.35", () => {
    const messages: Message[] = [
      {
        role: "user",
        content:
          "Analyze the trade-offs between microservice and monolith architectures. Compare performance, deployment complexity, and team scaling implications. Provide a methodology for migration.",
      },
    ];
    const result = scoreComplexity(messages);
    expect(result.score).toBeGreaterThan(0.35);
  });

  test("system prompt content is excluded from scoring", () => {
    const heavySystemPrompt =
      "You are an expert architect. Analyze trade-offs, evaluate microservice patterns, " +
      "synthesize complex distributed systems, compare methodologies, and provide step-by-step reasoning.";
    const messages: Message[] = [
      { role: "system", content: heavySystemPrompt },
      { role: "user", content: "hello" },
    ];
    const result = scoreComplexity(messages);
    expect(result.score).toBeLessThan(0.0);
  });

  test("only last 3 messages are considered, user messages only", () => {
    const messages: Message[] = [
      { role: "user", content: "Analyze the architecture of distributed systems with microservices" },
      { role: "assistant", content: "Sure, let me help." },
      { role: "user", content: "Also evaluate the trade-offs of kubernetes deployment" },
      { role: "assistant", content: "Here is my analysis..." },
      { role: "user", content: "hello" },
      { role: "assistant", content: "Hi there!" },
      { role: "user", content: "hello" },
      { role: "assistant", content: "Hello again!" },
      { role: "user", content: "thanks" },
      { role: "user", content: "ok" },
    ];
    const result = scoreComplexity(messages);
    expect(result.score).toBeLessThan(0.0);
  });

  test("empty messages array returns score 0.0 and confidence ~0.5", () => {
    const result = scoreComplexity([]);
    expect(result.score).toBe(0.0);
    expect(result.confidence).toBeCloseTo(0.5, 1);
    expect(result.textExcerpt).toBe("");
  });

  test("array content format is handled correctly", () => {
    const messages: Message[] = [
      {
        role: "user",
        content: [{ type: "text", text: "hello" }],
      },
    ];
    const result = scoreComplexity(messages);
    expect(result.score).toBeLessThan(0.0);
    expect(result.textExcerpt).toBe("hello ");
  });

  test("confidence is between 0 and 1", () => {
    const messages: Message[] = [
      { role: "user", content: "Analyze the trade-offs of microservice architecture" },
    ];
    const result = scoreComplexity(messages);
    expect(result.confidence).toBeGreaterThanOrEqual(0.0);
    expect(result.confidence).toBeLessThanOrEqual(1.0);
  });

  test("dimensions object contains all 14 dimensions", () => {
    const messages: Message[] = [{ role: "user", content: "hello" }];
    const result = scoreComplexity(messages);
    const expectedDimensions = [
      "tokenCount", "codePresence", "reasoningMarkers", "technicalTerms",
      "creativeMarkers", "simpleIndicators", "multiStepPatterns",
      "questionComplexity", "imperativeVerbs", "constraints",
      "outputFormat", "domainSpecificity", "agenticTasks", "relayIndicators",
    ];
    for (const dim of expectedDimensions) {
      expect(result.dimensions).toHaveProperty(dim);
    }
  });

  test("textExcerpt is truncated to 50 characters", () => {
    const longText = "a".repeat(100);
    const messages: Message[] = [{ role: "user", content: longText }];
    const result = scoreComplexity(messages);
    expect(result.textExcerpt.length).toBeLessThanOrEqual(50);
  });

  test("custom config overrides default weights", () => {
    const messages: Message[] = [{ role: "user", content: "hello" }];
    const resultDefault = scoreComplexity(messages);
    const resultCustom = scoreComplexity(messages, {
      weights: { simpleIndicators: 0.5 },
    });
    expect(resultCustom.score).not.toBe(resultDefault.score);
  });

  test("assistant messages in last 3 are skipped", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: "Analyze the trade-offs between microservice and monolith architectures with methodology",
      },
      { role: "user", content: "thanks" },
    ];
    const result = scoreComplexity(messages);
    expect(result.score).toBeLessThan(0.0);
  });

  test("code presence dimension detects backticks and keywords", () => {
    const messages: Message[] = [
      {
        role: "user",
        content: "```typescript\nfunction hello() { return 'world'; }\n```",
      },
    ];
    const result = scoreComplexity(messages);
    expect(result.dimensions.codePresence).toBeGreaterThan(0);
  });

  test("messages with only non-text content blocks are handled", () => {
    const messages: Message[] = [
      {
        role: "user",
        content: [{ type: "image", text: undefined }],
      },
    ];
    const result = scoreComplexity(messages);
    expect(result.score).toBe(0.0);
  });
});
