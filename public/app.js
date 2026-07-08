"use strict";

/* ---------- tiny helpers ---------- */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

function h(tag, attrs, ...children) {
  const e = document.createElement(tag);
  if (attrs)
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === "class") e.className = v;
      else if (k === "html") e.innerHTML = v;
      else if (k === "value") e.value = v;
      else if (k.startsWith("on") && typeof v === "function") e.addEventListener(k.slice(2).toLowerCase(), v);
      else if (v === true) e.setAttribute(k, "");
      else e.setAttribute(k, v);
    }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    e.appendChild(typeof c === "object" ? c : document.createTextNode(String(c)));
  }
  return e;
}

async function api(method, path, body) {
  const opts = { method, headers: {}, credentials: "same-origin" };
  if (body !== undefined) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(path, opts);
  if (res.status === 401) {
    showLogin();
    throw new Error("unauthorized");
  }
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const msg = data && (typeof data.error === "string" ? data.error : JSON.stringify(data.error || data));
    throw Object.assign(new Error(msg || res.statusText), { data, status: res.status });
  }
  return data;
}

function toast(msg, isErr) {
  const t = h("div", { class: "toast" + (isErr ? " err" : "") }, msg);
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3200);
}

function fmtTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
function fmtDur(sec) {
  if (sec == null) return "—";
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/* ---------- state ---------- */
const state = { agents: [], calls: [], numbers: [], settings: null, tab: "calls", openCallId: null };

/* ---------- modal ---------- */
function openModal(node, wide) {
  const backdrop = h(
    "div",
    { class: "modal-backdrop", onclick: (e) => e.target === backdrop && closeModal() },
    h("div", { class: "modal" + (wide ? " wide" : "") }, node),
  );
  $("#modal-root").innerHTML = "";
  $("#modal-root").appendChild(backdrop);
  return backdrop;
}
function closeModal() {
  $("#modal-root").innerHTML = "";
  state.openCallId = null;
}
function modalShell(title, bodyNodes, footNodes) {
  return [
    h("div", { class: "modal-head" }, h("h3", null, title), h("button", { class: "icon-btn", onclick: closeModal }, "✕")),
    h("div", { class: "modal-body" }, ...bodyNodes),
    footNodes ? h("div", { class: "modal-foot" }, ...footNodes) : null,
  ].filter(Boolean);
}

/* ---------- auth ---------- */
function showLogin() {
  $("#app").classList.add("hidden");
  $("#login").classList.remove("hidden");
}
function showApp() {
  $("#login").classList.add("hidden");
  $("#app").classList.remove("hidden");
}

$("#login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("#login-error").textContent = "";
  try {
    const res = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ password: $("#login-password").value }),
    });
    if (!res.ok) {
      $("#login-error").textContent = "Invalid password";
      return;
    }
    $("#login-password").value = "";
    await boot();
  } catch {
    $("#login-error").textContent = "Login failed";
  }
});

$("#logout-btn").addEventListener("click", async () => {
  await fetch("/api/logout", { method: "POST", credentials: "same-origin" });
  showLogin();
});

/* ---------- tabs ---------- */
$$(".tab").forEach((t) =>
  t.addEventListener("click", () => {
    state.tab = t.dataset.tab;
    $$(".tab").forEach((x) => x.classList.toggle("active", x === t));
    $$(".tab-panel").forEach((p) => p.classList.add("hidden"));
    $("#tab-" + state.tab).classList.remove("hidden");
    if (state.tab === "settings") renderSettings();
  }),
);

