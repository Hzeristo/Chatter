import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";

import { DEFAULT_DEVELOPER_PROMPT } from "@mas-chat/runtime";
import type {
  BackgroundFallbackPolicy,
  StartRunOptions,
} from "@mas-chat/runtime";

export type ReasoningEffort =
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

export type ReasoningSummary = "auto" | "concise" | "detailed";
export type TextVerbosity = "low" | "medium" | "high";
export type ApiKeySource = ".env" | "environment" | "missing";

export interface MasChatConfig {
  apiKey?: string;
  apiKeySource: ApiKeySource;
  backgroundFallback: BackgroundFallbackPolicy;
  baseURL: string;
  codeInterpreter: boolean;
  dataDirectory: string;
  developerPrompt: string;
  envFileLoaded: boolean;
  envFilePath: string;
  model: string;
  reasoningEffort: ReasoningEffort;
  reasoningSummary: ReasoningSummary;
  textVerbosity: TextVerbosity;
  webSearch: boolean;
}

export interface LoadConfigOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  envFileName?: string;
}

export class ConfigError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ConfigError";
  }
}

function definedEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}

function loadDotEnv(filePath: string): Record<string, string> {
  if (!existsSync(filePath)) {
    return {};
  }
  try {
    return definedEnvironment(parseEnv(readFileSync(filePath, "utf8")));
  } catch (error) {
    throw new ConfigError(`Cannot parse ${filePath}`, error);
  }
}

function optionalNonEmpty(
  values: Record<string, string>,
  name: string,
): string | undefined {
  const value = values[name]?.trim();
  return value === undefined || value === "" ? undefined : value;
}

function requiredString(
  values: Record<string, string>,
  name: string,
  fallback: string,
): string {
  const value = values[name] ?? fallback;
  if (value.trim() === "") {
    throw new ConfigError(`${name} must not be empty`);
  }
  return value;
}

function booleanValue(
  values: Record<string, string>,
  name: string,
  fallback: boolean,
): boolean {
  const raw = values[name];
  if (raw === undefined) {
    return fallback;
  }
  switch (raw.trim().toLowerCase()) {
    case "1":
    case "true":
    case "yes":
    case "on":
      return true;
    case "0":
    case "false":
    case "no":
    case "off":
      return false;
    default:
      throw new ConfigError(
        `${name} must be true/false, yes/no, on/off, or 1/0`,
      );
  }
}

function enumValue<const T extends readonly string[]>(
  values: Record<string, string>,
  name: string,
  allowed: T,
  fallback: T[number],
): T[number] {
  const value = values[name]?.trim().toLowerCase() ?? fallback;
  if (!allowed.includes(value)) {
    throw new ConfigError(`${name} must be one of: ${allowed.join(", ")}`);
  }
  return value;
}

function baseUrlValue(values: Record<string, string>): string {
  const value = requiredString(
    values,
    "OPENAI_BASE_URL",
    "https://api.openai.com/v1",
  );
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new ConfigError("OPENAI_BASE_URL must be an absolute URL", error);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ConfigError("OPENAI_BASE_URL must use http or https");
  }
  if (url.username !== "" || url.password !== "") {
    throw new ConfigError("OPENAI_BASE_URL must not contain credentials");
  }
  return value.replace(/\/+$/, "");
}

export function loadConfig(options: LoadConfigOptions = {}): MasChatConfig {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const envFilePath = path.resolve(cwd, options.envFileName ?? ".env");
  const environment = definedEnvironment(options.env ?? process.env);
  const dotEnv = loadDotEnv(envFilePath);

  // This precedence is a deliberate product decision: the static project file
  // overrides machine/process environment values with the same name.
  const values = { ...environment, ...dotEnv };
  const apiKey = optionalNonEmpty(values, "OPENAI_API_KEY");
  const dotEnvDefinesApiKey = Object.hasOwn(dotEnv, "OPENAI_API_KEY");
  const dataDirectoryValue = requiredString(
    values,
    "MAS_CHAT_DATA_DIR",
    ".chat-runtime",
  );
  const config: MasChatConfig = {
    apiKeySource:
      dotEnvDefinesApiKey
        ? apiKey === undefined
          ? "missing"
          : ".env"
        : optionalNonEmpty(environment, "OPENAI_API_KEY") !== undefined
          ? "environment"
          : "missing",
    backgroundFallback: enumValue(
      values,
      "MAS_CHAT_BACKGROUND_FALLBACK",
      ["never", "on_unsupported"] as const,
      "on_unsupported",
    ),
    baseURL: baseUrlValue(values),
    codeInterpreter: booleanValue(
      values,
      "MAS_CHAT_CODE_INTERPRETER",
      false,
    ),
    dataDirectory: path.resolve(cwd, dataDirectoryValue),
    developerPrompt:
      values.MAS_CHAT_DEVELOPER_PROMPT ?? DEFAULT_DEVELOPER_PROMPT,
    envFileLoaded: existsSync(envFilePath),
    envFilePath,
    model: requiredString(values, "MAS_CHAT_MODEL", "gpt-6-astra"),
    reasoningEffort: enumValue(
      values,
      "MAS_CHAT_REASONING_EFFORT",
      ["minimal", "low", "medium", "high", "xhigh", "max"] as const,
      "max",
    ),
    reasoningSummary: enumValue(
      values,
      "MAS_CHAT_REASONING_SUMMARY",
      ["auto", "concise", "detailed"] as const,
      "auto",
    ),
    textVerbosity: enumValue(
      values,
      "MAS_CHAT_TEXT_VERBOSITY",
      ["low", "medium", "high"] as const,
      "medium",
    ),
    webSearch: booleanValue(values, "MAS_CHAT_WEB_SEARCH", true),
  };
  if (apiKey !== undefined) {
    config.apiKey = apiKey;
  }
  return config;
}

export function requireApiKey(config: MasChatConfig): string {
  if (config.apiKey === undefined) {
    throw new ConfigError(
      "OPENAI_API_KEY is not configured in .env or the process environment",
    );
  }
  return config.apiKey;
}

export function requestOptionsFromConfig(
  config: MasChatConfig,
): Omit<StartRunOptions, "sessionId"> {
  return {
    backgroundFallback: config.backgroundFallback,
    model: config.model,
    developerPrompt: config.developerPrompt,
    reasoningEffort: config.reasoningEffort,
    reasoningSummary: config.reasoningSummary,
    textVerbosity: config.textVerbosity,
    enableWebSearch: config.webSearch,
    enableCodeInterpreter: config.codeInterpreter,
  };
}
