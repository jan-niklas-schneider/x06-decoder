// X06 Decoder v4
// Adds: frequency/strength display, better tone scoring, optional FFT8192, adjustable gate.

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

  spec: document.getElementById("spec"),
  wf: document.getElementById("wf"),
  chkWaterfall: document.getElementById("chkWaterfall"),
  chkAutolock: document.getElementById("chkAutolock"),
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

  mapTable: document.getElementById("mapTable"),
};

let DB = null;

let TONE_MAP = { "1": 815, "2": 845, "3": 875, "4": 910, "5": 950, "6": 990 };
let TONE_DURATION_MS = 333.333;
let TOLERANCE_HZ = 22; // more forgiving

let audioCtx = null;
let analyser = null;
let micStream = null;
let srcNode = null;

let fftByte = null;
let binLo = 0, binHi = 0;

let specCtx = null;
let wfCtx = null;

let running = false;
let lastPlot = 0;
let plotFps = 20;

let lastDigit = null;
let lastDigitTs = 0;
let stableMs = 0;
let seqDigits = [];
let lastCommitTs = 0;
let lastNonNullTs = 0;

const COMMIT_AFTER_MS = 180;
const GAP_RESET_MS = 2200;
const PAUSE_DETECT_MS = 800;

// gate is adjustable via UI (byte FFT 0..255)
let MIN_STRENGTH = 170;

// store last detection for plotting line + UI
let lastDet = { digit: null, freqHz: null, strength: 0 };

// ---------- helpers ----------
function setStatus(t){ UI.status.textContent = t; }
function setDigit(d){ UI.digit.textContent = d ?? "—"; }
function setFreq(f){ UI.freq.textContent = (f == null) ? "—" : `${f.toFixed(1)} Hz`; }
function setStrength(v){ UI.strength.textContent = (v == null) ? "—" : `${Math.round(v)}`; }
function setBuffer(){ UI.buffer.textContent = seqDigits.length ? seqDigits.join("") : "—"; }

function hzToBin(hz, sr, fft){ return Math.round(hz * fft / sr); }

function lookupSequence(seq){
  return DB?.stations?.find(s => s.sequence === seq) ?? null;
}
function escapeHtml(str){
  return String(str ?? "").replace(/[&<>"']/g, s => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"
  }[s]));
}
function renderResult(seq, item){
  if (!seq){ UI.result.textContent = "—"; return; }
  if (!item){ UI.result.innerHTML = `<b>${seq}</b> → unbekannt`; return; }
  UI.result.innerHTML = `<b>${seq}</b> → <b>${escapeHtml(item.target)}</b>`;
}

// ---------- decoder state ----------
function resetDecoder(){
  lastDigit = null;
  lastDigitTs = performance.now();
  stableMs = 0;
  seqDigits = [];
  lastCommitTs = 0;
  lastNonNullTs = 0;
  lastDet = { digit:null, freqHz:null, strength:0 };
  setDigit(null); setFreq(null); setStrength(null);
  setBuffer();
  renderResult(null, null);
}

function commitDigit(d, now){
  seqDigits.push(d);
  if (seqDigits.length > 6) seqDigits = seqDigits.slice(-6);
  lastCommitTs = now;
  setBuffer();
}

function finalizeIfComplete(){
  if (seqDigits.length !== 6) return;
  const seq = seqDigits.join("");
  renderResult(seq, lookupSequence(seq));
}

function ensureCanvas(){
  if (!specCtx) specCtx = UI.spec.getContext("2d", { alpha:false });
  if (!wfCtx) wfCtx = UI.wf.getContext("2d", { alpha:false });
}

// ---------- improved detection ----------
// Score each expected tone by max amplitude in a small bin window.
// Then estimate frequency using quadratic interpolation around the strongest bin.
function windowMax(binCenter, radius){
  let bestBin = binCenter;
  let bestVal = 0;
  for (let i = Math.max(binLo, binCenter - radius); i <= Math.min(binHi, binCenter + radius); i++){
    const v = fftByte[i];
    if (v > bestVal){ bestVal = v; bestBin = i; }
  }
  return { bestBin, bestVal };
}