/* ---------- CALLS ---------- */
function statusBadge(s) {
  return h("span", { class: "badge " + s }, s);
}
function dirCell(c) {
  const icon = c.direction === "outbound" ? "📤" : "📥";
  return h(
    "div",
    { class: "dir" },
    `${icon} `,
    h("span", null, c.from || "?"),
    h("span", { class: "arrow" }, " → "),
    h("span", null, c.to || "?"),
  );
}
function renderCalls() {
  const wrap = $("#calls-list");
  wrap.innerHTML = "";
  if (!state.calls.length) {
    wrap.appendChild(h("div", { class: "empty" }, "No calls yet. Place one, or wait for an inbound call."));
    return;
  }
  const table = h(
    "table",
    null,
    h(
      "thead",
      null,
      h(
        "tr",
        null,
        ...["Time", "Direction", "Agent", "Status", "Duration", ""].map((t) => h("th", null, t)),
      ),
    ),
    h(
      "tbody",
      null,
      ...state.calls.map((c) =>
        h(
          "tr",
          { onclick: () => openCallDetail(c.id) },
          h("td", null, fmtTime(c.createdAt)),
          h("td", null, dirCell(c)),
          h("td", null, c.agentName || "—"),
          h("td", null, statusBadge(c.status)),
          h("td", null, fmtDur(c.durationSec)),
          h("td", null, c.recordingUrl ? "🎧" : ""),
        ),
      ),
    ),
  );
  wrap.appendChild(table);
}

async function openCallDetail(id) {
  state.openCallId = id;
  let call;
  try {
    call = await api("GET", "/api/calls/" + id);
  } catch {
    return;
  }
  renderCallDetail(call);
}
function renderCallDetail(call) {
  if (state.openCallId !== call.id) return;
  const meta = h(
    "div",
    null,
    h("div", { class: "kv" }, h("span", { class: "k" }, "Direction"), h("span", null, call.direction)),
    h("div", { class: "kv" }, h("span", { class: "k" }, "From → To"), h("span", null, `${call.from || "?"} → ${call.to || "?"}`)),
    h("div", { class: "kv" }, h("span", { class: "k" }, "Agent"), h("span", null, call.agentName || "—")),
    h("div", { class: "kv" }, h("span", { class: "k" }, "Status"), statusBadge(call.status)),
    h("div", { class: "kv" }, h("span", { class: "k" }, "Started"), h("span", null, fmtTime(call.startedAt))),
    h("div", { class: "kv" }, h("span", { class: "k" }, "Duration"), h("span", null, fmtDur(call.durationSec))),
    call.notes ? h("div", { class: "kv" }, h("span", { class: "k" }, "Notes"), h("span", null, call.notes)) : null,
  );
  const rec = call.recordingUrl
    ? h("audio", { controls: true, src: call.recordingUrl })
    : null;
  const transcript = h(
    "div",
    { class: "transcript" },
    ...(call.transcript && call.transcript.length
      ? call.transcript.map((t) =>
          h(
            "div",
            { class: "turn " + (t.role === "user" ? "user" : "assistant") },
            h("div", { class: "who" }, t.role + (t.lang ? " · " + t.lang : "")),
            t.text,
          ),
        )
      : [h("div", { class: "muted small" }, "No transcript captured.")]),
  );
  openModal(
    modalShell(
      "Call detail",
      [meta, rec, h("h3", { class: "small muted", style: "margin-top:6px" }, "Transcript"), transcript],
      [h("button", { class: "btn", onclick: closeModal }, "Close")],
    ),
    true,
  );
}

