import type { OpenClawConfig, AuthProfile, ResolvedAuth, OpenClawProviderConfig } from "./types.js";
import { resolveEnvVar, getProviderConfig } from "./config-reader.js";
import { extractRegionFromUrl } from "../utils/aws-sigv4.ts";

const PROVIDER_ENV_VARS: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GEMINI_API_KEY",
  gemini: "GEMINI_API_KEY",
  zai: "ZAI_API_KEY",
  aws: "AWS_ACCESS_KEY_ID",
  bedrock: "AWS_ACCESS_KEY_ID",
};

function getEnvFallback(provider: string): string | undefined {
  const exact = PROVIDER_ENV_VARS[provider];
  if (exact) return process.env[exact];

  for (const [key, envVar] of Object.entries(PROVIDER_ENV_VARS)) {
    if (provider.startsWith(key)) {
      return process.env[envVar];
    }
  }

  return undefined;
}

function formatAuth(apiKey: string, providerConfig: OpenClawProviderConfig | undefined): ResolvedAuth {
  const api = providerConfig?.api ?? "";

  if (api === "anthropic-messages") {
    return { apiKey, headerName: "x-api-key", headerValue: apiKey };
  }

  if (api === "openai-completions" || api === "openai-responses") {
    return { apiKey, headerName: "Authorization", headerValue: `Bearer ${apiKey}` };
  }

  if (api === "google-generative-ai") {
    return { apiKey, headerName: "x-goog-api-key", headerValue: apiKey };
  }

  if (api === "bedrock-converse-stream") {
    const secretKey = process.env.AWS_SECRET_ACCESS_KEY ?? "";
    const sessionToken = process.env.AWS_SESSION_TOKEN;
    const region =
      process.env.AWS_REGION ??
      process.env.AWS_DEFAULT_REGION ??
      extractRegionFromUrl(providerConfig?.baseUrl ?? "") ??
      "us-east-1";

    return {
      apiKey,
      headerName: "Authorization",
      headerValue: "",
      awsAccessKeyId: apiKey,
      awsSecretKey: secretKey,
      awsSessionToken: sessionToken,
      awsRegion: region,
    };
  }

  return { apiKey, headerName: "Authorization", headerValue: `Bearer ${apiKey}` };
}

const NO_AUTH_APIS = new Set(["ollama"]);

export function resolveApiKey(
  provider: string,
  openclawConfig: OpenClawConfig,
  authProfiles: AuthProfile[],
): ResolvedAuth | undefined {
  const providerConfig = getProviderConfig(provider, openclawConfig);
  const api = providerConfig?.api ?? "";

  if (NO_AUTH_APIS.has(api)) {
    return { apiKey: "ollama-local", headerName: "", headerValue: "" };
  }

  for (const profile of authProfiles) {
    if (profile.provider === provider) {
      const key = profile.apiKey ?? profile.token;
      if (key) {
        const resolved = resolveEnvVar(key);
        if (resolved) {
          return formatAuth(resolved, providerConfig);
        }
      }
    }
  }

  if (providerConfig?.apiKey) {
    const resolved = resolveEnvVar(providerConfig.apiKey);
    if (resolved) {
      return formatAuth(resolved, providerConfig);
    }
  }

  const envKey = getEnvFallback(provider);
  if (envKey) {
    return formatAuth(envKey, providerConfig);
  }

  return undefined;
}
