#!/usr/bin/env node
import { readFile, writeFile, copyFile, access, mkdir, unlink } from "node:fs/promises";
import { join, dirname } from "node:path";
import { execSync } from "node:child_process";
import { platform } from "node:os";
import { createServer } from "./proxy/server.ts";

const VERSION = process.env.npm_package_version ?? "0.1.0";
const SERVICE_NAME = "clawmux";

const HELP = `Usage: clawmux <command>

Commands:
  init        Detect OpenClaw config, register providers, install system service
  start       Start the proxy server (foreground)
  stop        Stop the system service
  status      Check if ClawMux service is running
  uninstall   Remove system service and OpenClaw providers
  version     Print version
  help        Show this help message

Options:
  --port, -p <port>   Override server port (default: 3456)
  --no-service        Skip system service installation during init

Environment:
  CLAWMUX_PORT            Server port override
  OPENCLAW_CONFIG_PATH    Path to openclaw.json`;

const PROVIDERS = [
  { key: "clawmux-anthropic", api: "anthropic-messages" },
  { key: "clawmux-openai", api: "openai-completions" },
  { key: "clawmux-openai-responses", api: "openai-responses" },
  { key: "clawmux-google", api: "google-generative-ai" },
  { key: "clawmux-ollama", api: "ollama" },
  { key: "clawmux-bedrock", api: "bedrock-converse-stream" },
];

async function fileExistsLocal(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function resolveClawmuxBin(): string {
  try {
    return execSync("which clawmux", { encoding: "utf-8" }).trim();
  } catch {
    return "npx clawmux";
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
  const logDir = join(getHomeDir(), ".local", "log");
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
    const logDir = join(getHomeDir(), ".local", "log");
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

  const clawmuxJsonPath = join(process.cwd(), "clawmux.json");
  const examplePath = join(process.cwd(), "clawmux.example.json");

  if (!(await fileExistsLocal(clawmuxJsonPath))) {
    if (await fileExistsLocal(examplePath)) {
      await copyFile(examplePath, clawmuxJsonPath);
      console.log("[info] Created clawmux.json from clawmux.example.json");
    } else {
      console.warn("[warn] clawmux.json not found and no clawmux.example.json to copy from");
    }
  }

  const raw = await readFile(openclawConfigPath, "utf-8");
  const config = JSON.parse(raw) as Record<string, unknown>;

  if (!config.models) config.models = {};
  const models = config.models as Record<string, unknown>;
  if (!models.providers) models.providers = {};
  const providers = models.providers as Record<string, unknown>;

  let added = 0;
  for (const { key, api } of PROVIDERS) {
    if (providers[key]) {
      console.log(`  skip  ${key} (already exists)`);
      continue;
    }
    providers[key] = {
      baseUrl: "http://localhost:3456",
      api,
      models: [{ id: "auto", name: "ClawMux Auto Router" }],
    };
    added++;
    console.log(`  added ${key}`);
  }

  if (added > 0) {
    await writeFile(openclawConfigPath, JSON.stringify(config, null, 2) + "\n");
    console.log(`\nAdded ${added} provider(s) to openclaw.json`);
  } else {
    console.log("\nAll ClawMux providers already registered.");
  }

  const port = process.env.CLAWMUX_PORT ?? "3456";

  if (!noService) {
    console.log("");
    await installService(port, process.cwd());
  }

  console.log("\n[info] ClawMux setup complete!");
  console.log("\nNext steps:");
  console.log("  1. Edit clawmux.json to configure your models");
  if (noService) {
    console.log("  2. Run: clawmux start");
  } else {
    console.log("  2. ClawMux is running and will auto-start on boot");
    console.log("     Check status: clawmux status");
  }
  console.log("  3. Select a provider: openclaw provider clawmux-openai");
  console.log("  4. Start chatting: openclaw chat");
}

function start(): void {
  const args = process.argv.slice(2);
  let port = parseInt(process.env.CLAWMUX_PORT ?? "3456", 10);

  const portIdx = args.indexOf("--port") !== -1 ? args.indexOf("--port") : args.indexOf("-p");
  if (portIdx !== -1 && args[portIdx + 1]) {
    port = parseInt(args[portIdx + 1], 10);
  }

  const server = createServer({ port, host: "127.0.0.1" });
  server.start();
  console.log(`[clawmux] Proxy server running on http://127.0.0.1:${port}`);
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
      if (key.startsWith("clawmux-")) {
        delete providers[key];
        removed++;
      }
    }

    if (removed > 0) {
      await writeFile(openclawConfigPath, JSON.stringify(config, null, 2) + "\n");
      console.log(`[info] Removed ${removed} ClawMux provider(s) from openclaw.json`);
    }
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
    start();
    break;
  case "stop":
    stopService();
    break;
  case "status":
    getStatus();
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
