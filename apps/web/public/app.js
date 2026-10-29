import katex from "katex";
import splitAtDelimiters from "katex/contrib/auto-render/splitAtDelimiters.ts";
import { Marked } from "marked";
import { Editor } from "@tiptap/core";
import { Mathematics } from "@tiptap/extension-mathematics";
import { Markdown } from "@tiptap/markdown";
import Placeholder from "@tiptap/extension-placeholder";
import StarterKit from "@tiptap/starter-kit";

const elements = {
  cancelFork: document.querySelector("#cancel-fork"),
  composer: document.querySelector("#composer"),
  empty: document.querySelector("#empty-state"),
  log: document.querySelector("#activity-log"),
  messages: document.querySelector("#messages"),
  newSession: document.querySelector("#new-session"),
  prompt: document.querySelector("#prompt"),
  send: document.querySelector("#send"),
  stop: document.querySelector("#stop"),
  sessionList: document.querySelector("#session-list"),
  status: document.querySelector("#status"),
};

const state = {
  sessionId: null,
  headTurnId: null,
  running: false,
  canContinue: true,
  canStop: false,
  assistantNodes: new Map(),
  reasoningNodes: new Map(),
  userMessages: new Map(),
  editingTurnId: null,
  forkSourceTurnId: null,
  pollTimer: null,
  streamAbortController: null,
  stopRequested: false,
};
const SESSION_STORAGE_KEY = "mas-chat.session-id";
const markdownEditors = new WeakMap();
const mathDelimiters = [
  { left: "$$", right: "$$", display: true },
  { left: "\\[", right: "\\]", display: true },
  { left: "\\(", right: "\\)", display: false },
  { left: "$", right: "$", display: false },
];
const richTextMarkdown = new Marked({
  breaks: true,
  gfm: true,
  renderer: { html: ({ text }) => escapeHtml(text) },
  extensions: [createMathExtension("block"), createMathExtension("inline")],
});

function visibleOffsetAtCursor(source, rendered, cursor) {
  let renderedOffset = 0;
  for (const character of source.slice(0, cursor)) {
    if (character === rendered[renderedOffset]) renderedOffset += 1;
  }
  return renderedOffset;
}

function parseMarkdownAtCursor(editor) {
  const { selection } = editor.state;
  if (!selection.empty) return null;
  const { $from } = selection;
  const block = $from.parent;
  if (!block.isTextblock || block.type.name === "codeBlock") return null;
  let textNode = null;
  let textOffset = 0;
  block.forEach((node, offset) => {
    if (!node.isText || node.marks.length > 0) return;
    if ($from.parentOffset < offset || $from.parentOffset > offset + node.nodeSize) return;
    textNode = node;
    textOffset = offset;
  });
  if (!textNode) return null;

  const source = textNode.text.trim();
  if (!source) return null;
  const leadingWhitespace = textNode.text.length - textNode.text.trimStart().length;
  const contentStart = $from.start() + textOffset + leadingWhitespace;
  const contentEnd = contentStart + source.length;
  if ($from.pos < contentStart || $from.pos > contentEnd) return null;
  const parsedDocument = editor.schema.nodeFromJSON(editor.markdown.parse(source));
  const parsedBlock = parsedDocument.firstChild;
  if (parsedDocument.childCount !== 1 || parsedBlock?.type.name !== "paragraph") return null;
  const originalContent = block.content.cut(contentStart - $from.start(), contentEnd - $from.start());
  if (parsedBlock.content.eq(originalContent)) return null;

  const cursorOffset = $from.pos - contentStart;
  const nextCursor = contentStart + visibleOffsetAtCursor(source, parsedBlock.textContent, cursorOffset);
  return { parsedBlock, contentStart, contentEnd, nextCursor };
}

function normalizeMarkdownInput(editor) {
  const parsed = parseMarkdownAtCursor(editor);
  if (!parsed) return;
  editor.chain()
    .command(({ tr }) => {
      tr.replaceWith(parsed.contentStart, parsed.contentEnd, parsed.parsedBlock.content);
      return true;
    })
    .setTextSelection(parsed.nextCursor)
    .command(({ tr }) => {
      tr.setStoredMarks(tr.selection.$from.marks());
      return true;
    })
    .run();
}