/* place a call */
$("#new-call-btn").addEventListener("click", openPlaceCall);
function openPlaceCall() {
  const toInput = h("input", { placeholder: "+91XXXXXXXXXX", id: "pc-to" });
  const agentSel = h(
    "select",
    { id: "pc-agent" },
    ...state.agents.map((a) => h("option", { value: a.id }, a.name)),
  );
  if (state.settings?.settings?.defaultAgentId) agentSel.value = state.settings.settings.defaultAgentId;
  const didSel = h(
    "select",
    { id: "pc-did" },
    h("option", { value: "" }, "— default DID —"),
    ...state.numbers.map((n) => h("option", { value: n.number }, `${n.number}${n.label ? " (" + n.label + ")" : ""}`)),
  );
  const warn = state.settings && !state.settings.outboundConfigured
    ? h("div", { class: "hint", style: "color:var(--amber)" }, "⚠ Outbound is not configured yet (set VOICELINK_LEAD_* env vars). The call will fail until then.")
    : null;

  openModal(
    modalShell(
      "Place a call",
      [
        warn,
        h("div", { class: "field" }, h("label", null, "Destination number"), toInput),
        h("div", { class: "field" }, h("label", null, "Agent"), agentSel),
        h("div", { class: "field" }, h("label", null, "From (DID)"), didSel),
      ],
      [
        h("button", { class: "btn", onclick: closeModal }, "Cancel"),
        h(
          "button",
          {
            class: "btn btn-primary",
            onclick: async () => {
              const to = toInput.value.trim();
              if (!to) return toast("Enter a number", true);
              try {
                await api("POST", "/api/calls", { to, agentId: agentSel.value, did: didSel.value || undefined });
                toast("Call triggered");
                closeModal();
                state.tab = "calls";
              } catch (e) {
                toast(e.message || "Failed to place call", true);
              }
            },
          },
          "Call now",
        ),
      ],
    ),
  );
}

/* ---------- AGENTS ---------- */
function renderAgents() {
  const wrap = $("#agents-list");
  wrap.innerHTML = "";
  if (!state.agents.length) {
    wrap.appendChild(h("div", { class: "empty" }, "No agents yet."));
    return;
  }
  state.agents.forEach((a) => {
    wrap.appendChild(
      h(
        "div",
        { class: "card" },
        h("div", { class: "card-title" }, "🤖 ", a.name),
        h(
          "div",
          { class: "card-meta" },
          h("span", { class: "chip" }, a.language === "auto" ? "auto lang" : a.language),
          h("span", { class: "chip" }, a.ttsSpeaker),
          h("span", { class: "chip" }, a.ttsModel),
        ),
        h("p", { class: "desc" }, a.systemPrompt),
        h(
          "div",
          { class: "card-actions" },
          h("button", { class: "btn btn-sm", onclick: () => openAgentEditor(a) }, "Edit"),
          h("button", { class: "btn btn-sm", onclick: () => callWithAgent(a) }, "Call"),
          h("button", { class: "btn btn-sm btn-danger", onclick: () => deleteAgent(a) }, "Delete"),
        ),
      ),
    );
  });
}
function callWithAgent(a) {
  openPlaceCall();
  const sel = $("#pc-agent");
  if (sel) sel.value = a.id;
}
async function deleteAgent(a) {
  if (!confirm(`Delete agent "${a.name}"?`)) return;
  await api("DELETE", "/api/agents/" + a.id);
  await loadAgents();
  toast("Agent deleted");
}

