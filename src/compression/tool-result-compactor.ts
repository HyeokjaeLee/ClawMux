import { estimateBlockTokens, estimateMessagesTokens } from "../utils/token-estimator";
import type { ContentBlock, Message } from "../utils/token-estimator";

export interface CompactorConfig {
  targetTokens: number;
  maxToolResultChars: number;
  minReductionThreshold: number;
}

export const DEFAULT_COMPACTOR_CONFIG: CompactorConfig = {
  targetTokens: 120_000,
  maxToolResultChars: 16_000,
  minReductionThreshold: 0.05,
};

export interface CompactorResult {
  messages: Array<{ role: string; content: unknown }>;
  originalTokens: number;
  compactedTokens: number;
  truncatedCount: number;
}

const TRUNCATION_NOTE =
  "\n\n... [tool_result truncated by ClawMux: content exceeded per-block char budget] ...\n\n";

function truncateString(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const head = Math.floor((maxChars - TRUNCATION_NOTE.length) * 0.6);
  const tail = maxChars - TRUNCATION_NOTE.length - head;
  return text.slice(0, head) + TRUNCATION_NOTE + text.slice(-tail);
}

function compactToolResultContent(
  content: unknown,
  maxChars: number,
): { content: unknown; truncated: boolean } {
  if (typeof content === "string") {
    if (content.length <= maxChars) return { content, truncated: false };
    return { content: truncateString(content, maxChars), truncated: true };
  }

  if (Array.isArray(content)) {
    let truncated = false;
    const newContent = content.map((sub) => {
      if (!sub || typeof sub !== "object") return sub;
      const block = sub as ContentBlock;
      if (block.type === "text" && typeof block.text === "string") {
        if (block.text.length <= maxChars) return block;
        truncated = true;
        return { ...block, text: truncateString(block.text, maxChars) };
      }
      return block;
    });
    return { content: newContent, truncated };
  }

  return { content, truncated: false };
}

function compactBlock(
  block: ContentBlock,
  maxChars: number,
): { block: ContentBlock; truncated: boolean } {
  if (block.type !== "tool_result") return { block, truncated: false };
  const { content, truncated } = compactToolResultContent(block.content, maxChars);
  if (!truncated) return { block, truncated: false };
  return { block: { ...block, content }, truncated: true };
}

function compactMessage(
  message: { role: string; content: unknown },
  maxChars: number,
): { message: { role: string; content: unknown }; truncated: number } {
  if (!Array.isArray(message.content)) return { message, truncated: 0 };

  let truncated = 0;
  const newContent = (message.content as ContentBlock[]).map((block) => {
    const { block: newBlock, truncated: wasTruncated } = compactBlock(block, maxChars);
    if (wasTruncated) truncated++;
    return newBlock;
  });

  if (truncated === 0) return { message, truncated: 0 };
  return { message: { ...message, content: newContent }, truncated };
}

function sortedBlocksByTokenCost(
  messages: Array<{ role: string; content: unknown }>,
): Array<{ messageIdx: number; blockIdx: number; tokens: number }> {
  const entries: Array<{ messageIdx: number; blockIdx: number; tokens: number }> = [];
  messages.forEach((msg, mi) => {
    if (!Array.isArray(msg.content)) return;
    (msg.content as ContentBlock[]).forEach((block, bi) => {
      if (block.type !== "tool_result") return;
      entries.push({ messageIdx: mi, blockIdx: bi, tokens: estimateBlockTokens(block) });
    });
  });
  entries.sort((a, b) => b.tokens - a.tokens);
  return entries;
}

export function compactToolResults(
  messages: Array<{ role: string; content: unknown }>,
  config: CompactorConfig = DEFAULT_COMPACTOR_CONFIG,
): CompactorResult {
  const originalTokens = estimateMessagesTokens(messages as Message[]);

  if (originalTokens <= config.targetTokens) {
    return { messages, originalTokens, compactedTokens: originalTokens, truncatedCount: 0 };
  }

  let working = messages.map((m) => ({ ...m }));
  let totalTruncated = 0;

  let currentTokens = originalTokens;
  let maxChars = config.maxToolResultChars;

  while (
    currentTokens > config.targetTokens &&
    maxChars >= 512
  ) {
    const entries = sortedBlocksByTokenCost(working);
    if (entries.length === 0) break;

    const newWorking = working.map((msg) => {
      const { message, truncated } = compactMessage(msg, maxChars);
      totalTruncated += truncated;
      return message;
    });

    const newTokens = estimateMessagesTokens(newWorking as Message[]);
    const reduction = (currentTokens - newTokens) / currentTokens;
    working = newWorking;
    currentTokens = newTokens;

    if (reduction < config.minReductionThreshold) {
      maxChars = Math.floor(maxChars / 2);
    }
  }

  return {
    messages: working,
    originalTokens,
    compactedTokens: currentTokens,
    truncatedCount: totalTruncated,
  };
}
