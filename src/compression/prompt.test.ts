import { describe, expect, it } from "bun:test";
import {
  messagesToText,
  buildCompressionPrompt,
  buildCompressedMessages,
} from "./prompt";

describe("messagesToText", () => {
  it("converts string content messages to text", () => {
    const messages = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there!" },
    ];
    const result = messagesToText(messages);
    expect(result).toBe("[User]: Hello\n[Assistant]: Hi there!\n");
  });

  it("handles array content with text and image blocks", () => {
    const messages = [
      {
        role: "user",
        content: [
          { type: "text", text: "Look at this" },
          {
            type: "image",
            source: {
              type: "base64",
              data: "iVBORw0KGgoAAAANSUhEUg...",
            },
          },
        ],
      },
    ];
    const result = messagesToText(messages);
    expect(result).toBe("[User]: Look at this [image]\n");
  });

  it("replaces thinking blocks with [thinking]", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Let me think about this..." },
          { type: "text", text: "Here is my answer." },
        ],
      },
    ];
    const result = messagesToText(messages);
    expect(result).toBe("[Assistant]: [thinking] Here is my answer.\n");
  });

  it("truncates long messages at 2000 chars", () => {
    const longContent = "x".repeat(2500);
    const messages = [{ role: "user", content: longContent }];
    const result = messagesToText(messages);
    expect(result).toContain("... [truncated]");
    const line = result.split("\n")[0];
    expect(line.length).toBeLessThanOrEqual("[User]: ".length + 2000 + "... [truncated]".length);
  });

  it("handles empty messages array", () => {
    const result = messagesToText([]);
    expect(result).toBe("");
  });

  it("handles tool_result blocks by extracting text content", () => {
    const messages = [
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tool_123",
            content: [{ type: "text", text: "File saved successfully" }],
          },
        ],
      },
    ];
    const result = messagesToText(messages);
    expect(result).toContain("File saved successfully");
  });

  it("handles tool_result with string content", () => {
    const messages = [
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tool_456",
            content: "Operation completed",
          },
        ],
      },
    ];
    const result = messagesToText(messages);
    expect(result).toContain("Operation completed");
  });

  it("replaces base64 image data in image_url blocks", () => {
    const messages = [
      {
        role: "user",
        content: [
          {
            type: "image_url",
            image_url: { url: "data:image/png;base64,iVBORw0KGgo..." },
          },
        ],
      },
    ];
    const result = messagesToText(messages);
    expect(result).toBe("[User]: [image]\n");
    expect(result).not.toContain("base64");
  });

  it("handles unknown content types gracefully", () => {
    const messages = [
      {
        role: "user",
        content: 12345,
      },
    ];
    const result = messagesToText(messages as Array<{ role: string; content: unknown }>);
    expect(result).toBe("[User]: 12345\n");
  });
});

describe("buildCompressionPrompt", () => {
  it("returns system and user messages", () => {
    const messages = [{ role: "user", content: "Hello" }];
    const result = buildCompressionPrompt(messages, 500);
    expect(result).toHaveLength(2);
    expect(result[0].role).toBe("system");
    expect(result[1].role).toBe("user");
  });

  it("system prompt instructs not to continue conversation", () => {
    const messages = [{ role: "user", content: "Hello" }];
    const result = buildCompressionPrompt(messages, 500);
    expect(result[0].content).toContain("Do NOT continue the conversation");
    expect(result[0].content).toContain("ONLY output the structured summary");
  });

  it("includes target token count in user prompt", () => {
    const messages = [
      { role: "user", content: "Help me build a web app" },
      { role: "assistant", content: "Sure, I can help with that." },
    ];
    const result = buildCompressionPrompt(messages, 500);
    expect(result[1].content).toContain("500");
    expect(result[1].content).toContain("tokens");
  });

  it("wraps conversation in <conversation> tags", () => {
    const messages = [{ role: "user", content: "Hello" }];
    const result = buildCompressionPrompt(messages, 500);
    expect(result[1].content).toContain("<conversation>");
    expect(result[1].content).toContain("</conversation>");
  });

  it("preserves file paths in formatted messages", () => {
    const messages = [
      { role: "user", content: "Edit the file at src/utils/token-estimator.ts" },
      { role: "assistant", content: "I updated /home/user/project/index.ts" },
    ];
    const result = buildCompressionPrompt(messages, 1000);
    expect(result[1].content).toContain("src/utils/token-estimator.ts");
    expect(result[1].content).toContain("/home/user/project/index.ts");
  });

  it("includes structured summary template sections", () => {
    const messages = [{ role: "user", content: "Hello" }];
    const result = buildCompressionPrompt(messages, 500);
    const userContent = result[1].content;
    expect(userContent).toContain("## Goal");
    expect(userContent).toContain("## Constraints & Preferences");
    expect(userContent).toContain("## Progress");
    expect(userContent).toContain("### Done");
    expect(userContent).toContain("### In Progress");
    expect(userContent).toContain("### Blocked");
    expect(userContent).toContain("## Key Decisions");
    expect(userContent).toContain("## Next Steps");
    expect(userContent).toContain("## Critical Context");
  });

  it("includes identifier preservation instructions", () => {
    const messages = [{ role: "user", content: "Hello" }];
    const result = buildCompressionPrompt(messages, 500);
    expect(result[1].content).toContain("UUIDs");
    expect(result[1].content).toContain("file paths");
  });

  it("includes the conversation messages with [User]/[Assistant] labels", () => {
    const messages = [
      { role: "user", content: "Create a REST API" },
      { role: "assistant", content: "I'll create the API endpoints." },
    ];
    const result = buildCompressionPrompt(messages, 1000);
    expect(result[1].content).toContain("[User]: Create a REST API");
    expect(result[1].content).toContain("[Assistant]: I'll create the API endpoints.");
  });
});

describe("buildCompressedMessages", () => {
  it("returns user + assistant message pair", () => {
    const summary = "## Goal\nBuild an app";
    const result = buildCompressedMessages(summary);
    expect(result).toHaveLength(2);
    expect(result[0].role).toBe("user");
    expect(result[1].role).toBe("assistant");
  });

  it("prefixes user message with [Summary of previous conversation]", () => {
    const summary = "## Goal\nBuild an app";
    const result = buildCompressedMessages(summary);
    expect(result[0].content).toContain("[Summary of previous conversation]");
    expect(result[0].content).toContain(summary);
  });

  it("assistant message acknowledges context", () => {
    const result = buildCompressedMessages("some summary");
    expect(result[1].content).toContain("previous conversation");
  });

  it("preserves the full summary text", () => {
    const summary = `## Goal\nBuild a web app\n\n## Key Decisions\nUse Bun runtime`;
    const result = buildCompressedMessages(summary);
    expect(result[0].content).toContain("Build a web app");
    expect(result[0].content).toContain("Use Bun runtime");
  });
});
