import type { ClawMuxConfig, ValidationResultUnion } from "./types.ts";
import { applyDefaults } from "./defaults.ts";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireNumber(errors: string[], path: string, value: unknown): value is number {
  if (typeof value !== "number") {
    errors.push(`${path}: must be a number, got ${typeof value}`);
    return false;
  }
  return true;
}

function requireString(errors: string[], path: string, value: unknown): value is string {
  if (typeof value !== "string") {
    errors.push(`${path}: must be a string, got ${typeof value}`);
    return false;
  }
  return true;
}

function requireInRange(errors: string[], path: string, value: number, min: number, max: number) {
  if (value < min || value > max) {
    errors.push(`${path}: must be between ${min} and ${max}, got ${value}`);
  }
}

function checkRequiredString(errors: string[], errorPath: string, obj: unknown, key: string): string | undefined {
  if (!isObject(obj)) {
    errors.push(`${errorPath}: is required`);
    return undefined;
  }
  const value = obj[key];
  if (typeof value !== "string" || value === "") {
    errors.push(`${errorPath}: is required`);
    return undefined;
  }
  return value;
}

function checkProviderModelFormat(errors: string[], path: string, model: string) {
  if (!model.includes("/")) {
    errors.push(`${path} must be in 'provider/model' format (e.g., 'anthropic/claude-sonnet-4-20250514')`);
    return;
  }
  const providerName = model.split("/", 2)[0];
  if (providerName.toLowerCase().startsWith("clawmux-")) {
    errors.push(`Self-referencing model detected: ${model}. This would cause an infinite routing loop.`);
  }
}

function checkOptionalNumberRange(errors: string[], path: string, value: unknown, min: number, max: number) {
  if (requireNumber(errors, path, value)) {
    requireInRange(errors, path, value, min, max);
  }
}

export function validateConfig(raw: unknown): ValidationResultUnion {
  const errors: string[] = [];
  const obj = isObject(raw) ? raw : {};

  const compression = isObject(obj.compression) ? obj.compression : {};

  const threshold = compression.threshold;
  if (threshold === undefined) {
    errors.push("compression.threshold: is required");
  } else {
    checkOptionalNumberRange(errors, "compression.threshold", threshold, 0.1, 0.95);
  }

  if (compression.model === undefined || compression.model === "") {
    errors.push("compression.model: is required");
  } else if (requireString(errors, "compression.model", compression.model)) {
    checkProviderModelFormat(errors, "compression.model", compression.model as string);
  }

  if (compression.targetRatio !== undefined) {
    checkOptionalNumberRange(errors, "compression.targetRatio", compression.targetRatio, 0.2, 0.9);
  }

  const routing = isObject(obj.routing) ? obj.routing : {};
  const models = isObject(routing.models) ? routing.models : {};

  const light = checkRequiredString(errors, "routing.models.LIGHT", models, "LIGHT");
  const medium = checkRequiredString(errors, "routing.models.MEDIUM", models, "MEDIUM");
  const heavy = checkRequiredString(errors, "routing.models.HEAVY", models, "HEAVY");

  if (light) checkProviderModelFormat(errors, "routing.models.LIGHT", light);
  if (medium) checkProviderModelFormat(errors, "routing.models.MEDIUM", medium);
  if (heavy) checkProviderModelFormat(errors, "routing.models.HEAVY", heavy);

  const scoring = routing.scoring !== undefined && isObject(routing.scoring) ? routing.scoring : null;
  if (scoring !== null && scoring.confidenceThreshold !== undefined) {
    checkOptionalNumberRange(errors, "routing.scoring.confidenceThreshold", scoring.confidenceThreshold, 0.0, 1.0);
  }

  const server = obj.server !== undefined && isObject(obj.server) ? obj.server : null;
  if (server !== null && server.port !== undefined) {
    checkOptionalNumberRange(errors, "server.port", server.port, 1024, 65535);
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return { valid: true, config: applyDefaults(obj as unknown as ClawMuxConfig) };
}
