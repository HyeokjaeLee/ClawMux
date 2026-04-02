import { describe, expect, it } from "bun:test";
import { buildSyntheticSummaryResponse, buildSyntheticHttpResponse } from "./synthetic-response.ts";
import type { ParsedResponse } from "../adapters/response-types.ts";

describe("buildSyntheticSummaryResponse", () => {
  it("formats summary and recent messages correctly", () => {
    const result = buildSyntheticSummaryResponse(
      "The user discussed sorting algorithms.",
      [
        { role: "user", content: "What about quicksort?" },
        { role: "assistant", content: "Quicksort uses divide and conquer." },
      ],
      "claude-sonnet-4-20250514",
    );

    expect(result.content).toContain("<summary>");
    expect(result.content).toContain("The user discussed sorting algorithms.");
    expect(result.content).toContain("</summary>");
    expect(result.content).toContain("<recent_messages>");
    expect(result.content).toContain("[user]: What about quicksort?");
    expect(result.content).toContain("[assistant]: Quicksort uses divide and conquer.");
    expect(result.content).toContain("</recent_messages>");
  });

  it("returns correct ParsedResponse structure", () => {
    const result = buildSyntheticSummaryResponse(
      "Summary text",
      [],
      "test-model",
    );

    expect(result.id).toMatch(/^msg_precomputed_\d+$/);
    expect(result.model).toBe("test-model");
    expect(result.role).toBe("assistant");
    expect(result.stopReason).toBe("end_turn");
    expect(result.usage).toBeDefined();
    expect(result.usage?.inputTokens).toBe(0);
    expect(result.usage?.outputTokens).toBeGreaterThan(0);
  });

  it("handles array content blocks in recent messages", () => {
    const result = buildSyntheticSummaryResponse(
      "Summary",
      [
        {
          role: "user",
          content: [{ type: "text", text: "block content" }],
        },
      ],
      "model",
    );

    expect(result.content).toContain("[user]: block content");
  });
});

describe("buildSyntheticHttpResponse", () => {
  const sampleParsed: ParsedResponse = {
    id: "msg_precomputed_123",
    model: "test-model",
    content: "<summary>\ntest\n</summary>",
    role: "assistant",
    stopReason: "end_turn",
    usage: { inputTokens: 0, outputTokens: 10 },
  };

  it("sets x-synthetic-response header", async () => {
    const response = buildSyntheticHttpResponse(sampleParsed, {});
    expect(response.headers.get("x-synthetic-response")).toBe("true");
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.status).toBe(200);
  });

  it("calls adapter.buildResponse when available", async () => {
    let calledWith: ParsedResponse | undefined;
    const adapter = {
      buildResponse(parsed: ParsedResponse): Record<string, unknown> {
        calledWith = parsed;
        return { custom: true, id: parsed.id };
      },
    };

    const response = buildSyntheticHttpResponse(sampleParsed, adapter);
    const body = await response.json() as Record<string, unknown>;

    expect(calledWith).toBe(sampleParsed);
    expect(body.custom).toBe(true);
    expect(body.id).toBe("msg_precomputed_123");
  });

  it("builds Anthropic-format fallback when adapter has no buildResponse", async () => {
    const response = buildSyntheticHttpResponse(sampleParsed, {});
    const body = await response.json() as Record<string, unknown>;

    expect(body.id).toBe("msg_precomputed_123");
    expect(body.type).toBe("message");
    expect(body.role).toBe("assistant");
    expect(body.model).toBe("test-model");
    expect(body.stop_reason).toBe("end_turn");

    const content = body.content as Array<Record<string, unknown>>;
    expect(content).toHaveLength(1);
    expect(content[0].type).toBe("text");
    expect(content[0].text).toBe("<summary>\ntest\n</summary>");

    const usage = body.usage as Record<string, unknown>;
    expect(usage.input_tokens).toBe(0);
    expect(usage.output_tokens).toBe(10);
  });

  it("handles missing usage in fallback", async () => {
    const noUsage: ParsedResponse = {
      ...sampleParsed,
      usage: undefined,
    };
    const response = buildSyntheticHttpResponse(noUsage, {});
    const body = await response.json() as Record<string, unknown>;

    expect(body.usage).toBeUndefined();
  });
});