function openAgentEditor(agent) {
  const opts = state.settings?.options || { languages: [], speakers: {}, ttsModels: ["bulbul:v2"] };
  const isNew = !agent;
  agent = agent || {
    name: "",
    systemPrompt: "You are a warm, concise voice assistant.",
    greeting: "Hello! How can I help you today?",
    language: state.settings?.defaultLanguage || "auto",
    ttsModel: opts.ttsModels[0] || "bulbul:v2",
    ttsSpeaker: (opts.speakers[opts.ttsModels[0]] || ["anushka"])[0],
    transferNumber: "",
    temperature: 0.4,
    maxTokens: 2048,
  };

  const name = h("input", { value: agent.name, placeholder: "Sales agent" });
  const language = h(
    "select",
    null,
    ...opts.languages.map((l) => h("option", { value: l.code }, l.label)),
  );
  language.value = agent.language;
  const model = h("select", null, ...opts.ttsModels.map((m) => h("option", { value: m }, m)));
  model.value = agent.ttsModel;
  const speaker = h("select", null);
  const fillSpeakers = () => {
    speaker.innerHTML = "";
    (opts.speakers[model.value] || []).forEach((s) => speaker.appendChild(h("option", { value: s }, s)));
    if ((opts.speakers[model.value] || []).includes(agent.ttsSpeaker)) speaker.value = agent.ttsSpeaker;
  };
  fillSpeakers();
  model.addEventListener("change", fillSpeakers);
  const greeting = h("textarea", null, agent.greeting);
  const prompt = h("textarea", { style: "min-height:120px" }, agent.systemPrompt);
  const transfer = h("input", { value: agent.transferNumber || "", placeholder: "optional, e.g. +9198..." });
  const temp = h("input", { type: "number", step: "0.1", min: "0", max: "2", value: agent.temperature });
  const maxTok = h("input", { type: "number", step: "64", min: "16", max: "8000", value: agent.maxTokens });

  openModal(
    modalShell(
      isNew ? "New agent" : "Edit agent",
      [
        h("div", { class: "field" }, h("label", null, "Name"), name),
        h(
          "div",
          { class: "row" },
          h("div", { class: "field" }, h("label", null, "Language"), language),
          h("div", { class: "field" }, h("label", null, "TTS model"), model),
        ),
        h(
          "div",
          { class: "row" },
          h("div", { class: "field" }, h("label", null, "Voice (speaker)"), speaker),
          h("div", { class: "field" }, h("label", null, "Transfer to (optional)"), transfer),
        ),
        h("div", { class: "field" }, h("label", null, "Greeting (spoken first)"), greeting),
        h("div", { class: "field" }, h("label", null, "System prompt / persona"), prompt),
        h(
          "div",
          { class: "row" },
          h("div", { class: "field" }, h("label", null, "Temperature"), temp),
          h("div", { class: "field" }, h("label", null, "Max tokens (incl. reasoning)"), maxTok),
        ),
      ],
      [
        h("button", { class: "btn", onclick: closeModal }, "Cancel"),
        h(
          "button",
          {
            class: "btn btn-primary",
            onclick: async () => {
              const payload = {
                name: name.value.trim(),
                language: language.value,
                ttsModel: model.value,
                ttsSpeaker: speaker.value,
                greeting: greeting.value,
                systemPrompt: prompt.value,
                transferNumber: transfer.value.trim(),
                temperature: parseFloat(temp.value) || 0.4,
                maxTokens: parseInt(maxTok.value, 10) || 200,
              };
              if (!payload.name) return toast("Name is required", true);
              try {
                if (isNew) await api("POST", "/api/agents", payload);
                else await api("PUT", "/api/agents/" + agent.id, payload);
                await loadAgents();
                closeModal();
                toast("Saved");
              } catch (e) {
                toast(e.message || "Save failed", true);
              }
            },
          },
          "Save agent",
        ),
      ],
    ),
    true,
  );
}
$("#new-agent-btn").addEventListener("click", () => openAgentEditor(null));

