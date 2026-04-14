import { readFile, readdir } from "node:fs/promises";
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

function parseAuthProfilesFile(text: string): AuthProfile[] {
  try {
    const parsed = JSON.parse(text);

    if (Array.isArray(parsed)) return parsed as AuthProfile[];

    if (parsed && typeof parsed === "object" && parsed.profiles) {
      return Object.entries(parsed.profiles as Record<string, Record<string, unknown>>)
        .map(([key, profile]) => ({
          provider: (profile.provider as string) ?? key.split(":")[0],
          apiKey: (profile.access as string) ?? (profile.apiKey as string) ?? (profile.key as string),
          token: (profile.token as string),
        }))
        .filter((p) => {
          const token = p.apiKey ?? p.token;
          if (!token || !token.includes(".")) return true;
          try {
            const payload = token.split(".")[1];
            const decoded = JSON.parse(Buffer.from(payload, "base64").toString());
            if (decoded.exp && decoded.exp * 1000 < Date.now()) return false;
          } catch (_) { void _; return true; }
          return true;
        });
    }

    return [];
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse auth-profiles.json: ${message}`);
  }
}

/**
 * Read auth profiles from all agent directories and merge them.
 * ClawMux is a global proxy — it needs credentials for every provider
 * across all agents, not just one.
 *
 * Merge strategy: later files override earlier ones by profile key.
 * "main" agent is read first as baseline, then all others alphabetically.
 */
export async function readAuthProfiles(_agentId?: string, _profilesPath?: string, agentsDirOverride?: string): Promise<AuthProfile[]> {
  const agentsDir = agentsDirOverride ?? join(getHomeDir(), ".openclaw", "agents");

  let agentDirs: string[];
  try {
    agentDirs = (await readdir(agentsDir, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch {
    // agents dir doesn't exist — fall back to single file
    const path = getAuthProfilesPath(_agentId);
    try {
      return parseAuthProfilesFile(await readFile(path, "utf-8"));
    } catch {
      return [];
    }
  }

  // Read "main" first as baseline, then all others
  const ordered = ["main", ...agentDirs.filter((d) => d !== "main")];

  // Use Map for dedup: provider -> AuthProfile (last write wins)
  const merged = new Map<string, AuthProfile>();

  for (const agentId of ordered) {
    const profilePath = join(agentsDir, agentId, "agent", "auth-profiles.json");
    try {
      const text = await readFile(profilePath, "utf-8");
      const profiles = parseAuthProfilesFile(text);
      for (const p of profiles) {
        // Key by provider — later agents override earlier ones
        merged.set(p.provider, p);
      }
    } catch {
      // skip missing/unreadable files
    }
  }

  return Array.from(merged.values());
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
