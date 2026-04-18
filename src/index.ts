import { createServer } from "./proxy/server.ts";
import { loadConfig, getClawmuxConfigPath } from "./config/loader.ts";
import { createConfigWatcher } from "./config/watcher.ts";
import { readOpenClawConfig, readAuthProfiles } from "./openclaw/config-reader.ts";
import { loadPiAiCatalog } from "./openclaw/model-limits.ts";
import { setupPipelineRoutes, createResolvedCompressionMiddleware } from "./proxy/pipeline.ts";
import { clearCustomHandlers } from "./proxy/router.ts";

export async function bootstrap(portOverride?: number): Promise<void> {
  const configPath = getClawmuxConfigPath();

  const result = await loadConfig(configPath);
  if (!result.valid) {
    console.error("[clawmux] Config errors:");
    for (const err of result.errors) console.error(`  - ${err}`);
    process.exit(1);
  }

  const config = result.config;
  const openclawConfig = await readOpenClawConfig();
  const authProfiles = await readAuthProfiles();
  const piAiCatalog = await loadPiAiCatalog();

  const compressionMiddleware = createResolvedCompressionMiddleware(config, openclawConfig, authProfiles, piAiCatalog);
  setupPipelineRoutes(config, openclawConfig, authProfiles, compressionMiddleware);

  const port = portOverride ?? parseInt(process.env.CLAWMUX_PORT ?? "3456", 10);
  const server = createServer({ port, host: "127.0.0.1" });
  server.start();
  console.log(`[clawmux] Proxy server running on http://127.0.0.1:${port}`);

  const watcher = createConfigWatcher(configPath, (newConfig) => {
    console.log("[clawmux] Config reloaded, updating routes...");
    clearCustomHandlers();
    const newCompression = createResolvedCompressionMiddleware(newConfig, openclawConfig, authProfiles, piAiCatalog);
    setupPipelineRoutes(newConfig, openclawConfig, authProfiles, newCompression);
  });
  watcher.start();
}

if (require.main === module || (typeof Bun !== "undefined" && Bun.main === import.meta.path)) {
  bootstrap().catch((err: Error) => {
    console.error(`[clawmux] Fatal: ${err.message}`);
    process.exit(1);
  });
}
