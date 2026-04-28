const CHUNK_MS = 30_000;
const SETTINGS_KEY = "twinmind_settings_v1";

const defaultSettings = {
  groqApiKey: "",
  chatModel: "openai/gpt-oss-120b",
  suggestionContextWindow: 30,
  answerContextWindow: 60,
  chatContextWindow: 60,
  suggestionTemperature: 0.4,
  chatTemperature: 0.3,
  suggestionMaxTokens: 700,
  chatMaxTokens: 900,
  liveSuggestionPrompt:
    "You must maximize immediate usefulness for the next 1-2 minutes of conversation. Prefer specifics over generic advice. If someone asks a direct question, include at least one candidate direct answer.",
  detailedAnswerPrompt:
    "Provide an answer that can be spoken in a meeting now. Include concise bullets, concrete examples, and optional follow-up question if useful.",
  chatPrompt:
    "Act like a high-quality meeting copilot. Be accurate and brief by default, but add depth when needed."
};

const state = {
  isRecording: false,
  mediaStream: null,
  mediaRecorder: null,
  refreshTimer: null,
  transcriptEntries: [],
  suggestionBatches: [],
  chatHistory: [],
  settings: { ...defaultSettings }
};

const ui = {
  micButton: document.querySelector("#micButton"),
  refreshButton: document.querySelector("#refreshButton"),
  transcriptList: document.querySelector("#transcriptList"),
  suggestionBatches: document.querySelector("#suggestionBatches"),
  suggestionStatus: document.querySelector("#suggestionStatus"),
  chatMessages: document.querySelector("#chatMessages"),
  chatForm: document.querySelector("#chatForm"),
  chatInput: document.querySelector("#chatInput"),
  exportButton: document.querySelector("#exportButton"),
  settingsToggle: document.querySelector("#settingsToggle"),
  settingsPanel: document.querySelector("#settingsPanel"),
  saveSettings: document.querySelector("#saveSettings")
};

const fields = [
  "groqApiKey",
  "chatModel",
  "suggestionContextWindow",
  "answerContextWindow",
  "chatContextWindow",
  "suggestionTemperature",
  "chatTemperature",
  "liveSuggestionPrompt",
  "detailedAnswerPrompt",
  "chatPrompt"
];

function nowISO() {
  return new Date().toISOString();
}

function readSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...defaultSettings };
    return { ...defaultSettings, ...JSON.parse(raw) };
  } catch {
    return { ...defaultSettings };
  }
}

function saveSettings() {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings));
}

function hydrateSettingsUI() {
  for (const key of fields) {
    const el = document.querySelector(`#${key}`);
    if (!el) continue;
    el.value = state.settings[key] ?? "";
  }
}

function collectSettingsFromUI() {
  const next = { ...state.settings };
  for (const key of fields) {
    const el = document.querySelector(`#${key}`);
    if (!el) continue;
    if (el.type === "number") {
      next[key] = Number(el.value);
    } else {
      next[key] = el.value;
    }
  }
  return next;
}

function assertApiKey() {
  return true;
}

async function postJSON(url, payload) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-groq-api-key": state.settings.groqApiKey
    },
    body: JSON.stringify(payload)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  return data;
}

function renderTranscript() {
  ui.transcriptList.innerHTML = "";
  for (const entry of state.transcriptEntries) {
    const div = document.createElement("div");
    div.className = "transcript-item";
    div.innerHTML = `
      <div class="meta">${new Date(entry.timestamp).toLocaleTimeString()}</div>
      <div>${escapeHTML(entry.text)}</div>
    `;
    ui.transcriptList.appendChild(div);
  }
  ui.transcriptList.scrollTop = ui.transcriptList.scrollHeight;
}

function renderSuggestionBatches() {
  ui.suggestionBatches.innerHTML = "";
  for (const batch of state.suggestionBatches) {
    const wrapper = document.createElement("div");
    wrapper.className = "batch";
    wrapper.innerHTML = `<div class="batch-head">Batch ${new Date(batch.timestamp).toLocaleTimeString()}</div>`;

    for (const suggestion of batch.suggestions) {
      const card = document.createElement("button");
      card.className = "suggestion-card";
      card.type = "button";
      card.innerHTML = `
        <div class="suggestion-type">${escapeHTML(suggestion.type)}</div>
        <div class="suggestion-title">${escapeHTML(suggestion.title)}</div>
        <div class="suggestion-preview">${escapeHTML(suggestion.preview)}</div>
      `;
      card.addEventListener("click", () => onSuggestionClick(suggestion));
      wrapper.appendChild(card);
    }
    ui.suggestionBatches.appendChild(wrapper);
  }
}

function renderChat() {
  ui.chatMessages.innerHTML = "";
  for (const item of state.chatHistory) {
    const div = document.createElement("div");
    div.className = `chat-item ${item.role}`;
    div.innerHTML = `
      <div class="meta">${item.role === "user" ? "You" : "Copilot"} • ${new Date(item.timestamp).toLocaleTimeString()}</div>
      <div class="chat-content">${renderFormattedText(item.content)}</div>
    `;
    ui.chatMessages.appendChild(div);
  }
  ui.chatMessages.scrollTop = ui.chatMessages.scrollHeight;
}

