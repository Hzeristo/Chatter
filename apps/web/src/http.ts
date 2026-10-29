import { readFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";

import type { NormalizedEvent } from "@mas-chat/protocol";

const MAX_BODY_BYTES = 64 * 1024;

export function safeError(error: unknown): Record<string, unknown> {
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

function jsonHeaders(contentType = "application/json; charset=utf-8") {
  return {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
  };
}

export function sendJson(
  response: http.ServerResponse,
  statusCode: number,
  value: unknown,
): void {
  response.writeHead(statusCode, jsonHeaders());
  response.end(JSON.stringify(value));
}

export function sendError(
  response: http.ServerResponse,
  statusCode: number,
  error: unknown,
): void {
  sendJson(response, statusCode, { error: safeError(error) });
}

export async function readBody(
  request: http.IncomingMessage,
): Promise<unknown> {
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

export async function streamEvents(
  response: http.ServerResponse,
  events: AsyncIterable<NormalizedEvent>,
): Promise<void> {
  let connected = true;
  let lastSequenceNumber = 0;
  response.on("close", () => {
    connected = false;
  });
  response.writeHead(200, streamHeaders());
  response.flushHeaders();

  try {
    for await (const event of events) {
      if (connected && !response.destroyed) {
        writeSse(response, event);
        if (Number.isSafeInteger(event.sequenceNumber) && event.sequenceNumber >= 0) {
          lastSequenceNumber = Math.max(lastSequenceNumber, event.sequenceNumber);
        }
      }
    }
  } catch (error) {
    if (connected && !response.destroyed) {
      writeSse(response, {
        kind: "error",
        sourceType: "server.error",
        sequenceNumber: lastSequenceNumber,
        error: safeError(error),
      });
    }
  } finally {
    if (connected && !response.destroyed) {
      response.end();
    }
  }
}

export function statusForError(error: unknown): number {
  const message = error instanceof Error ? error.message : String(error);
  if (/not found|no such file|invalid session|unknown (?:visible )?turn/i.test(message)) {
    return 404;
  }
  if (
    /already has (?:an? )?(?:active|run owned)|different active|no resumable|no cancellable|still running|cannot fork/i.test(
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

export async function serveStatic(
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
