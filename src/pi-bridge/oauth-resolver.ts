import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

interface CodexTokens {
  access_token?: unknown;
  refresh_token?: unknown;
  account_id?: unknown;
}

interface CodexAuthFile {
  tokens?: CodexTokens;
  OPENAI_API_KEY?: unknown;
  auth_mode?: unknown;
}

interface ClaudeCredentialsFile {
  claudeAiOauth?: {
    accessToken?: unknown;
    refreshToken?: unknown;
    expiresAt?: unknown;
    subscriptionType?: unknown;
  };
}

export interface ResolvedOAuthTokens {
  apiKey: string;
  accountId?: string;
  expires?: number;
}

function decodeJwtExpiryMs(jwt: string): number | undefined {
  const parts = jwt.split(".");
  if (parts.length !== 3) return undefined;
  try {
    const payload = JSON.parse(
      Buffer.from(parts[1], "base64").toString("utf-8"),
    ) as { exp?: unknown };
    if (typeof payload.exp === "number") return payload.exp * 1000;
  } catch {
    return undefined;
  }
  return undefined;
}

function readJsonFile<T>(path: string): T | undefined {
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as T;
    return parsed;
  } catch {
    return undefined;
  }
}

function resolveCodexHome(): string {
  const override = process.env.CODEX_HOME;
  if (override) return override;
  return join(homedir(), ".codex");
}

function readOpenAiCodexTokens(): ResolvedOAuthTokens | undefined {
  const authPath = join(resolveCodexHome(), "auth.json");
  const parsed = readJsonFile<CodexAuthFile>(authPath);
  if (!parsed) return undefined;
  const tokens = parsed.tokens;
  if (!tokens || typeof tokens !== "object") {
    if (typeof parsed.OPENAI_API_KEY === "string" && parsed.OPENAI_API_KEY) {
      return { apiKey: parsed.OPENAI_API_KEY };
    }
    return undefined;
  }
  const access = tokens.access_token;
  if (typeof access !== "string" || !access) return undefined;
  const accountId =
    typeof tokens.account_id === "string" ? tokens.account_id : undefined;
  let expires = decodeJwtExpiryMs(access);
  if (expires === undefined) {
    try {
      expires = statSync(authPath).mtimeMs + 3600 * 1000;
    } catch {
      expires = Date.now() + 3600 * 1000;
    }
  }
  return { apiKey: access, accountId, expires };
}

function readAnthropicOAuth(): ResolvedOAuthTokens | undefined {
  const envToken = process.env.ANTHROPIC_OAUTH_TOKEN;
  if (envToken) return { apiKey: envToken };

  const candidates = [
    join(homedir(), ".claude", ".credentials.json"),
    join(homedir(), ".claude", "credentials.json"),
  ];
  for (const path of candidates) {
    const parsed = readJsonFile<ClaudeCredentialsFile>(path);
    const oauth = parsed?.claudeAiOauth;
    if (oauth && typeof oauth.accessToken === "string" && oauth.accessToken) {
      return {
        apiKey: oauth.accessToken,
        expires:
          typeof oauth.expiresAt === "number" ? oauth.expiresAt : undefined,
      };
    }
  }
  return undefined;
}

export function resolveOAuthTokens(
  providerName: string,
): ResolvedOAuthTokens | undefined {
  if (providerName === "openai-codex") return readOpenAiCodexTokens();
  if (providerName === "anthropic") return readAnthropicOAuth();
  return undefined;
}

const OAUTH_ONLY_PROVIDERS = new Set(["openai-codex"]);

export function isOAuthOnlyProvider(providerName: string): boolean {
  return OAUTH_ONLY_PROVIDERS.has(providerName);
}