function insertSpaceAndExitMarks(view, from, to) {
  if (from !== to || view.composing) return false;
  const activeMarks = view.state.storedMarks ?? view.state.doc.resolve(from).marks();
  if (activeMarks.length === 0 || activeMarks.some((mark) => mark.type.spec.code)) return false;
  view.dispatch(view.state.tr
    .setStoredMarks([])
    .insertText(" ", from, to)
    .setStoredMarks([])
    .scrollIntoView());
  return true;
}

function createMarkdownEditor(host, { initialValue = "", minHeight = "30px", onSubmit, onCancel } = {}) {
  let editor;
  let skipNormalization = false;
  let normalizing = false;
  let compositionActive = false;
  let compositionEndTimer = null;
  let hasPendingInput = false;

  function flushMarkdownInput() {
    if (!hasPendingInput || normalizing || compositionActive || editor.isDestroyed || editor.view.composing) return;
    hasPendingInput = false;
    normalizing = true;
    try {
      if (editor.isEmpty) {
        if (editor.state.storedMarks?.length) {
          editor.view.dispatch(editor.state.tr.setStoredMarks([]));
        }
      } else if (!skipNormalization) {
        normalizeMarkdownInput(editor);
      }
    } finally {
      normalizing = false;
    }
  }

  function beginComposition() {
    compositionActive = true;
    window.clearTimeout(compositionEndTimer);
    compositionEndTimer = null;
    return false;
  }

  const mathematics = Mathematics.configure({
    inlineOptions: {
      onClick: (node, pos) => {
        if (!editor) return;
        skipNormalization = true;
        editor.chain().focus().insertContentAt(
          { from: pos, to: pos + node.nodeSize },
          `$${node.attrs.latex}$`,
        ).run();
        queueMicrotask(() => { skipNormalization = false; });
      },
    },
    katexOptions: { throwOnError: false },
  });
  editor = new Editor({
    element: host,
    injectCSS: false,
    extensions: [
      StarterKit,
      Markdown,
      mathematics,
      Placeholder.configure({ placeholder: "输入消息……" }),
    ],
    content: initialValue,
    contentType: "markdown",
    autofocus: false,
    editorProps: {
      attributes: {
        class: "tiptap-editor",
        role: "textbox",
        "aria-multiline": "true",
      },
      handleDOMEvents: {
        compositionstart: beginComposition,
        compositionupdate: beginComposition,
        compositionend: () => {
          window.clearTimeout(compositionEndTimer);
          compositionEndTimer = window.setTimeout(() => {
            compositionEndTimer = null;
            compositionActive = false;
            flushMarkdownInput();
          }, 30);
          return false;
        },
      },
      handleTextInput: (view, from, to, text) => {
        if (compositionActive || (text !== " " && text !== "\u00a0")) return false;
        return insertSpaceAndExitMarks(view, from, to);
      },
      handleKeyDown: (view, event) => {
        if (compositionActive || event.isComposing || view.composing || event.keyCode === 229) return false;
        if (event.key === " " && !event.ctrlKey && !event.metaKey && !event.altKey) {
          const { from, to } = view.state.selection;
          if (insertSpaceAndExitMarks(view, from, to)) return true;
        }
        if (event.key === "Escape" && view.state.selection.empty) {
          const activeMarks = view.state.storedMarks ?? view.state.selection.$from.marks();
          if (activeMarks.length > 0) {
            view.dispatch(view.state.tr.setStoredMarks([]));
            return true;
          }
        }
        if (event.key === "Escape" && onCancel) {
          onCancel();
          return true;
        }
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
          skipNormalization = true;
          window.setTimeout(() => { skipNormalization = false; }, 0);
        }
        return false;
      },
    },
  });
  editor.on("update", ({ transaction }) => {
    if (normalizing || !transaction.docChanged) return;
    hasPendingInput = true;
    flushMarkdownInput();
  });
  editor.on("destroy", () => {
    window.clearTimeout(compositionEndTimer);
  });
  host.style.setProperty("--editor-min-height", minHeight);
  host.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.shiftKey || event.isComposing || event.keyCode === 229 || compositionActive || editor.view.composing) return;
    event.preventDefault();
    event.stopPropagation();
    onSubmit?.();
  }, true);
  markdownEditors.set(host, editor);
  return editor;
}

function destroyMarkdownEditor(host) {
  markdownEditors.get(host)?.destroy();
  markdownEditors.delete(host);
}

const promptEditor = createMarkdownEditor(elements.prompt, {
  onSubmit: () => elements.composer.requestSubmit(),
});

function headStorageKey(sessionId) {
  return `mas-chat.session-head.${sessionId}`;
}

