// X06 Decoder v5 (one-screen layout + spectrum visibility fix + HiDPI canvas resize)
// + Highlight DB row on detected station

const UI = {
  btnStart: document.getElementById("btnStart"),
  btnStop: document.getElementById("btnStop"),
  status: document.getElementById("status"),
  digit: document.getElementById("digit"),
  freq: document.getElementById("freq"),
  strength: document.getElementById("strength"),
  buffer: document.getElementById("buffer"),
  result: document.getElementById("result"),
  qualityHint: document.getElementById("qualityHint"),

  selInput: document.getElementById("selInput"),
  btnRefresh: document.getElementById("btnRefresh"),
  chkFft8192: document.getElementById("chkFft8192"),
  chkAutolock: document.getElementById("chkAutolock"),
  chkWaterfall: document.getElementById("chkWaterfall"),

  spec: document.getElementById("spec"),
  wf: document.getElementById("wf"),
  rngFps: document.getElementById("rngFps"),
  fpsVal: document.getElementById("fpsVal"),
  rngGate: document.getElementById("rngGate"),
  gateVal: document.getElementById("gateVal"),

  genSeq: document.getElementById("genSeq"),
  genToneMs: document.getElementById("genToneMs"),
  genGapMs: document.getElementById("genGapMs"),
  genVol: document.getElementById("genVol"),
  genLoop: document.getElementById("genLoop"),
  btnGenPlay: document.getElementById("btnGenPlay"),
  btnGenStop: document.getElementById("btnGenStop"),
  genHint: document.getElementById("genHint"),

  dbSearch: document.getElementById("dbSearch"),
  dbPrev: document.getElementById("dbPrev"),
  dbNext: document.getElementById("dbNext"),
  dbPageInfo: document.getElementById("dbPageInfo"),
  dbTable: document.getElementById("dbTable"),
};

let DB = null;
let TONE_MAP = { "1": 815, "2": 845, "3": 875, "4": 910, "5": 950, "6": 990 };
let TOLERANCE_HZ = 22;
let TONE_DURATION_MS = 333.333;

let audioCtx = null, analyser = null, micStream = null, srcNode = null;
let fftByte = null, binLo = 0, binHi = 0;

let specCtx = null, wfCtx = null;

let running = false, lastPlot = 0, plotFps = 20;
let MIN_STRENGTH = 170;

let lastDigit = null, lastDigitTs = 0, stableMs = 0;
let seqDigits = [], lastCommitTs = 0, lastNonNullTs = 0;

const COMMIT_AFTER_MS = 180, GAP_RESET_MS = 2200, PAUSE_DETECT_MS = 800;

let lastDet = { digit: null, freqHz: null, strength: 0, second: 0 };

// --- DB highlight state ---
let highlightedSequence = null;

// --- helpers ---
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
}[c]));

function setStatus(t) { UI.status.textContent = t; }
function setDigit(d) { UI.digit.textContent = d ?? "—"; }
function setFreq(f) { UI.freq.textContent = (f == null) ? "—" : `${f.toFixed(1)} Hz`; }
function setStrength(v) { UI.strength.textContent = (v == null) ? "—" : `${Math.round(v)}`; }
function setBuffer() { UI.buffer.textContent = seqDigits.length ? seqDigits.join("") : "—"; }

function renderResult(seq, item) {
  if (!seq) { UI.result.textContent = "—"; return; }
  if (!item) { UI.result.innerHTML = `<b>${seq}</b> → unknown`; return; }
  UI.result.innerHTML = `<b>${seq}</b> → <b>${esc(item.target)}</b>`;
}

function lookupSequence(seq) {
  return DB?.stations?.find(s => s.sequence === seq) ?? null;
}

function hzToBin(hz, sr, fft) { return Math.round(hz * fft / sr); }

function windowMax(center, r) {
  let bb = center, bv = 0;
  for (let i = Math.max(binLo, center - r); i <= Math.min(binHi, center + r); i++) {
    const v = fftByte[i];
    if (v > bv) { bv = v; bb = i; }
  }
  return { bb, bv };
}

function parab(y1, y2, y3) {
  const den = (y1 - 2 * y2 + y3);
  if (den === 0) return 0;
  return 0.5 * (y1 - y3) / den;
}

