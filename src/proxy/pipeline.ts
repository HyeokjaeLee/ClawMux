import type { ClawMuxConfig } from "../config/types.ts";
import type { OpenClawConfig, AuthProfile } from "../openclaw/types.ts";
import type { ApiAdapter, AuthInfo } from "../adapters/types.ts";
import type { CompressionMiddleware } from "./compression-integration.ts";
import type { PiAiCatalog } from "../openclaw/model-limits.ts";
import { getAdapter, registerAdapter } from "../adapters/registry.ts";
import { AnthropicAdapter } from "../adapters/anthropic.ts";
import "../adapters/openai-completions.ts";
import "../adapters/openai-responses.ts";
import "../adapters/google.ts";
import "../adapters/ollama.ts";
import "../adapters/bedrock.ts";
import "../adapters/openai-codex.ts";
import { detectCompaction } from "../compression/compaction-detector.ts";
import { buildSyntheticSummaryResponse, buildSyntheticHttpResponse } from "../compression/synthetic-response.ts";
import type { Message, RoutingDecision } from "../routing/types.ts";
import { SignalRouter, NEXT_TIER } from "../routing/signal-router.ts";
import { detectSignalInStream, createSignalDetectionState, type SignalDetectionState } from "./signal-detecting-stream.ts";
import { resolveApiKey } from "../openclaw/auth-resolver.ts";
import { translateResponse } from "../adapters/stream-transformer.ts";
import { collectStreamToResponse } from "../adapters/stream-collector.ts";
import { setRouteHandler } from "./router.ts";
import { createCompressionMiddleware } from "./compression-integration.ts";
import { resolveCompressionContextWindow, resolveContextWindow, DEFAULT_CONTEXT_TOKENS } from "../openclaw/model-limits.ts";
import { stream as piStream } from "@mariozechner/pi-ai";
import { buildPiAiModel } from "../pi-bridge/model-builder.ts";
import { buildPiContext } from "../pi-bridge/context-builder.ts";
import { buildPiOptions } from "../pi-bridge/options-builder.ts";
import {
  piStreamToAnthropicSse,
  piStreamToAnthropicJson,
  anthropicMessageFromAssistant,
} from "../pi-bridge/event-to-anthropic.ts";
import {
  piStreamToOpenAiCompletionsSse,
  piStreamToOpenAiCompletionsJson,
  openAiCompletionsMessageFromAssistant,
} from "../pi-bridge/event-to-openai-completions.ts";
import {
  piStreamToOpenAiResponsesSse,
  piStreamToOpenAiResponsesJson,
  openAiResponsesMessageFromAssistant,
} from "../pi-bridge/event-to-openai-responses.ts";
import {
  piStreamToGoogleSse,
  piStreamToGoogleJson,
  googleMessageFromAssistant,
} from "../pi-bridge/event-to-google.ts";

registerAdapter(new AnthropicAdapter());

const DEFAULT_CODEX_SYSTEM_PROMPT =
  "You are a helpful coding assistant that answers concisely and accurately.";

export function applyCodexSystemPromptFallback(
  piContext: { systemPrompt?: string },
  targetApiType: string,
): void {
  if (targetApiType !== "openai-codex-responses") return;
  if (piContext.systemPrompt && piContext.systemPrompt.trim() !== "") return;
  piContext.systemPrompt = DEFAULT_CODEX_SYSTEM_PROMPT;
}

interface ProviderLookupResult {
  providerName: string;
  baseUrl: string;
  apiType: string;
}

function findProviderForModel(
  modelString: string,
  openclawConfig: OpenClawConfig,
): ProviderLookupResult | undefined {
  const providers = openclawConfig.models?.providers;
  if (!providers) return undefined;

  const [providerName, modelId] = modelString.split("/", 2);
  if (!providerName || !modelId) return undefined;

  const providerConfig = providers[providerName];
  if (!providerConfig) return undefined;

  return {
    providerName,
    baseUrl: providerConfig.baseUrl ?? "",
    apiType: providerConfig.api ?? "",
  };
}

function jsonErrorResponse(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function tryParseJson(text: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
  } catch { /* ignore */ }
  return undefined;
}

