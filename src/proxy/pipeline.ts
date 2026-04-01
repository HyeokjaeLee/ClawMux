import type { ClawMuxConfig } from "../config/types.ts";
import type { OpenClawConfig, AuthProfile } from "../openclaw/types.ts";
import type { AuthInfo } from "../adapters/types.ts";
import type { CompressionMiddleware } from "./compression-integration.ts";
import { getAdapter, registerAdapter } from "../adapters/registry.ts";
import { AnthropicAdapter } from "../adapters/anthropic.ts";
import "../adapters/openai-completions.ts";
import "../adapters/openai-responses.ts";
import "../adapters/google.ts";
import "../adapters/ollama.ts";
import "../adapters/bedrock.ts";
import type { Message } from "../routing/types.ts";
import { scoreComplexity } from "../routing/scorer.ts";
import { routeRequest } from "../routing/tier-mapper.ts";
import { resolveApiKey } from "../openclaw/auth-resolver.ts";
import { setRouteHandler } from "./router.ts";

registerAdapter(new AnthropicAdapter());

interface ProviderLookupResult {
  providerName: string;
  baseUrl: string;
}

function findProviderForModel(
  modelId: string,
  openclawConfig: OpenClawConfig,
): ProviderLookupResult | undefined {
  const providers = openclawConfig.models?.providers;
  if (!providers) return undefined;

  for (const [providerName, providerConfig] of Object.entries(providers)) {
    const models = providerConfig.models;
    if (!models) continue;
    for (const model of models) {
      if (model.id === modelId) {
        return {
          providerName,
          baseUrl: providerConfig.baseUrl ?? "",
        };
      }
    }
  }

  return undefined;
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
  const scoringResult = scoreComplexity(messages, config.routing.scoring);
  const decision = routeRequest(scoringResult, config.routing);

  const lookup = findProviderForModel(decision.model, openclawConfig);
  let providerName: string;
  let baseUrl: string;

  if (lookup) {
    providerName = lookup.providerName;
    baseUrl = lookup.baseUrl;
  } else {
    const reqUrl = new URL(req.url);
    baseUrl = `${reqUrl.protocol}//${reqUrl.host}`;
    providerName = apiType.split("-")[0];
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

  const upstream = adapter.buildUpstreamRequest(effectiveParsed, decision.model, baseUrl, authInfo);

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
    `[clawmux] ${decision.tier} → ${decision.model} | score=${scoringResult.score.toFixed(3)} conf=${scoringResult.confidence.toFixed(2)} | ${scoringResult.textExcerpt}`,
  );

  if (compressionMiddleware && upstreamResponse.ok) {
    compressionMiddleware.afterResponse(parsed, adapter, baseUrl, authInfo);
  }

  return new Response(upstreamResponse.body, {
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers: upstreamResponse.headers,
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
