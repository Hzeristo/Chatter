import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import OpenAI from "openai";
import type { ResponseInputItem } from "openai/resources/responses/responses";

import { loadConfig, requireApiKey, requestOptionsFromConfig } from "@mas-chat/cli/config";
import type {
  JournalRecord,
  JsonObject,
  NormalizedEvent,
  OpenAINativeItem,
} from "@mas-chat/protocol";
import { OpenAIResponsesTransport, RunController } from "@mas-chat/runtime";
import { SessionStore } from "@mas-chat/storage";

const MAX_BODY_BYTES = 64 * 1024;
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8787;

type SessionMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  phase?: "commentary" | "final_answer" | "unknown";
};

type SessionView = {
  sessionId: string;
  status: string;
  responseId?: string;
  lastSequenceNumber: number;
  messages: SessionMessage[];
};

type SessionListItem = {
  sessionId: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  lastSequenceNumber: number;
  preview?: string;
  messageCount: number;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function textValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(textValue).join("");
  }
  if (isObject(value)) {
    return stringValue(value.text) ?? "";
  }
  return "";
}

function itemText(item: OpenAINativeItem): string {
  return textValue(item.content);
}

function phaseValue(item: OpenAINativeItem): SessionMessage["phase"] {
  const phase = stringValue(item.phase);
  return phase === "commentary" || phase === "final_answer" ? phase : "unknown";
}

function safeError(error: unknown): JsonObject {
  if (!(error instanceof Error)) {
    return { name: "UnknownError", message: String(error) };
  }
  const details = error as Error & { code?: unknown; status?: unknown };
  return {
    name: error.name,
    message: error.message,
    ...(typeof details.code === "string" ? { code: details.code } : {}),
    ...(typeof details.status === "number" ? { status: details.status } : {}),
  };
}

function sessionView(
  sessionId: string,
  metadata: Awaited<ReturnType<SessionStore["loadMetadata"]>>,
  records: JournalRecord[],
): SessionView {
  const messages: SessionMessage[] = [];

  for (const record of records) {
    if (record.kind === "turn.input") {
      record.items.forEach((item, index) => {
        const role = stringValue(item.role);
        const text = itemText(item);
        if (role === "user" && text !== "") {
          messages.push({
            id: `${record.turnId}:user:${index}`,
            role: "user",
            text,
          });
        }
      });
      continue;
    }

    if (record.kind === "turn.output") {
      record.items.forEach((item, index) => {
        if (item.type !== "message") {
          return;
        }
        const text = itemText(item);
        if (text === "") {
          return;
        }
        const message: SessionMessage = {
          id: stringValue(item.id) ?? `${record.turnId}:assistant:${index}`,
          role: "assistant",
          text,
        };
        const phase = phaseValue(item);
        if (phase !== undefined) {
          message.phase = phase;
        }
        messages.push(message);
      });
    }
  }

  return {
    sessionId,
    status: metadata.status,
    ...(metadata.responseId === undefined
      ? {}
      : { responseId: metadata.responseId }),
    lastSequenceNumber: metadata.lastSequenceNumber,
    messages,
  };
}

async function sessionListItem(
  store: SessionStore,
  metadata: Awaited<ReturnType<SessionStore["loadMetadata"]>>,
): Promise<SessionListItem> {
  const records = await store.readJournal(metadata.sessionId);
  const view = sessionView(metadata.sessionId, metadata, records);
  const firstUserMessage = view.messages.find((message) => message.role === "user");
  const preview = firstUserMessage?.text.trim().replace(/\s+/g, " ");
  return {
    sessionId: metadata.sessionId,
    status: metadata.status,
    createdAt: metadata.createdAt,
    updatedAt: metadata.updatedAt,
    lastSequenceNumber: metadata.lastSequenceNumber,
    ...(preview === undefined || preview === ""
      ? {}
      : { preview: preview.slice(0, 96) }),
    messageCount: view.messages.length,
  };
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

function requestPrompt(body: unknown): string {
  if (!isObject(body) || typeof body.prompt !== "string") {
    throw new Error("Request body must contain a prompt string");
  }
  const prompt = body.prompt.trim();
  if (prompt === "") {
    throw new Error("Prompt must not be empty");
  }
  return prompt;
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
  if (/not found|no such file|invalid session/i.test(message)) {
    return 404;
  }
  if (/already has active|no resumable|no cancellable/i.test(message)) {
    return 409;
  }
  if (/request body|prompt|too large/i.test(message)) {
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
      "Cache-Control": pathname === "/" ? "no-cache" : "public, max-age=60",
      "Content-Security-Policy": "default-src 'self'; connect-src 'self'; style-src 'self'; script-src 'self'",
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

function createApplication() {
  const config = loadConfig();
  const store = new SessionStore(config.dataDirectory);
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

  return { config, store, getController };
}

async function main(): Promise<void> {
  const { config, store, getController } = createApplication();
  const publicDirectory = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "public",
  );
  const host = process.env.MAS_CHAT_WEB_HOST?.trim() || DEFAULT_HOST;
  const configuredPort = Number(process.env.MAS_CHAT_WEB_PORT ?? DEFAULT_PORT);
  const port = Number.isInteger(configuredPort) && configuredPort > 0
    ? configuredPort
    : DEFAULT_PORT;

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? host}`);
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
        const sessions = await Promise.all(
          metadata.map((item) => sessionListItem(store, item)),
        );
        sendJson(response, 200, { sessions });
        return;
      }

      const sessionMatch = pathname.match(/^\/api\/sessions\/([^/]+)$/);
      if (request.method === "GET" && sessionMatch?.[1] !== undefined) {
        const sessionId = decodeURIComponent(sessionMatch[1]);
        const metadata = await store.loadMetadata(sessionId);
        const records = await store.readJournal(sessionId);
        sendJson(response, 200, sessionView(sessionId, metadata, records));
        return;
      }

      const turnMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/turn$/);
      if (request.method === "POST" && turnMatch?.[1] !== undefined) {
        const sessionId = decodeURIComponent(turnMatch[1]);
        const prompt = requestPrompt(await readBody(request));
        const input = [{ role: "user", content: prompt }] as ResponseInputItem[];
        await streamEvents(
          response,
          getController().start(input, {
            sessionId,
            ...requestOptionsFromConfig(config),
          }),
        );
        return;
      }

      const attachMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/attach$/);
      if (request.method === "GET" && attachMatch?.[1] !== undefined) {
        const sessionId = decodeURIComponent(attachMatch[1]);
        await streamEvents(response, getController().attach(sessionId));
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
  process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
