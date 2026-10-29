import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import OpenAI from "openai";

import {
  acquireDataDirectoryLease,
  SessionService,
  type SessionSnapshot,
} from "@mas-chat/application";
import {
  loadConfig,
  requireApiKey,
  runPolicyFromConfig,
} from "@mas-chat/config";
import {
  OpenAIResponsesTransport,
  RunController,
} from "@mas-chat/runtime";
import { SessionStore } from "@mas-chat/storage";
import type { SessionForkMetadata } from "@mas-chat/protocol";

import {
  readBody,
  sendError,
  sendJson,
  serveStatic,
  statusForError,
  streamEvents,
} from "./http.js";
import {
  createSessionView,
  type SessionView,
} from "./session-view.js";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8787;

type SessionListItem = {
  archived: boolean;
  fork?: SessionForkMetadata;
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
  const releaseLease = await acquireDataDirectoryLease(config.dataDirectory);
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

  const service = new SessionService(
    store,
    getController,
    runPolicyFromConfig(config),
  );
  try {
    await service.reconcileInterruptedSessions();
  } catch (error) {
    await releaseLease();
    throw error;
  }

  async function loadSessionView(
    sessionId: string,
    selectedHeadTurnId?: string,
  ): Promise<SessionView> {
    const { metadata, records, locallyActive } =
      await service.inspectSession(sessionId);
    return createSessionView(
      sessionId,
      metadata,
      records,
      selectedHeadTurnId,
      locallyActive,
    );
  }

  async function sessionListItem(
    snapshot: SessionSnapshot,
  ): Promise<SessionListItem> {
    const { metadata, records, locallyActive } = snapshot;
    const view = createSessionView(
      metadata.sessionId,
      metadata,
      records,
      undefined,
      locallyActive,
    );
    const firstUserMessage = view.messages.find(
      (message) => message.role === "user",
    );
    const preview = firstUserMessage?.text.trim().replace(/\s+/g, " ");
    return {
      archived: snapshot.archived,
      ...(metadata.fork === undefined ? {} : { fork: metadata.fork }),
      sessionId: metadata.sessionId,
      status: view.status,
      createdAt: metadata.createdAt,
      updatedAt: metadata.updatedAt,
      lastSequenceNumber: metadata.lastSequenceNumber,
      ...(preview === undefined || preview === ""
        ? {}
        : { preview: preview.slice(0, 96) }),
      messageCount: view.messages.filter(
        (message) => !message.id.endsWith(":status"),
      ).length,
    };
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
        const sessionId = await service.createSession();
        sendJson(response, 201, { sessionId });
        return;
      }

      if (request.method === "GET" && pathname === "/api/sessions") {
        const snapshots = await service.listSessions();
        const sessions = await Promise.all(snapshots.map(sessionListItem));
        sendJson(response, 200, {
          sessions: sessions.filter((session) => !session.archived),
          archivedSessions: sessions.filter((session) => session.archived),
        });
        return;
      }

      const archiveMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/archive$/);
      if (request.method === "POST" && archiveMatch?.[1] !== undefined) {
        const sessionId = decodeURIComponent(archiveMatch[1]);
        await service.archiveSession(sessionId);
        sendJson(response, 200, { sessionId, archived: true });
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
        await streamEvents(
          response,
          await service.retryTurn(sessionId, sourceTurnId),
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
        await streamEvents(
          response,
          await service.editTurn(sessionId, sourceTurnId, edited.prompt),
        );
        return;
      }

      const forkMatch = pathname.match(
        /^\/api\/sessions\/([^/]+)\/turns\/([^/]+)\/fork$/,
      );
      if (request.method === "POST" && forkMatch?.[1] !== undefined) {
        const sessionId = decodeURIComponent(forkMatch[1]);
        const sourceTurnId = decodeURIComponent(forkMatch[2] ?? "");
        const forked = parseTurnRequest(await readBody(request));
        const result = await service.forkTurn(
          sessionId,
          sourceTurnId,
          forked.prompt,
        );
        await streamEvents(response, result.events, {
          "X-MAS-Chat-Session-Id": result.sessionId,
        });
        return;
      }

      const turnMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/turn$/);
      if (request.method === "POST" && turnMatch?.[1] !== undefined) {
        const sessionId = decodeURIComponent(turnMatch[1]);
        const turn = parseTurnRequest(await readBody(request));
        await streamEvents(
          response,
          await service.continueSession(sessionId, turn.prompt, {
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
        await streamEvents(response, await service.attach(sessionId));
        return;
      }

      const cancelMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/cancel$/);
      if (request.method === "POST" && cancelMatch?.[1] !== undefined) {
        const sessionId = decodeURIComponent(cancelMatch[1]);
        sendJson(response, 200, await service.cancel(sessionId));
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
  let leaseReleased = false;
  async function releaseLeaseOnce(): Promise<void> {
    if (leaseReleased) {
      return;
    }
    leaseReleased = true;
    await releaseLease();
  }
  server.once("close", () => {
    void releaseLeaseOnce();
  });
  const shutdown = () => {
    server.close(() => {
      void releaseLeaseOnce();
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => {
        server.off("error", reject);
        process.stdout.write(`MAS Chat web listening at http://${host}:${port}\n`);
        process.stdout.write(
          `Model: ${config.model}; API key configured: ${config.apiKey !== undefined}\n`,
        );
        resolve();
      });
    });
  } catch (error) {
    await releaseLeaseOnce();
    throw error;
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `Error: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
