import { describe, expect, it } from "bun:test";
import {
  messagesToText,
  buildCompressionPrompt,
  parseSummary,
  buildCompressedMessages,
} from "./prompt";

describe("messagesToText", () => {
  it("converts string content messages to text", () => {
    const messages = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there!" },
    ];
    const result = messagesToText(messages);
    expect(result).toBe("[user]: Hello\n[assistant]: Hi there!\n");
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
    expect(result).toBe("[user]: Look at this [image]\n");
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
    expect(result).toBe("[assistant]: [thinking] Here is my answer.\n");
  });

  it("truncates long messages at 2000 chars", () => {
    const longContent = "x".repeat(2500);
    const messages = [{ role: "user", content: longContent }];
    const result = messagesToText(messages);
    expect(result).toContain("... [truncated]");
    // [user]: + 2000 chars + ... [truncated] + \n
    const line = result.split("\n")[0];
    expect(line.length).toBeLessThanOrEqual("[user]: ".length + 2000 + "... [truncated]".length);
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
    expect(result).toBe("[user]: [image]\n");
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
    expect(result).toBe("[user]: 12345\n");
  });
});

describe("buildCompressionPrompt", () => {
  it("includes target token count in prompt", () => {
    const messages = [
      { role: "user", content: "Help me build a web app" },
      { role: "assistant", content: "Sure, I can help with that." },
    ];
    const result = buildCompressionPrompt(messages, 500);
    expect(result).toContain("500");
    expect(result).toContain("tokens");
  });

  it("preserves file paths in formatted messages", () => {
    const messages = [
      { role: "user", content: "Edit the file at src/utils/token-estimator.ts" },
      { role: "assistant", content: "I updated /home/user/project/index.ts" },
    ];
    const result = buildCompressionPrompt(messages, 1000);
    expect(result).toContain("src/utils/token-estimator.ts");
    expect(result).toContain("/home/user/project/index.ts");
  });

  it("includes structured summary template sections", () => {
    const messages = [{ role: "user", content: "Hello" }];
    const result = buildCompressionPrompt(messages, 500);
    expect(result).toContain("## Goal");
    expect(result).toContain("## Constraints & Preferences");
    expect(result).toContain("## Progress");
    expect(result).toContain("### Done");
    expect(result).toContain("### In Progress");
    expect(result).toContain("### Blocked");
    expect(result).toContain("## Key Decisions");
    expect(result).toContain("## Active State");
    expect(result).toContain("## Next Steps");
    expect(result).toContain("## Critical Context");
  });

  it("includes preservation instructions", () => {
    const messages = [{ role: "user", content: "Hello" }];
    const result = buildCompressionPrompt(messages, 500);
    expect(result).toContain("file paths");
    expect(result).toContain("error messages");
  });

  it("includes the conversation messages in the prompt", () => {
    const messages = [
      { role: "user", content: "Create a REST API" },
      { role: "assistant", content: "I'll create the API endpoints." },
    ];
    const result = buildCompressionPrompt(messages, 1000);
    expect(result).toContain("[user]: Create a REST API");
    expect(result).toContain("[assistant]: I'll create the API endpoints.");
  });
});

describe("parseSummary", () => {
  it("extracts sections correctly", () => {
    const summaryText = `## Goal
Build a web application with authentication

## Constraints & Preferences
Use TypeScript, no external deps

## Progress
### Done
- Set up project structure
### In Progress
- Implementing auth
### Blocked
- None

## Key Decisions
Using JWT for auth

## Active State
src/auth/handler.ts, src/config/env.ts

## Next Steps
Implement token refresh

## Critical Context
API key stored in .env`;

    const result = parseSummary(summaryText);
    expect(result.fullText).toBe(summaryText);
    expect(result.sections["Goal"]).toContain("Build a web application");
    expect(result.sections["Constraints & Preferences"]).toContain("TypeScript");
    expect(result.sections["Key Decisions"]).toContain("JWT");
    expect(result.sections["Active State"]).toContain("src/auth/handler.ts");
    expect(result.sections["Next Steps"]).toContain("token refresh");
    expect(result.sections["Critical Context"]).toContain("API key");
  });

  it("handles Progress with sub-sections", () => {
    const summaryText = `## Progress
### Done
- Item A
### In Progress
- Item B
### Blocked
- Item C`;

    const result = parseSummary(summaryText);
    expect(result.sections["Progress"]).toContain("Item A");
    expect(result.sections["Progress"]).toContain("Item B");
    expect(result.sections["Progress"]).toContain("Item C");
  });

  it("returns fullText only for malformed input", () => {
    const malformed = "This is just plain text without any sections";
    const result = parseSummary(malformed);
    expect(result.fullText).toBe(malformed);
    expect(Object.keys(result.sections)).toHaveLength(0);
  });

  it("handles empty string", () => {
    const result = parseSummary("");
    expect(result.fullText).toBe("");
    expect(Object.keys(result.sections)).toHaveLength(0);
  });

  it("handles partial sections", () => {
    const partial = `## Goal
Do something cool

Some random text here`;

    const result = parseSummary(partial);
    expect(result.sections["Goal"]).toContain("Do something cool");
    expect(result.sections["Goal"]).toContain("Some random text here");
  });
});

describe("buildCompressedMessages", () => {
  it("wraps summary in a user message", () => {
    const summary = "## Goal\nBuild an app";
    const result = buildCompressedMessages(summary);
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe("user");
    expect(result[0].content).toContain("Previous conversation summary:");
    expect(result[0].content).toContain(summary);
  });

  it("preserves the full summary text", () => {
    const summary = `## Goal
Build a web app

## Key Decisions
Use Bun runtime`;

    const result = buildCompressedMessages(summary);
    expect(result[0].content).toContain("Build a web app");
    expect(result[0].content).toContain("Use Bun runtime");
  });
});
