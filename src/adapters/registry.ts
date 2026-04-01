import type { ApiAdapter } from "./types.ts";

const adapters = new Map<string, ApiAdapter>();

export function registerAdapter(adapter: ApiAdapter): void {
  adapters.set(adapter.apiType, adapter);
}

export function getAdapter(apiType: string): ApiAdapter | undefined {
  return adapters.get(apiType);
}

export function getAllAdapters(): ApiAdapter[] {
  return [...adapters.values()];
}
