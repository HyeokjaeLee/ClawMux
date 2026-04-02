import type { OpenClawConfig, AuthProfile } from "../openclaw/types.ts";
import type { ParsedRequest, AuthInfo } from "../adapters/types.ts";
import type { ClassificationResult, ClassificationTier, Message } from "./types.ts";
import { getAdapter } from "../adapters/registry.ts";
import { resolveApiKey } from "../openclaw/auth-resolver.ts";

export interface ClassifierDeps {
  openclawConfig: OpenClawConfig;
  authProfiles: AuthProfile[];
  classifierModel: string;
  timeoutMs: number;
  contextMessages: number;
  routingModels: { LIGHT: string; MEDIUM: string; HEAVY: string };
  scoringConfig?: {
    boundaries?: { lightMedium: number; mediumHeavy: number };
    confidenceThreshold?: number;
  };
}

const CLASSIFICATION_SYSTEM_PROMPT =
  "Classify complexity. Reply with exactly one character.\n" +
  "L - simple: greeting, confirmation, short factual answer, single lookup\n" +
  "M - moderate: standard coding, explanation, straightforward multi-step\n" +
  "H - complex: deep reasoning, architecture, complex debugging, multi-domain\n" +
  "Q - unclear without conversation context, need prior messages to judge";

const RECLASSIFICATION_SYSTEM_PROMPT =
  "Classify complexity. Reply with exactly one character.\n" +
  "L - simple: greeting, confirmation, short factual answer, single lookup\n" +
  "M - moderate: standard coding, explanation, straightforward multi-step\n" +
  "H - complex: deep reasoning, architecture, complex debugging, multi-domain";

const TIER_MAP: Record<string, ClassificationTier> = {
  L: "LIGHT",
  M: "MEDIUM",
  H: "HEAVY",
};

const VALID_CHARS = new Set(["L", "M", "H", "Q"]);
const MAX_TEXT_LENGTH = 500;
const MAX_RETRY_ATTEMPTS = 3;

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

function parseClassificationResponse(text: string): string | undefined {
  const trimmed = text.trim();
  if (trimmed.length === 0) return undefined;

  const firstChar = trimmed[0].toUpperCase();
  if (!VALID_CHARS.has(firstChar)) return undefined;

  return firstChar;
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

function buildSyntheticRequest(
  classifierModel: string,
  messages: Array<{ role: string; content: string }>,
  systemPrompt: string,
): ParsedRequest {
  return {
    model: classifierModel,
    messages,
    system: systemPrompt,
    stream: false,
    maxTokens: 1,
    rawBody: {
      model: classifierModel,
      system: systemPrompt,
      messages,
      stream: false,
      max_tokens: 1,
    },
  };
}

function resolveAuth(
  deps: ClassifierDeps,
): { resolved: ReturnType<typeof resolveProvider> & object; adapter: ReturnType<typeof getAdapter> & object; authInfo: AuthInfo } | undefined {
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

  return { resolved, adapter, authInfo };
}

async function sendClassifierRequest(
  syntheticParsed: ParsedRequest,
  resolved: { modelId: string; baseUrl: string },
  adapter: { buildUpstreamRequest: (p: ParsedRequest, m: string, b: string, a: AuthInfo) => { url: string; method: string; headers: Record<string, string>; body: string } },
  authInfo: AuthInfo,
  timeoutMs: number,
): Promise<string> {
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
    setTimeout(() => reject(new Error("Classifier timeout")), timeoutMs);
  });

  const response = await Promise.race([fetchPromise, timeoutPromise]);

  const body = await response.text();
  if (!response.ok) {
    throw new Error(`Classifier HTTP ${response.status}: ${body.slice(0, 200)}`);
  }

  return extractResponseText(body);
}

