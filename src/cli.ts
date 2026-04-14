#!/usr/bin/env node
import { readFile, writeFile, copyFile, access, mkdir, unlink } from "node:fs/promises";
import { join, dirname } from "node:path";
import { execSync } from "node:child_process";
import { platform } from "node:os";
import { bootstrap } from "./index.ts";
import { initLogger, getLogDir } from "./utils/logger.ts";
import { getClawmuxConfigPath } from "./config/loader.ts";

const VERSION = process.env.npm_package_version ?? "__CLAWMUX_VERSION__";
const SERVICE_NAME = "clawmux";

const HELP = `Usage: clawmux <command>

Commands:
  init        Detect OpenClaw config, register providers, install system service
  start       Start the proxy server (foreground)
  stop        Stop the system service
  status      Check if ClawMux service is running
  update      Update to the latest version and restart service
  uninstall   Remove system service and OpenClaw providers
  version     Print version
  help        Show this help message

Options:
  --port, -p <port>   Override server port (default: 3456)
  --no-service        Skip system service installation during init

Environment:
  CLAWMUX_PORT            Server port override
  OPENCLAW_CONFIG_PATH    Path to openclaw.json`;

const PROVIDER_KEY = "clawmux";
const PROVIDER_API_FALLBACK = "openai-responses";

function resolveProviderApi(
  mediumModel: string,
  openclawProviders: Record<string, unknown>,
): string {
  const providerName = mediumModel.split("/")[0];
  if (!providerName) return PROVIDER_API_FALLBACK;

  const providerConfig = openclawProviders[providerName] as Record<string, unknown> | undefined;
  const api = providerConfig?.["api"];
  if (typeof api === "string" && api.length > 0) return api;

  return PROVIDER_API_FALLBACK;
}

