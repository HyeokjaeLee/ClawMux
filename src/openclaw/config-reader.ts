import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { OpenClawConfig, OpenClawProviderConfig, AuthProfile } from "./types.js";

const ENV_VAR_PATTERN = /^\$\{([^}]+)\}$/;

export function resolveEnvVar(value: string): string {
  const match = value.match(ENV_VAR_PATTERN);
  if (match) {
    return process.env[match[1]] ?? "";
  }
  return value;
}

function getHomeDir(): string {
  return process.env.HOME ?? "/root";
}

export function getConfigPath(override?: string): string {
  if (override) return override;
  if (process.env.OPENCLAW_CONFIG_PATH) return process.env.OPENCLAW_CONFIG_PATH;
  return join(getHomeDir(), ".openclaw", "openclaw.json");
}

export async function readOpenClawConfig(configPath?: string): Promise<OpenClawConfig> {
  const path = getConfigPath(configPath);
  let text: string;
  try {
    text = await readFile(path, "utf-8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      throw new Error(`openclaw.json not found at ${path}. Ensure OpenClaw is installed.`);
    }
    throw err;
  }

  try {
    return JSON.parse(text) as OpenClawConfig;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse openclaw.json: ${message}`);
  }
}

export function getAuthProfilesPath(agentId?: string): string {
  const id = agentId ?? "main";
  return join(getHomeDir(), ".openclaw", "agents", id, "agent", "auth-profiles.json");
}

export async function readAuthProfiles(agentId?: string, profilesPath?: string): Promise<AuthProfile[]> {
  const path = profilesPath ?? getAuthProfilesPath(agentId);
  let text: string;
  try {
    text = await readFile(path, "utf-8");
  } catch {
    return [];
  }

  try {
    return JSON.parse(text) as AuthProfile[];
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse auth-profiles.json: ${message}`);
  }
}

export function getProviderConfig(provider: string, config: OpenClawConfig): OpenClawProviderConfig | undefined {
  return config.models?.providers?.[provider];
}

export function lookupContextWindowFromConfig(
  modelKey: string,
  config: OpenClawConfig,
): number | undefined {
  const [provider, ...rest] = modelKey.split("/");
  const modelId = rest.join("/");
  if (!provider || !modelId) return undefined;
  const providerConfig = config.models?.providers?.[provider];
  if (!providerConfig?.models) return undefined;
  const model = providerConfig.models.find(m => m.id === modelId);
  return model?.contextWindow;
}