// Quadratic interpolation around peak bin: returns fractional bin offset
function parabolicInterp(y1, y2, y3){
  const denom = (y1 - 2*y2 + y3);
  if (denom === 0) return 0;
  return 0.5 * (y1 - y3) / denom; // in [-0.5..0.5] typically
}

function detect(){
  if (!analyser || !fftByte) return { digit:null, freqHz:null, strength:0 };

  analyser.getByteFrequencyData(fftByte);

  // per-tone scoring
  let bestDigit = null;
  let bestVal = 0;
  let bestBin = null;

  const radius = 3;

  for (const [d, hz] of Object.entries(TONE_MAP)){
    const b = hzToBin(hz, audioCtx.sampleRate, analyser.fftSize);
    if (b < binLo || b > binHi) continue;
    const { bestBin: b2, bestVal: v } = windowMax(b, radius);
    if (v > bestVal){
      bestVal = v;
      bestDigit = d;
      bestBin = b2;
    }
  }

  if (bestVal < MIN_STRENGTH || bestBin == null){
    return { digit:null, freqHz:null, strength:bestVal };
  }

  // frequency estimation from bestBin with interpolation
  const y1 = fftByte[Math.max(binLo, bestBin - 1)];
  const y2 = fftByte[bestBin];
  const y3 = fftByte[Math.min(binHi, bestBin + 1)];
  const delta = parabolicInterp(y1, y2, y3);
  const fracBin = bestBin + delta;

  const freqHz = fracBin * audioCtx.sampleRate / analyser.fftSize;

  // safety: if way off any tone, null it
  let minDiff = Infinity;
  for (const hz of Object.values(TONE_MAP)){
    minDiff = Math.min(minDiff, Math.abs(freqHz - hz));
  }
  if (minDiff > TOLERANCE_HZ * 2.5){ // very off: likely noise
    return { digit:null, freqHz:freqHz, strength:bestVal };
  }

  return { digit:bestDigit, freqHz, strength:bestVal };
}

// ---------- drawing ----------
function drawSpectrum(now){
  if (!specCtx || !analyser || !fftByte) return;
  const minFrame = 1000 / Math.max(5, plotFps);
  if (now - lastPlot < minFrame) return;
  lastPlot = now;

  // fftByte already filled in detect(); but safe if tick order changes
  analyser.getByteFrequencyData(fftByte);

  const w = UI.spec.width, h = UI.spec.height;
  specCtx.clearRect(0,0,w,h);

  specCtx.beginPath();
  let started = false;
  for (let i = binLo; i <= binHi; i++){
    const x = (i - binLo) / (binHi - binLo) * (w - 1);
    const v = fftByte[i] / 255;
    const y = (1 - v) * (h - 1);
    if (!started){ specCtx.moveTo(x,y); started=true; }
    else specCtx.lineTo(x,y);
  }
  specCtx.stroke();

  // expected markers
  for (const [d, hz] of Object.entries(TONE_MAP)){
    const b = hzToBin(hz, audioCtx.sampleRate, analyser.fftSize);
    if (b < binLo || b > binHi) continue;
    const x = (b - binLo) / (binHi - binLo) * (w - 1);
    specCtx.beginPath();
    specCtx.moveTo(x, 0);
    specCtx.lineTo(x, h);
    specCtx.stroke();
    specCtx.fillText(d, x + 3, 14);
  }

  // detected frequency marker
  if (lastDet.freqHz != null){
    const b = (lastDet.freqHz * analyser.fftSize) / audioCtx.sampleRate;
    const x = (b - binLo) / (binHi - binLo) * (w - 1);
    if (x >= 0 && x <= w){
      specCtx.beginPath();
      specCtx.moveTo(x, 0);
      specCtx.lineTo(x, h);
      specCtx.stroke();
      specCtx.fillText("•", Math.min(w-10, Math.max(0, x + 3)), h - 8);
    }
  }
}