function upstreamErrorResponse(
  apiType: string,
  status: number,
  upstreamBody: string,
): Response {
  const parsed = tryParseJson(upstreamBody);

  if (parsed?.error || (parsed?.type === "error" && parsed.error)) {
    return new Response(upstreamBody, { status, headers: { "content-type": "application/json" } });
  }

  if (apiType === "anthropic-messages") {
    const body = JSON.stringify({
      type: "error",
      error: { type: "api_error", message: `Upstream error ${status}: ${upstreamBody.slice(0, 200)}` },
    });
    return new Response(body, { status, headers: { "content-type": "application/json" } });
  }
  const body = JSON.stringify({
    error: { message: `Upstream error ${status}: ${upstreamBody.slice(0, 200)}`, type: "upstream_error", code: status },
  });
  return new Response(body, { status, headers: { "content-type": "application/json" } });
}

async function fetchWithRetry(
  url: string,
  init: RequestInit,
  retryableStatusCodes: Set<number>,
  maxRetries: number,
  baseDelayMs: number,
  maxDelayMs: number,
  modelLabel: string,
): Promise<Response> {
  let lastResponse: Response | undefined;
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      lastResponse = await fetch(url, {
        method: init.method,
        headers: init.headers,
        body: init.body,
      });
      lastError = undefined;

      if (lastResponse.ok || !retryableStatusCodes.has(lastResponse.status)) {
        return lastResponse;
      }

      if (attempt < maxRetries) {
        const waitMs = computeRetryDelay(lastResponse, attempt, baseDelayMs, maxDelayMs);
        console.warn(
          `[clawmux] Upstream ${lastResponse.status} from ${modelLabel}, retrying in ${Math.round(waitMs)}ms (attempt ${attempt + 1}/${maxRetries})`,
        );
        await new Promise((r) => setTimeout(r, waitMs));
      }
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < maxRetries) {
        const jitter = Math.random() * 300;
        const delay = Math.min(baseDelayMs * 2 ** attempt + jitter, maxDelayMs);
        console.warn(
          `[clawmux] Upstream fetch failed for ${modelLabel}: ${lastError.message}, retrying in ${Math.round(delay)}ms (attempt ${attempt + 1}/${maxRetries})`,
        );
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  if (lastError) {
    throw lastError;
  }
  return lastResponse!;
}

function computeRetryDelay(
  response: Response,
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
): number {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter) {
    const asSeconds = Number(retryAfter);
    if (!Number.isNaN(asSeconds) && asSeconds > 0) {
      return asSeconds * 1000;
    }
    const asDate = Date.parse(retryAfter);
    if (!Number.isNaN(asDate)) {
      const diff = asDate - Date.now();
      if (diff > 0) return Math.min(diff, maxDelayMs);
    }
  }
  const jitter = Math.random() * 300;
  return Math.min(baseDelayMs * 2 ** attempt + jitter, maxDelayMs);
}

