import { readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { validateConfig } from "./validator.ts";
import type { ValidationResultUnion } from "./types.ts";

function getHomeDir(): string {
  return process.env.HOME ?? "/root";
}

export function getClawmuxConfigPath(): string {
  const envPath = process.env.CLAWMUX_CONFIG;
  if (envPath) return resolve(envPath);
  return join(getHomeDir(), ".openclaw", "clawmux.json");
}

function findConfigPath(): string {
  return getClawmuxConfigPath();
}

export async function loadConfig(configPath?: string): Promise<ValidationResultUnion> {
  const filePath = configPath ?? findConfigPath();

  let raw: string;
  try {
    raw = await readFile(filePath, "utf-8");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      valid: false,
      errors: [`Failed to read config file at ${filePath}: ${message}`],
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      valid: false,
      errors: [`Invalid JSON in config file ${filePath}: ${message}`],
    };
  }

  return validateConfig(parsed);
}

export { validateConfig } from "./validator.ts";
export type { ClawMuxConfig, ValidationResultUnion, ValidationResult, ValidationFailure } from "./types.ts";
