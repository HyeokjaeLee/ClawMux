const TOKENS_PER_CJK = 2.5;
const CHARS_PER_ASCII_TOKEN = 4;
const MESSAGE_OVERHEAD = 4;

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
  [key: string]: unknown;
}

export interface Message {
  role: string;
  content: string | ContentBlock[];
}

export function estimateMessagesTokens(messages: Message[]): number {
  let total = 0;

  for (const message of messages) {
    total += MESSAGE_OVERHEAD;

    if (typeof message.content === "string") {
      total += estimateTokens(message.content);
    } else if (Array.isArray(message.content)) {
      for (const block of message.content) {
        if (block.type === "text" && block.text !== undefined) {
          total += estimateTokens(block.text);
        }
      }
    }
  }

  return total;
}
