import { MESSAGES } from "./messages.js";

const TICK_MS = 600;
const ADVANCE_MS = 2000;
const CLIENT_TIMEOUT_MS = 6000; // the Worker gives up at 3s; this only catches a dead connection

const $ = id => document.getElementById(id);
const screens = ["start", "round", "results"];
const show = name => screens.forEach(s => $(s).classList.toggle("on", s === name));
const fmt = ms => (ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(2)}s`);
const sleep = ms => new Promise(r => setTimeout(r, ms));

let order = [];
let results = [];
let sawMock = false;

function shuffle(xs) {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

async function askJev(text) {
  try {
    const r = await fetch("/api/classify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(CLIENT_TIMEOUT_MS),
    });
    const body = await r.json();
    if (!r.ok) return { failed: true };
    if (body.mock) sawMock = true;
    return body;
  } catch {
    return { failed: true };
  }
}

async function countdown() {
  const el = $("count");
  el.hidden = false;
  $("play").hidden = true;
  for (const n of [3, 2, 1]) {
    el.textContent = n;
    el.classList.remove("tick");
    void el.offsetWidth; // restart the animation
    el.classList.add("tick");
    await sleep(TICK_MS);
  }
  el.hidden = true;
}

function resetRoundUI(i) {
  $("roundLabel").textContent = `Round ${i + 1}/${order.length}`;
  $("progress").style.width = `${(i / order.length) * 100}%`;
  const you = results.filter(r => r.humanCorrect).length;
  const jev = results.filter(r => r.jevCorrect).length;
  $("score").textContent = `You ${you} · Jev ${jev}`;
  for (const b of document.querySelectorAll(".choice")) {
    b.disabled = false;
    b.classList.remove("picked");
  }
  for (const id of ["youCard", "jevCard"]) $(id).classList.remove("win");
  $("youMark").textContent = $("jevMark").textContent = "";
  $("youBody").className = "muted thinking";
  $("youBody").textContent = "waiting on you";
  $("jevBody").className = "muted thinking";
  $("jevBody").textContent = "thinking";
  $("next").textContent = "";
}

// Resolves on the first tap. pointerdown, not click: click waits for the finger to lift.
function waitForHuman(t0) {
  return new Promise(resolve => {
    const buttons = [...document.querySelectorAll(".choice")];
    const onPick = e => {
      const humanTimeMs = performance.now() - t0;
      e.preventDefault();
      for (const b of buttons) {
        b.disabled = true;
        b.removeEventListener("pointerdown", onPick);
      }
      e.currentTarget.classList.add("picked");
      resolve({ humanSaysSpam: e.currentTarget.dataset.spam === "1", humanTimeMs });
    };
    for (const b of buttons) b.addEventListener("pointerdown", onPick);
  });
}

const mark = ok => `<span class="${ok ? "ok" : "bad"}">${ok ? "✓ correct" : "✗ wrong"}</span>`;

function renderHuman({ humanSaysSpam, humanTimeMs }, truth) {
  $("youBody").className = "";
  $("youBody").innerHTML =
    `<div class="time tabnum">${fmt(humanTimeMs)}</div>` +
    `<div class="verdict">${humanSaysSpam ? "🚫 Spam" : "✅ Not spam"}</div>`;
  $("youMark").innerHTML = mark(humanSaysSpam === truth);
}

function renderJev(jev, truth) {
  $("jevBody").className = "";
  if (jev.failed) {
    $("jevBody").innerHTML = `<div class="verdict bad">Jev didn't respond in time</div><div class="sub">counts as wrong</div>`;
    $("jevMark").innerHTML = mark(false);
    return;
  }
  const pct = Math.round(Math.max(jev.probability, 1 - jev.probability) * 100);
  $("jevBody").innerHTML =
    `<div class="time tabnum">${fmt(jev.latencyMs)}</div>` +
    `<div class="verdict">${jev.isSpam ? "🚫 Spam" : "✅ Not spam"}</div>` +
    `<div class="conf" title="spam probability ${jev.probability.toFixed(2)}"><b style="left:${jev.probability * 100}%"></b></div>` +
    `<div class="sub tabnum">${pct}% sure: ${jev.isSpam ? "spam" : "not spam"}${sawMock ? ' · <span class="badge">MOCK</span>' : ""}</div>`;
  $("jevMark").innerHTML = mark(jev.isSpam === truth);
}