export async function handleApiRequest(
  req: Request,
  body: unknown,
  apiType: string,
  config: ClawMuxConfig,
  openclawConfig: OpenClawConfig,
  authProfiles: AuthProfile[],
  compressionMiddleware: CompressionMiddleware | undefined,
  signalRouter: SignalRouter,
): Promise<Response> {
  const adapter = getAdapter(apiType);
  if (!adapter) {
    return jsonErrorResponse(`Unknown API type: ${apiType}`, 500);
  }

  const parsed = adapter.parseRequest(body);

  const compactionHeaders: Record<string, string> = {};
  req.headers.forEach((value, key) => { compactionHeaders[key] = value; });
  const compaction = detectCompaction(compactionHeaders, parsed.messages);

  if (compaction.isCompaction && compressionMiddleware) {
    const summaryData = compressionMiddleware.getSummaryForSession(parsed.messages);
    if (summaryData) {
      const syntheticParsed = buildSyntheticSummaryResponse(
        summaryData.summary,
        summaryData.recentMessages,
        parsed.model,
      );
      console.log(`[clawmux] Compaction detected (${compaction.detectedBy}) → returning synthetic response`);
      return buildSyntheticHttpResponse(syntheticParsed, adapter);
    }
    console.log(`[clawmux] Compaction detected but no summary available, forwarding to upstream`);
  }

  let effectiveParsed = parsed;
  if (compressionMiddleware) {
    const { messages: compressedMessages, wasCompressed } =
      compressionMiddleware.beforeForward(parsed, adapter);
    if (wasCompressed) {
      const modifiedRawBody = adapter.modifyMessages(parsed.rawBody, compressedMessages);
      effectiveParsed = {
        ...parsed,
        messages: compressedMessages,
        rawBody: modifiedRawBody,
      };
    }
  }

  const messages = effectiveParsed.messages as unknown as ReadonlyArray<Message>;
  const initialTier = signalRouter.selectInitialTier(messages);
  const decision: RoutingDecision = {
    tier: initialTier,
    model: config.routing.models[initialTier],
    confidence: 1,
  };

  const lookup = findProviderForModel(decision.model, openclawConfig);
  let providerName: string;
  let baseUrl: string;
  let targetApiType: string;

  if (lookup) {
    providerName = lookup.providerName;
    baseUrl = lookup.baseUrl;
    targetApiType = lookup.apiType;
  } else {
    const reqUrl = new URL(req.url);
    baseUrl = `${reqUrl.protocol}//${reqUrl.host}`;
    providerName = apiType.split("-")[0];
    targetApiType = apiType;
  }

  const auth = resolveApiKey(providerName, openclawConfig, authProfiles);
  if (!auth) {
    return jsonErrorResponse(
      `No auth credentials found for provider: ${providerName}`,
      502,
    );
  }

  const authInfo: AuthInfo = {
    apiKey: auth.apiKey,
    headerName: auth.headerName,
    headerValue: auth.headerValue,
    awsAccessKeyId: auth.awsAccessKeyId,
    awsSecretKey: auth.awsSecretKey,
    awsSessionToken: auth.awsSessionToken,
    awsRegion: auth.awsRegion,
    accountId: auth.accountId,
  };

  const actualModelId = decision.model.split("/").slice(1).join("/");

  const isCrossProvider = targetApiType !== "" && targetApiType !== apiType;
  const targetAdapter = isCrossProvider ? getAdapter(targetApiType) : undefined;
  const requestAdapter = targetAdapter ?? adapter;

  const piEnabled = process.env.CLAWMUX_PIAI !== "0";
  const PI_CLIENT_APIS = new Set([
    "anthropic-messages",
    "openai-completions",
    "openai-responses",
    "google-generative-ai",
  ]);
  const piEligible =
    piEnabled &&
    PI_CLIENT_APIS.has(apiType) &&
    targetApiType !== "ollama" &&
    targetApiType !== "bedrock-converse-stream";

  if (piEligible) {
    try {
      const lastUserMsg = [...parsed.messages].reverse().find((m) => m.role === "user");
      const msgText = typeof lastUserMsg?.content === "string"
        ? lastUserMsg.content
        : Array.isArray(lastUserMsg?.content)
          ? (lastUserMsg.content as Array<{ type?: string; text?: string }>)
              .filter((b) => b.type === "text")
              .map((b) => b.text ?? "")
              .join(" ")
          : "";
      const preview = msgText.replace(/\s+/g, " ").trim().slice(0, 100);

      if (compressionMiddleware) {
        compressionMiddleware.afterResponse(parsed);
      }

      const wantsStream = effectiveParsed.stream === true;
      let currentTier = initialTier;
      const MAX_ESCALATION_ATTEMPTS = 3;

      for (let attempt = 0; attempt < MAX_ESCALATION_ATTEMPTS; attempt++) {
        const currentModel = config.routing.models[currentTier];
        const currentActualModelId = currentModel.split("/").slice(1).join("/");
        const currentProviderName = findProviderForModel(currentModel, openclawConfig)?.providerName ?? providerName;

        const currentAuth = resolveApiKey(currentProviderName, openclawConfig, authProfiles);
        if (!currentAuth) {
          return jsonErrorResponse(
            `No auth credentials found for provider: ${currentProviderName}`,
            502,
          );
        }
        const currentAuthInfo: AuthInfo = {
          apiKey: currentAuth.apiKey,
          headerName: currentAuth.headerName,
          headerValue: currentAuth.headerValue,
          awsAccessKeyId: currentAuth.awsAccessKeyId,
          awsSecretKey: currentAuth.awsSecretKey,
          awsSessionToken: currentAuth.awsSessionToken,
          awsRegion: currentAuth.awsRegion,
          accountId: currentAuth.accountId,
        };

        const model = buildPiAiModel(currentProviderName, currentActualModelId, openclawConfig);
        const injectedMessages = signalRouter.injectInstructionIfNeeded(currentTier, messages);
        const injectedParsed = {
          ...effectiveParsed,
          messages: injectedMessages as Array<{ role: string; content: unknown }>,
          rawBody: adapter.modifyMessages(effectiveParsed.rawBody, injectedMessages as Array<{ role: string; content: unknown }>),
        };
        const piContext = buildPiContext(injectedParsed);
        applyCodexSystemPromptFallback(piContext, targetApiType);

        const shouldDetect = signalRouter.enabled && NEXT_TIER[currentTier] !== null;

        const abortCtrl = new AbortController();
        const piOptions = buildPiOptions(injectedParsed, currentAuthInfo, currentProviderName, abortCtrl.signal);

        console.log(
          `[clawmux] [llm] ${currentTier} → ${currentModel} | attempt=${attempt + 1} | pi-ai (${apiType})${preview ? ` | "${preview}${msgText.length > 100 ? "…" : ""}"` : ""}`,
        );

        const piStreamHandle = piStream(
          model,
          piContext,
          piOptions as unknown as import("@mariozechner/pi-ai").ProviderStreamOptions,
        );

        if (!shouldDetect) {
          return await yieldPiAiResponse(piStreamHandle, apiType, wantsStream);
        }

        const detector = signalRouter.createSignalDetector();
        const detectionState = createSignalDetectionState();

        const assistantMsg = await collectPiStreamWithSignalDetection(
          piStreamHandle,
          detector,
          detectionState,
        );

        if (detectionState.signalDetected) {
          abortCtrl.abort();
          const nextTier = signalRouter.handleEscalation(messages, currentTier);
          if (nextTier !== null) {
            console.log(`[clawmux] [escalation] ${currentTier} → ${nextTier} (signal detected)`);
            currentTier = nextTier;
            continue;
          }
        }

        signalRouter.touchActivity(messages);
        if (attempt > 0) {
          signalRouter.recordSuccessfulEscalation(messages, currentTier as "MEDIUM" | "HEAVY");
        }

        if (wantsStream) {
          const sseBody = buildSseForApiType(apiType, replayAssistantMessageAsEvents(assistantMsg));
          return new Response(sseBody, {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          });
        }

        const jsonBody = buildJsonForApiType(apiType, assistantMsg);
        return new Response(JSON.stringify(jsonBody), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[clawmux] pi-ai path failed, falling back to legacy: ${message}`);
    }
  }

  const upstream = requestAdapter.buildUpstreamRequest(effectiveParsed, actualModelId, baseUrl, authInfo);

  const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503]);
  const MAX_UPSTREAM_RETRIES = 3;
  const RETRY_BASE_DELAY_MS = 500;
  const RETRY_MAX_DELAY_MS = 8000;

  let upstreamResponse: Response;
  try {
    upstreamResponse = await fetchWithRetry(
      upstream.url,
      {
        method: upstream.method,
        headers: upstream.headers,
        body: upstream.body,
      },
      RETRYABLE_STATUS_CODES,
      MAX_UPSTREAM_RETRIES,
      RETRY_BASE_DELAY_MS,
      RETRY_MAX_DELAY_MS,
      decision.model,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return jsonErrorResponse(`Upstream request failed: ${message}`, 502);
  }

  const lastUserMsg = [...parsed.messages].reverse().find((m) => m.role === "user");
  const msgText = typeof lastUserMsg?.content === "string"
    ? lastUserMsg.content
    : Array.isArray(lastUserMsg?.content)
      ? (lastUserMsg.content as Array<{ type?: string; text?: string }>)
          .filter((b) => b.type === "text")
          .map((b) => b.text ?? "")
          .join(" ")
      : "";
  const preview = msgText.replace(/\s+/g, " ").trim().slice(0, 100);

  console.log(
    `[clawmux] [llm] ${decision.tier} → ${decision.model} | legacy${preview ? ` | "${preview}${msgText.length > 100 ? "…" : ""}"` : ""}`,
  );

  if (compressionMiddleware && upstreamResponse.ok) {
    compressionMiddleware.afterResponse(parsed);
  }

  if (!upstreamResponse.ok) {
    const errorBody = await upstreamResponse.text();
    console.error(
      `[clawmux] Upstream error ${upstreamResponse.status} from ${decision.model}: ${errorBody.slice(0, 200)}`,
    );
    return upstreamErrorResponse(apiType, upstreamResponse.status, errorBody);
  }

  const clientWantsStream = effectiveParsed.stream === true;
  const canInspectForCollect =
    !clientWantsStream &&
    upstreamResponse.body !== null &&
    typeof requestAdapter.parseStreamChunk === "function" &&
    typeof adapter.buildResponse === "function";

  if (canInspectForCollect) {
    const { kind, response: inspectedResponse } = await detectUpstreamBodyKind(upstreamResponse);
    if (kind === "stream") {
      try {
        const collected = await collectStreamToResponse(requestAdapter, inspectedResponse);
        const translated = adapter.buildResponse!(collected);
        return new Response(JSON.stringify(translated), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[clawmux] Stream collection failed: ${message}`);
        return jsonErrorResponse(`Upstream stream failed: ${message}`, 502);
      }
    }
    upstreamResponse = inspectedResponse;
    if (kind === "binary-stream") {
      return jsonErrorResponse(
        `Cross-provider non-streaming translation is not supported for binary eventstream upstream (${requestAdapter.apiType}). The client must request a streaming response.`,
        502,
      );
    }
  }

  if (targetAdapter) {
    return translateResponse(targetAdapter, adapter, upstreamResponse, clientWantsStream);
  }

  return new Response(upstreamResponse.body, {
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers: upstreamResponse.headers,
  });
}

