import type { OpenClawConfig, AuthProfile } from "../openclaw/types.ts";
import type { ParsedRequest, AuthInfo } from "../adapters/types.ts";
import type { ClassificationResult, Message, Tier } from "./types.ts";
import { getAdapter } from "../adapters/registry.ts";
import { resolveApiKey } from "../openclaw/auth-resolver.ts";
import { scoreComplexity } from "./scorer.ts";
import { routeRequest } from "./tier-mapper.ts";

export interface ClassifierDeps {
  openclawConfig: OpenClawConfig;
  authProfiles: AuthProfile[];
  classifierModel: string;
  timeoutMs: number;
  routingModels: { LIGHT: string; MEDIUM: string; HEAVY: string };
  scoringConfig?: {
    boundaries?: { lightMedium: number; mediumHeavy: number };
    confidenceThreshold?: number;
  };
}

const CLASSIFICATION_SYSTEM_PROMPT =
  "Classify this user message into exactly one complexity tier.\n\n" +
  "LIGHT: Greetings, confirmations, simple lookups, single-step tasks, brief questions\n" +
  "MEDIUM: Standard coding, explanations, moderate analysis, straightforward multi-step tasks\n" +
  "HEAVY: Complex reasoning, architecture decisions, deep debugging, multi-domain analysis, large refactoring\n\n" +
  "Respond with ONLY the tier name (LIGHT, MEDIUM, or HEAVY) on the first line.\n" +
  "Optionally add a brief reason on the second line.";

const VALID_TIERS = new Set<string>(["LIGHT", "MEDIUM", "HEAVY"]);
const MAX_TEXT_LENGTH = 500;

function extractLastUserText(messages: ReadonlyArray<Message>): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== "user") continue;

    if (typeof msg.content === "string") {
      return msg.content;
    }
    if (Array.isArray(msg.content)) {
      const parts: string[] = [];
      for (const block of msg.content) {
        if (block.type === "text" && block.text) {
          parts.push(block.text);
        }
      }
      if (parts.length > 0) return parts.join(" ");
    }
  }
  return undefined;
}

function parseClassificationResponse(text: string): ClassificationResult | undefined {
  const trimmed = text.trim();
  if (trimmed.length === 0) return undefined;

  const lines = trimmed.split("\n");
  const firstLine = lines[0].trim().toUpperCase();

  if (!VALID_TIERS.has(firstLine)) return undefined;

  const tier = firstLine as Tier;
  const reasoning = lines.length > 1 ? lines.slice(1).join("\n").trim() : undefined;

  return {
    tier,
    confidence: 1.0,
    reasoning: reasoning || undefined,
  };
}

function resolveProvider(
  modelString: string,
  openclawConfig: OpenClawConfig,
): { providerName: string; baseUrl: string; apiType: string; modelId: string } | undefined {
  const [providerName, ...rest] = modelString.split("/");
  const modelId = rest.join("/");
  if (!providerName || !modelId) return undefined;

  const providerConfig = openclawConfig.models?.providers?.[providerName];
  if (!providerConfig) return undefined;

  return {
    providerName,
    baseUrl: providerConfig.baseUrl ?? "",
    apiType: providerConfig.api ?? "",
    modelId,
  };
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

async function callClassifierLLM(
  userText: string,
  deps: ClassifierDeps,
): Promise<ClassificationResult | undefined> {
  const resolved = resolveProvider(deps.classifierModel, deps.openclawConfig);
  if (!resolved) return undefined;

  const adapter = getAdapter(resolved.apiType);
  if (!adapter) return undefined;

  const auth = resolveApiKey(resolved.providerName, deps.openclawConfig, deps.authProfiles);
  if (!auth) return undefined;

  const authInfo: AuthInfo = {
    apiKey: auth.apiKey,
    headerName: auth.headerName,
    headerValue: auth.headerValue,
  };

  const truncatedText = userText.slice(0, MAX_TEXT_LENGTH);

  const syntheticParsed: ParsedRequest = {
    model: deps.classifierModel,
    messages: [
      { role: "user", content: truncatedText },
    ],
    system: CLASSIFICATION_SYSTEM_PROMPT,
    stream: false,
    maxTokens: 16,
    rawBody: {
      model: deps.classifierModel,
      system: CLASSIFICATION_SYSTEM_PROMPT,
      messages: [{ role: "user", content: truncatedText }],
      stream: false,
      max_tokens: 16,
    },
  };

  const upstream = adapter.buildUpstreamRequest(
    syntheticParsed,
    resolved.modelId,
    resolved.baseUrl,
    authInfo,
  );

  const fetchPromise = fetch(upstream.url, {
    method: upstream.method,
    headers: upstream.headers,
    body: upstream.body,
  });

  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error("Classifier timeout")), deps.timeoutMs);
  });

  const response = await Promise.race([fetchPromise, timeoutPromise]);

  const body = await response.text();
  if (!response.ok) return undefined;

  const responseText = extractResponseText(body);
  return parseClassificationResponse(responseText);
}

function fallbackToKeywordScorer(
  messages: ReadonlyArray<Message>,
  deps: ClassifierDeps,
): ClassificationResult {
  try {
    const scoringResult = scoreComplexity(messages);
    const decision = routeRequest(scoringResult, {
      models: deps.routingModels,
      scoring: deps.scoringConfig,
    });
    return {
      tier: decision.tier,
      confidence: decision.confidence,
      reasoning: "Keyword scorer fallback",
    };
  } catch {
    return { tier: "HEAVY", confidence: 0.0, reasoning: "All classifiers failed" };
  }
}

export async function classifyComplexity(
  messages: ReadonlyArray<Message>,
  deps: ClassifierDeps,
): Promise<ClassificationResult> {
  const userText = extractLastUserText(messages);
  if (!userText) {
    return { tier: "HEAVY", confidence: 0.0, reasoning: "No user message found" };
  }

  try {
    const result = await callClassifierLLM(userText, deps);
    if (result) return result;
    return fallbackToKeywordScorer(messages, deps);
  } catch {
    return fallbackToKeywordScorer(messages, deps);
  }
}
