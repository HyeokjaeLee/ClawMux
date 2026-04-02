export interface ClawMuxConfig {
  compression: {
    /** Range: 0.1–0.95 */
    threshold: number;
    model: string;
    /** Range: 0.2–0.9 */
    targetRatio?: number;
  };
  routing: {
    models: {
      LIGHT: string;
      MEDIUM: string;
      HEAVY: string;
    };
    /** Per-model context window overrides, e.g. { "zai/glm-5": 204800 } */
    contextWindows?: Record<string, number>;
    classifier?: {
      /** Model to use for classification. Defaults to routing.models.LIGHT */
      model?: string;
      /** Timeout in ms for classification API call. Range: 500–10000. Default: 3000 */
      timeoutMs?: number;
      /** Number of previous messages to include when Q (needs context) is returned. Default: 10 */
      contextMessages?: number;
    };
    scoring?: {
      weights?: Record<string, number>;
      boundaries?: { lightMedium: number; mediumHeavy: number };
      /** Range: 0.0–1.0 */
      confidenceThreshold?: number;
    };
  };
  server?: {
    /** Range: 1024–65535 */
    port?: number;
    host?: string;
  };
}

export interface ValidationResult {
  valid: true;
  config: ClawMuxConfig;
}

export interface ValidationFailure {
  valid: false;
  errors: string[];
}

export type ValidationResultUnion = ValidationResult | ValidationFailure;
