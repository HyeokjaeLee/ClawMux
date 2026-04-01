import { describe, expect, it, afterEach, spyOn, mock } from "bun:test";
import { writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createConfigWatcher } from "./watcher.ts";
import type { ClawMuxConfig } from "./types.ts";

const VALID_CONFIG: ClawMuxConfig = {
  compression: { threshold: 0.75, model: "claude-3-5-haiku-20241022" },
  routing: {
    models: {
      LIGHT: "claude-3-5-haiku-20241022",
      MEDIUM: "claude-sonnet-4-20250514",
      HEAVY: "claude-opus-4-20250514",
    },
  },
};

function tempConfigPath(): string {
  return join(tmpdir(), `clawmux-watch-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
}

async function writeConfig(path: string, config: unknown): Promise<void> {
  await writeFile(path, JSON.stringify(config, null, 2), "utf-8");
}

describe("createConfigWatcher", () => {
  let configPath: string;
  let watcher: ReturnType<typeof createConfigWatcher>;
  let consoleWarnSpy: ReturnType<typeof spyOn>;

  afterEach(async () => {
    watcher?.stop();

    try { await unlink(configPath); } catch {}

    if (consoleWarnSpy) {
      consoleWarnSpy.mockRestore();
      consoleWarnSpy = null;
    }
  });

  it("calls onReload when config file is modified", async () => {
    configPath = tempConfigPath();
    await writeConfig(configPath, VALID_CONFIG);

    const onReload = mock<(config: ClawMuxConfig) => void>(() => {});
    watcher = createConfigWatcher(configPath, onReload, { debounceMs: 50 });
    watcher.start();

    await writeConfig(configPath, {
      ...VALID_CONFIG,
      compression: { ...VALID_CONFIG.compression, threshold: 0.5 },
    });

    await Bun.sleep(200);

    expect(onReload).toHaveBeenCalledTimes(1);
    expect(onReload.mock.calls[0][0].compression.threshold).toBe(0.5);
  });

  it("does NOT call onReload when config is invalid", async () => {
    configPath = tempConfigPath();
    await writeConfig(configPath, VALID_CONFIG);

    const onReload = mock<(config: ClawMuxConfig) => void>(() => {});
    consoleWarnSpy = spyOn(console, "warn").mockImplementation(() => {});
    watcher = createConfigWatcher(configPath, onReload, { debounceMs: 50 });
    watcher.start();

    await writeConfig(configPath, { compression: { threshold: 5.0, model: "bad" } });

    await Bun.sleep(200);

    expect(onReload).toHaveBeenCalledTimes(0);
    expect(consoleWarnSpy).toHaveBeenCalledTimes(1);
    expect(consoleWarnSpy.mock.calls[0][0]).toContain("Invalid config change ignored");
  });

  it("debounces rapid changes into a single reload", async () => {
    configPath = tempConfigPath();
    await writeConfig(configPath, VALID_CONFIG);

    const onReload = mock<(config: ClawMuxConfig) => void>(() => {});
    watcher = createConfigWatcher(configPath, onReload, { debounceMs: 100 });
    watcher.start();

    for (let i = 0; i < 5; i++) {
      await writeConfig(configPath, {
        ...VALID_CONFIG,
        compression: { ...VALID_CONFIG.compression, threshold: 0.1 + i * 0.1 },
      });
      await Bun.sleep(10);
    }

    await Bun.sleep(300);

    expect(onReload).toHaveBeenCalledTimes(1);
    expect(onReload.mock.calls[0][0].compression.threshold).toBe(0.5);
  });

  it("stops watching after stop() is called", async () => {
    configPath = tempConfigPath();
    await writeConfig(configPath, VALID_CONFIG);

    const onReload = mock<(config: ClawMuxConfig) => void>(() => {});
    watcher = createConfigWatcher(configPath, onReload, { debounceMs: 50 });
    watcher.start();
    watcher.stop();

    await writeConfig(configPath, {
      ...VALID_CONFIG,
      compression: { ...VALID_CONFIG.compression, threshold: 0.3 },
    });

    await Bun.sleep(200);

    expect(onReload).toHaveBeenCalledTimes(0);
    expect(watcher.isWatching()).toBe(false);
  });

  it("isWatching returns true after start and false after stop", async () => {
    configPath = tempConfigPath();
    await writeConfig(configPath, VALID_CONFIG);
    watcher = createConfigWatcher(configPath, () => {});

    expect(watcher.isWatching()).toBe(false);
    watcher.start();
    expect(watcher.isWatching()).toBe(true);
    watcher.stop();
    expect(watcher.isWatching()).toBe(false);
  });
});
