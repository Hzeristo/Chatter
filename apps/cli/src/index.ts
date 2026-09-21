#!/usr/bin/env node

import { randomUUID } from "node:crypto";

import OpenAI from "openai";
import type { ResponseInputItem } from "openai/resources/responses/responses";

import {
  OpenAIResponsesTransport,
  RunController,
  StreamEndedWithoutTerminalError,
} from "@mas-chat/runtime";
import { SessionStore } from "@mas-chat/storage";

import {
  loadConfig,
  requireApiKey,
  requestOptionsFromConfig,
  type MasChatConfig,
} from "./config.js";
import { consoleWriter, renderEvent } from "./render.js";

const USAGE = `MAS Chat

Usage:
  mas-chat new <prompt>
  mas-chat continue <session-id> <prompt>
  mas-chat attach <session-id>
  mas-chat cancel <session-id>
  mas-chat config

Configuration:
  Loads .env from the current directory.
  Precedence: .env > process/system environment > defaults.
  See .env.example for every supported setting.
`;

function requireText(parts: string[], label: string): string {
  const text = parts.join(" ").trim();
  if (text === "") {
    throw new Error(`${label} is required`);
  }
  return text;
}

function apiController(
  store: SessionStore,
  config: MasChatConfig,
): RunController {
  const client = new OpenAI({
    apiKey: requireApiKey(config),
    baseURL: config.baseURL,
  });
  return new RunController(store, new OpenAIResponsesTransport(client));
}

function printableConfig(config: MasChatConfig) {
  return {
    envFile: config.envFilePath,
    envFileLoaded: config.envFileLoaded,
    precedence: [".env", "process/system environment", "defaults"],
    apiKeyConfigured: config.apiKey !== undefined,
    apiKeySource: config.apiKeySource,
    backgroundFallback: config.backgroundFallback,
    baseURL: config.baseURL,
    dataDirectory: config.dataDirectory,
    model: config.model,
    reasoningEffort: config.reasoningEffort,
    reasoningSummary: config.reasoningSummary,
    textVerbosity: config.textVerbosity,
    webSearch: config.webSearch,
    codeInterpreter: config.codeInterpreter,
    developerPrompt: config.developerPrompt,
    sessionFollowingInstruction: config.sessionFollowingInstruction,
    execution: {
      preferred: "background",
      fallback: config.backgroundFallback,
    },
    locked: {
      stream: true,
      store: false,
    },
  };
}

async function render(stream: AsyncIterable<Parameters<typeof renderEvent>[0]>) {
  for await (const event of stream) {
    renderEvent(event, consoleWriter);
  }
}

async function main(argv: string[]): Promise<void> {
  const [command, ...args] = argv;
  if (command === undefined || command === "help" || command === "--help") {
    process.stdout.write(USAGE);
    return;
  }

  const config = loadConfig();
  if (command === "config") {
    process.stdout.write(`${JSON.stringify(printableConfig(config), null, 2)}\n`);
    return;
  }

  const store = new SessionStore(config.dataDirectory);

  if (command === "new") {
    const prompt = requireText(args, "prompt");
    const controller = apiController(store, config);
    const sessionId = randomUUID();
    await store.createSession(sessionId);
    process.stderr.write(`[session ${sessionId}]\n`);
    const input = [{ role: "user", content: prompt }] as ResponseInputItem[];
    await render(
      controller.start(input, {
        sessionId,
        ...requestOptionsFromConfig(config),
      }),
    );
    return;
  }

  if (command === "continue") {
    const [sessionId, ...promptParts] = args;
    if (sessionId === undefined) {
      throw new Error("session-id is required");
    }
    const prompt = requireText(promptParts, "prompt");
    const controller = apiController(store, config);
    const input = [{ role: "user", content: prompt }] as ResponseInputItem[];
    await render(
      controller.start(input, {
        sessionId,
        ...requestOptionsFromConfig(config),
      }),
    );
    return;
  }

  if (command === "attach") {
    const sessionId = requireText(args.slice(0, 1), "session-id");
    await render(apiController(store, config).attach(sessionId));
    return;
  }

  if (command === "cancel") {
    const sessionId = requireText(args.slice(0, 1), "session-id");
    renderEvent(
      await apiController(store, config).cancel(sessionId),
      consoleWriter,
    );
    return;
  }

  throw new Error(`Unknown command: ${command}\n\n${USAGE}`);
}

main(process.argv.slice(2)).catch((error: unknown) => {
  if (error instanceof StreamEndedWithoutTerminalError) {
    process.stderr.write(
      `\n[stream interrupted at sequence ${error.lastSequenceNumber}; run attach to resume]\n`,
    );
  } else {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Error: ${message}\n`);
  }
  process.exitCode = 1;
});