async function detectUpstreamBodyKind(
  response: Response,
): Promise<{ kind: "stream" | "binary-stream" | "json" | "unknown"; response: Response }> {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/vnd.amazon.eventstream")) {
    return { kind: "binary-stream", response };
  }
  if (
    contentType.includes("text/event-stream") ||
    contentType.includes("application/x-ndjson")
  ) {
    return { kind: "stream", response };
  }

  if (!response.body) {
    return { kind: "unknown", response };
  }

  const reader = response.body.getReader();
  const { value, done } = await reader.read();

  const rebuiltBody = new ReadableStream<Uint8Array>({
    async start(controller) {
      if (value) controller.enqueue(value);
      if (done) {
        controller.close();
        return;
      }
      for (;;) {
        const { value: nextValue, done: nextDone } = await reader.read();
        if (nextDone) break;
        if (nextValue) controller.enqueue(nextValue);
      }
      controller.close();
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });

  const rebuilt = new Response(rebuiltBody, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });

  if (!value || value.length === 0) {
    return { kind: "unknown", response: rebuilt };
  }

  const peek = new TextDecoder().decode(value.slice(0, Math.min(64, value.length))).trimStart();
  if (peek.startsWith("event:") || peek.startsWith("data:") || peek.startsWith(":")) {
    return { kind: "stream", response: rebuilt };
  }
  if (peek.startsWith("{") || peek.startsWith("[")) {
    return { kind: "json", response: rebuilt };
  }
  return { kind: "unknown", response: rebuilt };
}

