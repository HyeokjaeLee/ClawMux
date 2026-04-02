import type { ApiAdapter, ParsedRequest, AuthInfo } from "../adapters/types.ts";
import type { SessionStore } from "../compression/session-store.ts";
import type { CompressionWorker, MakeApiCall } from "../compression/worker.ts";
import type { StatsTracker } from "./stats.ts";
import { createSessionStore, generateSessionId } from "../compression/session-store.ts";
import { createCompressionWorker } from "../compression/worker.ts";
import { estimateMessagesTokens } from "../utils/token-estimator.ts";
import type { Message } from "../utils/token-estimator.ts";

export interface CompressionMiddlewareConfig {
  threshold: number;
  targetRatio: number;
  compressionModel: string;
  resolvedContextWindow: number;
  maxSessions?: number;
  statsTracker?: StatsTracker;
}

export interface BeforeForwardResult {
  messages: Array<{ role: string; content: unknown }>;
  wasCompressed: boolean;
}

export interface SummaryData {
  summary: string;
  recentMessages: Array<{ role: string; content: unknown }>;
}

export interface CompressionMiddleware {
  beforeForward(parsed: ParsedRequest, adapter: ApiAdapter): BeforeForwardResult;
  afterResponse(parsed: ParsedRequest, adapter: ApiAdapter, baseUrl: string, auth: AuthInfo): void;
  getSessionStore(): SessionStore;
  getWorker(): CompressionWorker;
  getSummaryForSession(messages: Array<{ role: string; content: unknown }>): SummaryData | undefined;
}

function messagesToTokenMessages(
  messages: Array<{ role: string; content: unknown }>,
): Message[] {
  return messages.map((m) => ({
    role: m.role,
    content: m.content as string | Array<{ type: string; text?: string; [key: string]: unknown }>,
  }));
}

function extractResponseText(responseBody: string): string {
  try {
    const parsed = JSON.parse(responseBody) as Record<string, unknown>;

    if (Array.isArray(parsed.content)) {
      const textBlocks = (parsed.content as Array<Record<string, unknown>>)
        .filter((b) => b.type === "text" && typeof b.text === "string")
        .map((b) => b.text as string);
      if (textBlocks.length > 0) return textBlocks.join("\n");
    }

    if (Array.isArray(parsed.choices)) {
      const choices = parsed.choices as Array<Record<string, unknown>>;
      const first = choices[0];
      if (first) {
        const message = first.message as Record<string, unknown> | undefined;
        if (message && typeof message.content === "string") {
          return message.content;
        }
      }
    }

    return JSON.stringify(parsed);
  } catch {
    return responseBody;
  }
}

function createMakeApiCall(
  adapter: ApiAdapter,
  compressionModel: string,
  baseUrl: string,
  auth: AuthInfo,
): MakeApiCall {
  const actualModelId = compressionModel.includes("/")
    ? compressionModel.split("/").slice(1).join("/")
    : compressionModel;

  return async (
    model: string,
    messages: Array<{ role: string; content: string }>,
  ): Promise<string> => {
    const syntheticParsed: ParsedRequest = {
      model,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      stream: false,
      maxTokens: 4096,
      rawBody: {
        model,
        messages,
        stream: false,
        max_tokens: 4096,
      },
    };

    const upstream = adapter.buildUpstreamRequest(
      syntheticParsed,
      actualModelId,
      baseUrl,
      auth,
    );

    const response = await fetch(upstream.url, {
      method: upstream.method,
      headers: upstream.headers,
      body: upstream.body,
    });

    const body = await response.text();
    if (!response.ok) {
      throw new Error(`Compression API call failed: ${response.status} ${body}`);
    }

    return extractResponseText(body);
  };
}

export function createCompressionMiddleware(
  config: CompressionMiddlewareConfig,
): CompressionMiddleware {
  const contextWindow = config.resolvedContextWindow;
  const sessionStore = createSessionStore(config.maxSessions ?? 500);
  const worker = createCompressionWorker({
    threshold: config.threshold,
    targetRatio: config.targetRatio,
    compressionModel: config.compressionModel,
    contextWindow,
    maxConcurrent: 2,
    timeoutMs: 60_000,
  });

  function beforeForward(
    parsed: ParsedRequest,
    adapter: ApiAdapter,
  ): BeforeForwardResult {
    const messages = parsed.messages;

    if (messages.length <= 1) {
      return { messages, wasCompressed: false };
    }

    const sessionId = generateSessionId(messages);
    const session = sessionStore.getOrCreate(sessionId, messages);

    const compressed = worker.applyCompression(session);
    if (compressed) {
      sessionStore.update(sessionId, {
        messages: compressed,
        compressionState: "idle",
        compressedMessages: undefined,
        compressedSummary: undefined,
      });

      const originalTokens = estimateMessagesTokens(messagesToTokenMessages(messages));
      const compressedTokens = estimateMessagesTokens(messagesToTokenMessages(compressed));

      if (config.statsTracker) {
        config.statsTracker.recordCompression(originalTokens, compressedTokens);
      }

      console.log(
        `[compression] Applied compression: ${originalTokens} → ${compressedTokens} tokens (${((1 - compressedTokens / originalTokens) * 100).toFixed(0)}% reduction)`,
      );

      return { messages: compressed, wasCompressed: true };
    }

    return { messages, wasCompressed: false };
  }

  function afterResponse(
    parsed: ParsedRequest,
    adapter: ApiAdapter,
    baseUrl: string,
    auth: AuthInfo,
  ): void {
    const messages = parsed.messages;

    if (messages.length <= 1) return;

    const sessionId = generateSessionId(messages);
    const session = sessionStore.getOrCreate(sessionId, messages);

    const tokenCount = estimateMessagesTokens(messagesToTokenMessages(messages));
    sessionStore.update(sessionId, {
      messages: [...messages],
      tokenCount,
    });

    const updatedSession = sessionStore.get(sessionId);
    if (!updatedSession) return;

    if (worker.shouldCompress(updatedSession)) {
      const makeApiCall = createMakeApiCall(
        adapter,
        config.compressionModel,
        baseUrl,
        auth,
      );

      worker.triggerCompression(updatedSession, sessionStore, makeApiCall);

      console.log(
        `[compression] Triggered background compression for session ${sessionId} (${tokenCount} tokens)`,
      );
    }
  }

  function getSummaryForSession(
    messages: Array<{ role: string; content: unknown }>,
  ): SummaryData | undefined {
    if (messages.length <= 1) return undefined;

    const sessionId = generateSessionId(messages);
    const session = sessionStore.get(sessionId);
    if (!session) return undefined;

    if (
      session.compressionState === "ready" &&
      session.compressedSummary
    ) {
      const recentMessages = session.messages.slice(-3);
      const summary = session.compressedSummary;

      sessionStore.update(sessionId, {
        compressionState: "idle",
        compressedMessages: undefined,
        compressedSummary: undefined,
      });

      return { summary, recentMessages };
    }

    return undefined;
  }

  return {
    beforeForward,
    afterResponse,
    getSessionStore: () => sessionStore,
    getWorker: () => worker,
    getSummaryForSession,
  };
}
