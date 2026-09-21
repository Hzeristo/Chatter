#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import path from "node:path";

import OpenAI from "openai";
import type { ResponseInputItem } from "openai/resources/responses/responses";

import {
  DEFAULT_DEVELOPER_PROMPT,
  OpenAIResponsesTransport,
  RunController,
  StreamEndedWithoutTerminalError,
} from "@mas-chat/runtime";
import { SessionStore } from "@mas-chat/storage";

import { consoleWriter, renderEvent } from "./render.js";

const USAGE = `MAS Chat

Usage:
  mas-chat new <prompt>
  mas-chat continue <session-id> <prompt>
  mas-chat attach <session-id>
  mas-chat cancel <session-id>

Environment:
  OPENAI_API_KEY              Required for API commands
  MAS_CHAT_DATA_DIR           Local state root (default: .chat-runtime)
  MAS_CHAT_DEVELOPER_PROMPT   Visible per-request developer prompt override
`;

function requireText(parts: string[], label: string): string {
  const text = parts.join(" ").trim();
  if (text === "") {
    throw new Error(`${label} is required`);
  }
  return text;
}

function apiController(store: SessionStore): RunController {
  const apiKey = process.env.OPENAI_API_KEY;
  if (apiKey === undefined || apiKey === "") {
    throw new Error("OPENAI_API_KEY is not configured");
  }
  const client = new OpenAI({ apiKey });
  return new RunController(store, new OpenAIResponsesTransport(client));
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

  const dataDirectory = path.resolve(
    process.env.MAS_CHAT_DATA_DIR ?? ".chat-runtime",
  );
  const store = new SessionStore(dataDirectory);

  if (command === "new") {
    const prompt = requireText(args, "prompt");
    const controller = apiController(store);
    const sessionId = randomUUID();
    await store.createSession(sessionId);
    process.stderr.write(`[session ${sessionId}]\n`);
    const developerPrompt =
      process.env.MAS_CHAT_DEVELOPER_PROMPT ?? DEFAULT_DEVELOPER_PROMPT;
    const input = [{ role: "user", content: prompt }] as ResponseInputItem[];
    await render(
      controller.start(input, { sessionId, developerPrompt }),
    );
    return;
  }

  if (command === "continue") {
    const [sessionId, ...promptParts] = args;
    if (sessionId === undefined) {
      throw new Error("session-id is required");
    }
    const prompt = requireText(promptParts, "prompt");
    const controller = apiController(store);
    const developerPrompt =
      process.env.MAS_CHAT_DEVELOPER_PROMPT ?? DEFAULT_DEVELOPER_PROMPT;
    const input = [{ role: "user", content: prompt }] as ResponseInputItem[];
    await render(
      controller.start(input, { sessionId, developerPrompt }),
    );
    return;
  }

  if (command === "attach") {
    const sessionId = requireText(args.slice(0, 1), "session-id");
    await render(apiController(store).attach(sessionId));
    return;
  }

  if (command === "cancel") {
    const sessionId = requireText(args.slice(0, 1), "session-id");
    renderEvent(await apiController(store).cancel(sessionId), consoleWriter);
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