const COMPRESSION_UNSUPPORTED_API_TYPES = new Set([
  "openai-codex-responses",
  "bedrock-converse-stream",
]);

function resolveCompressionTarget(
  compressionModel: string,
  openclawConfig: OpenClawConfig,
  authProfiles: AuthProfile[],
): import("./compression-integration.ts").ResolvedCompressionTarget | undefined {
  const lookup = findProviderForModel(compressionModel, openclawConfig);
  if (!lookup) {
    console.warn(
      `[clawmux] Compression model "${compressionModel}" has no matching provider in openclaw.json. Compression will be disabled.`,
    );
    return undefined;
  }

  if (COMPRESSION_UNSUPPORTED_API_TYPES.has(lookup.apiType)) {
    console.warn(
      `[clawmux] Compression provider "${lookup.providerName}" uses apiType "${lookup.apiType}" which is not supported for compression (OAuth/signed-request flow). Use a direct API-key provider (e.g. zai, openai, anthropic) for compression.model. Compression will be disabled.`,
    );
    return undefined;
  }

  const adapter = getAdapter(lookup.apiType);
  if (!adapter) {
    console.warn(
      `[clawmux] Compression provider "${lookup.providerName}" uses unknown apiType "${lookup.apiType}". Compression will be disabled.`,
    );
    return undefined;
  }

  const auth = resolveApiKey(lookup.providerName, openclawConfig, authProfiles);
  if (!auth) {
    console.warn(
      `[clawmux] No auth credentials for compression provider "${lookup.providerName}". Compression will be disabled.`,
    );
    return undefined;
  }

  if (!auth.apiKey || auth.apiKey.trim() === "") {
    console.warn(
      `[clawmux] Compression provider "${lookup.providerName}" returned empty apiKey (OAuth-only or missing credential). Compression will be disabled.`,
    );
    return undefined;
  }

  const actualModelId = compressionModel.includes("/")
    ? compressionModel.split("/").slice(1).join("/")
    : compressionModel;

  return {
    adapter,
    baseUrl: lookup.baseUrl,
    auth: {
      apiKey: auth.apiKey,
      headerName: auth.headerName,
      headerValue: auth.headerValue,
      awsAccessKeyId: auth.awsAccessKeyId,
      awsSecretKey: auth.awsSecretKey,
      awsSessionToken: auth.awsSessionToken,
      awsRegion: auth.awsRegion,
      accountId: auth.accountId,
    },
    actualModelId,
  };
}

