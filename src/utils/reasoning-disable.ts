/**
 * Injects reasoning/thinking disable parameters into a raw request body
 * based on the API format type. Used by the classifier to get fast responses
 * from small models without reasoning overhead.
 *
 * Non-reasoning models ignore these parameters, so injection is always safe.
 */
export function withReasoningDisabled(
  rawBody: Record<string, unknown>,
  apiType: string,
): Record<string, unknown> {
  switch (apiType) {
    case "openai-completions":
      // reasoning_effort: "none" disables reasoning for GPT-5+ / o-series models.
      // Values: none, low, medium, high. Non-reasoning models (gpt-4o-mini) ignore this.
      return { ...rawBody, reasoning_effort: "none" };

    case "openai-responses":
      // reasoning.effort: "none" for Responses API.
      // Values: none, minimal, low, medium, high, xhigh.
      return { ...rawBody, reasoning: { effort: "none" } };

    case "anthropic-messages":
      // thinking is OFF by default — omitting the parameter is sufficient.
      // Supported on: Claude Opus 4-4.6, Sonnet 4-4.6, Haiku 4.5, 3.7 Sonnet.
      // Claude 3.5 Haiku and earlier do NOT support thinking at all.
      return rawBody;

    case "google-generative-ai":
      // thinkingBudget: 0 disables thinking for Gemini 2.5+ models.
      // -1 = dynamic (model decides), 0 = off, 1024+ = specific budget.
      // Models before Gemini 2.5 (e.g., gemini-2.0-flash-lite) don't support
      // thinking and ignore this parameter.
      return {
        ...rawBody,
        generationConfig: {
          ...(typeof rawBody.generationConfig === "object" && rawBody.generationConfig !== null
            ? rawBody.generationConfig as Record<string, unknown>
            : {}),
          thinkingConfig: { thinkingBudget: 0 },
        },
      };

    case "ollama":
      // think: false disables thinking for models like Qwen3, Gemma 4, DeepSeek-R1.
      // Non-thinking models (llama-3.1-8b, etc.) ignore this parameter.
      return { ...rawBody, think: false };

    case "bedrock-converse-stream":
      // Bedrock Converse API: thinking is not enabled by default.
      // Only enabled via additionalModelRequestFields.thinking — omitting is sufficient.
      // Claude Haiku on Bedrock does NOT support thinking.
      return rawBody;

    default:
      return rawBody;
  }
}