/* ---------- NUMBERS ---------- */
function renderNumbers() {
  const wrap = $("#numbers-list");
  wrap.innerHTML = "";
  if (!state.numbers.length) {
    wrap.appendChild(h("div", { class: "empty" }, "No numbers added. Add your VoiceLink DIDs here."));
    return;
  }
  const agentName = (id) => state.agents.find((a) => a.id === id)?.name || "—";
  wrap.appendChild(
    h(
      "table",
      null,
      h("thead", null, h("tr", null, ...["Number", "Label", "Inbound agent", ""].map((t) => h("th", null, t)))),
      h(
        "tbody",
        null,
        ...state.numbers.map((n) =>
          h(
            "tr",
            null,
            h("td", null, n.number),
            h("td", null, n.label || "—"),
            h("td", null, agentName(n.agentId)),
            h(
              "td",
              null,
              h("button", { class: "btn btn-sm", onclick: () => openNumberEditor(n) }, "Edit"),
              " ",
              h("button", { class: "btn btn-sm btn-danger", onclick: () => deleteNumber(n) }, "✕"),
            ),
          ),
        ),
      ),
    ),
  );
}
async function deleteNumber(n) {
  if (!confirm(`Remove ${n.number}?`)) return;
  await api("DELETE", "/api/numbers/" + n.id);
  await loadNumbers();
}
function openNumberEditor(rec) {
  const isNew = !rec;
  rec = rec || { number: "", label: "", agentId: "" };
  const number = h("input", { value: rec.number, placeholder: "+91XXXXXXXXXX" });
  const label = h("input", { value: rec.label || "", placeholder: "Support line" });
  const agent = h(
    "select",
    null,
    h("option", { value: "" }, "— no agent —"),
    ...state.agents.map((a) => h("option", { value: a.id }, a.name)),
  );
  if (rec.agentId) agent.value = rec.agentId;
  openModal(
    modalShell(
      isNew ? "Add number" : "Edit number",
      [
        h("div", { class: "field" }, h("label", null, "Number (DID)"), number),
        h("div", { class: "field" }, h("label", null, "Label"), label),
        h("div", { class: "field" }, h("label", null, "Inbound agent"), agent),
      ],
      [
        h("button", { class: "btn", onclick: closeModal }, "Cancel"),
        h(
          "button",
          {
            class: "btn btn-primary",
            onclick: async () => {
              const payload = { number: number.value.trim(), label: label.value.trim(), agentId: agent.value || undefined };
              if (!payload.number) return toast("Number required", true);
              try {
                if (isNew) await api("POST", "/api/numbers", payload);
                else await api("PUT", "/api/numbers/" + rec.id, payload);
                await loadNumbers();
                closeModal();
              } catch (e) {
                toast(e.message, true);
              }
            },
          },
          "Save",
        ),
      ],
    ),
  );
}
$("#new-number-btn").addEventListener("click", () => openNumberEditor(null));

/* ---------- SETTINGS ---------- */
function copyRow(value) {
  const input = h("input", { value, readonly: true });
  return h(
    "div",
    { class: "copy-row" },
    input,
    h(
      "button",
      {
        class: "btn btn-sm",
        onclick: () => {
          input.select();
          navigator.clipboard?.writeText(value);
          toast("Copied");
        },
      },
      "Copy",
    ),
  );
}
function renderSettings() {
  const s = state.settings;
  if (!s) return;
  const body = $("#settings-body");
  body.innerHTML = "";

  // Sarvam card
  const sarvamCard = h(
    "div",
    { class: "setting-card" },
    h("h3", null, "Sarvam AI"),
    h(
      "div",
      { class: "status-line" },
      h("span", { class: "dot " + (s.sarvam.configured ? "good" : "bad") }),
      s.sarvam.configured ? "API key configured" : "SARVAM_API_KEY not set",
    ),
    h("div", { class: "kv" }, h("span", { class: "k" }, "Chat model"), h("span", null, s.sarvam.chatModel)),
    h("div", { class: "kv" }, h("span", { class: "k" }, "STT model"), h("span", null, s.sarvam.sttModel)),
    h("div", { class: "kv" }, h("span", { class: "k" }, "TTS model"), h("span", null, `${s.sarvam.ttsModel} · ${s.sarvam.ttsSpeaker}`)),
    h("button", { class: "btn btn-sm", id: "doctor-btn", onclick: runDoctor }, "Test Sarvam (STT · LLM · TTS)"),
    h("div", { id: "doctor-out" }),
  );

  // VoiceLink card
  const vlCard = h(
    "div",
    { class: "setting-card full" },
    h("h3", null, "VoiceLink integration"),
    h("p", { class: "hint" }, "Paste these into the VoiceLink panel → WebSocket Bot. Route your DID to this bot in Call Routing."),
    h("div", { class: "field" }, h("label", null, "WebSocket (WSS) URL"), copyRow(s.panelUrls.wssUrl)),
    h("div", { class: "field" }, h("label", null, "Webhook URL (call lifecycle)"), copyRow(s.panelUrls.webhookUrl)),
    h(
      "div",
      { class: "status-line", style: "margin-top:6px" },
      h("span", { class: "dot " + (s.outboundConfigured ? "good" : "warn") }),
      s.outboundConfigured ? "Outbound calling configured" : "Outbound not configured (set VOICELINK_LEAD_* to enable)",
    ),
  );

  // General card
  const defSel = h("select", null, ...state.agents.map((a) => h("option", { value: a.id }, a.name)));
  if (s.settings.defaultAgentId) defSel.value = s.settings.defaultAgentId;
  defSel.addEventListener("change", async () => {
    await api("PUT", "/api/settings", { defaultAgentId: defSel.value });
    toast("Saved");
  });
  const genCard = h(
    "div",
    { class: "setting-card" },
    h("h3", null, "General"),
    h("div", { class: "field" }, h("label", null, "Default agent (fallback)"), defSel),
    s.appBaseUrl ? h("div", { class: "kv" }, h("span", { class: "k" }, "Base URL"), h("span", null, s.appBaseUrl)) : null,
  );

  body.appendChild(sarvamCard);
  body.appendChild(genCard);
  body.appendChild(vlCard);
}