function drawWaterfall(){
  if (!wfCtx || !analyser || !fftByte) return;
  if (!UI.chkWaterfall.checked) return;

  wfCtx.drawImage(UI.wf, -1, 0);

  const w = UI.wf.width, h = UI.wf.height;
  const x = w - 1;

  for (let y = 0; y < h; y++){
    const t = 1 - (y / (h - 1));
    const bin = Math.round(binLo + t * (binHi - binLo));
    const v = fftByte[bin];
    wfCtx.fillStyle = `rgb(${v},${v},${v})`;
    wfCtx.fillRect(x, y, 1, 1);
  }
}

// ---------- main loop ----------
function tick(){
  if (!running) return;
  const now = performance.now();

  const det = detect();
  lastDet = det;

  setStrength(det.strength);
  if (det.digit){
    lastNonNullTs = now;
    setDigit(det.digit);
    setFreq(det.freqHz);
  } else {
    setDigit(null);
    setFreq(det.freqHz); // show freq even if uncertain, can help debugging
  }

  drawSpectrum(now);
  drawWaterfall();

  const autolock = UI.chkAutolock.checked;

  if (!autolock){
    if (det.digit && det.digit !== lastDigit){
      lastDigit = det.digit;
      commitDigit(det.digit, now);
    }
  } else {
    if (det.digit === lastDigit && det.digit !== null){
      stableMs = now - lastDigitTs;
    } else {
      lastDigit = det.digit;
      lastDigitTs = now;
      stableMs = 0;
    }

    const alreadyCommitted =
      seqDigits.length &&
      seqDigits[seqDigits.length - 1] === det.digit &&
      (now - lastCommitTs) < (TONE_DURATION_MS * 0.6);

    if (det.digit && stableMs >= COMMIT_AFTER_MS && !alreadyCommitted){
      commitDigit(det.digit, now);
    }
  }

  if (seqDigits.length && (now - lastNonNullTs) > GAP_RESET_MS){
    resetDecoder();
    setStatus("bereit (Reset nach Pause)");
  }

  if (seqDigits.length === 6 && (now - lastNonNullTs) > PAUSE_DETECT_MS){
    finalizeIfComplete();
    seqDigits = [];
    setBuffer();
  }

  requestAnimationFrame(tick);
}

// ---------- input selection ----------
async function refreshInputs(){
  const devices = await navigator.mediaDevices.enumerateDevices();
  const inputs = devices.filter(d => d.kind === "audioinput");
  UI.selInput.innerHTML = "";
  for (const d of inputs){
    const opt = document.createElement("option");
    opt.value = d.deviceId;
    opt.textContent = d.label || `Audio Input (${d.deviceId.slice(0,6)}…)`;
    UI.selInput.appendChild(opt);
  }
  if (!inputs.length){
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "Keine Audioinputs gefunden";
    UI.selInput.appendChild(opt);
  }
}

// ---------- start/stop ----------
async function start(){
  if (audioCtx) return;
  ensureCanvas();
  resetDecoder();

  plotFps = Number(UI.rngFps.value || 20);
  MIN_STRENGTH = Number(UI.rngGate.value || 170);

  setStatus("Mikrofon wird gestartet …");
  try{
    const deviceId = UI.selInput.value || undefined;

    micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false
      }
    });

    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = UI.chkFft8192.checked ? 8192 : 4096;
    analyser.smoothingTimeConstant = 0.05;

    srcNode = audioCtx.createMediaStreamSource(micStream);
    srcNode.connect(analyser);

    // widen band slightly
    binLo = hzToBin(650, audioCtx.sampleRate, analyser.fftSize);
    binHi = hzToBin(1150, audioCtx.sampleRate, analyser.fftSize);

    fftByte = new Uint8Array(analyser.frequencyBinCount);

    specCtx.clearRect(0,0,UI.spec.width,UI.spec.height);
    wfCtx.clearRect(0,0,UI.wf.width,UI.wf.height);

    UI.btnStart.disabled = true;
    UI.btnStop.disabled = false;

    running = true;
    setStatus("läuft");
    UI.qualityHint.textContent = "Neu: Frequenz+Stärke neben Ziffer. Wenn falsch: Gate erhöhen oder FFT8192 aktivieren.";
    tick();

    await refreshInputs();
  } catch(e){
    console.error(e);
    setStatus("Fehler: Mikrofonzugriff fehlgeschlagen");
    UI.qualityHint.textContent = String(e?.message || e);
    stop();
  }
}

