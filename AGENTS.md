# Repository guidance

## Environment

- Windows is a first-class target. Use PowerShell 7 (`pwsh`) for shell operations and examples.
- Use Node.js 24 and pnpm unless an architecture decision explicitly changes them.
- Never commit API keys, OAuth tokens, cookies, response payloads containing secrets, or local runtime journals.

## Product boundary

This repository implements a thin, OpenAI-native long-running chat runtime. It is not a coding agent.

The core must not automatically:

- inspect the current directory, Git repository, or `AGENTS.md` files;
- expose shell, filesystem, patch, test, browser-control, or computer-use tools;
- create subagents, plans, worktrees, commits, or pull requests;
- inject large hidden prompts or provider-independent agent frameworks.

OpenAI-hosted tools may be enabled explicitly per run. Local tools require a separate architecture decision and must remain opt-in.

## Architecture rules

- Use the official `openai` JavaScript SDK directly. Do not introduce the OpenAI Agents SDK without an explicit decision record.
- Keep `packages/runtime` independent of any CLI, web, desktop, React, Ink, or terminal-rendering library.
- Preserve Responses API structure. Do not flatten reasoning summaries, assistant phases, tool calls, annotations, usage, or terminal statuses into one text string.
- Every Response request must use `store: false`. Do not use `previous_response_id` or Conversations as the source of cross-turn state; replay the complete locally persisted native item history instead.
- Preserve every completed `response.output` item, including encrypted reasoning content and assistant phase values, before allowing the next turn.
- Prefer background streaming. Foreground fallback is allowed only after an explicit HTTP 400 unsupported-`background` error and only when the global policy enables it; never fallback for authentication, rate-limit, model, or network failures.
- Journal the actual execution mode. Foreground runs are not attachable after disconnect and cannot use the server-side cancel endpoint; do not represent them as durable background runs.
- Persist the response ID and highest acknowledged sequence number before acknowledging an event to the UI.
- Treat `sequence_number` as a non-negative monotonic recovery cursor; provider event numbers may be sparse, so a gap is not by itself a protocol error. Ignore duplicate or replayed events idempotently.
- Event replay must be idempotent. Duplicate events after reconnect must not duplicate visible text or tool state.
- Keep the developer prompt short, versioned, visible, and user-editable.
- Treat `response.completed`, `response.failed`, `response.incomplete`, and `response.cancelled` as distinct terminal outcomes.

## Verification

- Unit-test the event reducer with recorded synthetic SSE fixtures.
- Test disconnect and resume from multiple sequence numbers, including duplicate delivery.
- Test cancellation, incomplete responses, tool failures, and a stream ending without a terminal event.
- Live API tests must be opt-in and skipped unless the required environment variable is present.
- Do not claim 30-minute durability until a timed live run has survived a forced client disconnect and resumed without missing or duplicated visible events.

## Change discipline

- Preserve unrelated user changes and local runtime data.
- Prefer small, reviewable commits when commits are requested.
- Update `docs/technical-route.md` when an implementation decision changes a locked architectural boundary.