// --- highlight helpers ---
function highlightSequence(seq) {
  if (!seq) return;
  highlightedSequence = seq;

  // If user has an active filter, the item might not be in dbFiltered.
  // Easiest robust behavior: clear search filter, show full list, then jump.
  if (UI.dbSearch && (UI.dbSearch.value || "").trim() !== "") {
    UI.dbSearch.value = "";
    applyDbFilter(); // sets dbFiltered to all, renders table
  }

  const list = (dbFiltered && dbFiltered.length) ? dbFiltered : (DB?.stations || []);
  const idx = list.findIndex(s => s.sequence === seq);

  if (idx >= 0) {
    dbPage = Math.floor(idx / DB_PAGE_SIZE);
  }

  renderDbTable();

  const row = UI.dbTable?.querySelector?.(`tbody tr[data-seq="${seq}"]`);
  if (row) {
    row.scrollIntoView({ block: "nearest" });
  }
}

function clearHighlight() {
  highlightedSequence = null;
  renderDbTable();
}

function resetDecoder() {
  lastDigit = null; lastDigitTs = performance.now(); stableMs = 0;
  seqDigits = []; lastCommitTs = 0; lastNonNullTs = 0;
  lastDet = { digit: null, freqHz: null, strength: 0, second: 0 };
  setDigit(null); setFreq(null); setStrength(null); setBuffer(); renderResult(null, null);
  clearHighlight();
}

function commitDigit(d, now) {
  seqDigits.push(d); if (seqDigits.length > 6) seqDigits = seqDigits.slice(-6);
  lastCommitTs = now; setBuffer();
}

function finalizeIfComplete() {
  if (seqDigits.length !== 6) return;
  const seq = seqDigits.join("");
  const item = lookupSequence(seq);
  renderResult(seq, item);

  // highlight DB entry for this sequence
  highlightSequence(seq);
}

// --- HiDPI canvas ---
function resizeCanvas(canvas) {
  const r = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(r.width * dpr));
  const h = Math.max(1, Math.round(r.height * dpr));
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
}

function ensureCanvases() {
  resizeCanvas(UI.spec); resizeCanvas(UI.wf);
  if (!specCtx) specCtx = UI.spec.getContext("2d", { alpha: false });
  if (!wfCtx) wfCtx = UI.wf.getContext("2d", { alpha: false });
  // spectrum visibility (fix)
  specCtx.strokeStyle = "#e8eefc";
  specCtx.fillStyle = "#e8eefc";
  specCtx.lineWidth = 1;
  wfCtx.imageSmoothingEnabled = false;
}

// --- detection ---
function detect() {
  analyser.getByteFrequencyData(fftByte);

  let bestD = null, bestV = 0, bestB = null, secondV = 0;
  for (const [d, hz] of Object.entries(TONE_MAP)) {
    const b = hzToBin(hz, audioCtx.sampleRate, analyser.fftSize);
    if (b < binLo || b > binHi) continue;
    const rad = (d === "6" || d === "1") ? 4 : 3;
    const { bb, bv } = windowMax(b, rad);
    if (bv > bestV) { secondV = bestV; bestV = bv; bestD = d; bestB = bb; }
    else if (bv > secondV) { secondV = bv; }
  }
  if (bestV < MIN_STRENGTH || bestB == null) return { digit: null, freqHz: null, strength: bestV, second: secondV };

  const y1 = fftByte[Math.max(binLo, bestB - 1)], y2 = fftByte[bestB], y3 = fftByte[Math.min(binHi, bestB + 1)];
  const frac = bestB + parab(y1, y2, y3);
  const freqHz = frac * audioCtx.sampleRate / analyser.fftSize;

  // prefer freq mapping if close
  let nearest = null, diff = Infinity;
  for (const [d, hz] of Object.entries(TONE_MAP)) {
    const dd = Math.abs(freqHz - hz);
    if (dd < diff) { diff = dd; nearest = d; }
  }
  const digit = (diff <= TOLERANCE_HZ * 2) ? nearest : bestD;
  return { digit, freqHz, strength: bestV, second: secondV, nearestDigit: nearest, nearestDiff: diff };
}

// --- drawing ---
function drawSpectrumAxis(w, h) {
  // axis at bottom of spectrum
  const sr = audioCtx.sampleRate;
  const fft = analyser.fftSize;
  const hzLo = Math.round(binLo * sr / fft);
  const hzHi = Math.round(binHi * sr / fft);
  const step = 50; // Hz
  specCtx.globalAlpha = 0.7;
  specCtx.fillStyle = "#e8eefc";
  specCtx.font = `${Math.round(11 * (window.devicePixelRatio || 1))}px ui-monospace, Menlo, Consolas, monospace`;
  specCtx.strokeStyle = "rgba(232,238,252,.18)";
  for (let hz = Math.ceil(hzLo / step) * step; hz <= hzHi; hz += step) {
    const b = hzToBin(hz, sr, fft);
    const x = (b - binLo) / (binHi - binLo) * (w - 1);
    specCtx.beginPath();
    specCtx.moveTo(x, h - 16);
    specCtx.lineTo(x, h);
    specCtx.stroke();
    // label every 100 Hz to avoid clutter
    if (hz % 100 === 0) {
      specCtx.fillText(String(hz), x + 2, h - 4);
    }
  }
  specCtx.globalAlpha = 1;
}

