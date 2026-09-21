const elements = {
  badge: document.querySelector("#config-badge"),
  composer: document.querySelector("#composer"),
  empty: document.querySelector("#empty-state"),
  log: document.querySelector("#activity-log"),
  messages: document.querySelector("#messages"),
  newSession: document.querySelector("#new-session"),
  prompt: document.querySelector("#prompt"),
  send: document.querySelector("#send"),
  sessionSelect: document.querySelector("#session-select"),
  sessionLabel: document.querySelector("#session-label"),
  status: document.querySelector("#status"),
};

const state = {
  sessionId: null,
  running: false,
  assistantNodes: new Map(),
};
const SESSION_STORAGE_KEY = "mas-chat.session-id";

function setStatus(status) {
  elements.status.textContent = status;
  elements.sessionLabel.textContent = state.sessionId
    ? `session ${state.sessionId.slice(0, 8)}`
    : "准备会话中";
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
}

function addMessage(message) {
  const wrapper = document.createElement("article");
  wrapper.className = `message ${message.role}${message.phase === "commentary" ? " commentary" : ""}`;
  wrapper.dataset.messageId = message.id;
  const bubble = document.createElement("div");
  bubble.className = "message-bubble";
  bubble.textContent = message.text;
  wrapper.append(bubble);
  elements.messages.append(wrapper);
  elements.messages.scrollTop = elements.messages.scrollHeight;
  return { wrapper, bubble };
}

function renderSession(view) {
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
    node.bubble.textContent += event.delta;
    elements.messages.scrollTop = elements.messages.scrollHeight;
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
  if (!response.ok || !response.body) {
    throw new Error(`Stream failed: HTTP ${response.status}`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    const frames = buffer.split("\n\n");
    buffer = frames.pop() || "";
    for (const frame of frames) {
      const data = frame.split("\n").find((line) => line.startsWith("data: "));
      if (!data) continue;
      handleEvent(JSON.parse(data.slice(6)));
    }
    if (done) break;
  }
}

async function attachIfNeeded(view) {
  if (view.status !== "queued" && view.status !== "in_progress") return;
  try {
    addActivity("连接", "尝试恢复运行中的响应");
    await consumeSse(await fetch(`/api/sessions/${state.sessionId}/attach`));
  } catch (error) {
    addActivity("连接", error.message);
  }
}

async function loadSession() {
  const view = await requestJson(`/api/sessions/${state.sessionId}`);
  renderSession(view);
  await attachIfNeeded(view);
  await refreshSessionList();
}

async function createSession() {
  const result = await requestJson("/api/sessions", { method: "POST" });
  state.sessionId = result.sessionId;
  localStorage.setItem(SESSION_STORAGE_KEY, state.sessionId);
  await loadSession();
}

async function sendPrompt(event) {
  event.preventDefault();
  if (state.running) return;
  const prompt = elements.prompt.value.trim();
  if (!prompt) return;
  state.running = true;
  elements.send.disabled = true;
  elements.prompt.disabled = true;
  addMessage({ id: `local-user-${Date.now()}`, role: "user", text: prompt });
  elements.prompt.value = "";
  elements.log.replaceChildren();
  setStatus("in_progress");
  try {
    await consumeSse(await fetch(`/api/sessions/${state.sessionId}/turn`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt }),
    }));
    await loadSession();
  } catch (error) {
    addActivity("错误", error.message);
    setStatus("failed");
  } finally {
    state.running = false;
    elements.send.disabled = false;
    elements.prompt.disabled = false;
    elements.prompt.focus();
  }
}

elements.composer.addEventListener("submit", sendPrompt);
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
elements.sessionSelect.addEventListener("change", async () => {
  const sessionId = elements.sessionSelect.value;
  if (!sessionId || state.running) return;
  state.sessionId = sessionId;
  localStorage.setItem(SESSION_STORAGE_KEY, sessionId);
  elements.log.replaceChildren();
  try {
    await loadSession();
    elements.prompt.focus();
  } catch (error) {
    addActivity("错误", error.message);
  }
});
elements.prompt.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    elements.composer.requestSubmit();
  }
});

async function boot() {
  try {
    const health = await requestJson("/api/health");
    elements.badge.textContent = health.apiKeyConfigured ? health.model : "API key missing";
    const savedSessionId = localStorage.getItem(SESSION_STORAGE_KEY);
    if (savedSessionId) {
      state.sessionId = savedSessionId;
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
