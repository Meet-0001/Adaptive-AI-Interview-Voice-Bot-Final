"use strict";

// ── Page switching ────────────────────────────────────────
function launchApp() {
  document.getElementById("landing-page").style.display = "none";
  document.getElementById("app-page").style.display = "block";
  checkHealth();
  loadModels();
}

function exitApp() {
  document.getElementById("app-page").style.display = "none";
  document.getElementById("landing-page").style.display = "block";
}

function smoothScroll(id) {
  const el = document.getElementById(id);
  if (el) el.scrollIntoView({ behavior: "smooth" });
}

// ── State ─────────────────────────────────────────────────
const S = {
  role: "", experience: "mid", level: "medium",
  types: ["behavioral", "technical", "situational"],
  qCount: 5, ollamaModel: "llama3.2",
  questions: [], currentQ: 0, results: [],
  timerInterval: null, timeLeft: 0,
  mediaRecorder: null, audioChunks: [], isRecording: false,
  currentAudio: null,
};

document.addEventListener("DOMContentLoaded", () => {
  bindSetup();
  bindInterview();
  bindOverlay();

  // Smooth scroll for landing nav links
  document.querySelectorAll('.nav-links a[href^="#"]').forEach(a => {
    a.addEventListener("click", e => {
      e.preventDefault();
      const id = a.getAttribute("href").replace("#", "");
      smoothScroll(id);
    });
  });
});

// ── Health / status dots ──────────────────────────────────
async function checkHealth() {
  try {
    const r = await fetch("/api/health");
    const d = await r.json();

    setDot("ollama",  d.ollama  ? "green" : "red",  d.ollama  ? "Ollama connected"   : "Ollama offline — run: ollama serve");
    setDot("whisper", d.whisper ? "green" : "amber", d.whisper ? "Whisper ready"      : "Whisper not installed");
    setDot("tts",     d.tts     ? "green" : "amber", d.tts     ? "Edge TTS ready"     : "Edge TTS not installed");
  } catch {
    setDot("ollama",  "red",   "Ollama offline");
    setDot("whisper", "amber", "Unknown");
    setDot("tts",     "amber", "Unknown");
  }
}

function setDot(name, color, title) {
  const el = document.getElementById(`glow-${name}`);
  if (el) { el.className = `glow-dot ${color}`; el.title = title; }
}

async function loadModels() {
  try {
    const r = await fetch("/api/ollama-models");
    const d = await r.json();
    const sel = document.getElementById("model-select");
    if (sel) sel.innerHTML = d.models.map(m => `<option value="${m}">${m}</option>`).join("");
  } catch { /* keep default */ }
}

// ══════════════════════════════════════════════════════════
//  Setup bindings
// ══════════════════════════════════════════════════════════
function bindSetup() {
  document.querySelectorAll(".role-btn").forEach(btn =>
    btn.addEventListener("click", () => {
      document.querySelectorAll(".role-btn").forEach(b => b.classList.remove("selected"));
      btn.classList.add("selected");
      S.role = btn.dataset.role;
      document.getElementById("custom-role").value = "";
    })
  );

  document.getElementById("custom-role").addEventListener("input", e => {
    if (e.target.value.trim()) {
      document.querySelectorAll(".role-btn").forEach(b => b.classList.remove("selected"));
      S.role = e.target.value.trim();
    }
  });

  document.querySelectorAll(".diff-btn").forEach(btn =>
    btn.addEventListener("click", () => {
      document.querySelectorAll(".diff-btn").forEach(b => b.classList.remove("selected"));
      btn.classList.add("selected");
      S.level = btn.dataset.diff;
    })
  );

  document.querySelectorAll(".type-btn").forEach(btn =>
    btn.addEventListener("click", () => {
      btn.classList.toggle("selected");
      const t = btn.dataset.type;
      if (btn.classList.contains("selected")) { if (!S.types.includes(t)) S.types.push(t); }
      else { S.types = S.types.filter(x => x !== t); }
    })
  );

  document.getElementById("start-btn").addEventListener("click", startSession);
  document.getElementById("history-btn").addEventListener("click", openHistory);
  document.getElementById("history-btn2").addEventListener("click", openHistory);
}

