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
    },
    server: {
      port: partial.server?.port ?? defaults.server.port,
      host: partial.server?.host ?? defaults.server.host,
    },
  };
}