function setStatus(text, isError = false) {
  ui.suggestionStatus.textContent = text;
  ui.suggestionStatus.classList.toggle("error", isError);
}

function addTranscriptEntry(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return;
  state.transcriptEntries.push({
    timestamp: nowISO(),
    text: trimmed
  });
  renderTranscript();
}

async function transcribeChunk(blob) {
  assertApiKey();
  if (!blob || blob.size < 500) return;

  const formData = new FormData();
  formData.append("audio", blob, `chunk-${Date.now()}.webm`);

  const res = await fetch("/api/transcribe", {
    method: "POST",
    headers: {
      "x-groq-api-key": state.settings.groqApiKey
    },
    body: formData
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || "Transcription failed.");
  }
  addTranscriptEntry(data.text);
}

async function createSuggestionBatch() {
  assertApiKey();
  if (!state.transcriptEntries.length) {
    setStatus("No transcript yet");
    return;
  }

  setStatus("Generating suggestions...");
  const data = await postJSON("/api/suggestions", {
    transcriptEntries: state.transcriptEntries,
    settings: state.settings
  });
  const batch = {
    id: `batch-${Date.now()}`,
    timestamp: nowISO(),
    suggestions: data.suggestions
  };
  state.suggestionBatches.unshift(batch);
  renderSuggestionBatches();
  setStatus("Updated");
}

async function onSuggestionClick(suggestion) {
  try {
    assertApiKey();
    const content = `${suggestion.title}: ${suggestion.preview}`;
    state.chatHistory.push({ role: "user", content, timestamp: nowISO(), source: "suggestion_click" });
    renderChat();
    const data = await postJSON("/api/chat", {
      question: content,
      transcriptEntries: state.transcriptEntries,
      chatHistory: state.chatHistory,
      settings: state.settings,
      mode: "suggestion_click"
    });
    state.chatHistory.push({ role: "assistant", content: data.answer, timestamp: nowISO(), source: "suggestion_click" });
    renderChat();
  } catch (error) {
    setStatus(error.message, true);
  }
}

async function onTypedQuestion(question) {
  const clean = question.trim();
  if (!clean) return;
  assertApiKey();

  state.chatHistory.push({ role: "user", content: clean, timestamp: nowISO(), source: "typed_question" });
  renderChat();

  const data = await postJSON("/api/chat", {
    question: clean,
    transcriptEntries: state.transcriptEntries,
    chatHistory: state.chatHistory,
    settings: state.settings,
    mode: "typed_question"
  });
  state.chatHistory.push({ role: "assistant", content: data.answer, timestamp: nowISO(), source: "typed_question" });
  renderChat();
}

async function refreshAll() {
  try {
    if (state.mediaRecorder && state.mediaRecorder.state === "recording") {
      state.mediaRecorder.requestData();
      await delay(700);
    }
    await createSuggestionBatch();
  } catch (error) {
    setStatus(error.message, true);
  }
}

function startAutoRefresh() {
  stopAutoRefresh();
  state.refreshTimer = setInterval(() => {
    refreshAll().catch((error) => setStatus(error.message, true));
  }, CHUNK_MS + 1000);
}

function stopAutoRefresh() {
  if (!state.refreshTimer) return;
  clearInterval(state.refreshTimer);
  state.refreshTimer = null;
}

async function startMic() {
  assertApiKey();
  if (state.isRecording) return;

  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const recorder = new MediaRecorder(stream, { mimeType: "audio/webm" });
  state.mediaStream = stream;
  state.mediaRecorder = recorder;

  recorder.addEventListener("dataavailable", async (event) => {
    try {
      if (event.data?.size) {
        await transcribeChunk(event.data);
        await createSuggestionBatch();
      }
    } catch (error) {
      setStatus(error.message, true);
    }
  });

  recorder.start(CHUNK_MS);
  state.isRecording = true;
  ui.micButton.textContent = "Stop Mic";
  setStatus("Listening...");
  startAutoRefresh();
}

function stopMic() {
  if (!state.isRecording) return;
  stopAutoRefresh();
  state.mediaRecorder?.stop();
  state.mediaStream?.getTracks().forEach((track) => track.stop());
  state.mediaRecorder = null;
  state.mediaStream = null;
  state.isRecording = false;
  ui.micButton.textContent = "Start Mic";
  setStatus("Mic stopped");
}

