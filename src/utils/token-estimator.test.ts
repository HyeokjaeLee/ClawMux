import { describe, expect, it } from "bun:test";
import {
  estimateBlockTokens,
  estimateMessagesTokens,
  estimateTokens,
  isCJK,
} from "./token-estimator.ts";

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
    expect(isCJK(0xf900)).toBe(true);
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
    expect(estimateTokens("hello world")).toBe(3);
  });

  it("estimates Korean text (~2.5 tokens per character)", () => {
    expect(estimateTokens("안녕하세요")).toBe(13);
  });

  it("estimates mixed English + Korean", () => {
    expect(estimateTokens("Hello 안녕")).toBe(7);
  });

  it("estimates code text", () => {
    expect(estimateTokens("function foo() { return bar; }")).toBe(8);
  });

  it("handles whitespace-only string", () => {
    expect(estimateTokens("   ")).toBe(1);
  });

  it("handles CJK ideographs", () => {
    expect(estimateTokens("漢字")).toBe(5);
  });
});

describe("estimateBlockTokens", () => {
  it("counts text block", () => {
    expect(estimateBlockTokens({ type: "text", text: "hello" })).toBe(
      estimateTokens("hello"),
    );
  });

  it("counts thinking block", () => {
    expect(
      estimateBlockTokens({ type: "thinking", thinking: "reasoning here" }),
    ).toBe(estimateTokens("reasoning here"));
  });

  it("counts tool_use name + input", () => {
    const block = {
      type: "tool_use",
      id: "call_1",
      name: "search",
      input: { query: "hello world" },
    };
    const expected =
      estimateTokens("search") +
      estimateTokens(JSON.stringify({ query: "hello world" }));
    expect(estimateBlockTokens(block)).toBe(expected);
  });

  it("counts tool_result with string content", () => {
    const block = {
      type: "tool_result",
      tool_use_id: "call_1",
      content: "a".repeat(400),
    };
    expect(estimateBlockTokens(block)).toBe(estimateTokens("a".repeat(400)));
  });

  it("counts tool_result with array of text blocks", () => {
    const block = {
      type: "tool_result",
      tool_use_id: "call_1",
      content: [
        { type: "text", text: "part one" },
        { type: "text", text: "part two" },
      ],
    };
    const expected =
      estimateTokens("part one") + estimateTokens("part two");
    expect(estimateBlockTokens(block)).toBe(expected);
  });

  it("counts image block as a conservative constant", () => {
    const block = { type: "image", source: { type: "base64", data: "..." } };
    expect(estimateBlockTokens(block)).toBeGreaterThan(0);
  });

  it("falls back to JSON estimation for unknown block types", () => {
    const block = { type: "custom_future_block", payload: "some data" };
    expect(estimateBlockTokens(block)).toBe(
      estimateTokens(JSON.stringify(block)),
    );
  });
});

describe("estimateMessagesTokens", () => {
  it("returns 0 for empty array", () => {
    expect(estimateMessagesTokens([])).toBe(0);
  });

  it("estimates simple string content messages", () => {
    const messages = [{ role: "user", content: "hello" }];
    const expected = estimateTokens("hello") + 4;
    expect(estimateMessagesTokens(messages)).toBe(expected);
  });

  it("includes non-text blocks in array content", () => {
    const content = [
      { type: "text", text: "hello" },
      { type: "tool_use", id: "1", name: "fetch", input: { url: "x" } },
    ];
    const messages = [{ role: "assistant", content }];
    const expected =
      estimateTokens("hello") +
      estimateTokens("fetch") +
      estimateTokens(JSON.stringify({ url: "x" })) +
      4;
    expect(estimateMessagesTokens(messages)).toBe(expected);
  });

  it("includes tool_result content", () => {
    const toolResult = "R".repeat(1000);
    const content = [
      { type: "text", text: "hi" },
      { type: "tool_result", tool_use_id: "1", content: toolResult },
    ];
    const messages = [{ role: "user", content }];
    const expected =
      estimateTokens("hi") + estimateTokens(toolResult) + 4;
    expect(estimateMessagesTokens(messages)).toBe(expected);
  });

  it("handles multiple messages", () => {
    const messages = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "안녕하세요" },
    ];
    const expected =
      estimateTokens("hello") + estimateTokens("안녕하세요") + 4 + 4;
    expect(estimateMessagesTokens(messages)).toBe(expected);
  });

  it("counts image block tokens for multimodal inputs", () => {
    const content = [
      { type: "text", text: "see this:" },
      { type: "image", source: { type: "base64", data: "..." } },
    ];
    const messages = [{ role: "user", content }];
    const result = estimateMessagesTokens(messages);
    expect(result).toBeGreaterThan(estimateTokens("see this:") + 4);
  });

  it("does NOT drop unknown block types silently", () => {
    const content = [{ type: "weirdo_block", data: "X".repeat(400) }];
    const messages = [{ role: "assistant", content }];
    const result = estimateMessagesTokens(messages);
    expect(result).toBeGreaterThan(4);
  });
});
