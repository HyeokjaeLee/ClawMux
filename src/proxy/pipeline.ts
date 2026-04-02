import type { ClawMuxConfig } from "../config/types.ts";
import type { OpenClawConfig, AuthProfile } from "../openclaw/types.ts";
import type { AuthInfo } from "../adapters/types.ts";
import type { CompressionMiddleware } from "./compression-integration.ts";
import type { PiAiCatalog } from "../openclaw/model-limits.ts";
import { getAdapter, registerAdapter } from "../adapters/registry.ts";
import { AnthropicAdapter } from "../adapters/anthropic.ts";
import "../adapters/openai-completions.ts";
import "../adapters/openai-responses.ts";
import "../adapters/google.ts";
import "../adapters/ollama.ts";
import "../adapters/bedrock.ts";
import type { Message, RoutingDecision } from "../routing/types.ts";
import { classifyComplexity } from "../routing/llm-classifier.ts";
import { resolveApiKey } from "../openclaw/auth-resolver.ts";
import { translateResponse } from "../adapters/stream-transformer.ts";
import { setRouteHandler } from "./router.ts";
import { createCompressionMiddleware } from "./compression-integration.ts";
import { resolveCompressionContextWindow, resolveContextWindow, DEFAULT_CONTEXT_TOKENS } from "../openclaw/model-limits.ts";

registerAdapter(new AnthropicAdapter());

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
  const classifierModel = config.routing.classifier?.model ?? config.routing.models.LIGHT;
  const classifierDeps = {
    openclawConfig,
    authProfiles,
    classifierModel,
    timeoutMs: config.routing.classifier?.timeoutMs ?? 3000,
    routingModels: config.routing.models,
    scoringConfig: config.routing.scoring,
  };
  const classification = await classifyComplexity(messages, classifierDeps);
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

  console.log(
    `[clawmux] ${decision.tier} → ${decision.model} | conf=${classification.confidence.toFixed(2)}${classification.reasoning ? ` | ${classification.reasoning}` : ""}`,
  );

  if (compressionMiddleware && upstreamResponse.ok) {
    compressionMiddleware.afterResponse(parsed, adapter, baseUrl, authInfo);
  }

  if (targetAdapter && upstreamResponse.ok) {
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
