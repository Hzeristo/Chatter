import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ConfigError, loadConfig, requireApiKey } from "./config.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "mas-chat-config-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("CLI configuration", () => {
  it("uses .env before process environment and resolves relative data paths", async () => {
    const cwd = await temporaryDirectory();
    await writeFile(
      path.join(cwd, ".env"),
      [
        "OPENAI_API_KEY=file-key",
        "OPENAI_BASE_URL=http://localhost:8080/v1/",
        "MAS_CHAT_MODEL=file-model",
        "MAS_CHAT_DATA_DIR=state",
        "MAS_CHAT_WEB_SEARCH=false",
        "MAS_CHAT_CODE_INTERPRETER=yes",
      ].join("\n"),
      "utf8",
    );

    const config = loadConfig({
      cwd,
      env: {
        OPENAI_API_KEY: "environment-key",
        OPENAI_BASE_URL: "https://api.openai.com/v1",
        MAS_CHAT_MODEL: "environment-model",
      },
    });

    expect(config).toMatchObject({
      apiKey: "file-key",
      apiKeySource: ".env",
      baseURL: "http://localhost:8080/v1",
      model: "file-model",
      webSearch: false,
      codeInterpreter: true,
      backgroundFallback: "on_unsupported",
      envFileLoaded: true,
    });
    expect(config.dataDirectory).toBe(path.join(cwd, "state"));
  });

  it("falls back to environment and then safe defaults", async () => {
    const cwd = await temporaryDirectory();
    const config = loadConfig({
      cwd,
      env: { OPENAI_API_KEY: "environment-key" },
    });

    expect(config.apiKeySource).toBe("environment");
    expect(config.baseURL).toBe("https://api.openai.com/v1");
    expect(config.model).toBe("gpt-6-astra");
    expect(config.reasoningEffort).toBe("max");
    expect(config.dataDirectory).toBe(path.join(cwd, ".chat-runtime"));
  });

  it("lets an explicit empty .env value mask the process API key", async () => {
    const cwd = await temporaryDirectory();
    await writeFile(path.join(cwd, ".env"), "OPENAI_API_KEY=\n", "utf8");

    const config = loadConfig({
      cwd,
      env: { OPENAI_API_KEY: "environment-key" },
    });

    expect(config.apiKey).toBeUndefined();
    expect(config.apiKeySource).toBe("missing");
    expect(() => requireApiKey(config)).toThrow(ConfigError);
  });

  it("reports invalid URLs, enums, booleans, and missing keys", async () => {
    const cwd = await temporaryDirectory();
    expect(() =>
      loadConfig({ cwd, env: { OPENAI_BASE_URL: "not-a-url" } }),
    ).toThrow(ConfigError);
    expect(() =>
      loadConfig({ cwd, env: { MAS_CHAT_REASONING_EFFORT: "infinite" } }),
    ).toThrow(ConfigError);
    expect(() =>
      loadConfig({ cwd, env: { MAS_CHAT_WEB_SEARCH: "sometimes" } }),
    ).toThrow(ConfigError);
    expect(() => requireApiKey(loadConfig({ cwd, env: {} }))).toThrow(
      ConfigError,
    );
  });
});