function buildContextMessages(
  allMessages: ReadonlyArray<Message>,
  userText: string,
  contextCount: number,
): Array<{ role: string; content: string }> {
  const contextMsgs: Array<{ role: string; content: string }> = [];

  const relevantMessages = allMessages.filter(
    (m) => m.role === "user" || m.role === "assistant",
  );

  const lastN = relevantMessages.slice(-contextCount);

  for (const msg of lastN) {
    let text: string;
    if (typeof msg.content === "string") {
      text = msg.content;
    } else if (Array.isArray(msg.content)) {
      text = msg.content
        .filter((b) => b.type === "text" && b.text)
        .map((b) => b.text)
        .join(" ");
    } else {
      continue;
    }
    contextMsgs.push({ role: msg.role, content: text });
  }

  const lastContext = contextMsgs[contextMsgs.length - 1];
  if (!lastContext || lastContext.content !== userText || lastContext.role !== "user") {
    contextMsgs.push({ role: "user", content: userText });
  }

  return contextMsgs;
}

function errorResult(reasoning: string, errorMessage: string): ClassificationResult {
  return { tier: "MEDIUM", confidence: 0.0, reasoning, error: errorMessage };
}

async function callClassifierWithRetry(
  userText: string,
  deps: ClassifierDeps,
  authCtx: { resolved: { modelId: string; baseUrl: string }; adapter: { buildUpstreamRequest: (p: ParsedRequest, m: string, b: string, a: AuthInfo) => { url: string; method: string; headers: Record<string, string>; body: string } }; authInfo: AuthInfo },
): Promise<string> {
  const truncatedText = userText.slice(0, MAX_TEXT_LENGTH);
  const messages: Array<{ role: string; content: string }> = [
    { role: "user", content: truncatedText },
  ];

  let syntheticParsed = buildSyntheticRequest(deps.classifierModel, messages, CLASSIFICATION_SYSTEM_PROMPT);
  let responseText = await sendClassifierRequest(syntheticParsed, authCtx.resolved, authCtx.adapter, authCtx.authInfo, deps.timeoutMs);

  let parsed = parseClassificationResponse(responseText);
  if (parsed) return parsed;

  for (let attempt = 1; attempt < MAX_RETRY_ATTEMPTS; attempt++) {
    const retryMessages: Array<{ role: string; content: string }> = [
      { role: "user", content: truncatedText },
      { role: "assistant", content: responseText },
      { role: "user", content: "Invalid response. Reply with exactly one character: L, M, H, or Q" },
    ];

    syntheticParsed = buildSyntheticRequest(deps.classifierModel, retryMessages, CLASSIFICATION_SYSTEM_PROMPT);
    responseText = await sendClassifierRequest(syntheticParsed, authCtx.resolved, authCtx.adapter, authCtx.authInfo, deps.timeoutMs);

    parsed = parseClassificationResponse(responseText);
    if (parsed) return parsed;
  }

  throw new Error(`Classification failed after ${MAX_RETRY_ATTEMPTS} attempts. Last response: "${responseText}"`);
}

export async function classifyComplexity(
  messages: ReadonlyArray<Message>,
  deps: ClassifierDeps,
): Promise<ClassificationResult> {
  const userText = extractLastUserText(messages);
  if (!userText) {
    return errorResult("No user message found", "No user message found in request");
  }

  const authCtx = resolveAuth(deps);
  if (!authCtx) {
    return errorResult("No classifier provider available", "Classification unavailable: no provider, adapter, or auth for classifier model");
  }

  try {
    const charResult = await callClassifierWithRetry(userText, deps, authCtx);

    if (charResult === "Q") {
      console.log(`[clawmux] Classification needs context, retrying with ${deps.contextMessages} messages`);

      const contextMsgs = buildContextMessages(messages, userText, deps.contextMessages);
      const syntheticParsed = buildSyntheticRequest(deps.classifierModel, contextMsgs, RECLASSIFICATION_SYSTEM_PROMPT);
      const retryText = await sendClassifierRequest(syntheticParsed, authCtx.resolved, authCtx.adapter, authCtx.authInfo, deps.timeoutMs);
      const retryChar = parseClassificationResponse(retryText);

      if (retryChar && TIER_MAP[retryChar]) {
        return { tier: TIER_MAP[retryChar], confidence: 0.9, reasoning: "Classified with conversation context" };
      }

      return errorResult("Re-classification failed", `Re-classification returned invalid response: "${retryText}"`);
    }

    const tier = TIER_MAP[charResult];
    if (tier) {
      return { tier, confidence: 1.0 };
    }

    return errorResult("Unexpected classification character", `Unexpected classification: ${charResult}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return errorResult("Classification failed", message);
  }
}
