import { describe, expect, it } from "bun:test";
import {
  compressMessagesMapReduce,
  splitMessagesByBudget,
  DEFAULT_MAP_REDUCE_CONFIG,
} from "./map-reduce.ts";
import { estimateMessagesTokens } from "../utils/token-estimator.ts";

function makeMessage(role: string, length: number) {
  return { role, content: "x".repeat(length) };
}

describe("splitMessagesByBudget", () => {
  it("returns empty array for empty input", () => {
    expect(splitMessagesByBudget([], 1000)).toEqual([]);
  });

  it("packs messages under the budget into a single chunk", () => {
    const messages = [
      makeMessage("user", 40),
      makeMessage("assistant", 40),
    ];
    const chunks = splitMessagesByBudget(messages, 1000);
    expect(chunks.length).toBe(1);
    expect(chunks[0].length).toBe(2);
  });

  it("splits messages across chunks when budget is exceeded", () => {
    const messages = Array.from({ length: 10 }, (_, i) =>
      makeMessage(i % 2 === 0 ? "user" : "assistant", 400),
    );
    const chunks = splitMessagesByBudget(messages, 150);
    expect(chunks.length).toBeGreaterThan(1);
    const flattened = chunks.flat();
    expect(flattened.length).toBe(messages.length);
  });

  it("emits a single oversized message as its own chunk instead of dropping it", () => {
    const messages = [
      makeMessage("user", 5),
      makeMessage("assistant", 8000),
      makeMessage("user", 5),
    ];
    const chunks = splitMessagesByBudget(messages, 100);
    expect(chunks.flat().length).toBe(messages.length);
    const oversizedChunk = chunks.find(
      (c) => c.length === 1 && typeof c[0].content === "string" && c[0].content.length === 8000,
    );
    expect(oversizedChunk).toBeDefined();
  });

  it("preserves message order across chunks", () => {
    const messages = Array.from({ length: 20 }, (_, i) =>
      makeMessage("user", 200),
    );
    const chunks = splitMessagesByBudget(messages, 150);
    const flat = chunks.flat();
    for (let i = 0; i < messages.length; i++) {
      expect(flat[i]).toBe(messages[i]);
    }
  });
});

describe("compressMessagesMapReduce", () => {
  it("calls summarize exactly once when input fits under the safety budget", async () => {
    const calls: Array<{ count: number; msgs: number }> = [];
    const summarize = async (msgs: Array<{ role: string; content: unknown }>) => {
      calls.push({ count: calls.length, msgs: msgs.length });
      return "## Summary\n- tiny payload handled";
    };

    const messages = [
      makeMessage("user", 20),
      makeMessage("assistant", 30),
    ];
    const result = await compressMessagesMapReduce(
      messages,
      500,
      undefined,
      summarize,
    );
    expect(calls.length).toBe(1);
    expect(result).toContain("tiny payload");
  });

  it("splits oversized conversations into chunks and reduces recursively", async () => {
    let callCount = 0;
    const summarize = async (msgs: Array<{ role: string; content: unknown }>) => {
      callCount++;
      return `## Summary of ${msgs.length} messages (call #${callCount})`;
    };

    const messages = Array.from({ length: 40 }, () => makeMessage("user", 1000));
    const config = {
      modelContextWindow: 2000,
      safetyRatio: 0.5,
      maxDepth: 4,
      minChunkMessages: 2,
    };
    const result = await compressMessagesMapReduce(
      messages,
      500,
      undefined,
      summarize,
      config,
    );

    expect(callCount).toBeGreaterThan(1);
    expect(result).toContain("Summary");
  });

  it("respects maxDepth and stops recursing even if budget is still exceeded", async () => {
    let callCount = 0;
    const summarize = async () => {
      callCount++;
      return "x".repeat(5000);
    };

    const messages = Array.from({ length: 20 }, () => makeMessage("user", 2000));
    const config = {
      modelContextWindow: 1000,
      safetyRatio: 0.5,
      maxDepth: 2,
      minChunkMessages: 2,
    };
    await compressMessagesMapReduce(
      messages,
      500,
      undefined,
      summarize,
      config,
    );

    expect(callCount).toBeGreaterThan(0);
    expect(callCount).toBeLessThan(1000);
  });

  it("passes previousSummary only on the final (top-level) summarisation", async () => {
    const seenPreviousSummaries: Array<string | undefined> = [];
    const summarize = async (
      msgs: Array<{ role: string; content: unknown }>,
      _target: number,
      previousSummary: string | undefined,
    ) => {
      seenPreviousSummaries.push(previousSummary);
      return "## Summary ok";
    };

    const messages = [makeMessage("user", 50)];
    await compressMessagesMapReduce(
      messages,
      500,
      "previous summary here",
      summarize,
    );
    expect(seenPreviousSummaries.length).toBe(1);
    expect(seenPreviousSummaries[0]).toBe("previous summary here");
  });

  it("reports reasonable progress — summary shrinks across recursion", async () => {
    let totalInputSizes = 0;
    const summarize = async (
      msgs: Array<{ role: string; content: unknown }>,
    ) => {
      totalInputSizes += estimateMessagesTokens(
        msgs as Array<{ role: string; content: string }>,
      );
      return "## Summary\n- shrunk";
    };

    const messages = Array.from({ length: 30 }, () => makeMessage("user", 800));
    const config = {
      modelContextWindow: 2000,
      safetyRatio: 0.5,
      maxDepth: 4,
      minChunkMessages: 2,
    };
    const result = await compressMessagesMapReduce(
      messages,
      400,
      undefined,
      summarize,
      config,
    );

    expect(result).toBeTruthy();
    expect(totalInputSizes).toBeGreaterThan(0);
  });
});

describe("DEFAULT_MAP_REDUCE_CONFIG", () => {
  it("has safety margin under 1.0", () => {
    expect(DEFAULT_MAP_REDUCE_CONFIG.safetyRatio).toBeLessThan(1.0);
    expect(DEFAULT_MAP_REDUCE_CONFIG.safetyRatio).toBeGreaterThan(0.3);
  });

  it("limits recursion depth", () => {
    expect(DEFAULT_MAP_REDUCE_CONFIG.maxDepth).toBeGreaterThanOrEqual(2);
    expect(DEFAULT_MAP_REDUCE_CONFIG.maxDepth).toBeLessThanOrEqual(8);
  });
});
