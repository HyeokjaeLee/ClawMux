import { describe, expect, it } from "bun:test";
import { validateConfig } from "./validator.ts";

const VALID_CONFIG = {
  compression: { threshold: 0.75, model: "anthropic/claude-3-5-haiku-20241022" },
  routing: {
    models: {
      LIGHT: "anthropic/claude-3-5-haiku-20241022",
      MEDIUM: "anthropic/claude-sonnet-4-20250514",
      HEAVY: "anthropic/claude-opus-4-20250514",
    },
  },
};

describe("validateConfig", () => {
  it("accepts a valid complete config", () => {
    const result = validateConfig(VALID_CONFIG);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.config.compression.threshold).toBe(0.75);
      expect(result.config.compression.model).toBe("anthropic/claude-3-5-haiku-20241022");
    }
  });

  it("rejects missing routing.models.LIGHT with a clear error", () => {
    const result = validateConfig({
      compression: { threshold: 0.75, model: "anthropic/claude-3-5-haiku-20241022" },
      routing: { models: { LIGHT: "", MEDIUM: "anthropic/m", HEAVY: "anthropic/h" } },
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some((e) => e.includes("routing.models.LIGHT"))).toBe(true);
    }
  });

  it("rejects threshold=1.5 with a range error", () => {
    const result = validateConfig({
      ...VALID_CONFIG,
      compression: { threshold: 1.5, model: "anthropic/claude-3-5-haiku-20241022" },
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some((e) => e.includes("compression.threshold") && e.includes("0.1") && e.includes("0.95"))).toBe(true);
    }
  });

  it("detects self-referencing model containing 'clawmux-' prefix", () => {
    const result = validateConfig({
      ...VALID_CONFIG,
      routing: {
        models: {
          LIGHT: "anthropic/claude-3-5-haiku-20241022",
          MEDIUM: "anthropic/claude-sonnet-4-20250514",
          HEAVY: "clawmux-anthropic/auto",
        },
      },
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some((e) => e.includes("clawmux-anthropic/auto") && e.includes("infinite"))).toBe(true);
    }
  });

  it("detects self-referencing model with bare 'clawmux' provider", () => {
    const result = validateConfig({
      ...VALID_CONFIG,
      routing: {
        models: {
          LIGHT: "clawmux/auto",
          MEDIUM: "anthropic/claude-sonnet-4-20250514",
          HEAVY: "anthropic/claude-opus-4-20250514",
        },
      },
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some((e) => e.includes("clawmux/auto") && e.includes("infinite"))).toBe(true);
    }
  });

  it("lists all required fields when config is empty", () => {
    const result = validateConfig({});
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.length).toBeGreaterThanOrEqual(4);
      const joined = result.errors.join(" ");
      expect(joined).toContain("compression.threshold");
      expect(joined).toContain("compression.model");
      expect(joined).toContain("routing.models.LIGHT");
      expect(joined).toContain("routing.models.MEDIUM");
      expect(joined).toContain("routing.models.HEAVY");
    }
  });

  it("merges partial config with defaults", () => {
    const partial = {
      compression: { threshold: 0.8, model: "anthropic/claude-3-5-haiku-20241022", targetRatio: 0.5 },
      routing: {
        models: {
          LIGHT: "anthropic/claude-3-5-haiku-20241022",
          MEDIUM: "anthropic/claude-sonnet-4-20250514",
          HEAVY: "anthropic/claude-opus-4-20250514",
        },
      },
    };
    const result = validateConfig(partial);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.config.compression.threshold).toBe(0.8);
      expect(result.config.compression.targetRatio).toBe(0.5);
      expect(result.config.server!.port).toBe(3456);
      expect(result.config.server!.host).toBe("127.0.0.1");
    }
  });

  it("rejects non-number threshold", () => {
    const result = validateConfig({
      ...VALID_CONFIG,
      compression: { threshold: "high" as unknown as number, model: "anthropic/claude-3-5-haiku-20241022" },
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some((e) => e.includes("compression.threshold") && e.includes("number"))).toBe(true);
    }
  });

  it("rejects port below 1024", () => {
    const result = validateConfig({
      ...VALID_CONFIG,
      server: { port: 80 },
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some((e) => e.includes("server.port") && e.includes("1024"))).toBe(true);
    }
  });

  it("rejects model IDs without provider/model format", () => {
    const result = validateConfig({
      compression: { threshold: 0.75, model: "claude-3-5-haiku-20241022" },
      routing: {
        models: {
          LIGHT: "claude-3-5-haiku-20241022",
          MEDIUM: "anthropic/claude-sonnet-4-20250514",
          HEAVY: "anthropic/claude-opus-4-20250514",
        },
      },
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some((e) => e.includes("compression.model") && e.includes("provider/model"))).toBe(true);
      expect(result.errors.some((e) => e.includes("routing.models.LIGHT") && e.includes("provider/model"))).toBe(true);
    }
  });

  it("rejects targetRatio outside 0.2–0.9", () => {
    const result = validateConfig({
      ...VALID_CONFIG,
      compression: { threshold: 0.75, model: "anthropic/claude-3-5-haiku-20241022", targetRatio: 0.1 },
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some((e) => e.includes("compression.targetRatio") && e.includes("0.2") && e.includes("0.9"))).toBe(true);
    }
  });

  describe("routing.contextWindows validation", () => {
    it("accepts valid contextWindows", () => {
      const result = validateConfig({
        ...VALID_CONFIG,
        routing: {
          ...VALID_CONFIG.routing,
          contextWindows: { "zai/glm-5": 204800, "openai/gpt-5.4": 400000 },
        },
      });
      expect(result.valid).toBe(true);
    });

    it("accepts config without contextWindows (optional)", () => {
      const result = validateConfig(VALID_CONFIG);
      expect(result.valid).toBe(true);
    });

    it("accepts empty contextWindows", () => {
      const result = validateConfig({
        ...VALID_CONFIG,
        routing: {
          ...VALID_CONFIG.routing,
          contextWindows: {},
        },
      });
      expect(result.valid).toBe(true);
    });

    it("rejects non-positive contextWindow values", () => {
      const result = validateConfig({
        ...VALID_CONFIG,
        routing: {
          ...VALID_CONFIG.routing,
          contextWindows: { "zai/glm-5": 0 },
        },
      });
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.errors.some((e) => e.includes("routing.contextWindows") && e.includes("positive number"))).toBe(true);
      }
    });

    it("rejects negative contextWindow values", () => {
      const result = validateConfig({
        ...VALID_CONFIG,
        routing: {
          ...VALID_CONFIG.routing,
          contextWindows: { "openai/gpt-5.4": -100 },
        },
      });
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.errors.some((e) => e.includes("routing.contextWindows") && e.includes("positive number"))).toBe(true);
      }
    });

    it("rejects non-number contextWindow values", () => {
      const result = validateConfig({
        ...VALID_CONFIG,
        routing: {
          ...VALID_CONFIG.routing,
          contextWindows: { "zai/glm-5": "large" as unknown as number },
        },
      });
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.errors.some((e) => e.includes("routing.contextWindows") && e.includes("positive number"))).toBe(true);
      }
    });

    it("merges contextWindows with defaults", () => {
      const result = validateConfig({
        ...VALID_CONFIG,
        routing: {
          ...VALID_CONFIG.routing,
          contextWindows: { "zai/glm-5": 204800 },
        },
      });
      expect(result.valid).toBe(true);
      if (result.valid) {
        expect(result.config.routing.contextWindows).toEqual({ "zai/glm-5": 204800 });
      }
    });
  });

  describe("routing.escalation validation", () => {
    it("accepts partial escalation and applies defaults for omitted fields", () => {
      const result = validateConfig({
        ...VALID_CONFIG,
        routing: {
          ...VALID_CONFIG.routing,
          escalation: { activeThresholdMs: 60_000 },
        },
      });
      expect(result.valid).toBe(true);
      if (result.valid) {
        expect(result.config.routing.escalation!.activeThresholdMs).toBe(60_000);
        expect(result.config.routing.escalation!.maxLifetimeMs).toBe(7_200_000);
        expect(result.config.routing.escalation!.fingerprintRootCount).toBe(5);
        expect(result.config.routing.escalation!.enabled).toBe(true);
      }
    });

    it("rejects negative activeThresholdMs", () => {
      const result = validateConfig({
        ...VALID_CONFIG,
        routing: {
          ...VALID_CONFIG.routing,
          escalation: { activeThresholdMs: -1 },
        },
      });
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.errors.some((e) => e.includes("routing.escalation.activeThresholdMs") && e.includes("positive"))).toBe(true);
      }
    });

    it("rejects maxLifetimeMs of 0", () => {
      const result = validateConfig({
        ...VALID_CONFIG,
        routing: {
          ...VALID_CONFIG.routing,
          escalation: { maxLifetimeMs: 0 },
        },
      });
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.errors.some((e) => e.includes("routing.escalation.maxLifetimeMs") && e.includes("positive"))).toBe(true);
      }
    });

    it("accepts enabled=false and preserves it", () => {
      const result = validateConfig({
        ...VALID_CONFIG,
        routing: {
          ...VALID_CONFIG.routing,
          escalation: { enabled: false },
        },
      });
      expect(result.valid).toBe(true);
      if (result.valid) {
        expect(result.config.routing.escalation!.enabled).toBe(false);
      }
    });

    it("rejects fingerprintRootCount of 0", () => {
      const result = validateConfig({
        ...VALID_CONFIG,
        routing: {
          ...VALID_CONFIG.routing,
          escalation: { fingerprintRootCount: 0 },
        },
      });
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.errors.some((e) => e.includes("routing.escalation.fingerprintRootCount") && e.includes(">= 1"))).toBe(true);
      }
    });

    it("accepts config without escalation field (fully optional)", () => {
      const result = validateConfig(VALID_CONFIG);
      expect(result.valid).toBe(true);
      if (result.valid) {
        expect(result.config.routing.escalation).toBeDefined();
        expect(result.config.routing.escalation!.enabled).toBe(true);
      }
    });

    it("rejects non-numeric activeThresholdMs", () => {
      const result = validateConfig({
        ...VALID_CONFIG,
        routing: {
          ...VALID_CONFIG.routing,
          escalation: { activeThresholdMs: "fast" as unknown as number },
        },
      });
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.errors.some((e) => e.includes("routing.escalation.activeThresholdMs") && e.includes("number"))).toBe(true);
      }
    });

    it("applyDefaults fills all escalation fields when omitted", () => {
      const result = validateConfig(VALID_CONFIG);
      expect(result.valid).toBe(true);
      if (result.valid) {
        expect(result.config.routing.escalation).toEqual({
          activeThresholdMs: 300_000,
          maxLifetimeMs: 7_200_000,
          fingerprintRootCount: 5,
          enabled: true,
        });
      }
    });
  });
});
