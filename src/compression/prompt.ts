const MAX_MESSAGE_CHARS = 2000;

const SUMMARY_TEMPLATE = `## Goal
[What the user is trying to accomplish]
## Constraints & Preferences
[User's stated requirements and preferences]
## Progress
### Done
[Completed items]
### In Progress
[Current work]
### Blocked
[Issues encountered]
## Key Decisions
[Important choices made]
## Active State
[Current file paths, variable names, URLs that are still relevant]
## Next Steps
[What needs to happen next]
## Critical Context
[Any other important context that must be preserved]`;

interface ContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  content?: unknown;
  tool_use_id?: string;
  source?: { type?: string; data?: string };
  image_url?: { url?: string };
  [key: string]: unknown;
}

function isContentBlockArray(content: unknown): content is ContentBlock[] {
  return Array.isArray(content) && content.length > 0 && typeof content[0] === "object" && content[0] !== null && "type" in content[0];
}

function extractTextFromBlock(block: ContentBlock): string {
  if (block.type === "thinking") {
    return "[thinking]";
  }

  if (block.type === "image" || (block.type === "image_url")) {
    return "[image]";
  }

  if (block.type === "text" && block.text !== undefined) {
    return block.text;
  }

  if (block.type === "tool_result") {
    return extractToolResultText(block);
  }

  if (block.type === "tool_use") {
    return `[tool: ${String(block.name ?? block.type)}]`;
  }

  return "";
}

function extractToolResultText(block: ContentBlock): string {
  const { content } = block;

  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return (content as ContentBlock[])
      .filter((sub) => sub.type === "text" && sub.text !== undefined)
      .map((sub) => sub.text)
      .join(" ");
  }

  return "";
}

function extractContentText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  if (isContentBlockArray(content)) {
    return content
      .map(extractTextFromBlock)
      .filter(Boolean)
      .join(" ");
  }

  return String(content);
}

function truncate(text: string): string {
  if (text.length <= MAX_MESSAGE_CHARS) {
    return text;
  }
  return text.slice(0, MAX_MESSAGE_CHARS) + "... [truncated]";
}

export function messagesToText(messages: Array<{ role: string; content: unknown }>): string {
  if (messages.length === 0) return "";

  return messages
    .map((msg) => {
      const text = truncate(extractContentText(msg.content));
      return `[${msg.role}]: ${text}`;
    })
    .join("\n") + "\n";
}

export function buildCompressionPrompt(
  messages: Array<{ role: string; content: unknown }>,
  targetTokens: number,
): string {
  const conversationText = messagesToText(messages);

  return `Compress the following conversation into a structured summary. Target approximately ${targetTokens} tokens. Preserve: file paths, tool call names/results, error messages, URLs. Skip: base64 images, thinking blocks, redundant greetings.

Use this exact format:

${SUMMARY_TEMPLATE}

---
CONVERSATION:
${conversationText}`;
}

export function parseSummary(summaryText: string): {
  sections: Record<string, string>;
  fullText: string;
} {
  const sections: Record<string, string> = {};

  const sectionPattern = /^## (.+)$/gm;
  const matches: Array<{ heading: string; start: number }> = [];

  let match: RegExpExecArray | null;
  while ((match = sectionPattern.exec(summaryText)) !== null) {
    matches.push({ heading: match[1], start: match.index + match[0].length });
  }

  for (let i = 0; i < matches.length; i++) {
    const { heading, start } = matches[i];
    const end = i + 1 < matches.length ? matches[i + 1].start - matches[i + 1].heading.length - 4 : summaryText.length;
    const content = summaryText.slice(start, end).trim();
    sections[heading] = content;
  }

  return { sections, fullText: summaryText };
}

export function buildCompressedMessages(summary: string): Array<{ role: string; content: string }> {
  return [
    {
      role: "user",
      content: `Previous conversation summary:\n\n${summary}`,
    },
  ];
}
