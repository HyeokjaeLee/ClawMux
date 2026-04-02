import { realpath } from "node:fs/promises";
import { join, dirname } from "node:path";
import type { OpenClawConfig } from "./types.ts";
import { lookupContextWindowFromConfig } from "./config-reader.ts";

export const DEFAULT_CONTEXT_TOKENS = 200_000;

export interface PiAiModelEntry {
  contextWindow?: number;
  maxTokens?: number;
  [key: string]: unknown;
}

export type PiAiCatalog = Record<string, Record<string, PiAiModelEntry>>;

let cachedCatalog: PiAiCatalog | undefined | null = null;

export function resolveContextWindow(
  modelKey: string,
  clawmuxContextWindows: Record<string, number>,
  openclawConfig: OpenClawConfig,
  piAiCatalog: PiAiCatalog | undefined,
): number {
  const fromClawmux = clawmuxContextWindows[modelKey];
  if (typeof fromClawmux === "number" && fromClawmux > 0) {
    return fromClawmux;
  }

  const fromOpenclaw = lookupContextWindowFromConfig(modelKey, openclawConfig);
  if (typeof fromOpenclaw === "number" && fromOpenclaw > 0) {
    return fromOpenclaw;
  }

  if (piAiCatalog) {
    const [provider, ...rest] = modelKey.split("/");
    const modelId = rest.join("/");
    if (provider && modelId) {
      const providerModels = piAiCatalog[provider];
      if (providerModels) {
        const entry = providerModels[modelId];
        if (entry && typeof entry.contextWindow === "number" && entry.contextWindow > 0) {
          return entry.contextWindow;
        }
      }
    }
  }

  return DEFAULT_CONTEXT_TOKENS;
}

export function resolveCompressionContextWindow(
  routingModels: { LIGHT: string; MEDIUM: string; HEAVY: string },
  clawmuxContextWindows: Record<string, number>,
  openclawConfig: OpenClawConfig,
  piAiCatalog: PiAiCatalog | undefined,
): number {
  const modelKeys = [routingModels.LIGHT, routingModels.MEDIUM, routingModels.HEAVY];
  const uniqueKeys = [...new Set(modelKeys.filter(k => k !== ""))];

  if (uniqueKeys.length === 0) {
    return DEFAULT_CONTEXT_TOKENS;
  }

  let min = Infinity;
  for (const key of uniqueKeys) {
    const window = resolveContextWindow(key, clawmuxContextWindows, openclawConfig, piAiCatalog);
    if (window < min) {
      min = window;
    }
  }

  return min === Infinity ? DEFAULT_CONTEXT_TOKENS : min;
}

async function findOpenClawNodeModulesPath(): Promise<string | undefined> {
  try {
    const { execSync } = await import("node:child_process");
    const whichResult = execSync("which openclaw", { encoding: "utf-8" }).trim();
    if (!whichResult) return undefined;

    const resolved = await realpath(whichResult);
    // resolved is something like /path/to/node_modules/.bin/openclaw or /path/to/node_modules/openclaw/dist/cli.js
    // Walk up to find node_modules
    let dir = dirname(resolved);
    for (let i = 0; i < 10; i++) {
      const candidate = join(dir, "node_modules", "@mariozechner", "pi-ai", "dist", "models.generated.js");
      try {
        const file = Bun.file(candidate);
        if (await file.exists()) {
          return candidate;
        }
      } catch {
        // continue searching
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    // `which openclaw` failed — not installed
  }

  const homeDir = process.env.HOME ?? Bun.env.HOME ?? "/root";
  const fallbackPaths = [
    join(homeDir, ".npm-global", "lib", "node_modules", "openclaw", "node_modules", "@mariozechner", "pi-ai", "dist", "models.generated.js"),
    join(homeDir, ".local", "lib", "node_modules", "openclaw", "node_modules", "@mariozechner", "pi-ai", "dist", "models.generated.js"),
  ];

  for (const path of fallbackPaths) {
    try {
      const file = Bun.file(path);
      if (await file.exists()) {
        return path;
      }
    } catch {
      // continue
    }
  }

  return undefined;
}

// Regex to extract MODELS object from the generated JS file
// The file exports: export const MODELS = { ... }
function parseCatalogFromSource(source: string): PiAiCatalog | undefined {
  const modelsMatch = source.match(/export\s+const\s+MODELS\s*=\s*(\{[\s\S]*\});?\s*$/m);
  if (!modelsMatch) return undefined;

  try {
    // Use Function constructor to evaluate the object literal safely
    // This avoids eval() while still parsing the JS object
    const fn = new Function(`return (${modelsMatch[1]});`);
    const result = fn() as unknown;
    if (typeof result === "object" && result !== null && !Array.isArray(result)) {
      return result as PiAiCatalog;
    }
  } catch (err) {
    console.warn("[clawmux] Failed to parse pi-ai model catalog:", err instanceof Error ? err.message : String(err));
  }

  return undefined;
}

export async function loadPiAiCatalog(): Promise<PiAiCatalog | undefined> {
  // Return cached result (undefined means "tried and failed", null means "not yet tried")
  if (cachedCatalog !== null) {
    return cachedCatalog;
  }

  const filePath = await findOpenClawNodeModulesPath();
  if (!filePath) {
    console.warn("[clawmux] pi-ai model catalog not found — using default context windows");
    cachedCatalog = undefined;
    return undefined;
  }

  try {
    const source = await Bun.file(filePath).text();
    const catalog = parseCatalogFromSource(source);
    if (catalog) {
      const providerCount = Object.keys(catalog).length;
      const modelCount = Object.values(catalog).reduce(
        (sum, models) => sum + Object.keys(models).length,
        0,
      );
      console.log(`[clawmux] Loaded pi-ai model catalog: ${providerCount} providers, ${modelCount} models`);
      cachedCatalog = catalog;
      return catalog;
    }
    console.warn("[clawmux] pi-ai model catalog found but could not be parsed");
    cachedCatalog = undefined;
    return undefined;
  } catch (err) {
    console.warn("[clawmux] Failed to load pi-ai model catalog:", err instanceof Error ? err.message : String(err));
    cachedCatalog = undefined;
    return undefined;
  }
}

export function resetCatalogCache(): void {
  cachedCatalog = null;
}
