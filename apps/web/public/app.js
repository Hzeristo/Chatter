import katex from "katex";
import { marked } from "marked";

const elements = {
  badge: document.querySelector("#config-badge"),
  cancelFork: document.querySelector("#cancel-fork"),
  composer: document.querySelector("#composer"),
  empty: document.querySelector("#empty-state"),
  log: document.querySelector("#activity-log"),
  messages: document.querySelector("#messages"),
  newSession: document.querySelector("#new-session"),
  prompt: document.querySelector("#prompt"),
  promptPreview: document.querySelector("#prompt-preview"),
  send: document.querySelector("#send"),
  stop: document.querySelector("#stop"),
  sessionSelect: document.querySelector("#session-select"),
  sessionLabel: document.querySelector("#session-label"),
  status: document.querySelector("#status"),
};

const state = {
  sessionId: null,
  headTurnId: null,
  running: false,
  canContinue: true,
  canStop: false,
  assistantNodes: new Map(),
  userMessages: new Map(),
  editingTurnId: null,
  forkSourceTurnId: null,
  pollTimer: null,
  streamAbortController: null,
  stopRequested: false,
};
const SESSION_STORAGE_KEY = "mas-chat.session-id";

function headStorageKey(sessionId) {
  return `mas-chat.session-head.${sessionId}`;
}

function escapedMarkdownSource(source) {
  // Raw HTML is not part of the chat rendering contract. Escaping `<` keeps
  // Markdown syntax (including blockquotes) while preventing HTML injection.
  return source.replaceAll("&", "&amp;").replaceAll("<", "&lt;");
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

function renderInlineMath(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const textNodes = [];
  let current;
  while ((current = walker.nextNode())) {
    const parent = current.parentElement;
    if (parent && !parent.closest("code, pre, .katex")) {
      textNodes.push(current);
    }
  }

  const pattern = /\\\(([\s\S]+?)\\\)|(?<!\\)\$([^$\n]+?)(?<!\\)\$/g;
  for (const textNode of textNodes) {
    const source = textNode.nodeValue ?? "";
    pattern.lastIndex = 0;
    let lastIndex = 0;
    let changed = false;
    const replacement = document.createDocumentFragment();
    let match;
    while ((match = pattern.exec(source)) !== null) {
      const tex = match[1] ?? match[2];
      if (tex === undefined || tex.trim() === "") continue;
      changed = true;
      if (match.index > lastIndex) {
        replacement.append(source.slice(lastIndex, match.index));
      }
      const math = document.createElement("span");
      math.innerHTML = katex.renderToString(tex, {
        displayMode: false,
        output: "htmlAndMathml",
        throwOnError: false,
      });
      replacement.append(...math.childNodes);
      lastIndex = pattern.lastIndex;
    }
    if (!changed) continue;
    if (lastIndex < source.length) replacement.append(source.slice(lastIndex));
    textNode.replaceWith(replacement);
  }
}

function renderRichText(element, source) {
  const html = marked.parse(escapedMarkdownSource(source), {
    breaks: true,
    gfm: true,
  });
  const template = document.createElement("template");
  template.innerHTML = html;
  sanitizeFragment(template.content);
  element.replaceChildren(template.content.cloneNode(true));
  renderInlineMath(element);
}

function setStatus(status) {
  elements.status.textContent = status;
  elements.sessionLabel.textContent = state.forkSourceTurnId
    ? `从 ${state.forkSourceTurnId.slice(0, 8)} 分支`
    : state.sessionId
      ? `session ${state.sessionId.slice(0, 8)}`
      : "准备会话中";
  elements.cancelFork.hidden = state.forkSourceTurnId === null;
}

function updateComposerState() {
  const disabled = state.running || !state.canContinue || state.editingTurnId !== null;
  elements.prompt.disabled = disabled;
  elements.send.disabled = disabled;
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
  elements.sessionSelect.replaceChildren();
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "选择已有会话";
  elements.sessionSelect.append(placeholder);
  for (const session of result.sessions) {
    const option = document.createElement("option");
    option.value = session.sessionId;
    option.textContent = formatSessionOption(session);
    option.title = session.sessionId;
    option.selected = session.sessionId === state.sessionId;
    elements.sessionSelect.append(option);
  }
}

function addActivity(label, text = "") {
  const row = document.createElement("div");
  row.className = "activity-entry";
  const strong = document.createElement("strong");
  strong.textContent = label;
  row.append(strong, text ? `  ${text}` : "");
  elements.log.append(row);
  elements.log.scrollTop = elements.log.scrollHeight;
}

function clearConversation() {
  elements.messages.replaceChildren();
  elements.empty = null;
  state.assistantNodes.clear();
  state.userMessages.clear();
  state.editingTurnId = null;
}

function addMessage(message) {
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
  elements.messages.scrollTop = elements.messages.scrollHeight;
  return node;
}

function resizeEditInput(input) {
  input.style.height = "auto";
  input.style.height = `${Math.min(Math.max(input.scrollHeight, 96), 420)}px`;
}

function closeEditTurn() {
  if (state.editingTurnId === null) return;
  const message = state.userMessages.get(state.editingTurnId);
  if (message) {
    message.wrapper.querySelector(".message-edit-form")?.remove();
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
  const input = document.createElement("textarea");
  input.className = "message-edit-input";
  input.value = message.text;
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
  submit.className = "button primary compact";
  submit.textContent = "发送";
  footer.append(cancel, submit);
  form.append(input, footer);

  message.bubble.hidden = true;
  const actions = message.wrapper.querySelector(".message-actions");
  if (actions) actions.hidden = true;
  message.wrapper.prepend(form);
  state.editingTurnId = turnId;
  updateComposerState();
  resizeEditInput(input);
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
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
    node.raw += event.delta;
    renderRichText(node.bubble, node.raw);
    elements.messages.scrollTop = elements.messages.scrollHeight;
  }
}

function updatePromptPreview() {
  const source = elements.prompt.value.trim();
  elements.promptPreview.hidden = source === "";
  if (source !== "") {
    renderRichText(elements.promptPreview, source);
  } else {
    elements.promptPreview.replaceChildren();
  }
}

function handleEvent(event) {
  if (event.kind === "lifecycle") {
    setStatus(event.status);
    addActivity("状态", event.status);
  } else if (event.kind === "assistant_text") {
    updateAssistant(event);
  } else if (event.kind === "reasoning") {
    if (event.delta) addActivity("推理摘要", event.delta);
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
  const view = await requestJson(`/api/sessions/${state.sessionId}${query}`);
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
  const prompt = elements.prompt.value.trim();
  if (!prompt) return;
  state.running = true;
  state.canStop = true;
  updateComposerState();
  addMessage({ id: `local-user-${Date.now()}`, role: "user", text: prompt });
  elements.prompt.value = "";
  updatePromptPreview();
  elements.log.replaceChildren();
  setStatus("in_progress");
  const abortController = new AbortController();
  state.streamAbortController = abortController;
  try {
    const endpoint = state.forkSourceTurnId
      ? `/api/sessions/${state.sessionId}/turns/${encodeURIComponent(state.forkSourceTurnId)}/fork`
      : `/api/sessions/${state.sessionId}/turn`;
    await consumeSse(await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: abortController.signal,
      body: JSON.stringify(
        state.forkSourceTurnId
          ? { prompt }
          : { prompt, parentTurnId: state.headTurnId },
      ),
    }));
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
    elements.prompt.focus();
  }
}

