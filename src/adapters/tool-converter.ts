type AnyTool = Record<string, unknown>;

export function toOpenAITools(tools: unknown): AnyTool[] | undefined {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;

  return tools.map((tool: AnyTool) => {
    if (tool.type === "function" && tool.function) return tool;

    return {
      type: "function",
      function: {
        name: tool.name ?? "",
        description: tool.description ?? "",
        parameters: tool.input_schema ?? tool.parameters ?? { type: "object", properties: {} },
      },
    };
  });
}

export function toResponsesTools(tools: unknown): AnyTool[] | undefined {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;

  return tools.map((tool: AnyTool) => {
    if (tool.type === "function" && tool.name && !tool.function) return tool;

    const fn = (tool.function ?? tool) as AnyTool;
    const parameters = fn.parameters ?? fn.input_schema ?? { type: "object", properties: {} };
    return {
      type: "function",
      name: fn.name ?? "",
      description: fn.description ?? "",
      parameters,
      strict: fn.strict ?? false,
    };
  });
}

export function toCodexResponsesTools(tools: unknown): AnyTool[] | undefined {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;

  return tools.map((tool: AnyTool) => {
    if (tool.type === "function" && tool.name && !tool.function) return tool;

    const fn = (tool.function ?? tool) as AnyTool;
    const parameters = fn.parameters ?? fn.input_schema ?? { type: "object", properties: {} };
    return {
      type: "function",
      name: fn.name ?? "",
      description: fn.description ?? "",
      parameters,
      strict: null,
    };
  });
}

export function toAnthropicTools(tools: unknown): AnyTool[] | undefined {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;

  return tools.map((tool: AnyTool) => {
    if (tool.input_schema && !tool.type) return tool;

    const fn = (tool.function ?? tool) as AnyTool;
    return {
      name: fn.name ?? "",
      description: fn.description ?? "",
      input_schema: fn.parameters ?? { type: "object", properties: {} },
    };
  });
}
