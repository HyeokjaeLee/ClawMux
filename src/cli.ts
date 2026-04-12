#!/usr/bin/env node
import { readFile, writeFile, copyFile, access } from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "./proxy/server.ts";

const VERSION = process.env.npm_package_version ?? "0.1.0";

const HELP = `Usage: clawmux <command>

Commands:
  init      Detect OpenClaw config, create clawmux.json, register providers
  start     Start the proxy server (foreground)
  version   Print version
  help      Show this help message

Options:
  --port, -p <port>   Override server port (default: 3456)

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

async function init(): Promise<void> {
  const homeDir = process.env.HOME ?? "/root";
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

  console.log("\n[info] ClawMux provider registration complete!");
  console.log("\nNext steps:");
  console.log("  1. Edit clawmux.json to configure your models");
  console.log("  2. Run: clawmux start");
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
