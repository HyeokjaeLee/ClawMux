import { describe, expect, it } from "bun:test";
import { toResponsesInput } from "./openai-responses-shared.ts";

describe("toResponsesInput", () => {
  it("strips reasoning_content from assistant messages", () => {
    const input = [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: "hello",
        reasoning_content: "Let me think…",
      },
    ];

    const result = toResponsesInput(input);

    expect(result).toHaveLength(2);
    expect(result[1]).not.toHaveProperty("reasoning_content");
    expect(result[1]).toEqual({ role: "assistant", content: "hello" });
  });

  it("strips tool_calls, tool_call_id, name, function_call", () => {
    const input = [
      {
        role: "assistant",
        content: "calling tool",
        tool_calls: [{ id: "1", type: "function" }],
        function_call: { name: "x", arguments: "{}" },
      },
      {
        role: "tool",
        content: "result",
        tool_call_id: "1",
        name: "x",
      },
    ];

    const result = toResponsesInput(input);

    expect(result).toHaveLength(1);
    expect(result[0]).not.toHaveProperty("tool_calls");
    expect(result[0]).not.toHaveProperty("function_call");
  });

  it("drops role=tool messages entirely", () => {
    const input = [
      { role: "user", content: "a" },
      { role: "tool", content: "result", tool_call_id: "1" },
      { role: "assistant", content: "b" },
    ];

    const result = toResponsesInput(input);

    expect(result).toHaveLength(2);
    expect(result.every((m) => m.role !== "tool")).toBe(true);
  });

  it("drops messages whose content becomes null", () => {
    const input = [
      { role: "user", content: null },
      { role: "assistant", content: "kept" },
    ];

    const result = toResponsesInput(input);

    expect(result).toHaveLength(1);
    expect(result[0].content).toBe("kept");
  });

  it("maps content block types text→input_text, image_url→input_image", () => {
    const input = [
      {
        role: "user",
        content: [
          { type: "text", text: "hi" },
          { type: "image_url", image_url: { url: "data:…" } },
          { type: "other", value: "untouched" },
        ],
      },
    ];

    const result = toResponsesInput(input);

    const content = result[0].content as Array<Record<string, unknown>>;
    expect(content[0].type).toBe("input_text");
    expect(content[1].type).toBe("input_image");
    expect(content[2].type).toBe("other");
  });

  it("preserves plain string content", () => {
    const input = [{ role: "user", content: "plain" }];
    expect(toResponsesInput(input)[0].content).toBe("plain");
  });

  it("strips reasoning_content from nested content parts (regression: input[N].reasoning_content)", () => {
    const input = [
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "hello",
            reasoning_content: "nested thinking",
          },
          {
            type: "text",
            text: "world",
            thinking: { summary: "x" },
          },
        ],
      },
    ];

    const result = toResponsesInput(input);
    const content = result[0].content as Array<Record<string, unknown>>;

    expect(content[0]).not.toHaveProperty("reasoning_content");
    expect(content[0].type).toBe("input_text");
    expect(content[0].text).toBe("hello");

    expect(content[1]).not.toHaveProperty("thinking");
    expect(content[1].type).toBe("input_text");
    expect(content[1].text).toBe("world");
  });

  it("handles a large nested array like input[176] without leaking reasoning keys", () => {
    const many: Array<Record<string, unknown>> = [];
    for (let i = 0; i < 200; i++) {
      many.push({
        role: i % 2 === 0 ? "user" : "assistant",
        content: [
          {
            type: "text",
            text: `msg-${i}`,
            reasoning_content: `secret-${i}`,
            tool_calls: [{ id: `t-${i}` }],
          },
        ],
        reasoning_content: `top-${i}`,
      });
    }

    const result = toResponsesInput(many);

    expect(result).toHaveLength(200);
    for (const msg of result) {
      expect(msg).not.toHaveProperty("reasoning_content");
      expect(msg).not.toHaveProperty("tool_calls");
      const content = msg.content as Array<Record<string, unknown>>;
      for (const part of content) {
        expect(part).not.toHaveProperty("reasoning_content");
        expect(part).not.toHaveProperty("tool_calls");
      }
    }
  });

  it("strips reasoning_content from sibling fields like metadata (not just content)", () => {
    const input = [
      {
        role: "assistant",
        content: "visible",
        metadata: {
          reasoning_content: "should be stripped",
          keep: "ok",
          nested: {
            reasoning_content: "also stripped",
            thinking: { summary: "stripped too" },
            preserved: true,
          },
        },
        extra: {
          reasoning: "stripped at any level",
          fine: 42,
        },
      },
    ];

    const result = toResponsesInput(input);
    const msg = result[0];
    const metadata = msg.metadata as Record<string, unknown>;
    const nested = metadata.nested as Record<string, unknown>;
    const extra = msg.extra as Record<string, unknown>;

    expect(metadata).not.toHaveProperty("reasoning_content");
    expect(metadata.keep).toBe("ok");
    expect(nested).not.toHaveProperty("reasoning_content");
    expect(nested).not.toHaveProperty("thinking");
    expect(nested.preserved).toBe(true);
    expect(extra).not.toHaveProperty("reasoning");
    expect(extra.fine).toBe(42);
    expect(msg.content).toBe("visible");
  });

  it("recursively sanitizes deeply nested objects", () => {
    const input = [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "outer",
            extras: {
              nested: {
                reasoning_content: "deep",
                keep: "ok",
              },
            },
          },
        ],
      },
    ];

    const result = toResponsesInput(input);
    const content = result[0].content as Array<Record<string, unknown>>;
    const extras = content[0].extras as Record<string, unknown>;
    const nested = extras.nested as Record<string, unknown>;

    expect(nested).not.toHaveProperty("reasoning_content");
    expect(nested.keep).toBe("ok");
  });
});