// ══════════════════════════════════════════════════════════
//  Start session
// ══════════════════════════════════════════════════════════
async function startSession() {
  const custom = document.getElementById("custom-role").value.trim();
  if (custom) S.role = custom;
  if (!S.role)         { alert("Please select or enter a role."); return; }
  if (!S.types.length) { alert("Please select at least one question type."); return; }

  S.experience  = document.getElementById("experience").value;
  S.qCount      = parseInt(document.getElementById("q-count").value);
  S.ollamaModel = document.getElementById("model-select").value;
  S.results     = [];
  S.currentQ    = 0;

  showSection("sec-loading");
  document.getElementById("loading-sub").textContent =
    `Asking ${S.ollamaModel} to craft ${S.qCount} questions for ${S.role}…`;

  try {
    const r = await fetch("/api/generate-questions", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: S.role, level: S.level, count: S.qCount, types: S.types, experience: S.experience, model: S.ollamaModel }),
    });
    const d = await r.json();
    if (d.error) throw new Error(d.error);
    S.questions = Array.isArray(d.questions) ? d.questions : [];
    if (!S.questions.length) throw new Error("No questions returned");
  } catch {
    S.questions = fallbackQuestions();
  }

  buildNavDots();
  showSection("sec-interview");
  loadQuestion(0);
}

function fallbackQuestions() {
  const pools = {
    behavioral:  [
      { question: `Describe a major challenge you faced as a ${S.role} and how you resolved it.`, type: "behavioral",  hint: "Use STAR: Situation, Task, Action, Result." },
      { question: "Tell me about a time you had a disagreement with a colleague. What happened?", type: "behavioral", hint: "Focus on resolution and the positive outcome." },
    ],
    technical:   [
      { question: `What are the most critical technical skills for a ${S.role}? Give examples of how you've applied them.`, type: "technical", hint: "Give concrete examples with measurable impact." },
      { question: "Walk me through your approach to debugging a complex production issue.", type: "technical", hint: "Describe your systematic process step by step." },
    ],
    situational: [
      { question: `If you discovered a critical flaw in an ongoing project as a ${S.role}, what steps would you take?`, type: "situational", hint: "Show initiative, communication, and problem-solving." },
      { question: "How would you handle multiple urgent deadlines competing for your attention?", type: "situational", hint: "Mention prioritisation frameworks and stakeholder communication." },
    ],
  };
  return Array.from({ length: S.qCount }, (_, i) => {
    const t = S.types[i % S.types.length];
    const pool = pools[t] || pools.behavioral;
    return pool[i % pool.length];
  });
}

// ══════════════════════════════════════════════════════════
//  Interview bindings
// ══════════════════════════════════════════════════════════
function bindInterview() {
  document.getElementById("tts-btn").addEventListener("click",   playQuestion);
  document.getElementById("hint-btn").addEventListener("click",  toggleHint);
  document.getElementById("skip-btn").addEventListener("click",  skipQuestion);
  document.getElementById("submit-btn").addEventListener("click", () => submitAnswer());
  document.getElementById("next-btn").addEventListener("click",  nextQuestion);
  document.getElementById("mic-btn").addEventListener("click",   toggleRecording);
  document.getElementById("restart-btn").addEventListener("click", () => showSection("sec-setup"));
}

function buildNavDots() {
  document.getElementById("nav-dots").innerHTML =
    S.questions.map((_, i) => `<div class="nav-dot" id="dot-${i}"></div>`).join("");
}

function updateDots(idx) {
  S.questions.forEach((_, i) => {
    const d = document.getElementById(`dot-${i}`);
    if (d) d.className = "nav-dot" + (i < idx ? " done" : i === idx ? " current" : "");
  });
}

function loadQuestion(idx) {
  const q = S.questions[idx];
  if (!q) return;

  document.getElementById("progress-bar").style.width = `${(idx / S.questions.length) * 100}%`;
  document.getElementById("q-counter").textContent = `Question ${idx + 1} of ${S.questions.length}`;
  document.getElementById("question-text").textContent = q.question;
  document.getElementById("hint-text").textContent = q.hint || "";
  document.getElementById("hint-box").style.display = "none";
  document.getElementById("feedback-section").style.display = "none";
  document.getElementById("answer-input").value = "";
  document.getElementById("answer-input").disabled = false;

  ["submit-btn","skip-btn","hint-btn","mic-btn","tts-btn"].forEach(id =>
    (document.getElementById(id).disabled = false)
  );

  const badge = document.getElementById("q-badge");
  const type  = (q.type || "behavioral").toLowerCase();
  badge.textContent = type.charAt(0).toUpperCase() + type.slice(1);
  badge.className   = `q-badge ${type}`;

  updateDots(idx);
  resetMic();
  // Auto-play question via TTS
  playQuestion();
}

