import { watch, type FSWatcher } from "node:fs";
import { readFile } from "node:fs/promises";
import { validateConfig } from "./validator.ts";
import type { ClawMuxConfig } from "./types.ts";

export interface ConfigWatcher {
  start(): void;
  stop(): void;
  isWatching(): boolean;
}

export interface ConfigWatcherOptions {
  debounceMs?: number;
}

export function createConfigWatcher(
  configPath: string,
  onReload: (config: ClawMuxConfig) => void,
  options?: ConfigWatcherOptions,
): ConfigWatcher {
  const debounceMs = options?.debounceMs ?? 2000;

  let watcher: FSWatcher | null = null;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let reloading = false;
  let pendingReload = false;

  async function reloadConfig(): Promise<void> {
    if (reloading) {
      pendingReload = true;
      return;
    }

    reloading = true;

    try {
      let raw: string;
      try {
        raw = await readFile(configPath, "utf-8");
      } catch {
        console.warn(`[config] Config file ${configPath} not found, keeping old config`);
        return;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[config] Invalid JSON in config change, ignored: ${message}`);
        return;
      }

      const result = validateConfig(parsed);
      if (result.valid) {
        onReload(result.config);
        console.log("[config] Reloaded clawmux.json");
      } else {
        console.warn(`[config] Invalid config change ignored: ${result.errors.join(", ")}`);
      }
    } finally {
      reloading = false;

      if (pendingReload) {
        pendingReload = false;
        // Schedule next reload immediately via debounce to coalesce further changes
        scheduleReload();
      }
    }
  }

  function scheduleReload(): void {
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      reloadConfig();
    }, debounceMs);
  }

  return {
    start(): void {
      if (watcher !== null) return;

      watcher = watch(configPath, (eventType) => {
        if (eventType === "rename") {
          console.warn(`[config] Config file ${configPath} was deleted, keeping old config`);
          return;
        }
        scheduleReload();
      });

      watcher.on("error", (err) => {
        console.warn(`[config] Watcher error: ${err instanceof Error ? err.message : String(err)}`);
      });
    },

    stop(): void {
      if (debounceTimer !== null) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      if (watcher !== null) {
        watcher.close();
        watcher = null;
      }
    },

    isWatching(): boolean {
      return watcher !== null;
    },
  };
}
