import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { describe, test, expect, afterEach } from "bun:test";
import { readOpenClawConfig, readAuthProfiles, resolveEnvVar, getProviderConfig } from "./config-reader.js";
import { resolveApiKey } from "./auth-resolver.js";
import type { OpenClawConfig, AuthProfile } from "./types.js";

describe("resolveEnvVar", () => {
  test("returns literal value when not an env var reference", () => {
    expect(resolveEnvVar("sk-ant-123")).toBe("sk-ant-123");
  });

  test("resolves ${VAR_NAME} pattern from process.env", () => {
    process.env.__CLAWMUX_TEST_VAR = "resolved-value";
    expect(resolveEnvVar("${__CLAWMUX_TEST_VAR}")).toBe("resolved-value");
    delete process.env.__CLAWMUX_TEST_VAR;
  });

  test("returns empty string for undefined env var", () => {
    expect(resolveEnvVar("${__CLAWMUX_NONEXISTENT_VAR_12345}")).toBe("");
  });
});

describe("readOpenClawConfig", () => {
  let tempDir: string;

  afterEach(async () => {
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  });

  test("reads and parses openclaw.json with 2 providers", async () => {
    tempDir = await mkdtemp(`${tmpdir()}/clawmux-test-`);
    const configPath = `${tempDir}/openclaw.json`;
    const config = {
      models: {
        mode: "merge",
        providers: {
          anthropic: {
            api: "anthropic-messages",
            models: [{ id: "claude-sonnet-4-20250514", contextWindow: 200000 }],
          },
          openai: {
            api: "openai-completions",
            apiKey: "${OPENAI_API_KEY}",
            models: [{ id: "gpt-4o", contextWindow: 128000 }],
          },
        },
      },
    };
    await writeFile(configPath, JSON.stringify(config, null, 2));

    const result = await readOpenClawConfig(configPath);
    expect(result.models?.mode).toBe("merge");
    expect(Object.keys(result.models?.providers ?? {})).toEqual(["anthropic", "openai"]);
    expect(result.models?.providers?.anthropic?.api).toBe("anthropic-messages");
    expect(result.models?.providers?.openai?.models?.[0]?.id).toBe("gpt-4o");
  });

  test("throws descriptive error when file not found", async () => {
    await expect(readOpenClawConfig("/tmp/clawmux-test-nonexistent-xyz/openclaw.json")).rejects.toThrow(
      /openclaw\.json not found at .+\. Ensure OpenClaw is installed\./,
    );
  });

  test("throws error for invalid JSON", async () => {
    tempDir = await mkdtemp(`${tmpdir()}/clawmux-test-`);
    const configPath = `${tempDir}/openclaw.json`;
    await writeFile(configPath, "{ invalid json }");

    await expect(readOpenClawConfig(configPath)).rejects.toThrow(/Failed to parse openclaw\.json/);
  });

  test("returns empty config for minimal JSON", async () => {
    tempDir = await mkdtemp(`${tmpdir()}/clawmux-test-`);
    const configPath = `${tempDir}/openclaw.json`;
    await writeFile(configPath, "{}");

    const result = await readOpenClawConfig(configPath);
    expect(result).toEqual({});
  });
});

describe("readAuthProfiles", () => {
  let tempDir: string;
  let isolatedAgentsDir: string;

  afterEach(async () => {
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  });

  test("returns empty array when no profiles found", async () => {
    isolatedAgentsDir = await mkdtemp(`${tmpdir()}/clawmux-agents-`);
    const result = await readAuthProfiles("main", undefined, isolatedAgentsDir);
    expect(result).toEqual([]);
  });

  test("reads auth profiles from agent directory", async () => {
    isolatedAgentsDir = await mkdtemp(`${tmpdir()}/clawmux-agents-`);
    const agentDir = `${isolatedAgentsDir}/main/agent`;
    const { mkdir } = await import("node:fs/promises");
    await mkdir(agentDir, { recursive: true });
    const profiles = [
      { provider: "anthropic", apiKey: "sk-ant-from-profile" },
      { provider: "openai", token: "sk-oai-from-profile" },
    ];
    await writeFile(`${agentDir}/auth-profiles.json`, JSON.stringify(profiles));

    const result = await readAuthProfiles(undefined, undefined, isolatedAgentsDir);
    expect(result).toHaveLength(2);
    expect(result[0].provider).toBe("anthropic");
    expect(result[0].apiKey).toBe("sk-ant-from-profile");
    expect(result[1].token).toBe("sk-oai-from-profile");
  });
});

describe("getProviderConfig", () => {
  test("returns provider config when found", () => {
    const config: OpenClawConfig = {
      models: {
        providers: {
          anthropic: { api: "anthropic-messages" },
        },
      },
    };

    const result = getProviderConfig("anthropic", config);
    expect(result?.api).toBe("anthropic-messages");
  });

  test("returns undefined for missing provider", () => {
    const result = getProviderConfig("nonexistent", {});
    expect(result).toBeUndefined();
  });
});