export function createResolvedCompressionMiddleware(
  config: ClawMuxConfig,
  openclawConfig: OpenClawConfig,
  authProfiles: AuthProfile[],
  piAiCatalog: PiAiCatalog | undefined,
  statsTracker?: import("./stats.ts").StatsTracker,
): CompressionMiddleware {
  const contextWindows = config.routing.contextWindows ?? {};
  const resolvedContextWindow = resolveCompressionContextWindow(
    config.routing.models,
    contextWindows,
    openclawConfig,
    piAiCatalog,
  );

  const tiers = ["LIGHT", "MEDIUM", "HEAVY"] as const;
  for (const tier of tiers) {
    const modelKey = config.routing.models[tier];
    if (modelKey) {
      const window = resolveContextWindow(modelKey, contextWindows, openclawConfig, piAiCatalog);
      console.log(`[clawmux] ${tier} → ${modelKey} contextWindow=${window}`);
    }
  }
  console.log(`[clawmux] Compression contextWindow=${resolvedContextWindow} (minimum across tiers)`);

  const resolvedTarget = resolveCompressionTarget(
    config.compression.model,
    openclawConfig,
    authProfiles,
  );
  if (resolvedTarget) {
    console.log(
      `[clawmux] Compression model ${config.compression.model} → provider=${resolvedTarget.baseUrl} apiType=${resolvedTarget.adapter.apiType}`,
    );
  }

  return createCompressionMiddleware({
    threshold: config.compression.threshold,
    targetRatio: config.compression.targetRatio ?? 0.6,
    compressionModel: config.compression.model,
    resolvedContextWindow,
    resolvedTarget,
    statsTracker,
  });
}