function escapeHtml(source) {
  return source.replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function createMathExtension(level) {
  const name = level === "block" ? "blockMath" : "inlineMath";
  return {
    name,
    level,
    start(source) {
      const pattern = level === "block" ? /^ {0,3}(?:\$\$|\\\[)/m : /\$|\\[([]/;
      const index = source.search(pattern);
      return index < 0 ? undefined : index;
    },
    tokenizer(source) {
      const indentation = level === "block" ? source.match(/^ {0,3}/)[0].length : 0;
      const mathSource = source.slice(indentation);
      const delimiter = mathDelimiters.find((entry) => mathSource.startsWith(entry.left));
      if (!delimiter || (level === "block" && !delimiter.display)) return;
      const [formula] = splitAtDelimiters(mathSource, [delimiter]);
      if (formula?.type !== "math" || !formula.data.trim()) return;
      if (delimiter.left === "$" && /\n|^\s|\s$/.test(formula.data)) return;
      if (level === "block" && !/^[ \t]*(?:\n|$)/.test(mathSource.slice(formula.rawData.length))) return;
      return {
        type: name,
        raw: source.slice(0, indentation + formula.rawData.length),
        text: formula.data,
        display: formula.display,
      };
    },
    renderer(token) {
      const tag = level === "block" ? "div" : "span";
      return `<${tag} class="rendered-math" data-latex="${escapeHtml(token.text)}" data-display="${token.display}"></${tag}>`;
    },
  };
}

function sanitizeFragment(fragment) {
  const blockedTags = new Set(["SCRIPT", "IFRAME", "OBJECT", "EMBED", "STYLE", "LINK"]);
  for (const element of fragment.querySelectorAll("*")) {
    if (blockedTags.has(element.tagName)) {
      element.remove();
      continue;
    }
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase();
      const value = attribute.value.trim();
      if (name.startsWith("on")) {
        element.removeAttribute(attribute.name);
      } else if ((name === "href" || name === "src") && /^(?:javascript|vbscript|data):/i.test(value)) {
        element.removeAttribute(attribute.name);
      }
    }
  }
}

function renderRichText(element, source) {
  const template = document.createElement("template");
  template.innerHTML = richTextMarkdown.parse(source);
  sanitizeFragment(template.content);
  element.replaceChildren(template.content.cloneNode(true));
  for (const math of element.querySelectorAll(".rendered-math")) {
    katex.render(math.dataset.latex, math, {
      displayMode: math.dataset.display === "true",
      output: "htmlAndMathml",
      throwOnError: false,
      trust: false,
    });
  }
}

function setStatus(status) {
  elements.status.textContent = status;
  elements.cancelFork.hidden = state.forkSourceTurnId === null;
}

function updateComposerState() {
  const disabled = state.running || !state.canContinue || state.editingTurnId !== null;
  promptEditor.setEditable(!disabled);
  elements.prompt.toggleAttribute("inert", disabled);
  elements.prompt.setAttribute("aria-disabled", String(disabled));
  elements.send.disabled = disabled;
  elements.send.hidden = state.canStop;
  elements.stop.hidden = !state.canStop;
  elements.stop.disabled = !state.canStop || state.stopRequested;
}

function formatSessionOption(session) {
  const preview = session.preview || "空会话";
  const date = new Date(session.updatedAt);
  const when = Number.isNaN(date.valueOf()) ? "" : ` · ${date.toLocaleString()}`;
  return `${preview}${when}`;
}

async function refreshSessionList() {
  const result = await requestJson("/api/sessions");
  elements.sessionList.replaceChildren();
  for (const session of result.sessions ?? []) {
    const option = document.createElement("div");
    option.className = "session-option";
    option.dataset.sessionId = session.sessionId;
    option.setAttribute("role", "option");
    option.setAttribute("aria-selected", String(session.sessionId === state.sessionId));
    option.classList.toggle("selected", session.sessionId === state.sessionId);
    option.title = session.sessionId;
    const open = document.createElement("button");
    open.type = "button";
    open.className = "session-open";
    open.dataset.sessionId = session.sessionId;
    const preview = document.createElement("span");
    preview.className = "session-option-preview";
    preview.textContent = session.preview || "空会话";
    const meta = document.createElement("span");
    meta.className = "session-option-meta";
    const date = new Date(session.updatedAt);
    meta.textContent = Number.isNaN(date.valueOf()) ? "" : date.toLocaleString();
    open.append(preview, meta);
    const archive = document.createElement("button");
    archive.type = "button";
    archive.className = "session-archive-button";
    archive.dataset.action = "archive";
    archive.dataset.sessionId = session.sessionId;
    archive.setAttribute("aria-label", "归档会话");
    archive.title = "归档会话";
    archive.textContent = "↓";
    option.append(open, archive);
    elements.sessionList.append(option);
  }
}

function addActivity(label, text = "") {
  const follow = elements.log.scrollHeight - elements.log.scrollTop - elements.log.clientHeight < 36;
  const row = document.createElement("div");
  row.className = "activity-entry";
  const strong = document.createElement("strong");
  strong.textContent = label;
  row.append(strong);
  const content = document.createElement("div");
  content.className = "activity-content";
  if (text) {
    renderRichText(content, text);
    row.append(content);
  }
  elements.log.append(row);
  if (follow) elements.log.scrollTop = elements.log.scrollHeight;
  return content;
}

function updateReasoning(event) {
  if (!event.delta) return;
  const key = JSON.stringify([event.responseId, event.itemId]);
  let node = state.reasoningNodes.get(key);
  if (!node) {
    node = {
      content: addActivity("推理摘要", event.delta),
      raw: event.delta,
      sequenceNumber: event.sequenceNumber,
    };
    state.reasoningNodes.set(key, node);
    return;
  }
  if (event.sequenceNumber <= node.sequenceNumber) return;
  const follow = elements.log.scrollHeight - elements.log.scrollTop - elements.log.clientHeight < 36;
  node.raw += event.delta;
  node.sequenceNumber = event.sequenceNumber;
  renderRichText(node.content, node.raw);
  if (follow) elements.log.scrollTop = elements.log.scrollHeight;
}

function clearActivityLog() {
  elements.log.replaceChildren();
  state.reasoningNodes.clear();
}

function clearConversation() {
  closeEditTurn();
  elements.messages.replaceChildren();
  elements.empty = null;
  state.assistantNodes.clear();
  state.userMessages.clear();
}

function addResponseStatus(message) {
  const follow = elements.messages.scrollHeight - elements.messages.scrollTop - elements.messages.clientHeight < 80;
  const row = document.createElement("div");
  row.className = "response-status";
  row.dataset.messageId = message.id;
  row.dataset.status = message.turnStatus;
  row.setAttribute("role", "status");
  const indicator = document.createElement("span");
  indicator.className = "response-status-indicator";
  indicator.setAttribute("aria-hidden", "true");
  const label = document.createElement("span");
  label.textContent = message.text;
  row.append(indicator, label);
  elements.messages.append(row);
  if (follow) elements.messages.scrollTop = elements.messages.scrollHeight;
}

function addMessage(message) {
  if (message.kind === "status") {
    return addResponseStatus(message);
  }
  const follow = elements.messages.scrollHeight - elements.messages.scrollTop - elements.messages.clientHeight < 80;
  const wrapper = document.createElement("article");
  wrapper.className = `message ${message.role}${message.phase === "commentary" ? " commentary" : ""}`;
  wrapper.dataset.messageId = message.id;
  const bubble = document.createElement("div");
  bubble.className = "message-bubble";
  const node = { wrapper, bubble, raw: message.text };
  renderRichText(bubble, node.raw);
  wrapper.append(bubble);
  if (message.role === "user" && message.turnId) {
    state.userMessages.set(message.turnId, {
      bubble,
      text: message.text,
      wrapper,
    });
    const actions = document.createElement("div");
    actions.className = "message-actions";

    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "message-action";
    edit.dataset.action = "edit";
    edit.dataset.turnId = message.turnId;
    edit.textContent = "编辑";
    edit.disabled = message.retryable === false;
    actions.append(edit);

    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "message-action";
    retry.dataset.action = "retry";
    retry.dataset.turnId = message.turnId;
    retry.textContent = message.turnStatus === "completed" ? "重新生成" : "重试";
    retry.disabled = message.retryable === false;
    actions.append(retry);

    const fork = document.createElement("button");
    fork.type = "button";
    fork.className = "message-action";
    fork.dataset.action = "fork";
    fork.dataset.turnId = message.turnId;
    fork.textContent = "分支";
    fork.disabled = message.forkable !== true;
    actions.append(fork);

    if (Array.isArray(message.versions) && message.versions.length > 1) {
      const index = message.versionIndex ?? 0;
      const previous = document.createElement("button");
      previous.type = "button";
      previous.className = "message-action icon-action";
      previous.dataset.action = "switch-version";
      previous.dataset.headTurnId = message.versions[Math.max(0, index - 1)].headTurnId;
      previous.textContent = "‹";
      previous.title = "上一个版本";
      previous.disabled = index <= 0;

      const counter = document.createElement("span");
      counter.className = "version-counter";
      counter.textContent = `${index + 1} / ${message.versions.length}`;

      const next = document.createElement("button");
      next.type = "button";
      next.className = "message-action icon-action";
      next.dataset.action = "switch-version";
      next.dataset.headTurnId = message.versions[Math.min(message.versions.length - 1, index + 1)].headTurnId;
      next.textContent = "›";
      next.title = "下一个版本";
      next.disabled = index >= message.versions.length - 1;
      actions.append(previous, counter, next);
    }

    if (message.turnStatus && message.turnStatus !== "completed") {
      const status = document.createElement("span");
      status.className = "turn-status";
      status.textContent = message.turnStatus;
      actions.append(status);
    }
    wrapper.append(actions);
  }
  if (message.partial) {
    wrapper.classList.add("partial");
  }
  elements.messages.append(wrapper);
  if (follow) elements.messages.scrollTop = elements.messages.scrollHeight;
  return node;
}

function scrollMessagesToBottom() {
  elements.messages.scrollTop = elements.messages.scrollHeight;
}

function closeEditTurn() {
  if (state.editingTurnId === null) return;
  const message = state.userMessages.get(state.editingTurnId);
  if (message) {
    const form = message.wrapper.querySelector(".message-edit-form");
    const input = form?.querySelector(".message-edit-input");
    if (input) destroyMarkdownEditor(input);
    form?.remove();
    message.bubble.hidden = false;
    const actions = message.wrapper.querySelector(".message-actions");
    if (actions) actions.hidden = false;
  }
  state.editingTurnId = null;
  updateComposerState();
}

function beginEditTurn(turnId) {
  if (state.running) return;
  closeEditTurn();
  const message = state.userMessages.get(turnId);
  if (!message) return;

  const form = document.createElement("form");
  form.className = "message-edit-form";
  form.dataset.turnId = turnId;
  const input = document.createElement("div");
  input.className = "message-edit-input markdown-editor-host";
  input.setAttribute("aria-label", "编辑消息");

  const footer = document.createElement("div");
  footer.className = "message-edit-actions";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "button secondary compact";
  cancel.dataset.action = "cancel-edit";
  cancel.textContent = "取消";
  const submit = document.createElement("button");
  submit.type = "submit";
  submit.className = "button primary icon-button";
  submit.setAttribute("aria-label", "发送修改");
  submit.title = "发送修改";
  submit.append(elements.send.querySelector("svg").cloneNode(true));
  footer.append(cancel, submit);
  form.append(input, footer);

  message.bubble.hidden = true;
  const actions = message.wrapper.querySelector(".message-actions");
  if (actions) actions.hidden = true;
  message.wrapper.prepend(form);
  const editor = createMarkdownEditor(input, {
    initialValue: message.text,
    minHeight: "96px",
    onSubmit: () => form.requestSubmit(),
    onCancel: () => {
      closeEditTurn();
      promptEditor.commands.focus();
    },
  });
  state.editingTurnId = turnId;
  updateComposerState();
  editor.commands.focus("end");
}

function prepareForkDisplay(turnId, prompt) {
  const message = state.userMessages.get(turnId);
  if (!message) return;
  closeEditTurn();
  message.text = prompt;
  renderRichText(message.bubble, prompt);
  let sibling = message.wrapper.nextElementSibling;
  while (sibling) {
    const next = sibling.nextElementSibling;
    sibling.remove();
    sibling = next;
  }
  state.assistantNodes.clear();
}

function renderSession(view) {
  state.forkSourceTurnId = null;
  state.headTurnId = view.headTurnId;
  state.canContinue = view.canContinue;
  state.canStop = view.recovery === "attachable" || view.recovery === "running";
  if (state.sessionId && state.headTurnId) {
    localStorage.setItem(headStorageKey(state.sessionId), state.headTurnId);
  }
  clearConversation();
  if (view.messages.length === 0) {
    const empty = document.createElement("section");
    empty.className = "empty-state";
    empty.innerHTML = "<h2>从一个想法开始</h2><p>这里保留本地会话和 Responses 原生事件；输入一句话即可开始。</p>";
    elements.messages.append(empty);
  } else {
    view.messages.forEach(addMessage);
  }
  setStatus(view.status);
  updateComposerState();
  requestAnimationFrame(scrollMessagesToBottom);
}

function updateAssistant(event) {
  let node = state.assistantNodes.get(event.itemId);
  if (!node) {
    const message = addMessage({
      id: event.itemId,
      role: "assistant",
      text: "",
      phase: event.phase,
    });
    node = message;
    state.assistantNodes.set(event.itemId, node);
  }
  if (event.phase === "commentary") {
    node.wrapper.classList.add("commentary");
  }
  if (typeof event.delta === "string") {
    const follow = elements.messages.scrollHeight - elements.messages.scrollTop - elements.messages.clientHeight < 80;
    node.raw += event.delta;
    renderRichText(node.bubble, node.raw);
    if (follow) elements.messages.scrollTop = elements.messages.scrollHeight;
  }
}

function handleEvent(event) {
  if (event.kind === "lifecycle") {
    setStatus(event.status);
    addActivity("状态", event.status);
  } else if (event.kind === "assistant_text") {
    updateAssistant(event);
  } else if (event.kind === "reasoning") {
    updateReasoning(event);
  } else if (event.kind === "tool") {
    addActivity("工具", `${event.toolType} · ${event.status}`);
  } else if (event.kind === "terminal") {
    setStatus(event.status);
    addActivity("结束", event.status);
  } else if (event.kind === "error") {
    const message = event.error?.message || "stream error";
    addActivity("错误", message);
  }
}

async function requestJson(url, options) {
  const response = await fetch(url, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body.error?.message || `HTTP ${response.status}`);
  }
  return body;
}

async function consumeSse(response) {
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error?.message || `Stream failed: HTTP ${response.status}`);
  }
  if (!response.body) {
    throw new Error("Stream failed: response has no body");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let terminal = false;
  let streamError = null;
  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    const frames = buffer.split("\n\n");
    buffer = frames.pop() || "";
    for (const frame of frames) {
      const data = frame.split("\n").find((line) => line.startsWith("data: "));
      if (!data) continue;
      const event = JSON.parse(data.slice(6));
      handleEvent(event);
      terminal ||= event.kind === "terminal";
      if (event.kind === "error") {
        streamError = event.error?.message || "stream error";
      }
    }
    if (done) break;
  }
  if (streamError !== null) {
    throw new Error(streamError);
  }
  return { terminal };
}