async function playQuestion() {
  const text = document.getElementById("question-text").textContent;
  if (!text || text === "Loading…") return;
  const btn = document.getElementById("tts-btn");
  if (S.currentAudio) { S.currentAudio.pause(); S.currentAudio = null; }
  btn.classList.add("playing");
  try {
    const r = await fetch("/api/tts", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!r.ok) throw new Error();
    const blob = await r.blob();
    S.currentAudio = new Audio(URL.createObjectURL(blob));
    S.currentAudio.onended = () => { btn.classList.remove("playing"); S.currentAudio = null; };
    S.currentAudio.onerror = () => btn.classList.remove("playing");
    S.currentAudio.play();
  } catch { btn.classList.remove("playing"); }
}

function toggleHint() {
  const h = document.getElementById("hint-box");
  h.style.display = h.style.display === "none" ? "block" : "none";
}

function skipQuestion() {
  S.results.push({ q: S.questions[S.currentQ], answer: "[Skipped]", feedback: "Question was skipped.", score: 0, breakdown: {}, strengths: "", improvements: "" });
  clearInterval(S.timerInterval);
  nextQuestion();
}

// ── Submit answer ─────────────────────────────────────────
async function submitAnswer(timedOut = false) {
  const answer = document.getElementById("answer-input").value.trim();
  if (!answer && !timedOut) { alert("Please type or record your answer first."); return; }
  if (!answer) {
    S.results.push({ q: S.questions[S.currentQ], answer: "[Time expired]", feedback: "Time ran out.", score: 0, breakdown: {}, strengths: "", improvements: "" });
    nextQuestion(); return;
  }

  clearInterval(S.timerInterval);
  ["submit-btn","skip-btn","hint-btn","mic-btn"].forEach(id => (document.getElementById(id).disabled = true));
  document.getElementById("answer-input").disabled = true;

  // Show feedback panel with loading state
  const fs = document.getElementById("feedback-section");
  fs.style.display = "block";
  document.getElementById("overall-badge").className = "overall-badge";
  document.getElementById("overall-badge").textContent = "";
  document.getElementById("score-cards").innerHTML =
    `<div style="grid-column:1/-1;color:var(--muted);font-size:13px;padding:.5rem 0"><span class="dots"><span class="dot"></span><span class="dot"></span><span class="dot"></span></span> Evaluating with ${S.ollamaModel}…</div>`;
  document.getElementById("feedback-text").textContent = "";
  document.getElementById("sw-grid").style.display = "none";
  document.getElementById("next-btn").disabled = true;

  const q = S.questions[S.currentQ];
  try {
    const r = await fetch("/api/evaluate-answer", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: S.role, level: S.level, question: q.question, type: q.type, answer, model: S.ollamaModel }),
    });
    const result = await r.json();
    S.results.push({
      q, answer,
      feedback:     result.feedback     || "",
      score:        result.overallScore || 0,
      breakdown:    result.breakdown    || {},
      strengths:    result.strengths    || "",
      improvements: result.improvements || "",
    });
    renderFeedback(result);
  } catch (err) {
    const fb = {
      overallScore: 6,
      breakdown: { relevance: 6, clarity: 6, depth: 5 },
      strengths:    "You provided an answer to the question.",
      improvements: "Include specific examples with measurable results.",
      feedback:     "Could not connect to Ollama for evaluation. Make sure Ollama is running with: ollama serve"
    };
    S.results.push({ q, answer, feedback: fb.feedback, score: fb.overallScore, breakdown: fb.breakdown, strengths: fb.strengths, improvements: fb.improvements });
    renderFeedback(fb);
  }
  document.getElementById("next-btn").disabled = false;
}

