import { describe, test, expect } from "bun:test";
import { buildPiContext } from "./context-builder.ts";
import type { ParsedRequest } from "../adapters/types.ts";

function makeParsed(
  overrides: Partial<ParsedRequest> = {},
): ParsedRequest {
  return {
    model: "test-model",
    messages: [],
    rawBody: {},
    stream: false,
    ...overrides,
  };
}

describe("buildPiContext", () => {
  test("converts simple user text message", () => {
    const parsed = makeParsed({
      messages: [{ role: "user", content: "hello" }],
    });
    const ctx = buildPiContext(parsed);
    expect(ctx.messages.length).toBe(1);
    expect(ctx.messages[0].role).toBe("user");
    expect((ctx.messages[0] as { content: string }).content).toBe("hello");
  });

  test("converts system prompt (string form)", () => {
    const parsed = makeParsed({
      system: "you are a bot",
      messages: [{ role: "user", content: "hi" }],
    });
    const ctx = buildPiContext(parsed);
    expect(ctx.systemPrompt).toBe("you are a bot");
  });

  test("converts system prompt (array form)", () => {
    const parsed = makeParsed({
      system: [
        { type: "text", text: "line1" },
        { type: "text", text: "line2" },
      ] as unknown as ParsedRequest["system"],
      messages: [{ role: "user", content: "hi" }],
    });
    const ctx = buildPiContext(parsed);
    expect(ctx.systemPrompt).toBe("line1\nline2");
  });

  test("converts assistant tool_use block into toolCall block", () => {
    const parsed = makeParsed({
      messages: [
        {
          role: "assistant",
          content: [
            { type: "text", text: "calling tool" },
            {
              type: "tool_use",
              id: "t1",
              name: "search",
              input: { query: "foo" },
            },
          ],
        },
      ],
    });
    const ctx = buildPiContext(parsed);
    const assistant = ctx.messages[0] as {
      role: string;
      content: Array<{ type: string; name?: string; id?: string; arguments?: Record<string, unknown> }>;
    };
    expect(assistant.role).toBe("assistant");
    expect(assistant.content.length).toBe(2);
    expect(assistant.content[1].type).toBe("toolCall");
    expect(assistant.content[1].id).toBe("t1");
    expect(assistant.content[1].name).toBe("search");
    expect(assistant.content[1].arguments).toEqual({ query: "foo" });
  });

  test("converts user tool_result blocks into separate toolResult messages", () => {
    const parsed = makeParsed({
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "t1",
              content: "found it",
            },
          ],
        },
      ],
    });
    const ctx = buildPiContext(parsed);
    expect(ctx.messages.length).toBe(1);
    const tr = ctx.messages[0] as {
      role: string;
      toolCallId: string;
      content: Array<{ type: string; text?: string }>;
    };
    expect(tr.role).toBe("toolResult");
    expect(tr.toolCallId).toBe("t1");
    expect(tr.content[0].type).toBe("text");
    expect(tr.content[0].text).toBe("found it");
  });

  test("converts image block in user message", () => {
    const parsed = makeParsed({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "look" },
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/png",
                data: "iVBOR",
              },
            },
          ],
        },
      ],
    });
    const ctx = buildPiContext(parsed);
    const u = ctx.messages[0] as {
      content: Array<{ type: string; data?: string; mimeType?: string }>;
    };
    expect(Array.isArray(u.content)).toBe(true);
    expect(u.content.length).toBe(2);
    expect(u.content[1].type).toBe("image");
    expect(u.content[1].mimeType).toBe("image/png");
    expect(u.content[1].data).toBe("iVBOR");
  });

  test("extracts tools from rawBody with input_schema", () => {
    const parsed = makeParsed({
      messages: [{ role: "user", content: "go" }],
      rawBody: {
        tools: [
          {
            name: "calculator",
            description: "Performs math",
            input_schema: {
              type: "object",
              properties: { expr: { type: "string" } },
              required: ["expr"],
            },
          },
        ],
      },
    });
    const ctx = buildPiContext(parsed);
    expect(ctx.tools?.length).toBe(1);
    expect(ctx.tools?.[0].name).toBe("calculator");
    expect(ctx.tools?.[0].description).toBe("Performs math");
  });
});
