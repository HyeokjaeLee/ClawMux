import type { ClawMuxConfig } from "../config/types.ts";
import type { OpenClawConfig, AuthProfile } from "../openclaw/types.ts";
import type { ApiAdapter, AuthInfo } from "../adapters/types.ts";
import type { ParsedResponse } from "../adapters/response-types.ts";
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
import type { Message, RoutingDecision, ClassificationResult } from "../routing/types.ts";
import { classifyLocal } from "../routing/local-classifier.ts";
import { resolveApiKey } from "../openclaw/auth-resolver.ts";
import { translateResponse } from "../adapters/stream-transformer.ts";
import { setRouteHandler } from "./router.ts";
import { createCompressionMiddleware } from "./compression-integration.ts";
import { resolveCompressionContextWindow, resolveContextWindow, DEFAULT_CONTEXT_TOKENS } from "../openclaw/model-limits.ts";

registerAdapter(new AnthropicAdapter());

async function collectCodexStream(
  sourceAdapter: ApiAdapter,
  response: Response,
): Promise<ParsedResponse> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let id = "";
  let model = "";
  const textParts: string[] = [];
  let usage: { inputTokens: number; outputTokens: number } | undefined;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      if (!frame.trim() || !sourceAdapter.parseStreamChunk) continue;

      for (const event of sourceAdapter.parseStreamChunk(frame)) {
        if (event.type === "message_start") {
          id = event.id ?? "";
          model = event.model ?? "";
        } else if (event.type === "content_delta") {
          textParts.push(event.text ?? "");
        } else if (event.type === "message_stop" && event.usage) {
          usage = event.usage;
        }
      }
    }
  }

  return {
    id,
    model,
    content: textParts.join(""),
    role: "assistant",
    stopReason: "completed",
    usage,
  };
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

function upstreamErrorResponse(
  apiType: string,
  status: number,
  upstreamBody: string,
): Response {
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

export async function handleApiRequest(
  req: Request,
  body: unknown,
  apiType: string,
  config: ClawMuxConfig,
  openclawConfig: OpenClawConfig,
  authProfiles: AuthProfile[],
  compressionMiddleware?: CompressionMiddleware,
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
  const classification = await classifyLocal(messages);

  const decision: RoutingDecision = {
    tier: classification.tier,
    model: config.routing.models[classification.tier],
    confidence: classification.confidence,
    overrideReason: classification.reasoning,
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
  };

  const actualModelId = decision.model.split("/").slice(1).join("/");

  const isCrossProvider = targetApiType !== "" && targetApiType !== apiType;
  const targetAdapter = isCrossProvider ? getAdapter(targetApiType) : undefined;
  const requestAdapter = targetAdapter ?? adapter;
  const upstream = requestAdapter.buildUpstreamRequest(effectiveParsed, actualModelId, baseUrl, authInfo);

  let upstreamResponse: Response;
  try {
    upstreamResponse = await fetch(upstream.url, {
      method: upstream.method,
      headers: upstream.headers,
      body: upstream.body,
    });
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
    `[clawmux] [llm] ${decision.tier} → ${decision.model} | conf=${classification.confidence.toFixed(2)}${classification.reasoning ? ` | ${classification.reasoning}` : ""}${preview ? ` | "${preview}${msgText.length > 100 ? "…" : ""}"` : ""}`,
  );

  if (compressionMiddleware && upstreamResponse.ok) {
    compressionMiddleware.afterResponse(parsed, adapter, baseUrl, authInfo);
  }

  const isCodexUpstream = targetApiType === "openai-codex-responses";
  if (isCodexUpstream && upstreamResponse.ok && upstreamResponse.body) {
    if (effectiveParsed.stream) {
      return translateResponse(requestAdapter, adapter, upstreamResponse, true);
    }
    const collected = await collectCodexStream(requestAdapter, upstreamResponse);
    const translated = adapter.buildResponse!(collected);
    return new Response(JSON.stringify(translated), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  if (!upstreamResponse.ok) {
    const errorBody = await upstreamResponse.text();
    console.error(
      `[clawmux] Upstream error ${upstreamResponse.status} from ${decision.model}: ${errorBody.slice(0, 200)}`,
    );
    return upstreamErrorResponse(apiType, upstreamResponse.status, errorBody);
  }

  if (targetAdapter) {
    return translateResponse(targetAdapter, adapter, upstreamResponse, effectiveParsed.stream);
  }

  return new Response(upstreamResponse.body, {
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers: upstreamResponse.headers,
  });
}

export function createResolvedCompressionMiddleware(
  config: ClawMuxConfig,
  openclawConfig: OpenClawConfig,
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

  return createCompressionMiddleware({
    threshold: config.compression.threshold,
    targetRatio: config.compression.targetRatio ?? 0.6,
    compressionModel: config.compression.model,
    resolvedContextWindow,
    statsTracker,
  });
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
  for (const mapping of ROUTE_MAPPINGS) {
    setRouteHandler(mapping.key, (req, body) =>
      handleApiRequest(req, body, mapping.apiType, config, openclawConfig, authProfiles, compressionMiddleware),
    );
  }
}
