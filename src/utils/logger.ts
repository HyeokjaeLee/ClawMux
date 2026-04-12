import { mkdirSync, readdirSync, unlinkSync, createWriteStream, type WriteStream } from "node:fs";
import { join } from "node:path";

const LOG_DIR = join(process.env.HOME ?? "/root", ".openclaw", "clawmux");
const MAX_DAYS = 7;

let fileStream: WriteStream | null = null;
let currentDate = "";

function todayString(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function logPath(date: string): string {
  return join(LOG_DIR, `${date}.log`);
}

function rotateIfNeeded(): void {
  const today = todayString();
  if (today === currentDate && fileStream) return;

  if (fileStream) {
    fileStream.end();
  }

  currentDate = today;
  fileStream = createWriteStream(logPath(today), { flags: "a" });

  purgeOldLogs();
}

function purgeOldLogs(): void {
  try {
    const files = readdirSync(LOG_DIR).filter((f) => f.endsWith(".log")).sort();
    while (files.length > MAX_DAYS) {
      const oldest = files.shift()!;
      unlinkSync(join(LOG_DIR, oldest));
    }
  } catch (_) { void _; }
}

function formatTimestamp(): string {
  return new Date().toISOString();
}

function writeLine(level: string, args: unknown[]): void {
  rotateIfNeeded();

  const message = args
    .map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
    .join(" ");

  const line = `${formatTimestamp()} [${level}] ${message}\n`;

  if (fileStream) {
    fileStream.write(line);
  }
}

export function initLogger(): void {
  mkdirSync(LOG_DIR, { recursive: true });
  rotateIfNeeded();

  const origLog = console.log.bind(console);
  const origError = console.error.bind(console);
  const origWarn = console.warn.bind(console);

  console.log = (...args: unknown[]) => {
    origLog(...args);
    writeLine("INFO", args);
  };

  console.error = (...args: unknown[]) => {
    origError(...args);
    writeLine("ERROR", args);
  };

  console.warn = (...args: unknown[]) => {
    origWarn(...args);
    writeLine("WARN", args);
  };
}

export function getLogDir(): string {
  return LOG_DIR;
}
