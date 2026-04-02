import type { ClawMuxConfig } from "./types.ts";

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
    classifier: {
      model: undefined,
      timeoutMs: 3000,
      contextMessages: 10,
    },
    scoring: {
      weights: {},
      boundaries: {
        lightMedium: 0.0,
        mediumHeavy: 0.35,
      },
      confidenceThreshold: 0.70,
    },
  },
  server: {
    port: 3456,
    host: "127.0.0.1",
  },
};

export function applyDefaults(partial: ClawMuxConfig): Required<ClawMuxConfig> {
  const defaults = DEFAULT_CONFIG;
  const ps = partial.routing.scoring;
  const ds = defaults.routing.scoring!;

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
      classifier: {
        model: partial.routing.classifier?.model ?? defaults.routing.classifier!.model,
        timeoutMs: partial.routing.classifier?.timeoutMs ?? defaults.routing.classifier!.timeoutMs,
        contextMessages: partial.routing.classifier?.contextMessages ?? defaults.routing.classifier!.contextMessages,
      },
      scoring: {
        weights: { ...ds.weights, ...ps?.weights },
        boundaries: {
          lightMedium: ps?.boundaries?.lightMedium ?? ds.boundaries!.lightMedium,
          mediumHeavy: ps?.boundaries?.mediumHeavy ?? ds.boundaries!.mediumHeavy,
        },
        confidenceThreshold: ps?.confidenceThreshold ?? ds.confidenceThreshold,
      },
    },
    server: {
      port: partial.server?.port ?? defaults.server.port,
      host: partial.server?.host ?? defaults.server.host,
    },
  };
}