// ── Render feedback ───────────────────────────────────────
function renderFeedback(result) {
  const sc  = result.overallScore || 0;
  const cls = sc >= 8 ? "excellent" : sc >= 6 ? "good" : sc >= 4 ? "fair" : "poor";
  const lbl = sc >= 8 ? "★ Excellent · " + sc + "/10" : sc >= 6 ? "✓ Good · " + sc + "/10" : sc >= 4 ? "~ Fair · " + sc + "/10" : "↓ Needs Work · " + sc + "/10";

  // Overall badge
  const ob = document.getElementById("overall-badge");
  ob.className   = `overall-badge ${cls}`;
  ob.textContent = lbl;

  // Score breakdown cards
  const bd = result.breakdown || {};
  const dims = [
    { key: "relevance", label: "Relevance" },
    { key: "clarity",   label: "Clarity" },
    { key: "depth",     label: "Depth" },
  ];
  document.getElementById("score-cards").innerHTML = dims.map(d => {
    const val  = bd[d.key] || 0;
    const pct  = val * 10;
    const fill = val >= 7 ? "high" : val >= 5 ? "mid" : "low";
    const col  = val >= 7 ? "var(--green)" : val >= 5 ? "var(--amber)" : "var(--red)";
    return `
    <div class="score-card">
      <div class="sc-label">${d.label}</div>
      <div class="sc-value" style="color:${col}">${val}<span style="font-size:.9rem;font-weight:500;color:var(--muted)">/10</span></div>
      <div class="sc-bar"><div class="sc-fill ${fill}" style="width:${pct}%"></div></div>
    </div>`;
  }).join("");

  // Strengths / improvements
  const sw = document.getElementById("sw-grid");
  if (result.strengths || result.improvements) {
    sw.style.display = "grid";
    document.getElementById("strength-text").textContent = result.strengths    || "Good effort.";
    document.getElementById("improve-text").textContent  = result.improvements || "Keep practising.";
  } else {
    sw.style.display = "none";
  }

  // Feedback bubble
  document.getElementById("feedback-text").textContent = result.feedback || "No detailed feedback available.";
}

function nextQuestion() {
  if (S.currentAudio) { S.currentAudio.pause(); S.currentAudio = null; }
  if (S.currentQ < S.questions.length - 1) { S.currentQ++; loadQuestion(S.currentQ); }
  else { showResults(); }
}

// ══════════════════════════════════════════════════════════
//  Voice recording (Whisper STT)
// ══════════════════════════════════════════════════════════
async function toggleRecording() {
  S.isRecording ? stopRecording() : await startRecording();
}

async function startRecording() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    S.audioChunks   = [];
    S.mediaRecorder = new MediaRecorder(stream);
    S.mediaRecorder.ondataavailable = e => { if (e.data.size > 0) S.audioChunks.push(e.data); };
    S.mediaRecorder.onstop = transcribeAudio;
    S.mediaRecorder.start();
    S.isRecording = true;
    const btn = document.getElementById("mic-btn");
    const lbl = document.getElementById("mic-status");
    btn.classList.add("recording"); btn.textContent = "⏹";
    lbl.textContent = "Recording… click to stop"; lbl.className = "mic-status recording";
  } catch { alert("Microphone access denied. Please allow mic access in your browser settings."); }
}

function stopRecording() {
  if (S.mediaRecorder && S.mediaRecorder.state !== "inactive") {
    S.mediaRecorder.stop();
    S.mediaRecorder.stream.getTracks().forEach(t => t.stop());
  }
  S.isRecording = false;
  resetMic();
  document.getElementById("mic-status").textContent = "Transcribing…";
}

function resetMic() {
  S.isRecording = false;
  const btn = document.getElementById("mic-btn");
  btn.classList.remove("recording"); btn.textContent = "🎤";
  const lbl = document.getElementById("mic-status");
  lbl.textContent = "Click mic to record"; lbl.className = "mic-status";
}

async function transcribeAudio() {
  const blob = new Blob(S.audioChunks, { type: S.audioChunks[0]?.type || "audio/webm" });
  const form = new FormData();
  form.append("audio", blob, "answer.webm");
  document.getElementById("mic-status").textContent = "Transcribing with Whisper…";
  try {
    const r = await fetch("/api/stt", { method: "POST", body: form });
    const d = await r.json();
    if (d.text) {
      const ta = document.getElementById("answer-input");
      ta.value = (ta.value ? ta.value + " " : "") + d.text;
      document.getElementById("mic-status").textContent = "✓ Transcription added to answer";
    } else {
      document.getElementById("mic-status").textContent = "Transcription failed — please type manually";
    }
  } catch { document.getElementById("mic-status").textContent = "STT error — type manually"; }
}

