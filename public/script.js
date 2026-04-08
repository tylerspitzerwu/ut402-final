"use strict";

document.addEventListener("DOMContentLoaded", () => {
  const input = document.getElementById("user-input");
  const composer = document.getElementById("composer");
  const sendButton = document.getElementById("send-message");
  const resetButton = document.getElementById("reset-thread");
  const thread = document.getElementById("thread");
  const composerFeedback = document.getElementById("composer-feedback");
  const threadError = document.getElementById("thread-error");
  const jsonToggle = document.getElementById("json-toggle");
  const jsonPanel = document.getElementById("json-panel");
  const jsonClose = document.getElementById("json-close");
  const jsonOutput = document.getElementById("json-output");

  if (
    !(input instanceof HTMLTextAreaElement) ||
    !(composer instanceof HTMLFormElement) ||
    !(sendButton instanceof HTMLButtonElement) ||
    !(resetButton instanceof HTMLButtonElement) ||
    !(thread instanceof HTMLElement) ||
    !(composerFeedback instanceof HTMLElement) ||
    !(threadError instanceof HTMLElement) ||
    !(jsonToggle instanceof HTMLButtonElement) ||
    !(jsonPanel instanceof HTMLElement) ||
    !(jsonClose instanceof HTMLButtonElement) ||
    !(jsonOutput instanceof HTMLElement)
  ) {
    console.warn("Thread UI elements are missing.");
    return;
  }

  const messages = [];
  let latestJsonText = "";

  function nowIso() {
    return new Date().toISOString();
  }

  function formatTime(iso) {
    try {
      return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    } catch {
      return "";
    }
  }

  function scrollThreadToBottom() {
    thread.scrollTop = thread.scrollHeight;
  }

  function renderMessage({ role, text, ts, meta }) {
    const wrapper = document.createElement("article");
    wrapper.className = `message message-${role}`;

    const metaEl = document.createElement("div");
    metaEl.className = "message-meta";
    metaEl.textContent = `${role === "user" ? "You" : "Assistant"} · ${formatTime(ts)}`;

    const bubble = document.createElement("div");
    bubble.className = "message-bubble";
    bubble.textContent = text;

    wrapper.append(metaEl, bubble);

    if (meta && typeof meta === "object" && typeof meta.details === "string" && meta.details.trim()) {
      const details = document.createElement("details");
      details.className = "message-details";

      const summary = document.createElement("summary");
      summary.className = "message-details-summary";
      summary.textContent = "Show details";

      const pre = document.createElement("pre");
      pre.className = "json-block";
      pre.textContent = meta.details;

      details.append(summary, pre);
      wrapper.append(details);
    }

    thread.append(wrapper);
    scrollThreadToBottom();
  }

  function pushMessage(message) {
    messages.push(message);
    renderMessage(message);
  }

  function setJsonPanelOpen(isOpen) {
    jsonToggle.setAttribute("aria-expanded", String(isOpen));
    jsonPanel.setAttribute("aria-hidden", String(!isOpen));
    jsonPanel.classList.toggle("is-open", isOpen);
  }

  function setJsonOutput(text) {
    latestJsonText = String(text || "");
    jsonOutput.textContent = latestJsonText || "No JSON yet. Send a message to populate this panel.";
  }

  function updateJsonFromPayload(payload) {
    if (!payload || typeof payload !== "object") return;
    const operations = Array.isArray(payload.operations) ? payload.operations : undefined;
    const tasks = Array.isArray(payload.tasks) ? payload.tasks : undefined;
    const debug = payload.debug && typeof payload.debug === "object" ? payload.debug : undefined;
    const data = { operations, tasks, debug };
    setJsonOutput(JSON.stringify(data, null, 2));
  }

  async function applyTaskQuery(query) {
    const response = await fetch("/api/task", {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({ query })
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw payload;
    }

    if (typeof payload?.message === "string") {
      return payload;
    }

    throw new Error("Server response did not include a message.");
  }

  async function clearTaskStorage() {
    const response = await fetch("/api/tasks/clear", { method: "POST" });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const detail = payload?.details ? ` ${payload.details}` : "";
      throw new Error(`${payload?.error || "Failed to clear tasks."}${detail}`);
    }
    return payload;
  }

  function setBusyState(isBusy) {
    sendButton.disabled = isBusy;
    resetButton.disabled = isBusy;
    input.disabled = isBusy;
    sendButton.textContent = isBusy ? "Sending..." : "Send";
  }

  function formatDebugText(payload) {
    if (!payload || typeof payload !== "object") return "";
    const debug = payload.debug && typeof payload.debug === "object" ? payload.debug : undefined;
    const details = debug ? { debug } : undefined;
    return details ? JSON.stringify(details, null, 2) : "";
  }

  function renderAssistantMessage(payload) {
    const message =
      typeof payload?.message === "string" && payload.message.trim()
        ? payload.message.trim()
        : "Done.";

    const debugText = formatDebugText(payload);
    const meta = debugText ? { details: debugText } : undefined;
    pushMessage({
      role: "assistant",
      text: message,
      ts: nowIso(),
      meta
    });
  }

  async function handleSend() {
    const query = input.value.trim();
    composerFeedback.textContent = "";
    threadError.textContent = "";

    if (!query) {
      composerFeedback.textContent = "Type a message to send.";
      return;
    }

    pushMessage({ role: "user", text: query, ts: nowIso() });
    input.value = "";
    setBusyState(true);
    try {
      const payload = await applyTaskQuery(query);
      updateJsonFromPayload(payload);
      renderAssistantMessage(payload);
    } catch (error) {
      const payload = error && typeof error === "object" ? error : {};
      const friendly =
        typeof payload?.error === "string" && payload.error.trim()
          ? payload.error.trim()
          : error instanceof Error
            ? error.message
            : "Unexpected error while sending message.";

      const debugText = formatDebugText(payload);
      updateJsonFromPayload(payload);
      pushMessage({
        role: "assistant",
        text: friendly,
        ts: nowIso(),
        meta: debugText ? { details: debugText } : undefined
      });
    } finally {
      setBusyState(false);
    }
  }

  composer.addEventListener("submit", (event) => {
    event.preventDefault();
    handleSend();
  });

  resetButton.addEventListener("click", async () => {
    threadError.textContent = "";
    try {
      await clearTaskStorage();
      messages.length = 0;
      thread.replaceChildren();
      composerFeedback.textContent = "Reset complete.";
      setJsonOutput("");
    } catch (error) {
      threadError.textContent = error instanceof Error ? error.message : "Failed to reset.";
    }
  });

  // Requirement: reloading the page should clear persisted in-memory task state.
  window.addEventListener("load", async () => {
    try {
      await clearTaskStorage();
      messages.length = 0;
      thread.replaceChildren();
      setJsonOutput("");
    } catch (error) {
      threadError.textContent =
        error instanceof Error ? error.message : "Failed to reset tasks on load.";
    }
  });

  jsonToggle.addEventListener("click", () => {
    const isOpen = jsonPanel.classList.contains("is-open");
    setJsonPanelOpen(!isOpen);
  });

  jsonClose.addEventListener("click", () => {
    setJsonPanelOpen(false);
  });

  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      setJsonPanelOpen(false);
    }
  });

  setJsonOutput(latestJsonText);
});

