import { estimateMessagesTokens } from "../utils/token-estimator";
import type { Message } from "../utils/token-estimator";

export type SummarizeFn = (
  messages: Array<{ role: string; content: unknown }>,
  targetTokens: number,
  previousSummary: string | undefined,
) => Promise<string>;

export interface MapReduceConfig {
  modelContextWindow: number;
  safetyRatio: number;
  maxDepth: number;
  minChunkMessages: number;
}

export const DEFAULT_MAP_REDUCE_CONFIG: MapReduceConfig = {
  modelContextWindow: 200_000,
  safetyRatio: 0.6,
  maxDepth: 4,
  minChunkMessages: 2,
};

export function splitMessagesByBudget(
  messages: Array<{ role: string; content: unknown }>,
  budgetTokens: number,
): Array<Array<{ role: string; content: unknown }>> {
  if (messages.length === 0) return [];

  const chunks: Array<Array<{ role: string; content: unknown }>> = [];
  let current: Array<{ role: string; content: unknown }> = [];
  let currentTokens = 0;

  for (const msg of messages) {
    const msgTokens = estimateMessagesTokens([msg as Message]);
    // A single message larger than the entire budget cannot be split further
    // here (we keep message boundaries intact). Emit it as its own chunk so
    // the caller can decide whether to recurse or truncate it.
    if (msgTokens > budgetTokens && current.length === 0) {
      chunks.push([msg]);
      continue;
    }
    if (currentTokens + msgTokens > budgetTokens && current.length > 0) {
      chunks.push(current);
      current = [];
      currentTokens = 0;
    }
    current.push(msg);
    currentTokens += msgTokens;
  }

  if (current.length > 0) chunks.push(current);
  return chunks;
}

function summaryToMessages(summaries: string[]): Array<{ role: string; content: unknown }> {
  return summaries.map((summary, idx) => ({
    role: "user",
    content: `<chunk-summary index="${idx + 1}" of="${summaries.length}">\n${summary}\n</chunk-summary>`,
  }));
}

export async function compressMessagesMapReduce(
  messages: Array<{ role: string; content: unknown }>,
  targetTokens: number,
  previousSummary: string | undefined,
  summarize: SummarizeFn,
  config: MapReduceConfig = DEFAULT_MAP_REDUCE_CONFIG,
  depth = 0,
): Promise<string> {
  const safeInputBudget = Math.floor(
    config.modelContextWindow * config.safetyRatio,
  );

  const inputTokens = estimateMessagesTokens(messages as Message[]);

  if (inputTokens <= safeInputBudget || depth >= config.maxDepth) {
    return summarize(messages, targetTokens, previousSummary);
  }

  const chunks = splitMessagesByBudget(messages, safeInputBudget);

  if (chunks.length <= 1) {
    return summarize(messages, targetTokens, previousSummary);
  }

  const perChunkTarget = Math.max(
    Math.floor(targetTokens / chunks.length),
    Math.floor(safeInputBudget / (chunks.length * 4)),
  );

  const chunkSummaries = await Promise.all(
    chunks.map((chunk) =>
      summarize(chunk, perChunkTarget, undefined),
    ),
  );

  const mergedMessages = summaryToMessages(chunkSummaries);

  return compressMessagesMapReduce(
    mergedMessages,
    targetTokens,
    previousSummary,
    summarize,
    config,
    depth + 1,
  );
}