async function yieldPiAiResponse(
  piStreamHandle: import("@mariozechner/pi-ai").AssistantMessageEventStream,
  apiType: string,
  wantsStream: boolean,
): Promise<Response> {
  if (apiType === "anthropic-messages") {
    if (wantsStream) {
      return new Response(piStreamToAnthropicSse(piStreamHandle), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }
    const json = await piStreamToAnthropicJson(piStreamHandle);
    return new Response(JSON.stringify(json), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  if (apiType === "openai-completions") {
    if (wantsStream) {
      return new Response(piStreamToOpenAiCompletionsSse(piStreamHandle), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }
    const json = await piStreamToOpenAiCompletionsJson(piStreamHandle);
    return new Response(JSON.stringify(json), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  if (apiType === "openai-responses") {
    if (wantsStream) {
      return new Response(piStreamToOpenAiResponsesSse(piStreamHandle), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }
    const json = await piStreamToOpenAiResponsesJson(piStreamHandle);
    return new Response(JSON.stringify(json), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  if (apiType === "google-generative-ai") {
    if (wantsStream) {
      return new Response(piStreamToGoogleSse(piStreamHandle), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }
    const json = await piStreamToGoogleJson(piStreamHandle);
    return new Response(JSON.stringify(json), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  throw new Error(`Unsupported pi-ai apiType: ${apiType}`);
}

function buildSseForApiType(
  apiType: string,
  gen: AsyncIterable<import("@mariozechner/pi-ai").AssistantMessageEvent>,
): ReadableStream<Uint8Array> {
  if (apiType === "anthropic-messages") return piStreamToAnthropicSse(gen);
  if (apiType === "openai-completions") return piStreamToOpenAiCompletionsSse(gen);
  if (apiType === "openai-responses") return piStreamToOpenAiResponsesSse(gen);
  if (apiType === "google-generative-ai") return piStreamToGoogleSse(gen);
  return piStreamToAnthropicSse(gen);
}

function buildJsonForApiType(
  apiType: string,
  msg: import("@mariozechner/pi-ai").AssistantMessage,
): Record<string, unknown> {
  if (apiType === "anthropic-messages") return anthropicMessageFromAssistant(msg);
  if (apiType === "openai-completions") return openAiCompletionsMessageFromAssistant(msg);
  if (apiType === "openai-responses") return openAiResponsesMessageFromAssistant(msg);
  if (apiType === "google-generative-ai") return googleMessageFromAssistant(msg);
  return anthropicMessageFromAssistant(msg);
}

async function drainSignalGenerator(
  gen: AsyncIterable<import("@mariozechner/pi-ai").AssistantMessageEvent>,
): Promise<void> {
  for await (const _event of gen) {
    void _event;
  }
}

async function* replayAssistantMessageAsEvents(
  msg: import("@mariozechner/pi-ai").AssistantMessage,
): AsyncGenerator<import("@mariozechner/pi-ai").AssistantMessageEvent> {
  type Event = import("@mariozechner/pi-ai").AssistantMessageEvent;
  const partial = msg;

  yield { type: "start", partial } as Event;

  for (let i = 0; i < msg.content.length; i++) {
    const block = msg.content[i]!;
    if (block.type === "text") {
      yield { type: "text_start", contentIndex: i, partial } as Event;
      if (block.text.length > 0) {
        yield { type: "text_delta", contentIndex: i, delta: block.text, partial } as Event;
      }
      yield { type: "text_end", contentIndex: i, content: block.text, partial } as Event;
    } else if (block.type === "thinking") {
      yield { type: "thinking_start", contentIndex: i, partial } as Event;
      if (block.thinking.length > 0) {
        yield { type: "thinking_delta", contentIndex: i, delta: block.thinking, partial } as Event;
      }
      yield { type: "thinking_end", contentIndex: i, content: block.thinking, partial } as Event;
    } else if (block.type === "toolCall") {
      yield { type: "toolcall_start", contentIndex: i, partial } as Event;
      const argsJson = JSON.stringify(block.arguments ?? {});
      if (argsJson.length > 0 && argsJson !== "{}") {
        yield { type: "toolcall_delta", contentIndex: i, delta: argsJson, partial } as Event;
      }
      yield { type: "toolcall_end", contentIndex: i, toolCall: block, partial } as Event;
    }
  }

  yield { type: "done", reason: msg.stopReason, message: msg } as Event;
}

async function collectPiStreamWithSignalDetection(
  piStreamHandle: import("@mariozechner/pi-ai").AssistantMessageEventStream,
  detector: import("../routing/signal-detector.ts").SignalDetector,
  state: SignalDetectionState,
): Promise<import("@mariozechner/pi-ai").AssistantMessage> {
  const signalGen = detectSignalInStream(piStreamHandle, detector, state, () => {});
  await drainSignalGenerator(signalGen);
  return await piStreamHandle.result();
}

interface RouteMapping {
  apiType: string;
  key: string;
}

const ROUTE_MAPPINGS: RouteMapping[] = [
  { apiType: "anthropic-messages", key: "/v1/messages" },
  { apiType: "openai-completions", key: "/v1/chat/completions" },
  { apiType: "openai-responses", key: "/v1/responses" },
  { apiType: "google-generative-ai", key: "/v1beta/models/*" },
  { apiType: "ollama", key: "/api/chat" },
  { apiType: "bedrock-converse-stream", key: "/model/*/converse-stream" },
];

export function setupPipelineRoutes(
  config: ClawMuxConfig,
  openclawConfig: OpenClawConfig,
  authProfiles: AuthProfile[],
  compressionMiddleware?: CompressionMiddleware,
): void {
  const escalationConfig = config.routing.escalation;
  const signalRouter = new SignalRouter({
    escalation: {
      activeThresholdMs: escalationConfig?.activeThresholdMs ?? 300_000,
      maxLifetimeMs: escalationConfig?.maxLifetimeMs ?? 7_200_000,
      fingerprintRootCount: escalationConfig?.fingerprintRootCount ?? 5,
    },
    enabled: escalationConfig?.enabled ?? true,
  });

  for (const mapping of ROUTE_MAPPINGS) {
    setRouteHandler(mapping.key, (req, body) =>
      handleApiRequest(req, body, mapping.apiType, config, openclawConfig, authProfiles, compressionMiddleware, signalRouter),
    );
  }
}