async function attachIfNeeded(view) {
  if (view.recovery === "running") {
    state.pollTimer = setTimeout(() => {
      if (!state.running) loadSession(state.headTurnId).catch((error) => addActivity("错误", error.message));
    }, 1500);
    return;
  }
  if (view.recovery !== "attachable") return;
  state.running = true;
  const abortController = new AbortController();
  state.streamAbortController = abortController;
  updateComposerState();
  try {
    addActivity("连接", "尝试恢复运行中的响应");
    const result = await consumeSse(await fetch(
      `/api/sessions/${state.sessionId}/attach`,
      { signal: abortController.signal },
    ));
    if (result.terminal) {
      state.headTurnId = null;
      await loadSession(null);
    }
  } catch (error) {
    addActivity("连接", error.message);
    try {
      await loadSession(null, { recover: false });
    } catch (reloadError) {
      addActivity("恢复", reloadError.message);
    }
  } finally {
    if (state.streamAbortController === abortController) {
      state.streamAbortController = null;
    }
    state.running = false;
    updateComposerState();
  }
}

async function loadSession(headTurnId = state.headTurnId, options = {}) {
  if (state.pollTimer !== null) {
    clearTimeout(state.pollTimer);
    state.pollTimer = null;
  }
  const query = headTurnId ? `?head=${encodeURIComponent(headTurnId)}` : "";
  let view;
  try {
    view = await requestJson(`/api/sessions/${state.sessionId}${query}`);
  } catch (error) {
    if (!headTurnId || !/unknown visible turn/i.test(error.message)) {
      throw error;
    }
    state.headTurnId = null;
    localStorage.removeItem(headStorageKey(state.sessionId));
    view = await requestJson(`/api/sessions/${state.sessionId}`);
  }
  renderSession(view);
  if (options.recover !== false) {
    await attachIfNeeded(view);
  }
  await refreshSessionList();
}

