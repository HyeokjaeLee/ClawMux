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

  if (routing.contextWindows !== undefined) {
    if (!isObject(routing.contextWindows)) {
      errors.push("routing.contextWindows: must be an object");
    } else {
      for (const [key, value] of Object.entries(routing.contextWindows)) {
        if (typeof key !== "string") {
          errors.push(`routing.contextWindows: keys must be strings`);
        }
        if (typeof value !== "number" || value <= 0) {
          errors.push(`routing.contextWindows["${key}"]: must be a positive number, got ${String(value)}`);
        }
      }
    }
  }

  const classifier = routing.classifier !== undefined && isObject(routing.classifier) ? routing.classifier : null;
  if (classifier !== null) {
    if (classifier.mode !== undefined) {
      const validModes = ["heuristic", "llm", "hybrid"];
      if (typeof classifier.mode !== "string" || !validModes.includes(classifier.mode as string)) {
        errors.push(`routing.classifier.mode: must be one of ${validModes.join(", ")}, got "${String(classifier.mode)}"`);
      }
    }
    if (classifier.model !== undefined) {
      if (requireString(errors, "routing.classifier.model", classifier.model)) {
        checkProviderModelFormat(errors, "routing.classifier.model", classifier.model as string);
      }
    }
    if (classifier.timeoutMs !== undefined) {
      checkOptionalNumberRange(errors, "routing.classifier.timeoutMs", classifier.timeoutMs, 500, 10000);
    }
    if (classifier.contextMessages !== undefined) {
      if (requireNumber(errors, "routing.classifier.contextMessages", classifier.contextMessages)) {
        const n = classifier.contextMessages as number;
        if (!Number.isInteger(n) || n < 1 || n > 50) {
          errors.push("routing.classifier.contextMessages: must be a positive integer between 1 and 50, got " + String(n));
        }
      }
    }
  }

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