async function runDoctor() {
  const out = $("#doctor-out");
  const btn = $("#doctor-btn");
  if (btn) btn.textContent = "Testing…";
  out.innerHTML = "";
  try {
    const r = await api("POST", "/api/settings/doctor");
    const line = (label, ok, detail) =>
      h("div", { class: "status-line" }, h("span", { class: "dot " + (ok ? "good" : "bad") }), `${label}: `, h("span", { class: "muted" }, detail || (ok ? "ok" : "failed")));
    out.appendChild(line("TTS", r.tts.ok, r.tts.ok ? r.tts.bytes + " bytes A-law" : r.tts.detail));
    out.appendChild(line("STT", r.stt.ok, r.stt.ok ? `"${r.stt.transcript}"` : r.stt.detail));
    out.appendChild(line("Chat", r.chat.ok, r.chat.ok ? "model: " + r.chat.workingModel : "no model responded"));
    if (r.chat.workingModel && r.chat.workingModel !== state.settings.sarvam.chatModel) {
      out.appendChild(h("div", { class: "hint", style: "color:var(--amber)" }, `Tip: set SARVAM_CHAT_MODEL=${r.chat.workingModel}`));
    }
  } catch (e) {
    out.appendChild(h("div", { class: "hint", style: "color:var(--red)" }, e.message));
  }
  if (btn) btn.textContent = "Test Sarvam (STT · LLM · TTS)";
}

/* ---------- loaders ---------- */
async function loadAgents() {
  state.agents = await api("GET", "/api/agents");
  renderAgents();
}
async function loadCalls() {
  state.calls = await api("GET", "/api/calls?limit=200");
  renderCalls();
}
async function loadNumbers() {
  state.numbers = await api("GET", "/api/numbers");
  renderNumbers();
}
async function loadSettings() {
  state.settings = await api("GET", "/api/settings");
}

/* ---------- SSE live updates ---------- */
function upsertCall(call) {
  if (!call || !call.id) return;
  const i = state.calls.findIndex((c) => c.id === call.id);
  if (i >= 0) state.calls[i] = call;
  else state.calls.unshift(call);
  if (state.tab === "calls") renderCalls();
  if (state.openCallId === call.id) renderCallDetail(call);
}
function connectSSE() {
  const es = new EventSource("/api/events");
  es.onopen = () => $("#live-dot").classList.add("on");
  es.onerror = () => $("#live-dot").classList.remove("on");
  es.onmessage = (ev) => {
    let e;
    try {
      e = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (e.type === "call.created" || e.type === "call.updated") upsertCall(e.call);
    else if (e.type === "call.transcript" && state.openCallId === e.callId) openCallDetail(e.callId);
    else if (e.type === "agent.updated") loadAgents();
  };
}

/* ---------- boot ---------- */
async function boot() {
  try {
    await api("GET", "/api/me");
  } catch {
    showLogin();
    return;
  }
  showApp();
  await Promise.all([loadSettings(), loadAgents(), loadNumbers()]);
  await loadCalls();
  renderSettings();
  connectSSE();
}
boot();
