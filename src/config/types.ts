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
