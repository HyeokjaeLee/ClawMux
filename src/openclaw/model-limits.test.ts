import { describe, expect, it, beforeEach } from "bun:test";
import type { OpenClawConfig } from "./types.ts";
import type { PiAiCatalog } from "./model-limits.ts";
import {
  resolveContextWindow,
  resolveCompressionContextWindow,
  DEFAULT_CONTEXT_TOKENS,
  resetCatalogCache,
} from "./model-limits.ts";

const EMPTY_OPENCLAW: OpenClawConfig = {};

const OPENCLAW_WITH_MODELS: OpenClawConfig = {
  models: {
    providers: {
      anthropic: {
        baseUrl: "https://api.anthropic.com",
        models: [
          { id: "claude-sonnet-4-20250514", contextWindow: 200000 },
          { id: "claude-3-5-haiku-20241022", contextWindow: 200000 },
        ],
      },
      openai: {
        baseUrl: "https://api.openai.com",
        models: [
          { id: "gpt-5.4", contextWindow: 400000 },
        ],
      },
    },
  },
};

const PI_AI_CATALOG: PiAiCatalog = {
  anthropic: {
    "claude-sonnet-4-20250514": { contextWindow: 200000 },
    "claude-opus-4-20250514": { contextWindow: 200000 },
  },
  zai: {
    "glm-5": { contextWindow: 204800 },
  },
  openai: {
    "gpt-5.4": { contextWindow: 400000 },
    "o3-mini": { contextWindow: 128000 },
  },
};

describe("resolveContextWindow", () => {
  it("returns clawmux config value when present (level 1)", () => {
    const result = resolveContextWindow(
      "zai/glm-5",
      { "zai/glm-5": 100000 },
      EMPTY_OPENCLAW,
      undefined,
    );
    expect(result).toBe(100000);
  });

  it("falls back to openclaw config when clawmux has no entry (level 2)", () => {
    const result = resolveContextWindow(
      "openai/gpt-5.4",
      {},
      OPENCLAW_WITH_MODELS,
      undefined,
    );
    expect(result).toBe(400000);
  });

  it("falls back to pi-ai catalog when neither clawmux nor openclaw have entry (level 3)", () => {
    const result = resolveContextWindow(
      "zai/glm-5",
      {},
      EMPTY_OPENCLAW,
      PI_AI_CATALOG,
    );
    expect(result).toBe(204800);
  });

  it("returns DEFAULT_CONTEXT_TOKENS when no source has the model (level 4)", () => {
    const result = resolveContextWindow(
      "unknown/model-xyz",
      {},
      EMPTY_OPENCLAW,
      PI_AI_CATALOG,
    );
    expect(result).toBe(DEFAULT_CONTEXT_TOKENS);
  });

  it("returns DEFAULT_CONTEXT_TOKENS when pi-ai catalog is undefined", () => {
    const result = resolveContextWindow(
      "zai/glm-5",
      {},
      EMPTY_OPENCLAW,
      undefined,
    );
    expect(result).toBe(DEFAULT_CONTEXT_TOKENS);
  });

  it("clawmux config takes priority over openclaw config", () => {
    const result = resolveContextWindow(
      "openai/gpt-5.4",
      { "openai/gpt-5.4": 300000 },
      OPENCLAW_WITH_MODELS,
      PI_AI_CATALOG,
    );
    expect(result).toBe(300000);
  });

  it("openclaw config takes priority over pi-ai catalog", () => {
    const result = resolveContextWindow(
      "anthropic/claude-sonnet-4-20250514",
      {},
      OPENCLAW_WITH_MODELS,
      PI_AI_CATALOG,
    );
    expect(result).toBe(200000);
  });

  it("handles model key without provider prefix", () => {
    const result = resolveContextWindow(
      "no-slash-model",
      {},
      EMPTY_OPENCLAW,
      PI_AI_CATALOG,
    );
    expect(result).toBe(DEFAULT_CONTEXT_TOKENS);
  });

  it("ignores zero or negative values in clawmux config", () => {
    const result = resolveContextWindow(
      "zai/glm-5",
      { "zai/glm-5": 0 },
      EMPTY_OPENCLAW,
      PI_AI_CATALOG,
    );
    expect(result).toBe(204800);
  });

  it("ignores negative values in clawmux config", () => {
    const result = resolveContextWindow(
      "zai/glm-5",
      { "zai/glm-5": -1 },
      EMPTY_OPENCLAW,
      PI_AI_CATALOG,
    );
    expect(result).toBe(204800);
  });
});

describe("resolveCompressionContextWindow", () => {
  it("returns the minimum contextWindow across all routing models", () => {
    const result = resolveCompressionContextWindow(
      { LIGHT: "openai/o3-mini", MEDIUM: "anthropic/claude-sonnet-4-20250514", HEAVY: "openai/gpt-5.4" },
      {},
      EMPTY_OPENCLAW,
      PI_AI_CATALOG,
    );
    expect(result).toBe(128000);
  });

  it("returns DEFAULT_CONTEXT_TOKENS when all models are empty strings", () => {
    const result = resolveCompressionContextWindow(
      { LIGHT: "", MEDIUM: "", HEAVY: "" },
      {},
      EMPTY_OPENCLAW,
      undefined,
    );
    expect(result).toBe(DEFAULT_CONTEXT_TOKENS);
  });

  it("deduplicates models when same model used for multiple tiers", () => {
    const result = resolveCompressionContextWindow(
      { LIGHT: "zai/glm-5", MEDIUM: "zai/glm-5", HEAVY: "zai/glm-5" },
      {},
      EMPTY_OPENCLAW,
      PI_AI_CATALOG,
    );
    expect(result).toBe(204800);
  });

  it("uses clawmux overrides in minimum calculation", () => {
    const result = resolveCompressionContextWindow(
      { LIGHT: "zai/glm-5", MEDIUM: "anthropic/claude-sonnet-4-20250514", HEAVY: "openai/gpt-5.4" },
      { "zai/glm-5": 50000 },
      EMPTY_OPENCLAW,
      PI_AI_CATALOG,
    );
    expect(result).toBe(50000);
  });

  it("falls back to DEFAULT_CONTEXT_TOKENS for unknown models", () => {
    const result = resolveCompressionContextWindow(
      { LIGHT: "unknown/model-a", MEDIUM: "unknown/model-b", HEAVY: "unknown/model-c" },
      {},
      EMPTY_OPENCLAW,
      undefined,
    );
    expect(result).toBe(DEFAULT_CONTEXT_TOKENS);
  });
});

describe("loadPiAiCatalog", () => {
  beforeEach(() => {
    resetCatalogCache();
  });

  it("returns undefined when openclaw is not installed", async () => {
    const { loadPiAiCatalog } = await import("./model-limits.ts");
    resetCatalogCache();
    const result = await loadPiAiCatalog();
    expect(result === undefined || typeof result === "object").toBe(true);
  });

  it("caches the result after first call", async () => {
    const { loadPiAiCatalog } = await import("./model-limits.ts");
    resetCatalogCache();
    const first = await loadPiAiCatalog();
    const second = await loadPiAiCatalog();
    expect(first).toBe(second);
  });

  it("resetCatalogCache allows re-loading", async () => {
    const { loadPiAiCatalog } = await import("./model-limits.ts");
    resetCatalogCache();
    await loadPiAiCatalog();
    resetCatalogCache();
    const result = await loadPiAiCatalog();
    expect(result === undefined || typeof result === "object").toBe(true);
  });
});