async function fileExistsLocal(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function detectPackageManager(): "bunx" | "npx" {
  try {
    execSync("which bun", { stdio: "pipe" });
    return "bunx";
  } catch {
    return "npx";
  }
}

function resolveClawmuxBin(): string {
  try {
    const bin = execSync("which clawmux", { encoding: "utf-8" }).trim();
    if (bin.includes("/tmp/") || bin.includes("bunx-") || bin.includes("npx-")) {
      return detectPackageManager() === "bunx" ? "bunx clawmux" : "npx clawmux";
    }
    return bin;
  } catch {
    return detectPackageManager() === "bunx" ? "bunx clawmux" : "npx clawmux";
  }
}

function getHomeDir(): string {
  return process.env.HOME ?? "/root";
}

// ── Service management ─────────────────────────────────

const SYSTEMD_DIR = join(getHomeDir(), ".config", "systemd", "user");
const SYSTEMD_PATH = join(SYSTEMD_DIR, `${SERVICE_NAME}.service`);
const LAUNCHD_DIR = join(getHomeDir(), "Library", "LaunchAgents");
const LAUNCHD_PATH = join(LAUNCHD_DIR, `com.${SERVICE_NAME}.plist`);

function buildSystemdUnit(bin: string, port: string, workDir: string): string {
  return `[Unit]
Description=ClawMux - Smart model routing proxy
After=network.target

[Service]
Type=simple
ExecStart=${bin} start --port ${port}
WorkingDirectory=${workDir}
Restart=on-failure
RestartSec=5
Environment=CLAWMUX_PORT=${port}

[Install]
WantedBy=default.target
`;
}

function buildLaunchdPlist(bin: string, port: string, workDir: string): string {
  const logDir = join(getHomeDir(), ".openclaw", "clawmux");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.${SERVICE_NAME}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${bin}</string>
    <string>start</string>
    <string>--port</string>
    <string>${port}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${workDir}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>CLAWMUX_PORT</key>
    <string>${port}</string>
    <key>PATH</key>
    <string>/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${logDir}/clawmux.log</string>
  <key>StandardErrorPath</key>
  <string>${logDir}/clawmux.err</string>
</dict>
</plist>
`;
}

async function installService(port: string, workDir: string): Promise<void> {
  const bin = resolveClawmuxBin();
  const os = platform();

  if (os === "linux") {
    await mkdir(SYSTEMD_DIR, { recursive: true });
    await writeFile(SYSTEMD_PATH, buildSystemdUnit(bin, port, workDir));

    try {
      execSync("systemctl --user daemon-reload", { stdio: "pipe" });
      execSync(`systemctl --user enable ${SERVICE_NAME}`, { stdio: "pipe" });
      execSync(`systemctl --user start ${SERVICE_NAME}`, { stdio: "pipe" });
      execSync("loginctl enable-linger $(whoami)", { stdio: "pipe" });
      console.log("[info] systemd user service installed and started");
      console.log(`       Service file: ${SYSTEMD_PATH}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[warn] systemd setup failed: ${msg}`);
      console.warn("       You can start manually: clawmux start");
    }
  } else if (os === "darwin") {
    await mkdir(LAUNCHD_DIR, { recursive: true });
    const logDir = join(getHomeDir(), ".openclaw", "clawmux");
    await mkdir(logDir, { recursive: true });
    await writeFile(LAUNCHD_PATH, buildLaunchdPlist(bin, port, workDir));

    try {
      execSync(`launchctl load -w ${LAUNCHD_PATH}`, { stdio: "pipe" });
      console.log("[info] launchd service installed and started");
      console.log(`       Plist file: ${LAUNCHD_PATH}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[warn] launchd setup failed: ${msg}`);
      console.warn("       You can start manually: clawmux start");
    }
  } else {
    console.warn(`[warn] Auto-start not supported on ${os}. Start manually: clawmux start`);
  }
}

function stopService(): void {
  const os = platform();

  if (os === "linux") {
    try {
      execSync(`systemctl --user stop ${SERVICE_NAME}`, { stdio: "pipe" });
      console.log("[info] Service stopped");
    } catch {
      console.log("[info] Service is not running");
    }
  } else if (os === "darwin") {
    try {
      execSync(`launchctl unload ${LAUNCHD_PATH}`, { stdio: "pipe" });
      console.log("[info] Service stopped");
    } catch {
      console.log("[info] Service is not running");
    }
  } else {
    console.error(`[error] Auto-start not supported on ${os}`);
  }
}

function getStatus(): void {
  const os = platform();

  if (os === "linux") {
    try {
      const output = execSync(`systemctl --user is-active ${SERVICE_NAME}`, { encoding: "utf-8" }).trim();
      console.log(`ClawMux service: ${output}`);
    } catch {
      console.log("ClawMux service: inactive");
    }
  } else if (os === "darwin") {
    try {
      const output = execSync(`launchctl list | grep com.${SERVICE_NAME}`, { encoding: "utf-8" }).trim();
      console.log(output ? `ClawMux service: running\n${output}` : "ClawMux service: not loaded");
    } catch {
      console.log("ClawMux service: not loaded");
    }
  } else {
    console.log(`Auto-start not supported on ${os}`);
  }
}

async function removeService(): Promise<void> {
  const os = platform();

  if (os === "linux") {
    try {
      execSync(`systemctl --user stop ${SERVICE_NAME}`, { stdio: "pipe" });
      execSync(`systemctl --user disable ${SERVICE_NAME}`, { stdio: "pipe" });
    } catch (_) { void _; }
    if (await fileExistsLocal(SYSTEMD_PATH)) {
      await unlink(SYSTEMD_PATH);
      execSync("systemctl --user daemon-reload", { stdio: "pipe" });
      console.log("[info] systemd service removed");
    }
  } else if (os === "darwin") {
    try {
      execSync(`launchctl unload ${LAUNCHD_PATH}`, { stdio: "pipe" });
    } catch (_) { void _; }
    if (await fileExistsLocal(LAUNCHD_PATH)) {
      await unlink(LAUNCHD_PATH);
      console.log("[info] launchd plist removed");
    }
  }
}

// ── Update ──────────────────────────────────────────────

async function checkForUpdate(): Promise<void> {
  try {
    const res = await fetch("https://registry.npmjs.org/clawmux/latest", {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return;
    const data = await res.json() as { version?: string };
    const latest = data.version;
    if (!latest || latest === VERSION) return;

    const [curMajor, curMinor, curPatch] = VERSION.split(".").map(Number);
    const [latMajor, latMinor, latPatch] = latest.split(".").map(Number);
    const isNewer =
      latMajor > curMajor ||
      (latMajor === curMajor && latMinor > curMinor) ||
      (latMajor === curMajor && latMinor === curMinor && latPatch > curPatch);

    if (isNewer) {
      console.log(`[clawmux] Update available: ${VERSION} → ${latest}`);
      console.log(`[clawmux] Run 'clawmux update' to upgrade`);
    }
  } catch (_) { void _; }
}

async function update(): Promise<void> {
  const pm = detectPackageManager();
  console.log(`[clawmux] Checking for updates...`);

  try {
    const res = await fetch("https://registry.npmjs.org/clawmux/latest", {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      console.error("[error] Failed to check npm registry");
      process.exit(1);
    }
    const data = await res.json() as { version?: string };
    const latest = data.version;

    if (!latest) {
      console.error("[error] Could not determine latest version");
      process.exit(1);
    }

    if (latest === VERSION) {
      console.log(`[clawmux] Already on latest version (${VERSION})`);
      return;
    }

    console.log(`[clawmux] Updating ${VERSION} → ${latest}...`);

    if (pm === "bunx") {
      execSync("bun pm cache rm clawmux 2>/dev/null; bunx clawmux@latest version", { stdio: "inherit" });
    } else {
      execSync("npx clawmux@latest version", { stdio: "inherit" });
    }

    const os = platform();
    if (os === "linux") {
      try {
        execSync(`systemctl --user restart ${SERVICE_NAME}`, { stdio: "pipe" });
        console.log("[clawmux] Service restarted");
      } catch (_) { void _; }
    } else if (os === "darwin") {
      try {
        execSync(`launchctl unload ${LAUNCHD_PATH}`, { stdio: "pipe" });
        execSync(`launchctl load -w ${LAUNCHD_PATH}`, { stdio: "pipe" });
        console.log("[clawmux] Service restarted");
      } catch (_) { void _; }
    }

    console.log(`[clawmux] Updated to ${latest}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[error] Update failed: ${msg}`);
    process.exit(1);
  }
}

// ── Commands ────────────────────────────────────────────

async function init(): Promise<void> {
  const args = process.argv.slice(2);
  const noService = args.includes("--no-service");

  const homeDir = getHomeDir();
  const openclawConfigPath = process.env.OPENCLAW_CONFIG_PATH ?? join(homeDir, ".openclaw", "openclaw.json");

  if (!(await fileExistsLocal(openclawConfigPath))) {
    console.error(`[error] OpenClaw config not found at ${openclawConfigPath}`);
    console.error("Set OPENCLAW_CONFIG_PATH or ensure ~/.openclaw/openclaw.json exists");
    process.exit(1);
  }

  console.log(`[info] Using OpenClaw config: ${openclawConfigPath}`);

  const backupPath = `${openclawConfigPath}.bak.${Date.now()}`;
  await copyFile(openclawConfigPath, backupPath);
  console.log(`[info] Backup created: ${backupPath}`);

  const clawmuxJsonPath = getClawmuxConfigPath();
  const examplePath = join(process.cwd(), "clawmux.example.json");

  console.log(`[info] Using ClawMux config: ${clawmuxJsonPath}`);

  if (!(await fileExistsLocal(clawmuxJsonPath))) {
    if (await fileExistsLocal(examplePath)) {
      await copyFile(examplePath, clawmuxJsonPath);
      console.log("[info] Created clawmux.json from clawmux.example.json");
    } else {
      const defaultConfig = {
        compression: { threshold: 0.75, model: "" },
        routing: { models: { LIGHT: "", MEDIUM: "", HEAVY: "" } },
      };
      await writeFile(clawmuxJsonPath, JSON.stringify(defaultConfig, null, 2) + "\n");
      console.log("[info] Created default clawmux.json (configure models before use)");
    }
  }

  const raw = await readFile(openclawConfigPath, "utf-8");
  const config = JSON.parse(raw) as Record<string, unknown>;

  if (!config.models) config.models = {};
  const models = config.models as Record<string, unknown>;
  if (!models.providers) models.providers = {};
  const providers = models.providers as Record<string, unknown>;

  let providerApi = PROVIDER_API_FALLBACK;
  try {
    const clawmuxRaw = await readFile(clawmuxJsonPath, "utf-8");
    const clawmuxConfig = JSON.parse(clawmuxRaw) as Record<string, unknown>;
    const routing = clawmuxConfig["routing"] as Record<string, unknown> | undefined;
    const routingModels = routing?.["models"] as Record<string, unknown> | undefined;
    const mediumModel = routingModels?.["MEDIUM"];
    if (typeof mediumModel === "string" && mediumModel.length > 0) {
      providerApi = resolveProviderApi(mediumModel, providers);
      console.log(`[info] MEDIUM model: ${mediumModel} → provider api: ${providerApi}`);
    } else {
      console.log(`[info] MEDIUM model not configured yet, using default api: ${providerApi}`);
    }
  } catch {
    console.log(`[info] clawmux.json not readable, using default api: ${providerApi}`);
  }

  if (providers[PROVIDER_KEY]) {
    const existing = providers[PROVIDER_KEY] as Record<string, unknown>;
    if (existing["api"] !== providerApi) {
      existing["api"] = providerApi;
      await writeFile(openclawConfigPath, JSON.stringify(config, null, 2) + "\n");
      console.log(`  updated ${PROVIDER_KEY} provider api → ${providerApi}`);
    } else {
      console.log(`  skip  ${PROVIDER_KEY} (already exists, api=${providerApi})`);
    }
  } else {
    providers[PROVIDER_KEY] = {
      baseUrl: "http://localhost:3456",
      api: providerApi,
      models: [{ id: "auto", name: "ClawMux Auto Router" }],
    };
    await writeFile(openclawConfigPath, JSON.stringify(config, null, 2) + "\n");
    console.log(`  added ${PROVIDER_KEY} provider to openclaw.json (api=${providerApi})`);
  }

  const port = process.env.CLAWMUX_PORT ?? "3456";

  if (!noService) {
    console.log("");
    await installService(port, process.cwd());
  }

  console.log("\n[info] ClawMux setup complete!");
  console.log("\nNext steps:");
  console.log(`  1. Edit ${clawmuxJsonPath} to configure your models`);
  if (noService) {
    console.log("  2. Run: clawmux start");
  } else {
    console.log("  2. ClawMux is running and will auto-start on boot");
    console.log("     Check status: clawmux status");
  }
  console.log("  3. Ask the user whether to switch agent and session models to clawmux/auto,");
  console.log("     then use the openclaw CLI to apply their choice per agent.");
  console.log("  4. Start chatting: openclaw chat");
}

async function start(): Promise<void> {
  const args = process.argv.slice(2);
  let port = parseInt(process.env.CLAWMUX_PORT ?? "3456", 10);

  const portIdx = args.indexOf("--port") !== -1 ? args.indexOf("--port") : args.indexOf("-p");
  if (portIdx !== -1 && args[portIdx + 1]) {
    port = parseInt(args[portIdx + 1], 10);
  }

  initLogger();
  await bootstrap(port);
  console.log(`[clawmux] Logs: ${getLogDir()}`);
  checkForUpdate();
}

async function uninstall(): Promise<void> {
  await removeService();

  const homeDir = getHomeDir();
  const openclawConfigPath = process.env.OPENCLAW_CONFIG_PATH ?? join(homeDir, ".openclaw", "openclaw.json");

  if (await fileExistsLocal(openclawConfigPath)) {
    const backupPath = `${openclawConfigPath}.bak.${Date.now()}`;
    await copyFile(openclawConfigPath, backupPath);

    const raw = await readFile(openclawConfigPath, "utf-8");
    const config = JSON.parse(raw) as Record<string, unknown>;
    const models = (config.models ?? {}) as Record<string, unknown>;
    const providers = (models.providers ?? {}) as Record<string, unknown>;

    let removed = 0;
    for (const key of Object.keys(providers)) {
      if (key === "clawmux" || key.startsWith("clawmux-")) {
        delete providers[key];
        removed++;
      }
    }

    if (removed > 0) {
      await writeFile(openclawConfigPath, JSON.stringify(config, null, 2) + "\n");
      console.log(`[info] Removed ${removed} ClawMux provider(s) from openclaw.json`);
    }
  }

  const clawmuxDir = join(homeDir, ".openclaw", "clawmux");
  if (await fileExistsLocal(clawmuxDir)) {
    const { rm } = await import("node:fs/promises");
    await rm(clawmuxDir, { recursive: true, force: true });
    console.log("[info] Removed ~/.openclaw/clawmux (config and logs)");
  }

  console.log("[info] ClawMux uninstalled");
}

// ── Entry ───────────────────────────────────────────────

const command = process.argv[2];

switch (command) {
  case "init":
    init().catch((err: Error) => {
      console.error(`[error] ${err.message}`);
      process.exit(1);
    });
    break;
  case "start":
    start().catch((err: Error) => {
      console.error(`[error] ${err.message}`);
      process.exit(1);
    });
    break;
  case "stop":
    stopService();
    break;
  case "status":
    getStatus();
    break;
  case "update":
    update().catch((err: Error) => {
      console.error(`[error] ${err.message}`);
      process.exit(1);
    });
    break;
  case "uninstall":
    uninstall().catch((err: Error) => {
      console.error(`[error] ${err.message}`);
      process.exit(1);
    });
    break;
  case "version":
  case "--version":
  case "-v":
    console.log(VERSION);
    break;
  case "help":
  case "--help":
  case "-h":
  case undefined:
    console.log(HELP);
    break;
  default:
    console.error(`Unknown command: ${command}\n`);
    console.log(HELP);
    process.exit(1);
}
