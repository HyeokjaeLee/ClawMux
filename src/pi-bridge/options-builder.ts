import type { StreamOptions } from "@mariozechner/pi-ai";
import type { ParsedRequest, AuthInfo } from "../adapters/types.ts";
import { resolveOAuthTokens, isOAuthOnlyProvider } from "./oauth-resolver.ts";

export function buildPiOptions(
  parsed: ParsedRequest,
  auth: AuthInfo,
  providerName: string,
  signal?: AbortSignal,
): StreamOptions {
  const raw = parsed.rawBody ?? {};
  let apiKey = auth.apiKey;

  if (!apiKey || isOAuthOnlyProvider(providerName)) {
    const oauth = resolveOAuthTokens(providerName);
    if (oauth) apiKey = oauth.apiKey;
  }

  const options: StreamOptions = { apiKey };

  if (typeof raw.temperature === "number") options.temperature = raw.temperature;
  if (typeof parsed.maxTokens === "number") options.maxTokens = parsed.maxTokens;
  if (signal) options.signal = signal;

  const metadata = raw.metadata;
  if (metadata && typeof metadata === "object") {
    options.metadata = metadata as Record<string, unknown>;
    const md = metadata as { user_id?: string; session_id?: string };
    if (typeof md.user_id === "string") options.sessionId = md.user_id;
    else if (typeof md.session_id === "string") options.sessionId = md.session_id;
  }

  return options;
}
