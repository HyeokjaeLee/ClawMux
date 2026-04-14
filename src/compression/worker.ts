import type { Session } from "./types";
import type { SessionStore } from "./session-store";
import { estimateTokens } from "../utils/token-estimator";
import {
  buildCompressionPrompt,
  buildCompressedMessages,
  validateSummary,
  buildQualityFeedbackPrompt,
} from "./prompt";

export type MakeApiCall = (
  model: string,
  messages: Array<{ role: string; content: string }>,
) => Promise<string>;

export interface CompressionWorkerConfig {
  /** Trigger compression at this fraction of context window (default 0.75) */
  threshold: number;
  /** Compress to this fraction of context window (default 0.6) */
  targetRatio: number;
  /** Model to use for summarization */
  compressionModel: string;
  /** Context window size in tokens (default 200000) */
  contextWindow: number;
  /** Max concurrent compression jobs (default 2) */
  maxConcurrent: number;
  /** Timeout per job in ms (default 60000) */
  timeoutMs: number;
}

export interface CompressionWorker {
  shouldCompress(session: Session): boolean;
  triggerCompression(
    session: Session,
    sessionStore: SessionStore,
    makeApiCall: MakeApiCall,
  ): void;
  applyCompression(
    session: Session,
  ): Array<{ role: string; content: unknown }> | undefined;
  getStats(): { activeJobs: number; completedJobs: number; failedJobs: number };
}

const SUMMARY_PREFIX = "[Summary of previous conversation]";

function messageContentToString(content: unknown): string {
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
  return JSON.stringify(content);
}

function estimateMessageTokens(
  msg: { role: string; content: unknown },
): number {
  const MESSAGE_OVERHEAD = 4;
  return MESSAGE_OVERHEAD + estimateTokens(messageContentToString(msg.content));
}

export function truncateToFit(
  messages: Array<{ role: string; content: unknown }>,
  targetTokens: number,
): Array<{ role: string; content: unknown }> {
  const result: Array<{ role: string; content: unknown }> = [];
  let usedTokens = 0;

  const firstMsg = messages[0];
  const firstContent = firstMsg
    ? messageContentToString(firstMsg.content)
    : "";
  const hasSystemPrefix =
    firstMsg?.role === "user" && firstContent.startsWith(SUMMARY_PREFIX);

  if (hasSystemPrefix && firstMsg) {
    const tokens = estimateMessageTokens(firstMsg);
    result.push(firstMsg);
    usedTokens += tokens;
  }

  const tail: Array<{ role: string; content: unknown }> = [];
  const startIdx = hasSystemPrefix ? 1 : 0;

  for (let i = messages.length - 1; i >= startIdx; i--) {
    const msg = messages[i];
    const tokens = estimateMessageTokens(msg);
    if (usedTokens + tokens > targetTokens) break;
    tail.unshift(msg);
    usedTokens += tokens;
  }

  return [...result, ...tail];
}

export function createCompressionWorker(
  config: CompressionWorkerConfig,
): CompressionWorker {
  let activeJobs = 0;
  let completedJobs = 0;
  let failedJobs = 0;

  function shouldCompress(session: Session): boolean {
    const thresholdTokens = config.threshold * config.contextWindow;
    return (
      session.tokenCount >= thresholdTokens &&
      session.compressionState === "idle"
    );
  }

  function triggerCompression(
    session: Session,
    sessionStore: SessionStore,
    makeApiCall: MakeApiCall,
  ): void {
    if (activeJobs >= config.maxConcurrent) return;

    session.compressionState = "computing";
    session.snapshotIndex = session.messages.length;
    sessionStore.update(session.id, {
      compressionState: "computing",
      snapshotIndex: session.messages.length,
    });
    activeJobs++;

    const targetTokens = config.targetRatio * config.contextWindow;
    const promptMessages = buildCompressionPrompt(
      session.messages,
      targetTokens,
    );
    const sessionId = session.id;
    const originalMessages = [...session.messages];

    const jobPromise = Promise.race([
      makeApiCall(config.compressionModel, promptMessages),
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error("compression_timeout")), config.timeoutMs);
      }),
    ]);

    jobPromise
      .then((summaryText: string) => {
        const compressed = buildCompressedMessages(summaryText);
        sessionStore.update(sessionId, {
          compressionState: "ready",
          compressedSummary: summaryText,
          compressedMessages: compressed,
        });
        const current = sessionStore.get(sessionId);
        if (current) {
          session.compressionState = current.compressionState;
          session.compressedSummary = current.compressedSummary;
          session.compressedMessages = current.compressedMessages;
        }
        activeJobs--;
        completedJobs++;
      })
      .catch((error: Error) => {
        if (error.message === "compression_timeout") {
          const truncated = truncateToFit(originalMessages, targetTokens);
          sessionStore.update(sessionId, {
            compressionState: "ready",
            compressedMessages: truncated,
          });
          const current = sessionStore.get(sessionId);
          if (current) {
            session.compressionState = current.compressionState;
            session.compressedMessages = current.compressedMessages;
          }
          activeJobs--;
          completedJobs++;
        } else {
          sessionStore.update(sessionId, { compressionState: "idle" });
          session.compressionState = "idle";
          activeJobs--;
          failedJobs++;
          console.error(
            `[CompressionWorker] Job failed for session ${sessionId}:`,
            error.message,
          );
        }
      });
  }

  function applyCompression(
    session: Session,
  ): Array<{ role: string; content: unknown }> | undefined {
    if (
      session.compressionState !== "ready" ||
      !session.compressedMessages
    ) {
      return undefined;
    }

    const compressed = session.compressedMessages;
    const snapshotIdx = session.snapshotIndex ?? session.messages.length - 3;
    const postSnapshotMessages = session.messages.slice(snapshotIdx);

    const combined = [...compressed, ...postSnapshotMessages];

    session.compressionState = "idle";
    session.compressedMessages = undefined;
    session.compressedSummary = undefined;
    session.snapshotIndex = undefined;

    return combined;
  }

  function getStats(): {
    activeJobs: number;
    completedJobs: number;
    failedJobs: number;
  } {
    return { activeJobs, completedJobs, failedJobs };
  }

  return {
    shouldCompress,
    triggerCompression,
    applyCompression,
    getStats,
  };
}