// Tap anywhere to skip the wait, or wait ADVANCE_MS.
function waitToAdvance(isLast, verdict) {
  $("next").textContent = `${verdict} · ${isLast ? "tap for results" : "tap to continue"}`;
  return new Promise(resolve => {
    const done = () => {
      clearTimeout(timer);
      document.removeEventListener("pointerdown", done);
      resolve();
    };
    const timer = setTimeout(done, ADVANCE_MS);
    // Attach after this tap's own event has finished bubbling.
    setTimeout(() => document.addEventListener("pointerdown", done), 250);
  });
}

async function playRound(i) {
  const { text, isSpam: truth } = order[i];
  resetRoundUI(i);
  await countdown();

  $("msg").textContent = text;
  $("play").hidden = false;
  // Same tick: human clock starts, Jev request leaves.
  const t0 = performance.now();
  const jevP = askJev(text);
  const humanP = waitForHuman(t0);

  // If Jev finishes first, only say that it answered: showing the verdict would let you copy it.
  let humanDone = false;
  jevP.then(jev => {
    if (humanDone) return;
    $("jevBody").className = "";
    $("jevBody").innerHTML = jev.failed
      ? `<div class="verdict muted">no answer yet…</div>`
      : `<div class="time tabnum">${fmt(jev.latencyMs)}</div><div class="sub">answered, hidden until you pick</div>`;
  });
  const humanResult = await humanP;
  humanDone = true;
  renderHuman(humanResult, truth);
  const jev = await jevP;
  renderJev(jev, truth);

  const r = {
    text, truth,
    humanSaysSpam: humanResult.humanSaysSpam,
    humanTimeMs: humanResult.humanTimeMs,
    humanCorrect: humanResult.humanSaysSpam === truth,
    jevFailed: Boolean(jev.failed),
    jevLatencyMs: jev.failed ? null : jev.latencyMs,
    jevProbability: jev.failed ? null : jev.probability,
    jevCorrect: !jev.failed && jev.isSpam === truth,
  };
  results.push(r);

  const humanFaster = r.jevFailed || r.humanTimeMs <= r.jevLatencyMs;
  $(humanFaster ? "youCard" : "jevCard").classList.add("win");
  const verdict = r.jevFailed
    ? "⚡ You were faster"
    : `⚡ ${humanFaster ? "You" : "Jev"} faster by ${fmt(Math.abs(r.humanTimeMs - r.jevLatencyMs))}`;

  await waitToAdvance(i === order.length - 1, verdict);
}

function summarize() {
  const n = results.length;
  const humanTotal = results.reduce((s, r) => s + r.humanTimeMs, 0);
  const answered = results.filter(r => !r.jevFailed);
  const jevTotal = answered.reduce((s, r) => s + r.jevLatencyMs, 0);
  const humanAvg = humanTotal / n;
  const jevAvg = answered.length ? jevTotal / answered.length : null;
  return {
    n, humanTotal, humanAvg, jevTotal, jevAvg,
    jevMisses: n - answered.length,
    humanCorrect: results.filter(r => r.humanCorrect).length,
    jevCorrect: results.filter(r => r.jevCorrect).length,
    multiplier: jevAvg ? humanAvg / jevAvg : null,
  };
}

function headlineFor(s) {
  if (s.multiplier == null) return "Jev never showed up. You win by default.";
  if (s.multiplier >= 1.05) return `Jev was ${s.multiplier.toFixed(1)}× faster than you`;
  if (s.multiplier <= 0.95) return `You were ${(1 / s.multiplier).toFixed(1)}× faster than Jev 🤯`;
  return "Dead heat on speed";
}

