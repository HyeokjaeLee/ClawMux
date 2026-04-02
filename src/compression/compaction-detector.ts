export interface CompactionDetection {
  isCompaction: boolean;
  detectedBy: "header" | "prompt_pattern" | "none";
  confidence: number;
}

const COMPACTION_PATTERNS = [
  // OpenClaw patterns
  "merge these partial summaries into a single cohesive summary",
  "preserve all opaque identifiers exactly as written",
  // Claude Code patterns
  "your task is to create a detailed summary of the conversation so far",
  "do not use any tools. you must respond with only the <summary>",
  "important: do not use any tools",
  // Generic patterns
  "summarize the conversation",
  "create a summary of our conversation",
  "compact the conversation",
] as const;

function extractTextFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter(
        (block: Record<string, unknown>) =>
          block.type === "text" && typeof block.text === "string",
      )
      .map((block: Record<string, unknown>) => block.text as string)
      .join("\n");
  }
  return "";
}

/**
 * Detect if a request is a compaction/summarization request from OpenClaw.
 *
 * Priority 0: X-Request-Compaction header (confidence 1.0)
 * Priority 1: Prompt pattern matching in last user message (confidence 0.95)
 */
export function detectCompaction(
  headers: Record<string, string>,
  messages: ReadonlyArray<{ role: string; content: unknown }>,
): CompactionDetection {
  // Priority 0: Header detection (case-insensitive header name)
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === "x-request-compaction" && value === "true") {
      return { isCompaction: true, detectedBy: "header", confidence: 1.0 };
    }
  }

  // Priority 1: Prompt pattern matching on last user message
  let lastUserMessage: { role: string; content: unknown } | undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      lastUserMessage = messages[i];
      break;
    }
  }

  if (lastUserMessage) {
    const text = extractTextFromContent(lastUserMessage.content).toLowerCase();
    for (const pattern of COMPACTION_PATTERNS) {
      if (text.includes(pattern)) {
        return { isCompaction: true, detectedBy: "prompt_pattern", confidence: 0.95 };
      }
    }
  }

  return { isCompaction: false, detectedBy: "none", confidence: 0.0 };
}