function drawSpectrum(now) {
  if (!specCtx || !fftByte) return;
  const minFrame = 1000 / Math.max(5, plotFps);
  if (now - lastPlot < minFrame) return;
  lastPlot = now;

  const w = UI.spec.width, h = UI.spec.height;
  specCtx.clearRect(0, 0, w, h);

  specCtx.beginPath();
  let started = false;
  for (let i = binLo; i <= binHi; i++) {
    const x = (i - binLo) / (binHi - binLo) * (w - 1);
    const v = fftByte[i] / 255;
    const y = (1 - v) * (h - 1);
    if (!started) { specCtx.moveTo(x, y); started = true; }
    else specCtx.lineTo(x, y);
  }
  specCtx.stroke();

  for (const [d, hz] of Object.entries(TONE_MAP)) {
    const b = hzToBin(hz, audioCtx.sampleRate, analyser.fftSize);
    if (b < binLo || b > binHi) continue;
    const x = (b - binLo) / (binHi - binLo) * (w - 1);
    specCtx.globalAlpha = 0.35;
    specCtx.beginPath(); specCtx.moveTo(x, 0); specCtx.lineTo(x, h); specCtx.stroke();
    specCtx.globalAlpha = 0.9;
    specCtx.fillText(d, x + 3, 14);
  }
  specCtx.globalAlpha = 1;

  drawSpectrumAxis(w, h);

  if (lastDet.freqHz != null) {
    const b = (lastDet.freqHz * analyser.fftSize) / audioCtx.sampleRate;
    const x = (b - binLo) / (binHi - binLo) * (w - 1);
    if (x >= 0 && x <= w) {
      specCtx.beginPath(); specCtx.moveTo(x, 0); specCtx.lineTo(x, h); specCtx.stroke();
    }
  }
}

function drawWaterfall() {
  if (!wfCtx || !fftByte || !UI.chkWaterfall.checked) return;
  const w = UI.wf.width, h = UI.wf.height;
  wfCtx.drawImage(UI.wf, -1, 0);
  const x = w - 1;
  for (let y = 0; y < h; y++) {
    const t = 1 - (y / (h - 1));
    const bin = Math.round(binLo + t * (binHi - binLo));
    const v = fftByte[bin];
    wfCtx.fillStyle = `rgb(${v},${v},${v})`;
    wfCtx.fillRect(x, y, 1, 1);
  }
}

function tick() {
  if (!running) return;
  ensureCanvases();
  const now = performance.now();
  const det = detect(); lastDet = det;

  setStrength(det.strength);
  if (det.digit) { lastNonNullTs = now; setDigit(det.digit); setFreq(det.freqHz); }
  else { setDigit(null); setFreq(det.freqHz); }

  drawSpectrum(now);
  drawWaterfall();

  const autolock = UI.chkAutolock.checked;
  if (!autolock) {
    if (det.digit && det.digit !== lastDigit) { lastDigit = det.digit; commitDigit(det.digit, now); }
    else if (!det.digit) { lastDigit = null; }
  } else {
    if (det.digit === lastDigit && det.digit != null) { stableMs = now - lastDigitTs; }
    else { lastDigit = det.digit; lastDigitTs = now; stableMs = 0; }

    const alreadyCommitted =
      seqDigits.length &&
      seqDigits[seqDigits.length - 1] === det.digit &&
      (now - lastCommitTs) < (TONE_DURATION_MS * 0.6);

    if (det.digit && stableMs >= COMMIT_AFTER_MS && !alreadyCommitted) { commitDigit(det.digit, now); }
  }

  if (seqDigits.length && (now - lastNonNullTs) > GAP_RESET_MS) { resetDecoder(); setStatus("ready (reset after pause)"); }
  if (seqDigits.length === 6 && (now - lastNonNullTs) > PAUSE_DETECT_MS) { finalizeIfComplete(); seqDigits = []; setBuffer(); }

  requestAnimationFrame(tick);
}