function shareText(s) {
  const url = location.origin;
  if (s.multiplier == null) return `I raced an AI on ${s.n} spam messages and got ${s.humanCorrect}/${s.n} right. Try to beat Jev: ${url}`;
  const speed = s.multiplier >= 1
    ? `It was ~${s.multiplier.toFixed(1)}x faster`
    : `I was ~${(1 / s.multiplier).toFixed(1)}x faster`;
  return `I raced an AI on ${s.n} spam messages. ${speed} and got ${s.jevCorrect}/${s.n} right (I got ${s.humanCorrect}/${s.n}). Try to beat Jev: ${url}`;
}

function drawCard(s) {
  const c = $("shareCanvas");
  const g = c.getContext("2d");
  const W = c.width, H = c.height;
  g.fillStyle = "#0b0d10"; g.fillRect(0, 0, W, H);
  const font = (w, px) => `${w} ${px}px ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;

  g.fillStyle = "#eef1f5"; g.font = font(900, 64); g.textBaseline = "top";
  g.fillText("Beat", 64, 56);
  const w = g.measureText("Beat").width;
  g.fillStyle = "#ffd23f"; g.fillText("Jev", 64 + w, 56);
  g.fillStyle = "#8a94a3"; g.font = font(600, 30);
  g.fillText(`Human vs AI · ${s.n} spam calls`, 64, 136);

  g.fillStyle = "#ffd23f"; g.font = font(900, 58);
  g.fillText(headlineFor(s).replace(" 🤯", ""), 64, 206);

  const col = (x, label, avg, acc) => {
    g.fillStyle = "#151920"; roundRect(g, x, 320, 520, 290, 24); g.fill();
    g.fillStyle = "#8a94a3"; g.font = font(700, 28); g.fillText(label, x + 36, 352);
    g.fillStyle = "#eef1f5"; g.font = font(900, 84); g.fillText(avg, x + 36, 398);
    g.fillStyle = "#8a94a3"; g.font = font(600, 26); g.fillText("average per message", x + 36, 492);
    g.fillStyle = "#2ecc8f"; g.font = font(800, 40); g.fillText(acc, x + 36, 536);
  };
  col(64, "YOU", fmt(s.humanAvg), `${s.humanCorrect}/${s.n} correct`);
  col(616, "JEV", s.jevAvg == null ? "—" : fmt(s.jevAvg), `${s.jevCorrect}/${s.n} correct`);

  g.fillStyle = "#8a94a3"; g.font = font(600, 26);
  g.fillText(`Try to beat Jev → ${location.host}`, 64, 632);
}

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

function showResults() {
  const s = summarize();
  $("headline").textContent = headlineFor(s);
  $("rYouAvg").textContent = fmt(s.humanAvg);
  $("rYouTot").textContent = `total ${fmt(s.humanTotal)}`;
  $("rJevAvg").textContent = s.jevAvg == null ? "—" : fmt(s.jevAvg);
  $("rJevTot").textContent = `total ${fmt(s.jevTotal)}`;
  $("rYouAcc").textContent = `${s.humanCorrect}/${s.n}`;
  $("rJevAcc").textContent = `${s.jevCorrect}/${s.n}`;
  $("rJevMiss").innerHTML = [
    s.jevMisses ? `${s.jevMisses} timed out` : "",
    sawMock ? '<span class="badge">MOCK, not Jev</span>' : "",
  ].filter(Boolean).join(" · ");
  $("tweet").href = `https://twitter.com/intent/tweet?text=${encodeURIComponent(shareText(s))}`;
  drawCard(s);
  $("shareImg").onclick = () => shareImage(s);
  show("results");
}

async function shareImage(s) {
  const blob = await new Promise(r => $("shareCanvas").toBlob(r, "image/png"));
  const file = new File([blob], "beatjev.png", { type: "image/png" });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], text: shareText(s) }); } catch { /* user cancelled */ }
    return;
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "beatjev.png";
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function start() {
  order = shuffle(MESSAGES);
  results = [];
  sawMock = false;
  show("round");
  for (let i = 0; i < order.length; i++) await playRound(i);
  $("progress").style.width = "100%";
  showResults();
}

$("go").addEventListener("click", start);
$("again").addEventListener("click", start);
