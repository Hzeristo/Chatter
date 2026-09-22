import OpenAI from "openai";

import {
  acquireDataDirectoryLease,
  SessionService,
} from "@mas-chat/application";
import type { JsonObject, NormalizedEvent } from "@mas-chat/protocol";
import { OpenAIResponsesTransport, RunController } from "@mas-chat/runtime";
import { SessionStore } from "@mas-chat/storage";
import {
  loadConfig,
  requireApiKey,
  runPolicyFromConfig,
} from "@mas-chat/config";


const DEFAULT_PROMPT =
  "Search the official OpenAI documentation and answer in one sentence: which parameter resumes a background Responses stream after a known sequence number? Include the official source citation.";

function safeError(error: unknown, depth = 0): JsonObject {
  if (!(error instanceof Error)) {
    return { name: "UnknownError", message: String(error) };
  }
  const extended = error as Error & {
    cause?: unknown;
    code?: unknown;
    status?: unknown;
    type?: unknown;
  };
  const result: JsonObject = {
    name: error.name,
    message: error.message,
  };
  if (typeof extended.status === "number") {
    result.status = extended.status;
  }
  if (typeof extended.code === "string") {
    result.code = extended.code;
  }
  if (typeof extended.type === "string") {
    result.errorType = extended.type;
  }
  if (extended.cause !== undefined && depth < 2) {
    result.cause = safeError(extended.cause, depth + 1);
  }
  return result;
}

function writeStage(stage: string, details: JsonObject): void {
  process.stdout.write(`${JSON.stringify({ stage, ...details })}\n`);
}

function countEvent(
  counts: Record<string, number>,
  event: NormalizedEvent,
): void {
  counts[event.kind] = (counts[event.kind] ?? 0) + 1;
  if (event.kind === "tool") {
    writeStage("tool", {
      toolType: event.toolType,
      status: event.status,
      sequenceNumber: event.sequenceNumber,
    });
  }
  if (
    event.kind === "assistant_text" &&
    event.phase === "final_answer" &&
    event.delta !== undefined
  ) {
    process.stdout.write(event.delta);
  }
}

async function probeModels(client: OpenAI, configuredModel: string): Promise<void> {
  try {
    const page = await client.models.list();
    writeStage("models", {
      status: "ok",
      count: page.data.length,
      configuredModelListed: page.data.some(
        (model) => model.id === configuredModel,
      ),
      sampleIds: page.data.slice(0, 5).map((model) => model.id),
    });
  } catch (error) {
    writeStage("models", {
      status: "warning",
      error: safeError(error),
    });
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  const apiKey = requireApiKey(config);
  const prompt = process.argv.slice(2).join(" ").trim() || DEFAULT_PROMPT;
  writeStage("config", {
    envFileLoaded: config.envFileLoaded,
    apiKeyConfigured: true,
    apiKeySource: config.apiKeySource,
    backgroundFallback: config.backgroundFallback,
    baseURL: config.baseURL,
    model: config.model,
    reasoningEffort: config.reasoningEffort,
    webSearch: config.webSearch,
    codeInterpreter: config.codeInterpreter,
  });

  const client = new OpenAI({
    apiKey,
    baseURL: config.baseURL,
    maxRetries: 0,
  });
  await probeModels(client, config.model);

  const releaseLease = await acquireDataDirectoryLease(config.dataDirectory);
  const store = new SessionStore(config.dataDirectory);
  try {
    const controller = new RunController(
      store,
      new OpenAIResponsesTransport(client),
    );
    const service = new SessionService(
      store,
      () => controller,
      runPolicyFromConfig(config),
    );
    const sessionId = await service.createSession();
    writeStage("session", { sessionId });
    const counts: Record<string, number> = {};

    for await (const event of await service.continueSession(sessionId, prompt)) {
      countEvent(counts, event);
    }
    process.stdout.write("\n");

    const metadata = await store.loadMetadata(sessionId);
    const records = await store.readJournal(sessionId);
    const rawEventTypes = records
      .filter((record) => record.kind === "response.event")
      .map((record) =>
        typeof record.event.type === "string" ? record.event.type : "unknown",
      );
    const executionModes = records
      .filter((record) => record.kind === "turn.input")
      .map((record) =>
        record.kind === "turn.input" && record.configuration.background
          ? "background"
          : "foreground",
      );
    const outputRecord = records.findLast(
      (record) => record.kind === "turn.output",
    );
    const outputItems =
      outputRecord?.kind === "turn.output" ? outputRecord.items : [];
    const reasoningItems = outputItems.filter(
      (item) => item.type === "reasoning",
    );
    const searchItems = outputItems.filter(
      (item) => item.type === "web_search_call",
    );
    const messageItems = outputItems.filter((item) => item.type === "message");
    writeStage("result", {
      status: metadata.status,
      responseIdPresent: metadata.responseId !== undefined,
      lastSequenceNumber: metadata.lastSequenceNumber,
      journalRecordCount: records.length,
      rawEventCount: rawEventTypes.length,
      rawEventTypes,
      executionModes,
      outputItemTypes: outputItems.map((item) => item.type ?? "unknown"),
      reasoningItemCount: reasoningItems.length,
      encryptedReasoningItemCount: reasoningItems.filter(
        (item) =>
          typeof item.encrypted_content === "string" &&
          item.encrypted_content.length > 0,
      ).length,
      searchCallCount: searchItems.length,
      searchSourceCount: searchItems.reduce((sum, item) => {
        const action =
          typeof item.action === "object" &&
          item.action !== null &&
          !Array.isArray(item.action)
            ? item.action
            : undefined;
        return sum + (Array.isArray(action?.sources) ? action.sources.length : 0);
      }, 0),
      assistantPhases: messageItems.map((item) =>
        typeof item.phase === "string" ? item.phase : "unknown",
      ),
      normalizedEventCounts: counts,
    });

    if (metadata.status !== "completed") {
      throw new Error(`Smoke response ended as ${metadata.status}`);
    }
  } finally {
    await releaseLease();
  }
}

main().catch((error: unknown) => {
  writeStage("failure", { error: safeError(error) });
  process.exitCode = 1;
});
