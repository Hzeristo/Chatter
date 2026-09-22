import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import OpenAI from "openai";
import type { ResponseInputItem } from "openai/resources/responses/responses";

import {
  loadConfig,
  requireApiKey,
  requestOptionsFromConfig,
} from "@mas-chat/cli/config";
import type { NormalizedEvent, SessionMetadata } from "@mas-chat/protocol";
import {
  OpenAIResponsesTransport,
  resolveTurns,
  RunController,
} from "@mas-chat/runtime";
import { SessionStore } from "@mas-chat/storage";

import {
  createSessionView,
  safeError,
  type SessionView,
} from "./session-view.js";

const MAX_BODY_BYTES = 64 * 1024;
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8787;

type SessionListItem = {
  sessionId: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  lastSequenceNumber: number;
  preview?: string;
  messageCount: number;
};

type TurnRequest = {
  parentTurnId?: string | null;
  prompt: string;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonHeaders(contentType = "application/json; charset=utf-8") {
  return {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
  };
}

function sendJson(
  response: http.ServerResponse,
  statusCode: number,
  value: unknown,
): void {
  response.writeHead(statusCode, jsonHeaders());
  response.end(JSON.stringify(value));
}

function sendError(
  response: http.ServerResponse,
  statusCode: number,
  error: unknown,
): void {
  sendJson(response, statusCode, { error: safeError(error) });
}

async function readBody(request: http.IncomingMessage): Promise<unknown> {
  const declaredLength = Number(request.headers["content-length"] ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    throw new Error("Request body is too large");
  }

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      throw new Error("Request body is too large");
    }
    chunks.push(buffer);
  }

  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (text === "") {
    return {};
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error("Request body must be valid JSON", { cause: error });
  }
}

function parseTurnRequest(body: unknown): TurnRequest {
  if (!isObject(body) || typeof body.prompt !== "string") {
    throw new Error("Request body must contain a prompt string");
  }
  const prompt = body.prompt.trim();
  if (prompt === "") {
    throw new Error("Prompt must not be empty");
  }
  const rawParent = body.parentTurnId;
  if (
    rawParent !== undefined &&
    rawParent !== null &&
    typeof rawParent !== "string"
  ) {
    throw new Error("parentTurnId must be a string or null");
  }
  return {
    prompt,
    ...(rawParent === undefined ? {} : { parentTurnId: rawParent }),
  };
}

function streamHeaders() {
  return {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-store",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  };
}

function writeSse(response: http.ServerResponse, value: unknown): void {
  response.write(`data: ${JSON.stringify(value)}\n\n`);
}

async function streamEvents(
  response: http.ServerResponse,
  events: AsyncIterable<NormalizedEvent>,
): Promise<void> {
  let connected = true;
  response.on("close", () => {
    connected = false;
  });
  response.writeHead(200, streamHeaders());
  response.flushHeaders();

  try {
    for await (const event of events) {
      if (connected && !response.destroyed) {
        writeSse(response, event);
      }
    }
  } catch (error) {
    if (connected && !response.destroyed) {
      writeSse(response, {
        kind: "error",
        sourceType: "server.error",
        sequenceNumber: -1,
        error: safeError(error),
      });
    }
  } finally {
    if (connected && !response.destroyed) {
      response.end();
    }
  }
}

function statusForError(error: unknown): number {
  const message = error instanceof Error ? error.message : String(error);
  if (/not found|no such file|invalid session|unknown (?:visible )?turn/i.test(message)) {
    return 404;
  }
  if (
    /already has active|different active|no resumable|no cancellable|still running/i.test(
      message,
    )
  ) {
    return 409;
  }
  if (/request body|prompt|parentTurnId|too large/i.test(message)) {
    return 400;
  }
  return 500;
}

function contentType(filePath: string): string {
  switch (path.extname(filePath)) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".woff2":
      return "font/woff2";
    default:
      return "application/octet-stream";
  }
}

async function serveStatic(
  response: http.ServerResponse,
  publicDirectory: string,
  pathname: string,
): Promise<void> {
  const relative = pathname === "/" ? "index.html" : pathname.slice(1);
  const filePath = path.resolve(publicDirectory, decodeURIComponent(relative));
  const root = `${path.resolve(publicDirectory)}${path.sep}`;
  if (!filePath.startsWith(root)) {
    sendError(response, 400, new Error("Invalid asset path"));
    return;
  }

  try {
    const body = await readFile(filePath);
    response.writeHead(200, {
      "Content-Type": contentType(filePath),
      "Cache-Control": "no-cache",
      "Content-Security-Policy":
        "default-src 'self'; connect-src 'self'; style-src 'self'; script-src 'self'",
    });
    response.end(body);
  } catch {
    sendError(response, 404, new Error("Asset not found"));
  }
}

