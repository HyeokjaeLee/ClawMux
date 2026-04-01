import { describe, expect, it } from "bun:test";
import { estimateTokens, estimateMessagesTokens, isCJK } from "./token-estimator.ts";

describe("isCJK", () => {
  it("returns true for CJK unified ideographs", () => {
    expect(isCJK("漢".charCodeAt(0))).toBe(true);
    expect(isCJK("字".charCodeAt(0))).toBe(true);
  });

  it("returns true for Korean Hangul", () => {
    expect(isCJK("안".charCodeAt(0))).toBe(true);
    expect(isCJK("녕".charCodeAt(0))).toBe(true);
  });

  it("returns true for CJK compatibility ideographs", () => {
    expect(isCJK(0xF900)).toBe(true);
  });

  it("returns false for ASCII", () => {
    expect(isCJK("a".charCodeAt(0))).toBe(false);
    expect(isCJK(" ".charCodeAt(0))).toBe(false);
  });

  it("returns false for accented Latin", () => {
    expect(isCJK("é".charCodeAt(0))).toBe(false);
  });
});

describe("estimateTokens", () => {
  it("returns 0 for empty string", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("estimates English text (~4 chars per token)", () => {
    expect(estimateTokens("hello world")).toBe(3); // 11 chars / 4 = 2.75, ceil = 3
  });

  it("estimates Korean text (~2.5 tokens per character)", () => {
    expect(estimateTokens("안녕하세요")).toBe(13); // 5 × 2.5 = 12.5, ceil = 13
  });

  it("estimates mixed English + Korean", () => {
    expect(estimateTokens("Hello 안녕")).toBe(7); // 6 ASCII/4=1.5 + 2 CJK×2.5=5 → 6.5, ceil = 7
  });

  it("estimates code text", () => {
    expect(estimateTokens("function foo() { return bar; }")).toBe(8); // 29 chars / 4 = 7.25, ceil = 8
  });

  it("handles whitespace-only string", () => {
    expect(estimateTokens("   ")).toBe(1); // 3 chars / 4 = 0.75, ceil = 1
  });

  it("handles CJK ideographs", () => {
    expect(estimateTokens("漢字")).toBe(5); // 2 × 2.5 = 5, ceil = 5
  });
});

interface Message {
  role: string;
  content: string | Array<{ type: string; text?: string }>;
}

describe("estimateMessagesTokens", () => {
  it("returns 0 for empty array", () => {
    expect(estimateMessagesTokens([])).toBe(0);
  });

  it("estimates simple string content messages", () => {
    const messages: Message[] = [{ role: "user", content: "hello" }];
    const expected = estimateTokens("hello") + 4; // content + overhead
    expect(estimateMessagesTokens(messages)).toBe(expected);
  });

  it("only counts text blocks in array content", () => {
    const content = [
      { type: "text", text: "hello" },
      { type: "image", source: {} },
    ];
    const messages = [{ role: "assistant", content }];
    const expected = estimateTokens("hello") + 4;
    expect(estimateMessagesTokens(messages)).toBe(expected);
  });

  it("handles multiple messages", () => {
    const messages: Message[] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "안녕하세요" },
    ];
    const expected = estimateTokens("hello") + estimateTokens("안녕하세요") + 4 + 4;
    expect(estimateMessagesTokens(messages)).toBe(expected);
  });

  it("handles content array with no text blocks", () => {
    const content = [{ type: "tool_use", id: "1", name: "foo" }];
    const messages = [{ role: "assistant", content }];
    expect(estimateMessagesTokens(messages)).toBe(4); // overhead only
  });

  it("skips content blocks without text field", () => {
    const content = [
      { type: "text", text: "hi" },
      { type: "tool_result", tool_use_id: "1" },
    ];
    const messages = [{ role: "user", content }];
    const expected = estimateTokens("hi") + 4;
    expect(estimateMessagesTokens(messages)).toBe(expected);
  });
});