async function retryTurn(turnId) {
  if (state.running) return;
  state.running = true;
  state.canStop = true;
  updateComposerState();
  elements.log.replaceChildren();
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
    elements.prompt.focus();
  }
}

async function editTurn(turnId, prompt) {
  if (state.running) return;
  state.running = true;
  state.canStop = true;
  prepareForkDisplay(turnId, prompt);
  updateComposerState();
  elements.log.replaceChildren();
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
    elements.prompt.focus();
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
    elements.log.replaceChildren();
    elements.prompt.focus();
  } catch (error) {
    addActivity("错误", error.message);
  }
});
elements.cancelFork.addEventListener("click", async () => {
  state.forkSourceTurnId = null;
  await loadSession(null);
  elements.prompt.focus();
});
elements.sessionSelect.addEventListener("change", async () => {
  const sessionId = elements.sessionSelect.value;
  if (!sessionId || state.running) return;
  state.sessionId = sessionId;
  state.headTurnId = localStorage.getItem(headStorageKey(sessionId));
  localStorage.setItem(SESSION_STORAGE_KEY, sessionId);
  elements.log.replaceChildren();
  try {
    await loadSession();
    elements.prompt.focus();
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
    elements.prompt.focus();
  } else if (button.dataset.action === "retry" && button.dataset.turnId) {
    await retryTurn(button.dataset.turnId);
  } else if (button.dataset.action === "fork" && button.dataset.turnId) {
    await loadSession(button.dataset.turnId);
    state.forkSourceTurnId = button.dataset.turnId;
    setStatus(elements.status.textContent);
    elements.prompt.focus();
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
  const prompt = input?.value.trim();
  if (!prompt || !form.dataset.turnId) return;
  await editTurn(form.dataset.turnId, prompt);
});
elements.messages.addEventListener("input", (event) => {
  if (event.target.matches(".message-edit-input")) {
    resizeEditInput(event.target);
  }
});
elements.messages.addEventListener("keydown", (event) => {
  if (!event.target.matches(".message-edit-input")) return;
  if (event.key === "Escape") {
    event.preventDefault();
    closeEditTurn();
    elements.prompt.focus();
  } else if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    event.target.form?.requestSubmit();
  }
});
elements.prompt.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    elements.composer.requestSubmit();
  }
});
elements.prompt.addEventListener("input", updatePromptPreview);

async function boot() {
  try {
    const health = await requestJson("/api/health");
    elements.badge.textContent = health.apiKeyConfigured ? health.model : "API key missing";
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
    elements.prompt.focus();
  } catch (error) {
    elements.badge.textContent = "offline";
    addActivity("错误", error.message);
  }
}

boot();
