const MAX_MESSAGE_CHARS = 2000;

const SUMMARY_TEMPLATE = `## Goal
[What the user is trying to accomplish]

## Constraints & Preferences
- [User's stated requirements and preferences, or "(none)"]

## Progress
### Done
- [x] [Completed items]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue, or "(none)"]`;

export const REQUIRED_SUMMARY_SECTIONS = [
  "## Goal",
  "## Constraints & Preferences",
  "## Progress",
  "## Key Decisions",
  "## Next Steps",
  "## Critical Context",
] as const;

export const SYSTEM_PROMPT =
  "You are a context summarization assistant. Your task is to read a conversation between a user and an AI assistant, " +
  "then produce a structured summary following the exact format specified.\n\n" +
  "Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.";

const IDENTIFIER_INSTRUCTIONS =
  "Preserve all opaque identifiers exactly as written (no shortening or reconstruction), " +
  "including UUIDs, hashes, IDs, tokens, hostnames, IPs, ports, URLs, and file paths.";

const LANGUAGE_INSTRUCTIONS =
  "Write the summary body in the primary language used in the conversation. " +
  "Keep the required summary structure and section headers unchanged. " +
  "Do not translate or alter code, file paths, identifiers, or error messages.";

const INITIAL_SUMMARIZATION_INSTRUCTIONS = `Compress the conversation above into a structured summary that another AI assistant will use to continue the work.
Preserve: file paths, tool call names/results, error messages, URLs.
Skip: base64 images, thinking blocks, redundant greetings.

${IDENTIFIER_INSTRUCTIONS}
${LANGUAGE_INSTRUCTIONS}

Use this EXACT format:

${SUMMARY_TEMPLATE}`;

const UPDATE_SUMMARIZATION_INSTRUCTIONS = `The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.

Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact file paths, function names, and error messages
- If something is no longer relevant, you may remove it

${IDENTIFIER_INSTRUCTIONS}
${LANGUAGE_INSTRUCTIONS}

Use this EXACT format:

${SUMMARY_TEMPLATE}`;

interface ContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  content?: unknown;
  tool_use_id?: string;
  name?: string;
  source?: { type?: string; data?: string };
  image_url?: { url?: string };
  [key: string]: unknown;
}

function isContentBlockArray(content: unknown): content is ContentBlock[] {
  return (
    Array.isArray(content) &&
    content.length > 0 &&
    typeof content[0] === "object" &&
    content[0] !== null &&
    "type" in content[0]
  );
}

function extractTextFromBlock(block: ContentBlock): string {
  if (block.type === "thinking") return "[thinking]";
  if (block.type === "image" || block.type === "image_url") return "[image]";
  if (block.type === "text" && block.text !== undefined) return block.text;
  if (block.type === "tool_result") return extractToolResultText(block);
  if (block.type === "tool_use") return `[tool: ${String(block.name ?? block.type)}]`;
  return "";
}

function extractToolResultText(block: ContentBlock): string {
  const { content } = block;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return (content as ContentBlock[])
      .filter((sub) => sub.type === "text" && sub.text !== undefined)
      .map((sub) => sub.text)
      .join(" ");
  }
  return "";
}

function extractContentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (isContentBlockArray(content)) {
    return content.map(extractTextFromBlock).filter(Boolean).join(" ");
  }
  return String(content);
}

function truncate(text: string): string {
  if (text.length <= MAX_MESSAGE_CHARS) return text;
  return text.slice(0, MAX_MESSAGE_CHARS) + "... [truncated]";
}

export function messagesToText(messages: Array<{ role: string; content: unknown }>): string {
  if (messages.length === 0) return "";

  return (
    messages
      .map((msg) => {
        const label =
          msg.role === "user"
            ? "[User]"
            : msg.role === "assistant"
              ? "[Assistant]"
              : `[${msg.role}]`;
        const text = truncate(extractContentText(msg.content));
        return `${label}: ${text}`;
      })
      .join("\n") + "\n"
  );
}

export function buildCompressionPrompt(
  messages: Array<{ role: string; content: unknown }>,
  targetTokens: number,
  previousSummary?: string,
): Array<{ role: string; content: string }> {
  const conversationText = messagesToText(messages);

  const parts: string[] = [
    `<conversation>`,
    conversationText.trimEnd(),
    `</conversation>`,
    ``,
    `Target approximately ${targetTokens} tokens.`,
    ``,
  ];

  if (previousSummary) {
    parts.push(`<previous-summary>`, previousSummary, `</previous-summary>`, ``);
    parts.push(UPDATE_SUMMARIZATION_INSTRUCTIONS);
  } else {
    parts.push(INITIAL_SUMMARIZATION_INSTRUCTIONS);
  }

  return [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: parts.join("\n") },
  ];
}

export function validateSummary(summary: string): { valid: boolean; missingSections: string[] } {
  const missingSections = REQUIRED_SUMMARY_SECTIONS.filter(
    (section) => !summary.includes(section),
  );
  return { valid: missingSections.length === 0, missingSections };
}

export function buildQualityFeedbackPrompt(
  summary: string,
  missingSections: string[],
): Array<{ role: string; content: string }> {
  return [
    { role: "assistant", content: summary },
    {
      role: "user",
      content:
        `The summary is missing required sections: ${missingSections.join(", ")}.\n` +
        `Please regenerate the summary including ALL required sections with this EXACT format:\n\n` +
        SUMMARY_TEMPLATE,
    },
  ];
}

export function buildCompressedMessages(
  summary: string,
): Array<{ role: string; content: string }> {
  return [
    {
      role: "user",
      content: `[Summary of previous conversation]\n${summary}`,
    },
    {
      role: "assistant",
      content:
        "Understood. I have the context from our previous conversation. How can I help you continue?",
    },
  ];
}
