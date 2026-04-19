import { describe, expect, it } from "bun:test";
import {
  compactToolResults,
  DEFAULT_COMPACTOR_CONFIG,
} from "./tool-result-compactor.ts";
import { estimateMessagesTokens } from "../utils/token-estimator.ts";

function toolResultMsg(id: string, size: number) {
  return {
    role: "user",
    content: [
      {
        type: "tool_result",
        tool_use_id: id,
        content: "R".repeat(size),
      },
    ],
  };
}

function textMsg(role: string, text: string) {
  return { role, content: [{ type: "text", text }] };
}

describe("compactToolResults", () => {
  it("returns messages unchanged when already under target", () => {
    const messages = [textMsg("user", "hi"), textMsg("assistant", "hello")];
    const result = compactToolResults(messages, {
      targetTokens: 1_000,
      maxToolResultChars: 16_000,
      minReductionThreshold: 0.05,
    });
    expect(result.truncatedCount).toBe(0);
    expect(result.messages).toEqual(messages);
  });

  it("truncates oversized tool_result content when over target", () => {
    const messages = [
      textMsg("user", "please check"),
      toolResultMsg("call_1", 200_000),
      textMsg("assistant", "done"),
    ];
    const result = compactToolResults(messages, {
      targetTokens: 5_000,
      maxToolResultChars: 4_000,
      minReductionThreshold: 0.05,
    });

    expect(result.truncatedCount).toBeGreaterThanOrEqual(1);
    expect(result.compactedTokens).toBeLessThan(result.originalTokens);

    const block = (result.messages[1].content as Array<{ content: string }>)[0];
    expect(block.content.length).toBeLessThan(200_000);
    expect(block.content).toContain("[tool_result truncated");
  });

  it("preserves text and tool_use blocks untouched", () => {
    const toolUseBlock = {
      type: "tool_use",
      id: "call_2",
      name: "http",
      input: { url: "https://example.com" },
    };
    const messages = [
      textMsg("user", "hello"),
      { role: "assistant", content: [toolUseBlock] },
      toolResultMsg("call_2", 300_000),
    ];
    const result = compactToolResults(messages, {
      targetTokens: 5_000,
      maxToolResultChars: 4_000,
      minReductionThreshold: 0.05,
    });

    expect(result.messages[0]).toEqual(messages[0]);
    const assistantContent = result.messages[1].content as Array<Record<string, unknown>>;
    expect(assistantContent[0]).toEqual(toolUseBlock);
  });

  it("handles tool_result with array-of-text-blocks content", () => {
    const messages = [
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call_3",
            content: [
              { type: "text", text: "X".repeat(100_000) },
              { type: "text", text: "Y".repeat(100_000) },
            ],
          },
        ],
      },
    ];
    const result = compactToolResults(messages, {
      targetTokens: 5_000,
      maxToolResultChars: 3_000,
      minReductionThreshold: 0.05,
    });

    expect(result.truncatedCount).toBeGreaterThanOrEqual(1);
    const block = (result.messages[0].content as Array<{ content: Array<{ text: string }> }>)[0];
    for (const sub of block.content) {
      expect(sub.text.length).toBeLessThan(100_000);
    }
  });

  it("bails out gracefully when no tool_result blocks exist", () => {
    const messages = [
      textMsg("user", "a".repeat(500_000)),
      textMsg("assistant", "b".repeat(500_000)),
    ];
    const result = compactToolResults(messages, {
      targetTokens: 1_000,
      maxToolResultChars: 4_000,
      minReductionThreshold: 0.05,
    });

    expect(result.truncatedCount).toBe(0);
    expect(result.compactedTokens).toBe(result.originalTokens);
  });

  it("shrinks max chars progressively when reduction is not enough", () => {
    const messages = [
      toolResultMsg("c1", 50_000),
      toolResultMsg("c2", 50_000),
      toolResultMsg("c3", 50_000),
      toolResultMsg("c4", 50_000),
      toolResultMsg("c5", 50_000),
    ];

    const result = compactToolResults(messages, {
      targetTokens: 4_000,
      maxToolResultChars: 16_000,
      minReductionThreshold: 0.05,
    });

    expect(result.compactedTokens).toBeLessThan(result.originalTokens);
    expect(result.truncatedCount).toBeGreaterThan(0);
  });

  it("produces messages with correctly estimated reduced token count", () => {
    const messages = [toolResultMsg("c1", 100_000), toolResultMsg("c2", 100_000)];
    const result = compactToolResults(messages, {
      targetTokens: 3_000,
      maxToolResultChars: 2_000,
      minReductionThreshold: 0.05,
    });
    const actualTokens = estimateMessagesTokens(
      result.messages as Array<{ role: string; content: string }>,
    );
    expect(actualTokens).toBe(result.compactedTokens);
  });
});

describe("DEFAULT_COMPACTOR_CONFIG", () => {
  it("has sensible defaults", () => {
    expect(DEFAULT_COMPACTOR_CONFIG.targetTokens).toBeGreaterThan(10_000);
    expect(DEFAULT_COMPACTOR_CONFIG.maxToolResultChars).toBeGreaterThanOrEqual(4_000);
    expect(DEFAULT_COMPACTOR_CONFIG.minReductionThreshold).toBeGreaterThan(0);
  });
});