// ══════════════════════════════════════════════════════════
//  Results
// ══════════════════════════════════════════════════════════
async function showResults() {
  showSection("sec-results");
  document.getElementById("progress-bar").style.width = "100%";

  const valid = S.results.filter(r => r.score > 0);
  const avg   = valid.length ? +(valid.reduce((a, b) => a + b.score, 0) / valid.length).toFixed(1) : 0;

  document.getElementById("final-score").textContent = avg || "–";
  document.getElementById("results-title").textContent =
    avg >= 8 ? "Outstanding!" : avg >= 6 ? "Well Done!" : avg >= 4 ? "Keep Practising" : "Room to Grow";
  document.getElementById("results-sub").textContent =
    `${valid.length} of ${S.questions.length} answered · ${S.role} · ${diffLabel(S.level)}`;

  // Animate ring
  const circle = document.getElementById("ring-circle");
  if (circle) {
    const offset = 263.9 - (avg / 10) * 263.9;
    setTimeout(() => { circle.style.strokeDashoffset = offset; }, 200);
  }

  // Dimension averages
  const dims = ["relevance", "clarity", "depth"];
  const dimAvg = {};
  dims.forEach(d => {
    const vals = S.results.map(r => r.breakdown?.[d]).filter(v => v !== undefined && v > 0);
    dimAvg[d] = vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : 0;
  });
  document.getElementById("breakdown").innerHTML = dims.map(d => `
    <div class="br-row">
      <div class="br-lbl">${d.charAt(0).toUpperCase() + d.slice(1)}</div>
      <div class="br-track"><div class="br-fill" style="width:${dimAvg[d] * 10}%"></div></div>
      <div class="br-val">${dimAvg[d]}/10</div>
    </div>`).join("");

  // Per-question list
  document.getElementById("results-list").innerHTML = S.results.map((r, i) => {
    const col = r.score >= 8 ? "var(--green)" : r.score >= 6 ? "var(--teal)" : r.score >= 4 ? "var(--amber)" : "var(--red)";
    return `<div class="q-result">
      <div class="q-result-top">
        <div class="q-result-q">Q${i + 1}: ${r.q.question}</div>
        <div class="q-result-score" style="color:${col}">${r.score > 0 ? r.score + "/10" : "–"}</div>
      </div>
      <div class="q-result-fb">${r.feedback}</div>
    </div>`;
  }).join("");

  // Save to DB
  try {
    await fetch("/api/save-session", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: S.role, level: S.level, experience: S.experience, score: avg, total_questions: S.questions.length, results: S.results }),
    });
  } catch { /* silent */ }
}

// ══════════════════════════════════════════════════════════
//  History overlay
// ══════════════════════════════════════════════════════════
function bindOverlay() {
  document.getElementById("close-history").addEventListener("click", closeHistory);
  document.getElementById("history-overlay").addEventListener("click", e => {
    if (e.target === document.getElementById("history-overlay")) closeHistory();
  });
}

async function openHistory() {
  document.getElementById("history-overlay").style.display = "flex";
  document.getElementById("history-list").innerHTML =
    `<div class="empty-state"><span class="dots"><span class="dot"></span><span class="dot"></span><span class="dot"></span></span></div>`;
  try {
    const r = await fetch("/api/history");
    const d = await r.json();
    document.getElementById("history-meta").textContent =
      `${d.count} of ${d.max} sessions stored · oldest auto-deleted when limit reached`;
    if (!d.history.length) {
      document.getElementById("history-list").innerHTML = `<div class="empty-state">No sessions yet. Complete an interview to see history here.</div>`;
      return;
    }
    document.getElementById("history-list").innerHTML = d.history.map(h => `
      <div class="h-item" id="h-${h.id}">
        <div class="h-item-info">
          <div class="h-item-role">${h.role}</div>
          <div class="h-item-meta">${diffLabel(h.level)} · ${h.experience || "mid"} · ${h.total_questions} questions · ${formatDate(h.created_at)}</div>
        </div>
        <div class="h-item-score">${h.score ? parseFloat(h.score).toFixed(1) : "–"}</div>
        <button class="h-del-btn" onclick="deleteSession(${h.id})">Delete</button>
      </div>`).join("");
  } catch {
    document.getElementById("history-list").innerHTML = `<div class="empty-state">Could not load history.</div>`;
  }
}

function closeHistory() { document.getElementById("history-overlay").style.display = "none"; }

async function deleteSession(id) {
  if (!confirm("Delete this session?")) return;
  try {
    await fetch(`/api/history/${id}`, { method: "DELETE" });
    const el = document.getElementById(`h-${id}`);
    if (el) el.remove();
  } catch { alert("Delete failed."); }
}

// ── Helpers ───────────────────────────────────────────────
function showSection(id) {
  document.querySelectorAll("section").forEach(s => s.classList.remove("active"));
  document.getElementById(id).classList.add("active");
}

function diffLabel(lvl) {
  return { very_easy: "Very Easy", easy: "Easy", medium: "Medium", difficult: "Difficult" }[lvl] || lvl;
}

function formatDate(str) {
  if (!str) return "";
  try { return new Date(str).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }); }
  catch { return str; }
}