async function createSession() {
  const result = await requestJson("/api/sessions", { method: "POST" });
  state.sessionId = result.sessionId;
  state.headTurnId = null;
  localStorage.setItem(SESSION_STORAGE_KEY, state.sessionId);
  await loadSession();
}

async function sendPrompt(event) {
  event.preventDefault();
  if (state.running) return;
  const prompt = promptEditor.getMarkdown().trim();
  if (!prompt) return;
  state.running = true;
  state.canStop = true;
  updateComposerState();
  addMessage({ id: `local-user-${Date.now()}`, role: "user", text: prompt });
  promptEditor.commands.clearContent(false);
  clearActivityLog();
  setStatus("in_progress");
  const abortController = new AbortController();
  state.streamAbortController = abortController;
  try {
    const endpoint = state.forkSourceTurnId
      ? `/api/sessions/${state.sessionId}/turns/${encodeURIComponent(state.forkSourceTurnId)}/fork`
      : `/api/sessions/${state.sessionId}/turn`;
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: abortController.signal,
      body: JSON.stringify(
        state.forkSourceTurnId
          ? { prompt }
          : { prompt, parentTurnId: state.headTurnId },
      ),
    });
    if (state.forkSourceTurnId && response.ok) {
      const forkedSessionId = response.headers.get("X-MAS-Chat-Session-Id");
      if (!forkedSessionId) {
        throw new Error("Fork response did not provide a session ID");
      }
      state.sessionId = forkedSessionId;
      state.headTurnId = null;
      localStorage.setItem(SESSION_STORAGE_KEY, forkedSessionId);
    }
    await consumeSse(response);
    state.forkSourceTurnId = null;
    state.headTurnId = null;
    await loadSession(null, { recover: false });
  } catch (error) {
    addActivity("错误", error.message);
    state.headTurnId = null;
    try {
      await loadSession(null, { recover: false });
    } catch (reloadError) {
      setStatus("failed");
      addActivity("恢复", reloadError.message);
    }
  } finally {
    if (state.streamAbortController === abortController) {
      state.streamAbortController = null;
    }
    state.running = false;
    updateComposerState();
    promptEditor.commands.focus();
  }
}