describe("resolveApiKey", () => {
  test("resolves from auth profile apiKey", () => {
    const config: OpenClawConfig = {
      models: {
        providers: {
          anthropic: { api: "anthropic-messages" },
        },
      },
    };
    const profiles: AuthProfile[] = [
      { provider: "anthropic", apiKey: "sk-ant-profile-key" },
    ];

    const result = resolveApiKey("anthropic", config, profiles);
    expect(result).toBeDefined();
    expect(result?.apiKey).toBe("sk-ant-profile-key");
    expect(result?.headerName).toBe("x-api-key");
    expect(result?.headerValue).toBe("sk-ant-profile-key");
  });

  test("resolves from auth profile token", () => {
    const config: OpenClawConfig = {
      models: {
        providers: {
          openai: { api: "openai-completions" },
        },
      },
    };
    const profiles: AuthProfile[] = [
      { provider: "openai", token: "sk-oai-token" },
    ];

    const result = resolveApiKey("openai", config, profiles);
    expect(result).toBeDefined();
    expect(result?.apiKey).toBe("sk-oai-token");
    expect(result?.headerName).toBe("Authorization");
    expect(result?.headerValue).toBe("Bearer sk-oai-token");
  });

  test("resolves ${ENV_VAR} reference from provider config", () => {
    process.env.__CLAWMUX_ANTHROPIC_KEY = "sk-ant-env-resolved";
    const config: OpenClawConfig = {
      models: {
        providers: {
          anthropic: { api: "anthropic-messages", apiKey: "${__CLAWMUX_ANTHROPIC_KEY}" },
        },
      },
    };

    const result = resolveApiKey("anthropic", config, []);
    expect(result?.apiKey).toBe("sk-ant-env-resolved");
    delete process.env.__CLAWMUX_ANTHROPIC_KEY;
  });

  test("falls back to env var for provider name", () => {
    process.env.__CLAWMUX_ANTHROPIC_KEY = "sk-ant-env-fallback";
    const prevKey = process.env["ANTHROPIC_API_KEY"];
    process.env["ANTHROPIC_API_KEY"] = "sk-ant-env-fallback";
    const config: OpenClawConfig = {
      models: {
        providers: {
          anthropic: { api: "anthropic-messages" },
        },
      },
    };

    const result = resolveApiKey("anthropic", config, []);
    expect(result?.apiKey).toBe("sk-ant-env-fallback");

    if (prevKey === undefined) delete process.env["ANTHROPIC_API_KEY"];
    else process.env["ANTHROPIC_API_KEY"] = prevKey;
  });

  test("returns undefined when no key found", () => {
    const config: OpenClawConfig = {
      models: {
        providers: {
          unknownProvider: { api: "anthropic-messages" },
        },
      },
    };

    const result = resolveApiKey("unknownProvider", config, []);
    expect(result).toBeUndefined();
  });

  test("anthropic header format: x-api-key", () => {
    const config: OpenClawConfig = {
      models: {
        providers: {
          anthropic: { api: "anthropic-messages", apiKey: "sk-ant-123" },
        },
      },
    };

    const result = resolveApiKey("anthropic", config, []);
    expect(result?.headerName).toBe("x-api-key");
    expect(result?.headerValue).toBe("sk-ant-123");
  });

  test("openai header format: Authorization Bearer", () => {
    const config: OpenClawConfig = {
      models: {
        providers: {
          openai: { api: "openai-completions", apiKey: "sk-oai-123" },
        },
      },
    };

    const result = resolveApiKey("openai", config, []);
    expect(result?.headerName).toBe("Authorization");
    expect(result?.headerValue).toBe("Bearer sk-oai-123");
  });

  test("google header format: x-goog-api-key", () => {
    const config: OpenClawConfig = {
      models: {
        providers: {
          google: { api: "google-generative-ai", apiKey: "goog-key-123" },
        },
      },
    };

    const result = resolveApiKey("google", config, []);
    expect(result?.headerName).toBe("x-goog-api-key");
    expect(result?.headerValue).toBe("goog-key-123");
  });

  test("ollama returns synthetic placeholder", () => {
    const config: OpenClawConfig = {
      models: {
        providers: {
          ollama: { api: "ollama" },
        },
      },
    };

    const result = resolveApiKey("ollama", config, []);
    expect(result?.apiKey).toBe("ollama-local");
    expect(result?.headerName).toBe("");
    expect(result?.headerValue).toBe("");
  });

  test("bedrock returns SigV4 credentials", () => {
    const config: OpenClawConfig = {
      models: {
        providers: {
          bedrock: { api: "bedrock-converse-stream", apiKey: "AKIDEXAMPLE" },
        },
      },
    };

    const result = resolveApiKey("bedrock", config, []);
    expect(result?.apiKey).toBe("AKIDEXAMPLE");
    expect(result?.headerName).toBe("Authorization");
    expect(result?.headerValue).toBe("");
    expect(result?.awsAccessKeyId).toBe("AKIDEXAMPLE");
    expect(result?.awsRegion).toBe("us-east-1");
  });

  test("auth profile takes priority over provider config apiKey", () => {
    const config: OpenClawConfig = {
      models: {
        providers: {
          anthropic: { api: "anthropic-messages", apiKey: "sk-ant-config" },
        },
      },
    };
    const profiles: AuthProfile[] = [
      { provider: "anthropic", apiKey: "sk-ant-profile" },
    ];

    const result = resolveApiKey("anthropic", config, profiles);
    expect(result?.apiKey).toBe("sk-ant-profile");
  });

  test("provider config apiKey takes priority over env var", () => {
    process.env.__CLAWMUX_ANTHROPIC_KEY = "sk-ant-env";
    const prevKey = process.env["ANTHROPIC_API_KEY"];
    process.env["ANTHROPIC_API_KEY"] = "sk-ant-env";
    const config: OpenClawConfig = {
      models: {
        providers: {
          anthropic: { api: "anthropic-messages", apiKey: "sk-ant-config" },
        },
      },
    };

    const result = resolveApiKey("anthropic", config, []);
    expect(result?.apiKey).toBe("sk-ant-config");

    delete process.env.__CLAWMUX_ANTHROPIC_KEY;
    if (prevKey === undefined) delete process.env["ANTHROPIC_API_KEY"];
    else process.env["ANTHROPIC_API_KEY"] = prevKey;
  });
});
