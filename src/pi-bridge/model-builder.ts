import type { Api, Model } from "@mariozechner/pi-ai";
import { getModel } from "@mariozechner/pi-ai";
import type { OpenClawConfig, OpenClawProviderConfig } from "../openclaw/types.ts";

const DEFAULT_CONTEXT_TOKENS = 200_000;

export type PiAiModel = Model<Api>;

export function buildPiAiModel(
  providerName: string,
  modelId: string,
  openclawConfig: OpenClawConfig,
): PiAiModel {
  const providerConfig: OpenClawProviderConfig | undefined =
    openclawConfig.models?.providers?.[providerName];

  const inlineModel = providerConfig?.models?.find((m) => m.id === modelId);
  if (inlineModel) {
    return {
      id: inlineModel.id,
      name: inlineModel.name ?? inlineModel.id,
      api: (providerConfig?.api ?? "openai-completions") as Api,
      provider: providerName,
      baseUrl: providerConfig?.baseUrl,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: inlineModel.contextWindow ?? DEFAULT_CONTEXT_TOKENS,
      maxTokens: inlineModel.maxTokens ?? DEFAULT_CONTEXT_TOKENS,
    } as PiAiModel;
  }

  const catalogModel = (getModel as unknown as (p: string, m: string) => PiAiModel | undefined)(
    providerName,
    modelId,
  );
  if (catalogModel) {
    if (providerConfig?.baseUrl) {
      return { ...catalogModel, baseUrl: providerConfig.baseUrl } as PiAiModel;
    }
    return catalogModel as PiAiModel;
  }

  return {
    id: modelId,
    name: modelId,
    api: (providerConfig?.api ?? "openai-responses") as Api,
    provider: providerName,
    baseUrl: providerConfig?.baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: providerConfig?.models?.[0]?.contextWindow ?? DEFAULT_CONTEXT_TOKENS,
    maxTokens: providerConfig?.models?.[0]?.maxTokens ?? DEFAULT_CONTEXT_TOKENS,
  } as PiAiModel;
}