async function retryTurn(turnId) {
  if (state.running) return;
  state.running = true;
  state.canStop = true;
  updateComposerState();
  clearActivityLog();
  addActivity("重试", "从该用户消息重新生成");
  const prompt = state.userMessages.get(turnId)?.text;
  if (prompt) prepareForkDisplay(turnId, prompt);
  const abortController = new AbortController();
  state.streamAbortController = abortController;
  try {
    await consumeSse(await fetch(
      `/api/sessions/${state.sessionId}/turns/${encodeURIComponent(turnId)}/retry`,
      { method: "POST", signal: abortController.signal },
    ));
    state.headTurnId = null;
    await loadSession(null, { recover: false });
  } catch (error) {
    addActivity("错误", error.message);
    state.headTurnId = null;
    try {
      await loadSession(null, { recover: false });
    } catch (reloadError) {
      addActivity("恢复", reloadError.message);
    }
  } finally {
    if (state.streamAbortController === abortController) {
      state.streamAbortController = null;
    }
    state.running = false;
    updateComposerState();
    promptEditor.commands.focus();
  }
}

async function editTurn(turnId, prompt) {
  if (state.running) return;
  state.running = true;
  state.canStop = true;
  prepareForkDisplay(turnId, prompt);
  updateComposerState();
  clearActivityLog();
  addActivity("编辑", "从修改后的用户消息重新生成");
  const abortController = new AbortController();
  state.streamAbortController = abortController;
  try {
    await consumeSse(await fetch(
      `/api/sessions/${state.sessionId}/turns/${encodeURIComponent(turnId)}/edit`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: abortController.signal,
        body: JSON.stringify({ prompt }),
      },
    ));
    state.headTurnId = null;
    await loadSession(null, { recover: false });
  } catch (error) {
    addActivity("错误", error.message);
    state.headTurnId = null;
    try {
      await loadSession(null, { recover: false });
    } catch (reloadError) {
      addActivity("恢复", reloadError.message);
    }
  } finally {
    if (state.streamAbortController === abortController) {
      state.streamAbortController = null;
    }
    state.running = false;
    updateComposerState();
    promptEditor.commands.focus();
  }
}