// --- devices ---
async function refreshInputs() {
  const dev = await navigator.mediaDevices.enumerateDevices();
  const ins = dev.filter(d => d.kind === "audioinput");
  UI.selInput.innerHTML = "";
  for (const d of ins) {
    const o = document.createElement("option");
    o.value = d.deviceId;
    o.textContent = d.label || `Audio Input (${d.deviceId.slice(0, 6)}…)`;
    UI.selInput.appendChild(o);
  }
  if (!ins.length) {
    const o = document.createElement("option");
    o.value = ""; o.textContent = "No audio inputs found";
    UI.selInput.appendChild(o);
  }
}

// --- start/stop ---
async function start() {
  if (audioCtx) return;
  ensureCanvases();
  resetDecoder();

  plotFps = Number(UI.rngFps.value || 20);
  MIN_STRENGTH = Number(UI.rngGate.value || 170);

  setStatus("Microphone is starting up...");
  try {
    const deviceId = UI.selInput.value || undefined;
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        echoCancellation: false, noiseSuppression: false, autoGainControl: false
      }
    });

    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = UI.chkFft8192.checked ? 8192 : 4096;
    analyser.smoothingTimeConstant = 0.05;

    srcNode = audioCtx.createMediaStreamSource(micStream);
    srcNode.connect(analyser);

    binLo = hzToBin(650, audioCtx.sampleRate, analyser.fftSize);
    binHi = hzToBin(1150, audioCtx.sampleRate, analyser.fftSize);
    fftByte = new Uint8Array(analyser.frequencyBinCount);

    UI.btnStart.disabled = true;
    UI.btnStop.disabled = false;
    running = true;
    setStatus("running");
    UI.qualityHint.textContent = "";
    tick();
    await refreshInputs();
  } catch (e) {
    console.error(e);
    setStatus("Error: Microphone access failed");
    UI.qualityHint.textContent = String(e?.message || e);
    stop();
  }
}

function stop() {
  running = false;
  try { srcNode && srcNode.disconnect(); } catch { }
  if (micStream) micStream.getTracks().forEach(t => t.stop());
  micStream = null;
  if (audioCtx) audioCtx.close().catch(() => { });
  audioCtx = null; analyser = null; srcNode = null; fftByte = null;
  UI.btnStart.disabled = false;
  UI.btnStop.disabled = true;
  setStatus("stopped");
  setDigit(null); setFreq(null); setStrength(null);
}

// --- DB browser ---
let dbFiltered = [], dbPage = 0;
const DB_PAGE_SIZE = 25;

function applyDbFilter() {
  const q = (UI.dbSearch.value || "").trim().toLowerCase();
  const all = DB?.stations || [];
  dbFiltered = !q ? all : all.filter(s =>
    s.sequence.includes(q) || (s.target || "").toLowerCase().includes(q)
  );
  dbPage = 0; renderDbTable();
}

function renderDbTable() {
  const total = dbFiltered.length;
  const pages = Math.max(1, Math.ceil(total / DB_PAGE_SIZE));
  dbPage = Math.max(0, Math.min(dbPage, pages - 1));
  const start = dbPage * DB_PAGE_SIZE;
  const slice = dbFiltered.slice(start, start + DB_PAGE_SIZE);
  UI.dbPageInfo.textContent = `${dbPage + 1}/${pages} (${total})`;

  const rows = slice.map(s => {
    const hl = (highlightedSequence === s.sequence) ? ' class="hl"' : "";
    return `
    <tr${hl} data-seq="${s.sequence}">
      <td><b>${s.sequence}</b></td>
      <td>${esc(s.target)}</td>
      <td>${esc(s.daytime ?? "")}</td>
      <td>${esc(s.nighttime ?? "")}</td>
    </tr>
  `;
  }).join("");

  UI.dbTable.innerHTML = `
    <thead><tr><th>Sequence</th><th>Target</th><th>Daytime frequencies</th><th>Nighttime frequencies</th></tr></thead>
    <tbody>${rows || `<tr><td colspan="4">Keine Treffer</td></tr>`}</tbody>
  `;

  UI.dbTable.querySelectorAll("tbody tr[data-seq]").forEach(tr => {
    tr.addEventListener("click", () => { UI.genSeq.value = tr.getAttribute("data-seq"); });
  });

  UI.dbPrev.disabled = (dbPage <= 0);
  UI.dbNext.disabled = (dbPage >= pages - 1);
}

// --- Generator ---
let genCtx = null, genOsc = null, genGain = null, genTimer = null;

