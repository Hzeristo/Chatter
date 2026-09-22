import { createHash } from "node:crypto";

import OpenAI from "openai";

import {
  acquireDataDirectoryLease,
  SessionService,
} from "@mas-chat/application";
import type {
  JsonObject,
  JsonValue,
  OpenAINativeItem,
} from "@mas-chat/protocol";
import {
  loadConfig,
  requireApiKey,
  runPolicyFromConfig,
} from "@mas-chat/config";
import { OpenAIResponsesTransport, RunController } from "@mas-chat/runtime";
import { SessionStore } from "@mas-chat/storage";

import {
  GENERAL_ASSISTANT_V1,
  WEB_RELAXED_V3,
} from "./prompts.js";

const WA2_PROMPT =
  "纯粹闲聊。在2011/13那个时间点，《白色相簿2》的横空出世就像是lambda calculus至于函数式编程一般，可以说是重新定义了gal历史中的所谓关系性";

const VARIANTS = [
  { id: "A-native", instructions: null },
  { id: "B-general-assistant-v1", instructions: GENERAL_ASSISTANT_V1 },
  { id: "C-web-relaxed-v3", instructions: WEB_RELAXED_V3 },
] as const;

function selectedVariants(): readonly (typeof VARIANTS)[number][] {
  const requested = process.argv.slice(2);
  if (requested.length === 0) {
    return VARIANTS;
  }
  const selected = VARIANTS.filter((variant) => requested.includes(variant.id));
  const unknown = requested.filter(
    (id) => !VARIANTS.some((variant) => variant.id === id),
  );
  if (unknown.length > 0) {
    throw new Error(`Unknown prompt variant: ${unknown.join(", ")}`);
  }
  return selected;
}

function objectValue(value: JsonValue | undefined): JsonObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value
    : undefined;
}

function assistantText(items: OpenAINativeItem[]): string {
  const fragments: string[] = [];
  for (const item of items) {
    if (item.type !== "message" || !Array.isArray(item.content)) {
      continue;
    }
    for (const part of item.content) {
      const content = objectValue(part);
      if (content?.type === "output_text" && typeof content.text === "string") {
        fragments.push(content.text);
      }
    }
  }
  return fragments.join("");
}

function promptHash(instructions: string | null): string | null {
  return instructions === null
    ? null
    : createHash("sha256").update(instructions).digest("hex");
}

function safeError(error: unknown): JsonObject {
  if (!(error instanceof Error)) {
    return { name: "UnknownError", message: String(error) };
  }
  const extended = error as Error & { code?: unknown; status?: unknown };
  return {
    name: error.name,
    message: error.message,
    ...(typeof extended.status === "number"
      ? { status: extended.status }
      : {}),
    ...(typeof extended.code === "string" ? { code: extended.code } : {}),
  };
}

async function main(): Promise<void> {
  const config = loadConfig();
  const apiKey = requireApiKey(config);
  const client = new OpenAI({
    apiKey,
    baseURL: config.baseURL,
    maxRetries: 0,
  });
  const store = new SessionStore(config.dataDirectory);
  const controller = new RunController(
    store,
    new OpenAIResponsesTransport(client),
  );
  const {
    developerPrompt: _configuredPrompt,
    ...sharedOptions
  } = runPolicyFromConfig(config);
  let failed = false;

  process.stdout.write(
    `${JSON.stringify({
      stage: "config",
      model: config.model,
      reasoningEffort: config.reasoningEffort,
      reasoningSummary: config.reasoningSummary,
      textVerbosity: config.textVerbosity,
      webSearch: config.webSearch,
      codeInterpreter: config.codeInterpreter,
      backgroundFallback: config.backgroundFallback,
    })}\n`,
  );

  const releaseLease = await acquireDataDirectoryLease(config.dataDirectory);
  try {
    for (const variant of selectedVariants()) {
      const service = new SessionService(store, () => controller, {
        ...sharedOptions,
        developerPrompt: variant.instructions,
      });
      const sessionId = await service.createSession();
      process.stdout.write(
        `${JSON.stringify({
          stage: "variant.start",
          variant: variant.id,
          sessionId,
          instructionsOmitted: variant.instructions === null,
          promptHash: promptHash(variant.instructions),
        })}\n`,
      );

      try {
        for await (const _event of await service.continueSession(
          sessionId,
          WA2_PROMPT,
        )) {
          // Drain the complete stream; the journal remains the source of truth.
        }

        const records = await store.readJournal(sessionId);
        const output = records.findLast(
          (record) => record.kind === "turn.output",
        );
        const items = output?.kind === "turn.output" ? output.items : [];
        const response =
          output?.kind === "turn.output" ? output.response : undefined;
        const usage = objectValue(response?.usage);
        const outputTokenDetails = objectValue(usage?.output_tokens_details);
        const executionModes = records
          .filter((record) => record.kind === "turn.input")
          .map((record) =>
            record.kind === "turn.input" && record.configuration.background
              ? "background"
              : "foreground",
          );
        const text = assistantText(items);

        process.stdout.write(
          `${JSON.stringify({
            stage: "variant.result",
            variant: variant.id,
            sessionId,
            status: output?.kind === "turn.output" ? output.status : "missing",
            executionModes,
            outputItemTypes: items.map((item) => item.type ?? "unknown"),
            reasoningTokens:
              typeof outputTokenDetails?.reasoning_tokens === "number"
                ? outputTokenDetails.reasoning_tokens
                : null,
            outputCharacters: text.length,
          })}\n`,
        );
        process.stdout.write(`\n===== ${variant.id} =====\n${text}\n\n`);
      } catch (error) {
        failed = true;
        process.stdout.write(
          `${JSON.stringify({
            stage: "variant.failure",
            variant: variant.id,
            sessionId,
            error: safeError(error),
          })}\n`,
        );
      }
    }
  } finally {
    await releaseLease();
  }

  if (failed) {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  process.stdout.write(
    `${JSON.stringify({ stage: "failure", error: safeError(error) })}\n`,
  );
  process.exitCode = 1;
});
