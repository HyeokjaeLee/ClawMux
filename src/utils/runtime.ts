import { readFile, access } from "node:fs/promises";

export const isBun = typeof globalThis.Bun !== "undefined";

export async function readFileText(path: string): Promise<string> {
  if (isBun) {
    const bun = (globalThis as Record<string, unknown>).Bun as Record<string, Function>;
    return (bun.file(path) as { text(): Promise<string> }).text();
  }
  return readFile(path, "utf-8");
}

export async function fileExists(path: string): Promise<boolean> {
  if (isBun) {
    const bun = (globalThis as Record<string, unknown>).Bun as Record<string, Function>;
    return (bun.file(path) as { exists(): Promise<boolean> }).exists();
  }
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