async function playSequenceOnce(seq, toneMs, gapMs, vol) {
  if (!genCtx) genCtx = new (window.AudioContext || window.webkitAudioContext)();
  await genCtx.resume();

  try { genOsc && genOsc.stop(); } catch { }
  genOsc = genCtx.createOscillator();
  genGain = genCtx.createGain();
  genGain.gain.value = 0.0001;
  genOsc.type = "sine";
  genOsc.connect(genGain).connect(genCtx.destination);
  genOsc.start();

  const ramp = 0.006;
  let t = genCtx.currentTime + 0.05;

  for (const ch of seq) {
    const hz = Number(TONE_MAP[ch]);
    if (!hz) continue;
    genOsc.frequency.setValueAtTime(hz, t);
    genGain.gain.setValueAtTime(0.0001, t);
    genGain.gain.exponentialRampToValueAtTime(vol, t + ramp);
    genGain.gain.setValueAtTime(vol, t + (toneMs / 1000) - ramp);
    genGain.gain.exponentialRampToValueAtTime(0.0001, t + (toneMs / 1000));
    t += (toneMs + gapMs) / 1000;
  }
  genOsc.stop(t + 0.05);

  const local = genOsc;
  local.onended = () => {
    if (local !== genOsc) return;
    if (!UI.genLoop.checked) {
      UI.btnGenPlay.disabled = false;
      UI.btnGenStop.disabled = true;
      UI.genHint.textContent = "ready";
    }
  };
}

async function startGenerator() {
  const seq = (UI.genSeq.value || "").trim();
  if (!/^[1-6]{6}$/.test(seq)) { UI.genHint.textContent = "Please enter 6 digits, only 1–6."; return; }
  const toneMs = Math.max(60, Math.min(2000, Number(UI.genToneMs.value || 333)));
  const gapMs = Math.max(0, Math.min(2000, Number(UI.genGapMs.value || 40)));
  const vol = Math.max(0.05, Math.min(0.9, Number(UI.genVol.value || 0.35)));

  UI.btnGenPlay.disabled = true;
  UI.btnGenStop.disabled = false;
  UI.genHint.textContent = "playing…";

  const schedule = async () => {
    await playSequenceOnce(seq, toneMs, gapMs, vol);
    const totalMs = 100 + seq.length * (toneMs + gapMs) + 150;
    if (UI.genLoop.checked) genTimer = setTimeout(schedule, totalMs);
  };
  schedule();
}

function stopGenerator() {
  if (genTimer) { clearTimeout(genTimer); genTimer = null; }
  try { genOsc && genOsc.stop(); } catch { }
  genOsc = null; genGain = null;
  UI.btnGenPlay.disabled = false;
  UI.btnGenStop.disabled = true;
  UI.genHint.textContent = "stopped";
}

// --- init ---
async function loadDb() {
  const res = await fetch("db.json", { cache: "no-store" });
  DB = await res.json();
  const sig = DB.signal || {};
  if (sig.mapping) TONE_MAP = sig.mapping;
  if (sig.tolerance_hz) TOLERANCE_HZ = sig.tolerance_hz;
  if (sig.tone_duration_ms) TONE_DURATION_MS = sig.tone_duration_ms;

  dbFiltered = DB.stations || [];
  renderDbTable();
}

UI.btnStart.addEventListener("click", start);
UI.btnStop.addEventListener("click", stop);
UI.btnRefresh.addEventListener("click", refreshInputs);

UI.rngFps.addEventListener("input", () => { plotFps = Number(UI.rngFps.value || 20); UI.fpsVal.textContent = String(plotFps); });
UI.rngGate.addEventListener("input", () => { MIN_STRENGTH = Number(UI.rngGate.value || 170); UI.gateVal.textContent = String(MIN_STRENGTH); });

UI.dbSearch.addEventListener("input", applyDbFilter);
UI.dbPrev.addEventListener("click", () => { dbPage--; renderDbTable(); });
UI.dbNext.addEventListener("click", () => { dbPage++; renderDbTable(); });

UI.btnGenPlay.addEventListener("click", startGenerator);
UI.btnGenStop.addEventListener("click", stopGenerator);

window.addEventListener("resize", ensureCanvases);

loadDb().then(refreshInputs).then(() => {
  UI.fpsVal.textContent = String(UI.rngFps.value || 20);
  UI.gateVal.textContent = String(UI.rngGate.value || 170);
  ensureCanvases();
  setStatus("ready");
}).catch(e => { console.error(e); setStatus("Error: db.json could not be loaded."); });