function stop(){
  running = false;
  try{ srcNode && srcNode.disconnect(); } catch {}
  if (micStream) micStream.getTracks().forEach(t => t.stop());
  micStream = null;

  if (audioCtx) audioCtx.close().catch(()=>{});
  audioCtx = null;
  analyser = null;
  srcNode = null;
  fftByte = null;

  UI.btnStart.disabled = false;
  UI.btnStop.disabled = true;
  setStatus("gestoppt");
  setDigit(null); setFreq(null); setStrength(null);
}

// ---------- DB browser ----------
let dbFiltered = [];
let dbPage = 0;
const DB_PAGE_SIZE = 25;

function applyDbFilter(){
  const q = (UI.dbSearch.value || "").trim().toLowerCase();
  const all = DB?.stations || [];
  dbFiltered = !q ? all : all.filter(s =>
    s.sequence.includes(q) || (s.target || "").toLowerCase().includes(q)
  );
  dbPage = 0;
  renderDbTable();
}
function renderDbTable(){
  const total = dbFiltered.length;
  const pages = Math.max(1, Math.ceil(total / DB_PAGE_SIZE));
  dbPage = Math.max(0, Math.min(dbPage, pages - 1));

  const start = dbPage * DB_PAGE_SIZE;
  const slice = dbFiltered.slice(start, start + DB_PAGE_SIZE);

  UI.dbPageInfo.textContent = `Seite ${dbPage + 1} / ${pages} — ${total} Einträge`;

  const rows = slice.map(s => `
    <tr data-seq="${s.sequence}">
      <td><b>${s.sequence}</b></td>
      <td>${escapeHtml(s.target)}</td>
    </tr>
  `).join("");

  UI.dbTable.innerHTML = `
    <thead><tr><th>Sequenz</th><th>Target</th></tr></thead>
    <tbody>${rows || `<tr><td colspan="2" class="small">Keine Treffer</td></tr>`}</tbody>
  `;

  UI.dbTable.querySelectorAll("tbody tr[data-seq]").forEach(tr => {
    tr.addEventListener("click", () => {
      const seq = tr.getAttribute("data-seq");
      UI.genSeq.value = seq;
      UI.genSeq.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  });

  UI.dbPrev.disabled = (dbPage <= 0);
  UI.dbNext.disabled = (dbPage >= pages - 1);
}

// ---------- mapping table ----------
function renderMapTable(){
  const rows = Object.entries(TONE_MAP).map(([k, hz]) =>
    `<tr><td><b>${k}</b></td><td>${hz} Hz</td></tr>`
  ).join("");
  UI.mapTable.innerHTML = `<thead><tr><th>Ziffer</th><th>Frequenz</th></tr></thead><tbody>${rows}</tbody>`;
}

// ---------- test generator ----------
let genCtx = null;
let genOsc = null;
let genGain = null;
let genTimer = null;

async function playSequenceOnce(seq, toneMs, gapMs, vol){
  if (!genCtx) genCtx = new (window.AudioContext || window.webkitAudioContext)();
  await genCtx.resume();

  try{ genOsc && genOsc.stop(); } catch {}

  genOsc = genCtx.createOscillator();
  genGain = genCtx.createGain();
  genGain.gain.value = 0.0001;

  genOsc.type = "sine";
  genOsc.connect(genGain).connect(genCtx.destination);
  genOsc.start();

  const ramp = 0.006;
  let t = genCtx.currentTime + 0.05;

  for (const ch of seq){
    const hz = Number(TONE_MAP[ch]);
    if (!hz) continue;

    genOsc.frequency.setValueAtTime(hz, t);

    genGain.gain.setValueAtTime(0.0001, t);
    genGain.gain.exponentialRampToValueAtTime(vol, t + ramp);
    genGain.gain.setValueAtTime(vol, t + (toneMs/1000) - ramp);
    genGain.gain.exponentialRampToValueAtTime(0.0001, t + (toneMs/1000));

    t += (toneMs + gapMs) / 1000;
  }

  genOsc.stop(t + 0.05);

  const localOsc = genOsc;
  localOsc.onended = () => {
    if (localOsc !== genOsc) return;
    if (!UI.genLoop.checked){
      UI.btnGenPlay.disabled = false;
      UI.btnGenStop.disabled = true;
      UI.genHint.textContent = "fertig";
    }
  };
}

async function startGenerator(){
  const seq = (UI.genSeq.value || "").trim();
  if (!/^[1-6]{6}$/.test(seq)){
    UI.genHint.textContent = "Bitte 6 Ziffern, nur 1–6 (z.B. 124356).";
    return;
  }
  const toneMs = Math.max(60, Math.min(2000, Number(UI.genToneMs.value || 333)));
  const gapMs = Math.max(0, Math.min(2000, Number(UI.genGapMs.value || 40)));
  const vol = Math.max(0.05, Math.min(0.9, Number(UI.genVol.value || 0.35)));

  UI.btnGenPlay.disabled = true;
  UI.btnGenStop.disabled = false;
  UI.genHint.textContent = "spielt…";

  const schedule = async () => {
    await playSequenceOnce(seq, toneMs, gapMs, vol);
    const totalMs = 100 + seq.length * (toneMs + gapMs) + 150;
    if (UI.genLoop.checked){
      genTimer = setTimeout(schedule, totalMs);
    }
  };
  schedule();
}

function stopGenerator(){
  if (genTimer){ clearTimeout(genTimer); genTimer = null; }
  try{ genOsc && genOsc.stop(); } catch {}
  genOsc = null;
  genGain = null;
  UI.btnGenPlay.disabled = false;
  UI.btnGenStop.disabled = true;
  UI.genHint.textContent = "gestoppt";
}

// ---------- init ----------
async function loadDb(){
  const res = await fetch("db.json", { cache: "no-store" });
  DB = await res.json();

  const sig = DB.signal || {};
  if (sig.mapping) TONE_MAP = sig.mapping;
  if (sig.tone_duration_ms) TONE_DURATION_MS = sig.tone_duration_ms;
  if (sig.tolerance_hz) TOLERANCE_HZ = sig.tolerance_hz;

  dbFiltered = DB.stations || [];
  renderDbTable();
  renderMapTable();
}

UI.btnStart.addEventListener("click", start);
UI.btnStop.addEventListener("click", stop);
UI.btnRefresh.addEventListener("click", refreshInputs);

UI.rngFps.addEventListener("input", () => {
  plotFps = Number(UI.rngFps.value || 20);
  UI.fpsVal.textContent = String(plotFps);
});
UI.rngGate.addEventListener("input", () => {
  MIN_STRENGTH = Number(UI.rngGate.value || 170);
  UI.gateVal.textContent = String(MIN_STRENGTH);
});

UI.dbSearch.addEventListener("input", applyDbFilter);
UI.dbPrev.addEventListener("click", () => { dbPage--; renderDbTable(); });
UI.dbNext.addEventListener("click", () => { dbPage++; renderDbTable(); });

UI.btnGenPlay.addEventListener("click", startGenerator);
UI.btnGenStop.addEventListener("click", stopGenerator);

loadDb()
  .then(refreshInputs)
  .then(() => {
    UI.fpsVal.textContent = String(UI.rngFps.value || 20);
    UI.gateVal.textContent = String(UI.rngGate.value || 170);
    setStatus("bereit");
  })
  .catch(e => { console.error(e); setStatus("Fehler: db.json konnte nicht geladen werden"); });
