import type { ClawMuxConfig, EscalationConfig } from "./types.ts";

export const ESCALATION_DEFAULTS: Required<EscalationConfig> = {
  activeThresholdMs: 300_000,
  maxLifetimeMs: 7_200_000,
  fingerprintRootCount: 5,
  enabled: true,
};

export const DEFAULT_CONFIG: Required<ClawMuxConfig> = {
  compression: {
    threshold: 0.75,
    model: "",
    targetRatio: 0.6,
  },
  routing: {
    models: {
      LIGHT: "",
      MEDIUM: "",
      HEAVY: "",
    },
    contextWindows: {},
    escalation: ESCALATION_DEFAULTS,
  },
  server: {
    port: 3456,
    host: "127.0.0.1",
  },
};

export function applyDefaults(partial: ClawMuxConfig): Required<ClawMuxConfig> {
  const defaults = DEFAULT_CONFIG;

  return {
    compression: {
      threshold: partial.compression.threshold ?? defaults.compression.threshold,
      model: partial.compression.model ?? defaults.compression.model,
      targetRatio: partial.compression.targetRatio ?? defaults.compression.targetRatio,
    },
    routing: {
      models: {
        LIGHT: partial.routing.models.LIGHT ?? defaults.routing.models.LIGHT,
        MEDIUM: partial.routing.models.MEDIUM ?? defaults.routing.models.MEDIUM,
        HEAVY: partial.routing.models.HEAVY ?? defaults.routing.models.HEAVY,
      },
      contextWindows: { ...defaults.routing.contextWindows, ...partial.routing.contextWindows },
      escalation: {
        activeThresholdMs: partial.routing.escalation?.activeThresholdMs ?? ESCALATION_DEFAULTS.activeThresholdMs,
        maxLifetimeMs: partial.routing.escalation?.maxLifetimeMs ?? ESCALATION_DEFAULTS.maxLifetimeMs,
        fingerprintRootCount: partial.routing.escalation?.fingerprintRootCount ?? ESCALATION_DEFAULTS.fingerprintRootCount,
        enabled: partial.routing.escalation?.enabled !== undefined
          ? partial.routing.escalation.enabled
          : ESCALATION_DEFAULTS.enabled,
      },
    },
    server: {
      port: partial.server?.port ?? defaults.server.port,
      host: partial.server?.host ?? defaults.server.host,
    },
  };
}