async function stopGeneration() {
  if (!state.sessionId || (!state.running && !state.canStop)) return;
  state.stopRequested = true;
  updateComposerState();
  addActivity("停止", "正在停止生成");
  let remoteStopped = false;
  try {
    const result = await requestJson(`/api/sessions/${state.sessionId}/cancel`, {
      method: "POST",
    });
    remoteStopped = result.kind === "terminal" || result.status === "cancelled";
    addActivity("停止", "生成已停止");
  } catch (error) {
    addActivity("停止", error.message);
  } finally {
    state.streamAbortController?.abort();
    state.streamAbortController = null;
    state.running = false;
    state.canStop = false;
    state.stopRequested = false;
    try {
      await loadSession(null, { recover: false });
    } catch (reloadError) {
      addActivity("恢复", reloadError.message);
    }
    if (!remoteStopped) {
      addActivity("停止", "已断开当前生成连接");
    }
    updateComposerState();
  }
}

elements.composer.addEventListener("submit", sendPrompt);
elements.stop.addEventListener("click", stopGeneration);
elements.newSession.addEventListener("click", async () => {
  if (state.running) return;
  try {
    await createSession();
    clearActivityLog();
    promptEditor.commands.focus();
  } catch (error) {
    addActivity("错误", error.message);
  }
});
elements.cancelFork.addEventListener("click", async () => {
  state.forkSourceTurnId = null;
  await loadSession(null);
  promptEditor.commands.focus();
});
elements.sessionList.addEventListener("click", async (event) => {
  const archiveButton = event.target.closest("button[data-action=archive]");
  const target = event.target.closest("[data-session-id]");
  const sessionId = archiveButton?.dataset.sessionId ?? target?.dataset.sessionId;
  if (archiveButton) {
    if (!sessionId) return;
    const shouldArchive = window.confirm(
      state.running && sessionId === state.sessionId
        ? "当前会话正在生成，归档后将无法继续当前生成。确定归档吗？"
        : "确定归档这个会话吗？",
    );
    if (!shouldArchive) return;
    try {
      await requestJson(`/api/sessions/${encodeURIComponent(sessionId)}/archive`, { method: "POST" });
      if (sessionId === state.sessionId) {
        state.sessionId = null;
        localStorage.removeItem(SESSION_STORAGE_KEY);
        await createSession();
      } else await refreshSessionList();
    } catch (error) { addActivity("归档", error.message); }
    return;
  }
  if (!sessionId || state.running) return;
  state.sessionId = sessionId;
  state.headTurnId = localStorage.getItem(headStorageKey(sessionId));
  localStorage.setItem(SESSION_STORAGE_KEY, sessionId);
  clearActivityLog();
  try {
    await loadSession();
    promptEditor.commands.focus();
  } catch (error) {
    addActivity("错误", error.message);
  }
});
elements.messages.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button || state.running) return;
  if (button.dataset.action === "edit" && button.dataset.turnId) {
    beginEditTurn(button.dataset.turnId);
  } else if (button.dataset.action === "cancel-edit") {
    closeEditTurn();
    promptEditor.commands.focus();
  } else if (button.dataset.action === "retry" && button.dataset.turnId) {
    await retryTurn(button.dataset.turnId);
  } else if (button.dataset.action === "fork" && button.dataset.turnId) {
    await loadSession(button.dataset.turnId);
    state.forkSourceTurnId = button.dataset.turnId;
    setStatus(elements.status.textContent);
    promptEditor.commands.focus();
  } else if (button.dataset.action === "switch-version" && button.dataset.headTurnId) {
    state.headTurnId = button.dataset.headTurnId;
    await loadSession(state.headTurnId);
  }
});
elements.messages.addEventListener("submit", async (event) => {
  const form = event.target.closest("form.message-edit-form");
  if (!form || state.running) return;
  event.preventDefault();
  const input = form.querySelector(".message-edit-input");
  const prompt = input ? markdownEditors.get(input)?.getMarkdown().trim() : "";
  if (!prompt || !form.dataset.turnId) return;
  await editTurn(form.dataset.turnId, prompt);
});
async function boot() {
  try {
    await requestJson("/api/health");
    // The model/config status is intentionally not displayed in the chat shell.
    const savedSessionId = localStorage.getItem(SESSION_STORAGE_KEY);
    if (savedSessionId) {
      state.sessionId = savedSessionId;
      state.headTurnId = localStorage.getItem(headStorageKey(savedSessionId));
      try {
        await loadSession();
      } catch {
        await createSession();
      }
    } else {
      await createSession();
    }
    promptEditor.commands.focus();
  } catch (error) {
    addActivity("错误", error.message);
  }
}

boot();
