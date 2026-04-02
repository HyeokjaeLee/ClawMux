import { describe, expect, it } from "bun:test";
import { detectCompaction } from "./compaction-detector.ts";

describe("detectCompaction", () => {
  describe("header detection", () => {
    it("detects X-Request-Compaction: true header", () => {
      const result = detectCompaction(
        { "x-request-compaction": "true" },
        [{ role: "user", content: "hello" }],
      );
      expect(result).toEqual({
        isCompaction: true,
        detectedBy: "header",
        confidence: 1.0,
      });
    });

    it("handles case-insensitive header name", () => {
      const result = detectCompaction(
        { "X-Request-Compaction": "true" },
        [{ role: "user", content: "hello" }],
      );
      expect(result).toEqual({
        isCompaction: true,
        detectedBy: "header",
        confidence: 1.0,
      });
    });

    it("ignores header with non-true value", () => {
      const result = detectCompaction(
        { "x-request-compaction": "false" },
        [{ role: "user", content: "hello" }],
      );
      expect(result).toEqual({
        isCompaction: false,
        detectedBy: "none",
        confidence: 0.0,
      });
    });

    it("header takes priority over prompt pattern", () => {
      const result = detectCompaction(
        { "x-request-compaction": "true" },
        [{ role: "user", content: "summarize the conversation" }],
      );
      expect(result.detectedBy).toBe("header");
      expect(result.confidence).toBe(1.0);
    });
  });

  describe("prompt pattern detection", () => {
    const patterns = [
      "merge these partial summaries into a single cohesive summary",
      "preserve all opaque identifiers exactly as written",
      "your task is to create a detailed summary of the conversation so far",
      "do not use any tools. you must respond with only the <summary>",
      "important: do not use any tools",
      "summarize the conversation",
      "create a summary of our conversation",
      "compact the conversation",
    ];

    for (const pattern of patterns) {
      it(`detects pattern: "${pattern.slice(0, 50)}..."`, () => {
        const result = detectCompaction(
          {},
          [{ role: "user", content: `Please ${pattern} now.` }],
        );
        expect(result).toEqual({
          isCompaction: true,
          detectedBy: "prompt_pattern",
          confidence: 0.95,
        });
      });
    }

    it("matches case-insensitively", () => {
      const result = detectCompaction(
        {},
        [{ role: "user", content: "SUMMARIZE THE CONVERSATION please" }],
      );
      expect(result.isCompaction).toBe(true);
      expect(result.detectedBy).toBe("prompt_pattern");
    });

    it("only checks the last user message", () => {
      const result = detectCompaction(
        {},
        [
          { role: "user", content: "summarize the conversation" },
          { role: "assistant", content: "Sure, here is a summary." },
          { role: "user", content: "What is 2+2?" },
        ],
      );
      expect(result.isCompaction).toBe(false);
    });

    it("skips assistant and system messages when finding last user", () => {
      const result = detectCompaction(
        {},
        [
          { role: "user", content: "hello" },
          { role: "assistant", content: "hi" },
          { role: "user", content: "compact the conversation" },
          { role: "assistant", content: "ok" },
        ],
      );
      expect(result.isCompaction).toBe(true);
      expect(result.detectedBy).toBe("prompt_pattern");
    });

    it("handles Anthropic-style content blocks", () => {
      const result = detectCompaction(
        {},
        [
          {
            role: "user",
            content: [
              { type: "text", text: "Please summarize the conversation for me." },
            ],
          },
        ],
      );
      expect(result.isCompaction).toBe(true);
      expect(result.detectedBy).toBe("prompt_pattern");
    });

    it("handles multi-block content", () => {
      const result = detectCompaction(
        {},
        [
          {
            role: "user",
            content: [
              { type: "text", text: "Here is context." },
              { type: "text", text: "Now compact the conversation." },
            ],
          },
        ],
      );
      expect(result.isCompaction).toBe(true);
    });
  });

  describe("no match", () => {
    it("returns isCompaction false for normal messages", () => {
      const result = detectCompaction(
        {},
        [{ role: "user", content: "Write a function to sort an array" }],
      );
      expect(result).toEqual({
        isCompaction: false,
        detectedBy: "none",
        confidence: 0.0,
      });
    });

    it("returns isCompaction false for empty messages", () => {
      const result = detectCompaction({}, []);
      expect(result).toEqual({
        isCompaction: false,
        detectedBy: "none",
        confidence: 0.0,
      });
    });
  });
});