function exportSession() {
  const data = {
    exportedAt: nowISO(),
    transcriptEntries: state.transcriptEntries,
    suggestionBatches: state.suggestionBatches,
    chatHistory: state.chatHistory,
    settingsSnapshot: {
      ...state.settings,
      groqApiKey: state.settings.groqApiKey ? "***redacted***" : ""
    }
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `twinmind-session-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function escapeHTML(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function renderFormattedText(value) {
  const lines = String(value || "").replace(/\r/g, "").split("\n");
  const chunks = [];
  let listItems = [];
  let orderedItems = [];
  let quoteLines = [];
  let tableRows = [];

  function flushList() {
    if (!listItems.length) return;
    chunks.push(`<ul>${listItems.map((item) => `<li>${inlineFormat(item)}</li>`).join("")}</ul>`);
    listItems = [];
  }

  function flushOrderedList() {
    if (!orderedItems.length) return;
    chunks.push(`<ol>${orderedItems.map((item) => `<li>${inlineFormat(item)}</li>`).join("")}</ol>`);
    orderedItems = [];
  }

  function flushQuotes() {
    if (!quoteLines.length) return;
    chunks.push(`<blockquote>${quoteLines.map((line) => `<p>${inlineFormat(line)}</p>`).join("")}</blockquote>`);
    quoteLines = [];
  }

  function isLikelyTableRow(line) {
    const pipeCount = (line.match(/\|/g) || []).length;
    return pipeCount >= 2 && /[A-Za-z0-9]/.test(line);
  }

  function isSeparatorRow(cells) {
    if (!cells.length) return false;
    return cells.every((cell) => /^:?-{3,}:?$/.test(cell.replace(/\s+/g, "")));
  }

  function flushTable() {
    if (!tableRows.length) return;
    const rows = tableRows.map((row) =>
      row
        .trim()
        .replace(/^\|/, "")
        .replace(/\|$/, "")
        .split("|")
        .map((cell) => cell.trim())
    );
    tableRows = [];

    if (!rows.length) return;
    const header = rows[0];
    const hasSeparator = rows.length > 1 && isSeparatorRow(rows[1]);
    const bodyRows = hasSeparator ? rows.slice(2) : rows.slice(1);

    chunks.push(`
      <table>
        <thead>
          <tr>${header.map((cell) => `<th>${inlineFormat(cell)}</th>`).join("")}</tr>
        </thead>
        <tbody>
          ${bodyRows.map((row) => `<tr>${row.map((cell) => `<td>${inlineFormat(cell)}</td>`).join("")}</tr>`).join("")}
        </tbody>
      </table>
    `);
  }

  function flushAllStructured() {
    flushList();
    flushOrderedList();
    flushQuotes();
    flushTable();
  }

  for (let i = 0; i < lines.length; i += 1) {
    const rawLine = lines[i];
    const line = rawLine.trim();

    if (!line) {
      const nextLine = (lines[i + 1] || "").trim();
      const tableContinues = tableRows.length && isLikelyTableRow(nextLine);
      if (!tableContinues) {
        flushAllStructured();
      }
      continue;
    }

    if (isLikelyTableRow(line)) {
      flushList();
      flushOrderedList();
      flushQuotes();
      tableRows.push(line);
      continue;
    }

    flushTable();

    if (line.startsWith(">")) {
      flushList();
      flushOrderedList();
      quoteLines.push(line.replace(/^>\s?/, ""));
      continue;
    }

    flushQuotes();

    if (/^[-*_]{3,}$/.test(line.replace(/\s+/g, ""))) {
      flushList();
      flushOrderedList();
      chunks.push("<hr />");
      continue;
    }

    if (/^[-*•]\s+/.test(line)) {
      flushOrderedList();
      listItems.push(line.replace(/^[-*•]\s+/, "").trim());
      continue;
    }

    if (/^\d+\.\s+/.test(line)) {
      flushList();
      orderedItems.push(line.replace(/^\d+\.\s+/, "").trim());
      continue;
    }

    flushList();
    flushOrderedList();

    const headingMatch = line.match(/^(#{1,4})\s+(.+)$/);
    if (headingMatch) {
      const level = Math.min(headingMatch[1].length + 3, 6);
      chunks.push(`<h${level}>${inlineFormat(headingMatch[2].trim())}</h${level}>`);
      continue;
    }

    if (line.endsWith(":") && line.length < 90) {
      chunks.push(`<h4>${inlineFormat(line.slice(0, -1))}</h4>`);
      continue;
    }

    chunks.push(`<p>${inlineFormat(line)}</p>`);
  }

  flushAllStructured();
  return chunks.join("");
}

function inlineFormat(value) {
  return escapeHTML(value)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(?!\s)([^*]+?)\*/g, "<em>$1</em>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");
}

function bindEvents() {
  ui.micButton.addEventListener("click", async () => {
    try {
      if (state.isRecording) {
        stopMic();
      } else {
        await startMic();
      }
    } catch (error) {
      setStatus(error.message, true);
    }
  });

  ui.refreshButton.addEventListener("click", () => {
    refreshAll().catch((error) => setStatus(error.message, true));
  });

  ui.chatForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const question = ui.chatInput.value;
    ui.chatInput.value = "";
    try {
      await onTypedQuestion(question);
    } catch (error) {
      setStatus(error.message, true);
    }
  });

  ui.exportButton.addEventListener("click", exportSession);
  ui.settingsToggle.addEventListener("click", () => ui.settingsPanel.classList.toggle("hidden"));
  ui.saveSettings.addEventListener("click", () => {
    state.settings = collectSettingsFromUI();
    saveSettings();
    setStatus("Settings saved");
  });
}

function init() {
  state.settings = readSettings();
  hydrateSettingsUI();
  bindEvents();
  renderTranscript();
  renderSuggestionBatches();
  renderChat();
}

init();
