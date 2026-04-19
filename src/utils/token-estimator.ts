const TOKENS_PER_CJK = 2.5;
const CHARS_PER_ASCII_TOKEN = 4;
const MESSAGE_OVERHEAD = 4;
// Conservative token cost per image block. Anthropic's guidance on vision
// inputs tops out near ~1600 tokens per 1568×1568 image; we intentionally
// undershoot because most images ClawMux sees are smaller tool screenshots.
const TOKENS_PER_IMAGE = 1000;

export function isCJK(charCode: number): boolean {
  return (
    (charCode >= 0x3000 && charCode <= 0x9fff) ||
    (charCode >= 0xac00 && charCode <= 0xd7af) ||
    (charCode >= 0xf900 && charCode <= 0xfaff)
  );
}

export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;

  let asciiSegmentLength = 0;
  let tokenCount = 0;

  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);

    if (isCJK(code)) {
      tokenCount += asciiSegmentLength / CHARS_PER_ASCII_TOKEN;
      asciiSegmentLength = 0;
      tokenCount += TOKENS_PER_CJK;
    } else {
      asciiSegmentLength++;
    }
  }

  tokenCount += asciiSegmentLength / CHARS_PER_ASCII_TOKEN;

  return Math.ceil(tokenCount);
}

export interface ContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  name?: string;
  input?: unknown;
  content?: unknown;
  source?: { type?: string; data?: string; media_type?: string };
  image_url?: { url?: string } | string;
  [key: string]: unknown;
}

export interface Message {
  role: string;
  content: string | ContentBlock[];
}

export function estimateBlockTokens(block: ContentBlock): number {
  const type = block.type;

  if (type === "text") {
    return typeof block.text === "string" ? estimateTokens(block.text) : 0;
  }

  if (type === "thinking") {
    return typeof block.thinking === "string"
      ? estimateTokens(block.thinking)
      : 0;
  }

  if (type === "tool_use") {
    const nameCost =
      typeof block.name === "string" ? estimateTokens(block.name) : 0;
    const inputCost =
      block.input !== undefined
        ? estimateTokens(safeStringify(block.input))
        : 0;
    return nameCost + inputCost;
  }

  if (type === "tool_result") {
    return estimateToolResultTokens(block.content);
  }

  if (type === "image" || type === "image_url") {
    return TOKENS_PER_IMAGE;
  }

  // Fallback: serialise the entire block so we never silently drop cost
  // for an unknown block type. Better to overestimate than to under-count
  // and skip compression.
  return estimateTokens(safeStringify(block));
}

function estimateToolResultTokens(content: unknown): number {
  if (typeof content === "string") return estimateTokens(content);
  if (Array.isArray(content)) {
    let total = 0;
    for (const sub of content) {
      if (typeof sub === "string") {
        total += estimateTokens(sub);
      } else if (sub && typeof sub === "object") {
        total += estimateBlockTokens(sub as ContentBlock);
      }
    }
    return total;
  }
  if (content === undefined || content === null) return 0;
  return estimateTokens(safeStringify(content));
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value);
  }
}

export function estimateMessagesTokens(messages: Message[]): number {
  let total = 0;

  for (const message of messages) {
    total += MESSAGE_OVERHEAD;

    if (typeof message.content === "string") {
      total += estimateTokens(message.content);
    } else if (Array.isArray(message.content)) {
      for (const block of message.content) {
        total += estimateBlockTokens(block);
      }
    }
  }

  return total;
}