function configView(config: ReturnType<typeof loadConfig>) {
  return {
    model: config.model,
    reasoningEffort: config.reasoningEffort,
    reasoningSummary: config.reasoningSummary,
    textVerbosity: config.textVerbosity,
    webSearch: config.webSearch,
    codeInterpreter: config.codeInterpreter,
    backgroundFallback: config.backgroundFallback,
    developerPrompt: config.developerPrompt,
    sessionFollowingInstruction: config.sessionFollowingInstruction,
    apiKeyConfigured: config.apiKey !== undefined,
  };
}

async function main(): Promise<void> {
  const config = loadConfig();
  const store = new SessionStore(config.dataDirectory);
  const activeRuns = new Set<string>();
  let controller: RunController | undefined;

  function getController(): RunController {
    if (controller !== undefined) {
      return controller;
    }
    const client = new OpenAI({
      apiKey: requireApiKey(config),
      baseURL: config.baseURL,
      maxRetries: 0,
    });
    controller = new RunController(store, new OpenAIResponsesTransport(client));
    return controller;
  }

  async function reconcileSession(sessionId: string): Promise<{
    metadata: SessionMetadata;
    records: Awaited<ReturnType<SessionStore["readJournal"]>>;
  }> {
    let metadata = await store.loadMetadata(sessionId);
    let records = await store.readJournal(sessionId);
    if (
      metadata.activeTurnId !== undefined &&
      !activeRuns.has(sessionId)
    ) {
      const activeInput = records.find(
        (record) =>
          record.kind === "turn.input" &&
          record.turnId === metadata.activeTurnId,
      );
      const orphanError =
        activeInput?.kind !== "turn.input"
          ? {
              name: "ActiveTurnInputMissing",
              message: "The active turn has no persisted input record",
            }
          : !activeInput.configuration.background
            ? {
                name: "ForegroundRunOrphaned",
                message:
                  "The foreground response lost its owning server process and cannot be resumed",
              }
            : metadata.responseId === undefined
              ? {
                  name: "ResponseIdUnavailable",
                  message:
                    "The background response ID was not persisted before its owning server process stopped",
                }
              : undefined;
      if (orphanError !== undefined) {
        await store.failTurn(sessionId, metadata.activeTurnId, {
          ...orphanError,
        });
        metadata = await store.loadMetadata(sessionId);
        records = await store.readJournal(sessionId);
      }
    }
    return { metadata, records };
  }

  async function loadSessionView(
    sessionId: string,
    selectedHeadTurnId?: string,
  ): Promise<SessionView> {
    const { metadata, records } = await reconcileSession(sessionId);
    return createSessionView(
      sessionId,
      metadata,
      records,
      selectedHeadTurnId,
      activeRuns.has(sessionId),
    );
  }

  async function supersedeActiveTurn(
    sessionId: string,
    turnId: string,
    background: boolean,
    reason: "continuation" | "retry",
  ): Promise<void> {
    const metadata = await store.loadMetadata(sessionId);
    if (metadata.activeTurnId === undefined) {
      return;
    }
    if (activeRuns.has(sessionId)) {
      throw new Error(`Session ${sessionId} is still running locally`);
    }
    if (metadata.activeTurnId !== turnId) {
      throw new Error(`Session ${sessionId} has a different active turn`);
    }

    const failureName =
      reason === "retry"
        ? "TurnSupersededByRetry"
        : "TurnSupersededByContinuation";
    if (metadata.responseId !== undefined && background) {
      try {
        await getController().cancel(sessionId);
        return;
      } catch (error) {
        const afterCancel = await store.loadMetadata(sessionId);
        if (afterCancel.activeTurnId === undefined) {
          return;
        }
        if (afterCancel.activeTurnId !== turnId) {
          throw error;
        }
        const cancelError = safeError(error);
        await store.failTurn(sessionId, turnId, {
          name: failureName,
          message: `The unfinished response was superseded by user ${reason} after remote cancellation failed`,
          cancelError,
        });
        process.stderr.write(
          `Remote cancellation failed for ${sessionId}/${turnId}: ${String(cancelError.message ?? "unknown error")}\n`,
        );
        return;
      }
    }

    await store.failTurn(sessionId, turnId, {
      name: failureName,
      message: `The unfinished response was superseded by user ${reason}`,
    });
  }

  async function sessionListItem(
    metadata: SessionMetadata,
  ): Promise<SessionListItem> {
    const view = await loadSessionView(metadata.sessionId);
    const firstUserMessage = view.messages.find(
      (message) => message.role === "user",
    );
    const preview = firstUserMessage?.text.trim().replace(/\s+/g, " ");
    const currentMetadata = await store.loadMetadata(metadata.sessionId);
    return {
      sessionId: metadata.sessionId,
      status: view.status,
      createdAt: currentMetadata.createdAt,
      updatedAt: currentMetadata.updatedAt,
      lastSequenceNumber: currentMetadata.lastSequenceNumber,
      ...(preview === undefined || preview === ""
        ? {}
        : { preview: preview.slice(0, 96) }),
      messageCount: view.messages.filter(
        (message) => !message.id.endsWith(":status"),
      ).length,
    };
  }

  async function runStream(
    sessionId: string,
    response: http.ServerResponse,
    events: AsyncIterable<NormalizedEvent>,
  ): Promise<void> {
    if (activeRuns.has(sessionId)) {
      throw new Error(`Session ${sessionId} is still running locally`);
    }
    activeRuns.add(sessionId);
    try {
      await streamEvents(response, events);
    } finally {
      activeRuns.delete(sessionId);
    }
  }

  const publicDirectory = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "public",
  );
  const host = process.env.MAS_CHAT_WEB_HOST?.trim() || DEFAULT_HOST;
  const configuredPort = Number(process.env.MAS_CHAT_WEB_PORT ?? DEFAULT_PORT);
  const port =
    Number.isInteger(configuredPort) && configuredPort > 0
      ? configuredPort
      : DEFAULT_PORT;

  const server = http.createServer(async (request, response) => {
    const url = new URL(
      request.url ?? "/",
      `http://${request.headers.host ?? host}`,
    );
    const pathname = url.pathname;

    try {
      if (request.method === "GET" && pathname === "/api/health") {
        sendJson(response, 200, { ok: true, ...configView(config) });
        return;
      }

      if (request.method === "POST" && pathname === "/api/sessions") {
        const sessionId = randomUUID();
        await store.createSession(sessionId);
        sendJson(response, 201, { sessionId });
        return;
      }

      if (request.method === "GET" && pathname === "/api/sessions") {
        const metadata = await store.listSessions();
        const sessions = await Promise.all(metadata.map(sessionListItem));
        sendJson(response, 200, { sessions });
        return;
      }

      const sessionMatch = pathname.match(/^\/api\/sessions\/([^/]+)$/);
      if (request.method === "GET" && sessionMatch?.[1] !== undefined) {
        const sessionId = decodeURIComponent(sessionMatch[1]);
        const selectedHead = url.searchParams.get("head") ?? undefined;
        sendJson(
          response,
          200,
          await loadSessionView(sessionId, selectedHead),
        );
        return;
      }

      const retryMatch = pathname.match(
        /^\/api\/sessions\/([^/]+)\/turns\/([^/]+)\/retry$/,
      );
      if (request.method === "POST" && retryMatch?.[1] !== undefined) {
        const sessionId = decodeURIComponent(retryMatch[1]);
        const sourceTurnId = decodeURIComponent(retryMatch[2] ?? "");
        let { metadata, records } = await reconcileSession(sessionId);
        let source = resolveTurns(records).find(
          (turn) => turn.input.turnId === sourceTurnId,
        );
        if (source === undefined) {
          throw new Error(`Unknown turn ${sourceTurnId}`);
        }
        if (metadata.activeTurnId !== undefined) {
          await supersedeActiveTurn(
            sessionId,
            sourceTurnId,
            source.input.configuration.background,
            "retry",
          );
          metadata = await store.loadMetadata(sessionId);
          records = await store.readJournal(sessionId);
          source = resolveTurns(records).find(
            (turn) => turn.input.turnId === sourceTurnId,
          );
          if (source === undefined) {
            throw new Error(`Unknown turn ${sourceTurnId}`);
          }
        }

        const input = source.input.items as unknown as ResponseInputItem[];
        await runStream(
          sessionId,
          response,
          getController().start(input, {
            sessionId,
            ...requestOptionsFromConfig(config),
            parentTurnId: source.parentTurnId,
            fork: { kind: "retry", sourceTurnId },
          }),
        );
        return;
      }

      const editMatch = pathname.match(
        /^\/api\/sessions\/([^/]+)\/turns\/([^/]+)\/edit$/,
      );
      if (request.method === "POST" && editMatch?.[1] !== undefined) {
        const sessionId = decodeURIComponent(editMatch[1]);
        const sourceTurnId = decodeURIComponent(editMatch[2] ?? "");
        const edited = parseTurnRequest(await readBody(request));
        let { metadata, records } = await reconcileSession(sessionId);
        let source = resolveTurns(records).find(
          (turn) => turn.input.turnId === sourceTurnId,
        );
        if (source === undefined) {
          throw new Error(`Unknown turn ${sourceTurnId}`);
        }
        if (metadata.activeTurnId !== undefined) {
          await supersedeActiveTurn(
            sessionId,
            sourceTurnId,
            source.input.configuration.background,
            "retry",
          );
          metadata = await store.loadMetadata(sessionId);
          records = await store.readJournal(sessionId);
          source = resolveTurns(records).find(
            (turn) => turn.input.turnId === sourceTurnId,
          );
          if (source === undefined) {
            throw new Error(`Unknown turn ${sourceTurnId}`);
          }
        }

        const input = [
          { role: "user", content: edited.prompt },
        ] as ResponseInputItem[];
        await runStream(
          sessionId,
          response,
          getController().start(input, {
            sessionId,
            ...requestOptionsFromConfig(config),
            parentTurnId: source.parentTurnId,
            fork: { kind: "edit", sourceTurnId },
          }),
        );
        return;
      }

      const turnMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/turn$/);
      if (request.method === "POST" && turnMatch?.[1] !== undefined) {
        const sessionId = decodeURIComponent(turnMatch[1]);
        const turn = parseTurnRequest(await readBody(request));
        const { metadata, records } = await reconcileSession(sessionId);
        if (metadata.activeTurnId !== undefined) {
          if (turn.parentTurnId !== metadata.activeTurnId) {
            throw new Error(
              `Session ${sessionId} has a different active turn than parentTurnId`,
            );
          }
          const active = resolveTurns(records).find(
            (candidate) => candidate.input.turnId === metadata.activeTurnId,
          );
          if (active === undefined) {
            throw new Error(`Unknown turn ${metadata.activeTurnId}`);
          }
          await supersedeActiveTurn(
            sessionId,
            metadata.activeTurnId,
            active.input.configuration.background,
            "continuation",
          );
        }
        const input = [
          { role: "user", content: turn.prompt },
        ] as ResponseInputItem[];
        await runStream(
          sessionId,
          response,
          getController().start(input, {
            sessionId,
            ...requestOptionsFromConfig(config),
            ...(turn.parentTurnId === undefined
              ? {}
              : { parentTurnId: turn.parentTurnId }),
          }),
        );
        return;
      }

      const attachMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/attach$/);
      if (request.method === "GET" && attachMatch?.[1] !== undefined) {
        const sessionId = decodeURIComponent(attachMatch[1]);
        await runStream(
          sessionId,
          response,
          getController().attach(sessionId),
        );
        return;
      }

      const cancelMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/cancel$/);
      if (request.method === "POST" && cancelMatch?.[1] !== undefined) {
        const sessionId = decodeURIComponent(cancelMatch[1]);
        sendJson(response, 200, await getController().cancel(sessionId));
        return;
      }

      if (request.method === "GET") {
        await serveStatic(response, publicDirectory, pathname);
        return;
      }

      sendError(response, 404, new Error("Route not found"));
    } catch (error) {
      if (!response.headersSent) {
        sendError(response, statusForError(error), error);
      } else if (!response.destroyed) {
        response.end();
      }
    }
  });

  server.requestTimeout = 0;
  server.listen(port, host, () => {
    process.stdout.write(`MAS Chat web listening at http://${host}:${port}\n`);
    process.stdout.write(
      `Model: ${config.model}; API key configured: ${config.apiKey !== undefined}\n`,
    );
  });
}

main().catch((error: unknown) => {
  process.stderr.write(
    `Error: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
