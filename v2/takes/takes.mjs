// Takes: one job, one loop, and the chain of versions made visible.
//
// Not a second client. app.mjs is V1's browser client imported unchanged, so contracts, Filecoin Pay,
// Curio and the chain are its code and cannot drift from it. What is here drives a single job and draws
// the part V1's generic catalogue page cannot: a chain of takes where each names the take it was built on.
//
// It still has to do everything V1 does before any of that is possible — show what the wallet holds, say
// where to get test tokens, move money into Filecoin Pay, and choose a data set — because a page that
// only implements the happy path leaves a visitor with an empty wallet staring at a disabled button and
// no idea why.
import * as PW from "./app.mjs";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const short = (h) => (h ? `${h.slice(0, 10)}…${h.slice(-6)}` : "—");
const num = (s) => Number(s ?? 0);
const fmt = (s, dp = 3) => num(s).toFixed(dp);

const JOB = "video-gen:v1";
// The other things a client can run over the same data set. Takes was one job because there was one job;
// these read what is already stored -- the pictures that went in, the takes that came out -- so they belong
// on the same page rather than behind a separate catalogue.
//
// frame-stability is here too but needs a track.json saying which region to watch, and a region nobody
// chose produces a confident answer about nothing. So it is offered only once such a file is in the data
// set, which the drop zone above will take like any other file.
const EXTRAS = [
  { type: "image-index:v1", title: "What is in my pictures",
    blurb: "Detects what is in each picture and where. Faces are detected, never identified.",
    needs: "a picture" },
  { type: "frame-similarity:v1", title: "Where does a take change",
    blurb: "The cut points of a take \u2014 what would let the next version reuse the segments it did not change.",
    needs: "a take" },
  { type: "frame-stability:v1", title: "Did something move",
    blurb: "Reads every frame and tracks one region named in track.json. Drop a track.json above to enable it.",
    needs: "a take and a track.json" },
];

const extFor = (type) => (PW.CFG.jobs[type]?.inputExtensions ?? []).map((e) => e.toLowerCase());
const piecesFor = (type) => {
  const exts = extFor(type);
  const named = state.pieces.filter((f) => exts.some((e) => f.name.toLowerCase().endsWith(e)));
  // frame-stability is useless without its spec, so do not offer it as though it were ready.
  if (type === "frame-stability:v1" && !named.some((f) => /^track\.json$/i.test(f.name))) return [];
  if (type === "frame-stability:v1" && !named.some((f) => /\.(mp4|mov|mkv|webm|avi|m4v)$/i.test(f.name))) return [];
  return named;
};

async function runExtra(type) {
  const ids = piecesFor(type).map((f) => f.pieceId);
  if (!ids.length) throw new Error(`nothing in this data set that ${type} can read`);
  await PW.order(state.provider, state.dataSetId, type, "keep-inputs", ids);
  await refresh();
}

function drawExtras() {
  if (!state.dataSetId) return "";
  const price = (t) => num(PW.CFG.jobs[t]?.price);
  const canPay = (t) => state.money && num(state.money.available) >= price(t);
  const rows = EXTRAS.map((x) => {
    const n = piecesFor(x.type).length;
    const ok = n > 0 && canPay(x.type) && !state.busy;
    const why = n === 0 ? `needs ${x.needs} in this data set`
      : !canPay(x.type) ? `needs ${price(x.type)} ${PW.CFG.token} in Filecoin Pay`
      : `over ${n} piece${n > 1 ? "s" : ""}`;
    return `<div class="extra">
      <div><b>${esc(x.title)}</b> <span class="muted">${esc(price(x.type))} ${esc(PW.CFG.token)}</span>
        <div class="muted">${esc(x.blurb)}</div></div>
      <div style="text-align:right">
        <button class="b" data-extra="${esc(x.type)}" ${ok ? "" : "disabled"}>Run it</button>
        <div class="muted" style="font-size:.78rem;margin-top:4px">${esc(why)}</div></div>
    </div>`;
  }).join("");
  return `<div class="card"><h2>Other things you can run on this data set</h2>
    <p class="muted">These read what is already stored here \u2014 the pictures you uploaded and the takes
    they produced \u2014 and write their answers back in as new pieces.</p>${rows}</div>`;
}
// /piece/<cid> is the bytes the CID names and nothing else. /play/<cid> is the same video re-encoded if a
// browser could not decode it -- a convenience for the <video> element, never for a download or a check.
//
// Only the stand-in provider serves it. A real Curio does not, and asking one for /play/ would 404 on every
// take, so a provider has to say it offers the route; without that the player reads the piece directly,
// which is correct for anything the job encoded as H.264.
const playUrl = (providerId, cid) => {
  const url = PW.fileUrl(providerId, cid);
  const p = PW.CFG.providers.find((x) => x.id === providerId);
  return p?.playRoute ? url.replace(/\/piece\/(?=[a-z0-9]+$)/, "/play/") : url;
};
// What the job reads out of the data set: the pictures, the prompt, and the takes so far.
const IS_PICTURE = /\.(jpe?g|png|webp|bmp|gif)$/i;
const IS_INPUT = /(\.(jpe?g|png|webp|bmp|gif)|^prompt\.json|^version-\d+\.mp4)$/i;
// pick is what the dropdown is showing, held here rather than read off the element: draw() rebuilds the
// select, and run() draws before it does anything, so a choice left in the DOM was destroyed the moment it
// was acted on.
const state = { provider: null, dataSetId: null, sets: [], money: null, pick: "new",
                waiting: [], takes: [], pieces: [], jobs: {}, block: 0,
                busy: false, busyText: "", error: "", note: "", setsError: "" };

// Which providers can actually run this job. The page used to take the first and say nothing, which was
// right while only one could; with two it has to be a choice, because a data set lives at one provider and
// the money goes to whoever runs the work.
const ableProviders = () => PW.CFG.providers.filter((p) => !p.offers || p.offers.includes(JOB));

function pickProvider() {
  const able = ableProviders();
  if (!able.length) throw new Error(`no provider in this configuration offers ${JOB}`);
  return able.find((p) => p.id === state.provider) ?? able[0];
}

// A data set belongs to one provider and so does everything in it, so changing provider cannot keep the
// open set, its pieces or its takes: those are another machine's and reading them from this one would
// show a chain that is not there.
function useProvider(id) {
  if (id === state.provider) return;
  state.provider = id;
  state.dataSetId = null; state.pick = "new"; state.sets = []; state.setsError = "";
  state.pieces = []; state.takes = []; state.jobs = {};
  try { localStorage.setItem("takes-provider", id); } catch { /* private window */ }
  draw();
  run("steps", "Switching provider", async () => { await refreshSets(); await refreshMoney(); });
}

function drawProviders() {
  const able = ableProviders();
  if (able.length < 2) return "";
  const p = pickProvider();
  return `<div class="row" style="margin-bottom:10px">
      <select id="prov">${able.map((x) =>
        `<option value="${esc(x.id)}"${x.id === p.id ? " selected" : ""}>${esc(x.name)}</option>`).join("")}</select>
      <span class="muted">${esc(p.curioUrl)} — takes you order are run here, and paid to this provider</span>
    </div>`;
}

function say(where, text) { const el = $(where); if (el) el.textContent = text || ""; }

async function run(where, label, fn) {
  if (state.busy) return;
  state.busy = true; state.note = ""; state.error = ""; state.busyText = `${label}…`; draw();
  PW.reportSteps((s) => { state.busyText = s; say(where, s); draw(); });
  try {
    await fn();
    say(where, "");
  } catch (e) {
    const why = e?.shortMessage ?? e?.message ?? String(e);
    state.error = `${label} failed: ${why}`;
    say(where, state.error);
  }
  PW.reportSteps(() => {});
  state.busy = false; state.busyText = ""; draw();
}

function drawTask() {
  if (state.busy) return `<div class="task"><b><span class="spin"></span>${esc(state.busyText || "Working")}</b>
    <div class="muted">Each step is a real transaction on Filecoin Calibration and waits for a block, about 30 seconds.
    If nothing seems to happen, open your wallet: it may be holding a request without showing it.</div></div>`;
  if (state.error) return `<div class="task err"><b>Failed</b><div>${esc(state.error)}</div></div>`;
  return "";
}

// Between ordering a take and being paid for it, nothing on chain changes, so the page has to say what it
// does know: how long ago it was ordered, how long is left, and whether result pieces have started landing
// in the data set -- which happens a block or two before the provider claims the money.
const mins = (blocks) => (blocks <= 0 ? "now" : blocks < 2 ? "under a minute" : `${Math.round(blocks * 30 / 60)} min`);
function jobLine(j) {
  const status = j.status !== "waiting"
    ? ({ paid: "delivered and paid", refunded: "refunded" }[j.status] ?? j.status)
    : j.arriving > 0 ? `results arriving (${j.arriving} file${j.arriving === 1 ? "" : "s"})`
    : "running at the provider";
  const timing = j.status === "waiting" && state.block && j.deadline > state.block
    ? `${j.postedAt && state.block > j.postedAt ? `ordered ${mins(state.block - j.postedAt)} ago · ` : ""}deadline in ${mins(j.deadline - state.block)}`
    : "";
  return `<div class="jobrow"><b>Take job #${esc(j.jobId)}</b>
    <span>${esc(status)}</span>
    <span class="muted">${esc(j.price)} ${esc(PW.CFG.token)}${timing ? ` · ${esc(timing)}` : ""}</span></div>`;
}

function drawJobs() {
  const mine = Object.values(state.jobs)
    .filter((j) => Number(j.dataSetId) === Number(state.dataSetId))
    .sort((a, b) => Number(b.jobId) - Number(a.jobId)).slice(0, 4);
  if (!mine.length) return "";
  return `<div class="card"><h2>What the provider is doing</h2>${mine.map(jobLine).join("")}</div>`;
}

async function refreshMoney() { state.money = await PW.money().catch(() => null); }

async function refreshSets() {
  if (!state.provider) return;
  try {
    state.sets = await PW.findDataSets(state.provider);
    state.setsError = "";
  } catch (e) {
    state.setsError = e?.shortMessage ?? e?.message ?? String(e);
  }
}

// A typed prompt becomes the file the job reads. The job is unchanged and still looks for prompt.json in
// its inputs, exactly as it does when a command line puts one there: the page's convenience did not leak
// into the thing being demonstrated.
// A piece smaller than 127 bytes cannot be stored at all, and a short prompt makes one: the first take
// failed at upload, before anything reached the chain. The job keeps only the keys it knows
// (jobs/video-gen/generate.py), so a note carrying the file past the floor changes nothing it reads.
const MIN_PIECE = 127;
function promptBody(o) {
  let body = JSON.stringify(o, null, 2);
  if (new TextEncoder().encode(body).length < MIN_PIECE)
    body = JSON.stringify({ ...o, note: "padded to the smallest piece a provider will store (127 bytes)" }, null, 2);
  return body;
}

function promptFile() {
  const body = promptBody({ prompt: $("prompt").value.trim(), seconds: 4, fps: 12, seed: state.takes.length });
  return new File([body], "prompt.json", { type: "application/json" });
}

async function useSet(id) {
  state.dataSetId = Number(id);
  state.pick = String(state.dataSetId);
  state.takes = [];
  const s = await PW.readSet(state.provider, state.dataSetId, PW.CFG.jobs);
  // Without this the provider's results are refused by Warm Storage after the job has already run.
  if (!s.canReceiveResults) await PW.allowResults(state.dataSetId);
  await refresh();
}

async function uploadWaiting() {
  const p = pickProvider();
  state.provider = p.id;
  if (!state.waiting.length) throw new Error("add some pictures first");
  if (!state.dataSetId) {
    const set = await PW.createSet(p.id, state.waiting, "Takes");
    state.dataSetId = Number(set.dataSetId ?? set);
    state.pick = String(state.dataSetId);
    await PW.allowResults(state.dataSetId);
    await refreshSets();
  } else {
    await PW.addFiles(state.provider, state.dataSetId, state.waiting);
  }
  state.waiting = [];
  await refresh();
}

// A take is ordered over what is already stored. The prompt goes in as a file first, because the job reads
// prompt.json out of the data set exactly as it would if a command line had put one there.
async function makeTake() {
  if (!state.dataSetId) throw new Error("upload your pictures first");
  if (!$("prompt").value.trim()) throw new Error("type a prompt first");
  await PW.addFiles(state.provider, state.dataSetId, [promptFile()]);
  await order();
}

async function order() {
  const s = await PW.readSet(state.provider, state.dataSetId, PW.CFG.jobs);
  // Everything the job reads: the pictures, the prompt, and the takes so far. Which of them is the parent
  // is the job's decision, not the page's.
  const ids = Object.entries(s.files ?? {})
    .filter(([, f]) => IS_INPUT.test(f.name))
    .map(([pid]) => pid);
  if (!ids.length) throw new Error("this data set has no pictures in it yet");
  await PW.order(state.provider, state.dataSetId, JOB, "keep-inputs", ids);
  await refresh();
}

// Read the data set back and assemble the takes: the video, and the manifest saying what it came from.
async function refresh() {
  await refreshMoney();
  state.block = await PW.block().catch(() => state.block);
  await refreshSets();
  state.jobs = await PW.findJobs().catch(() => state.jobs);
  if (!state.dataSetId) return draw();
  const s = await PW.readSet(state.provider, state.dataSetId, PW.CFG.jobs);
  const files = Object.entries(s.files ?? {}).map(([pieceId, f]) => ({ pieceId, ...f }));
  state.pieces = files;
  const takes = [];
  for (const v of files.filter((f) => /^version-\d+\.mp4$/i.test(f.name))) {
    const n = Number(v.name.match(/\d+/)[0]);
    const m = files.find((x) => x.name === `version-${n}.json`);
    const manifest = m
      ? await fetch(PW.fileUrl(state.provider, m.cid)).then((r) => r.json()).catch(() => null)
      : null;
    takes.push({ n, video: v, manifest });
  }
  state.takes = takes.sort((a, b) => b.n - a.n);
  draw();
}

function drawBalances() {
  const m = state.money;
  if (!m) return "";
  const price = num(PW.CFG.jobs[JOB]?.price);
  const cards = [
    { n: fmt(m.gas, 4), l: "tFIL for gas", low: num(m.gas) < 0.05 },
    { n: fmt(m.wallet), l: `${PW.CFG.token} in your wallet`, low: num(m.wallet) < price && num(m.available) < price },
    { n: fmt(m.available), l: `${PW.CFG.token} in Filecoin Pay`, low: num(m.available) < price, ok: num(m.available) >= price },
  ];
  return cards.map((c) => `<div class="bal ${c.low ? "low" : c.ok ? "ok" : ""}">
    <div class="n">${esc(c.n)}</div><div class="l">${esc(c.l)}</div></div>`).join("");
}

function drawFaucets() {
  const m = state.money;
  const links = Object.entries(PW.CFG.faucets ?? {})
    .map(([k, url]) => `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(k)}</a>`).join(" · ");
  if (!links) return "";
  const short = m && (num(m.gas) < 0.05 || num(m.available) + num(m.wallet) < num(PW.CFG.jobs[JOB]?.price));
  return `${short ? "You are short of something. " : ""}Test tokens: ${links}`;
}

function drawSets() {
  const opts = state.sets.map((s) => `<option value="${s.id}"${String(s.id) === state.pick ? " selected" : ""}>#${s.id}${s.label ? ` · ${esc(s.label)}` : ""}</option>`).join("");
  return `<select id="setsel">
      <option value="new"${state.pick === "new" ? " selected" : ""}>Start a new one</option>${opts}
    </select>
    <button class="b small" id="useset" ${state.busy ? "disabled" : ""}>${
      state.pick === "new" ? "Start a new one" : `Open #${esc(state.pick)}`}</button>
    ${state.sets.length ? "" : '<span class="muted">no data sets here yet — your first take makes one</span>'}`;
}

// Choosing "Start a new one" has to actually put the page back to having no data set, or the next take is
// added to the one still open and the dropdown is decoration.
function startNew() {
  state.dataSetId = null; state.takes = []; state.pick = "new"; draw();
}

async function saveWithItsName(e) {
  const a = e.currentTarget, name = a.dataset.save;
  if (!name) return;
  e.preventDefault();
  try {
    const res = await fetch(a.href);
    if (!res.ok) throw new Error(`the provider answered ${res.status}`);
    const blob = await res.blob();
    const EXT = { "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "image/gif": ".gif",
      "text/plain": ".txt", "application/json": ".json", "application/pdf": ".pdf", "video/mp4": ".mp4" };
    const guessed = EXT[(blob.type || "").split(";")[0].trim()];
    const saveAs = /\.[A-Za-z0-9]{1,5}$/.test(name) || !guessed ? name : name + guessed;
    const url = URL.createObjectURL(blob);
    const tmp = Object.assign(document.createElement("a"), { href: url, download: saveAs });
    document.body.append(tmp); tmp.click(); tmp.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  } catch {
    window.open(a.href, "_blank", "noopener");
  }
}

function drawPieces() {
  if (!state.dataSetId) return "";
  if (!state.pieces.length) return '<p class="muted">Nothing stored in it yet.</p>';
  const rows = state.pieces.map((f) => `<tr>
    <td>${IS_PICTURE.test(f.name)
      ? `<img class="tn" loading="lazy" src="${esc(PW.fileUrl(state.provider, f.cid))}" alt="">`
      : ""}</td>
    <td><a href="${esc(PW.fileUrl(state.provider, f.cid))}" data-save="${esc(f.name)}" target="_blank" rel="noopener">${esc(f.name)}</a>${
      f.kind === "output" ? ' <span class="pill ok">made here</span>' : ""}</td>
    <td class="muted">piece ${esc(f.pieceId)}</td>
    <td class="muted">${esc(short(f.cid))}</td></tr>`).join("");
  return `<p class="muted">${state.pieces.length} piece${state.pieces.length > 1 ? "s" : ""} in this data set.</p>
    <div class="staged"><table>${rows}</table></div>`;
}

function drawTakes() {
  return state.takes.map((t) => {
    const m = t.manifest;
    const parent = m?.from?.parent;
    const parentTake = parent && state.takes.find((x) => x.manifest?.produced?.name === parent.name);
    const matches = parentTake && parentTake.manifest.produced.sha256 === parent.sha256;
    return `<div class="take">
      <div data-slot="${t.n}"><video controls muted playsinline preload="metadata" data-take="${t.n}"
             src="${esc(playUrl(state.provider, t.video.cid))}"></video></div>
      <div>
        <h3>Take ${t.n}${t.n === state.takes[0].n ? ' <span class="pill ok">newest</span>' : ""}
          <a href="${esc(PW.fileUrl(state.provider, t.video.cid))}" data-save="${esc(t.video.name)}"
             style="font-size:.8rem;font-weight:400;margin-left:8px">save ${esc(t.video.name)}</a></h3>
        ${m?.prompt ? `<div class="muted">“${esc(m.prompt)}”</div>` : ""}
        ${m ? `<div class="lineage">this take   ${esc(short(m.produced.sha256))}
built on    ${parent ? `<span class="parent">${esc(parent.name)}  ${esc(short(parent.sha256))}</span>` : "nothing — this is the first take"}${
  parent ? `\n            ${matches ? '<span class="ok">✓ matches the hash that take published for itself</span>'
                                    : '<span class="bad">✗ does not match any take here</span>'}` : ""}
from        ${esc((m.from.images ?? []).map((i) => i.name).join(", ") || "—")}
frames      ${m.produced.frames}${m.produced.carriedFromParent ? ` (${m.produced.carriedFromParent} carried from the take before)` : ""}</div>` : '<div class="muted">waiting for its record…</div>'}
      </div>
    </div>`;
  }).join("");
}

function draw() {
  const on = !!PW.me;
  const price = num(PW.CFG.jobs[JOB]?.price);
  const canPay = state.money && num(state.money.available) >= price;
  $("connectcard").hidden = on;
  $("moneycard").hidden = !on;
  $("setcard").hidden = !on;
  $("setupcard").hidden = !on;
  $("takescard").hidden = !state.takes.length;

  $("balances").innerHTML = drawBalances();
  $("faucets").innerHTML = drawFaucets();
  $("provpick").innerHTML = drawProviders();
  const pv = $("prov");
  if (pv) pv.onchange = () => useProvider(pv.value);

  const picker = $("setpick"), wantSets = drawSets();
  const touching = picker.contains(document.activeElement);
  if (!touching && picker.dataset.html !== wantSets) { picker.innerHTML = wantSets; picker.dataset.html = wantSets; }
  $("uphint").textContent = state.dataSetId
    ? "" : "Upload your pictures first, then type a prompt and make a take.";
  $("setnote").innerHTML = state.setsError
    ? `<span class="pill bad">could not read your data sets</span> ${esc(state.setsError)} — retrying every few seconds.`
    : !state.sets.length && PW.me ? "No data sets with this provider yet. Your first upload makes one."
    : "";
  $("setnote2").textContent = state.dataSetId
    ? `Using data set #${state.dataSetId} at ${PW.CFG.providers.find((p) => p.id === state.provider)?.name ?? state.provider}.`
    : "Your first take makes a data set. Everything after that goes into the same one, which is what lets a take be built on the one before.";
  const w = state.waiting;
  $("waiting").innerHTML = w.length ? `<div class="staged">
      <b>${w.length} file${w.length > 1 ? "s" : ""} ready to upload</b>
      <table>${w.map((f, i) => `<tr>
        <td>${esc(f.name)}</td>
        <td class="muted">${f.size < 127
          ? `<span class="pill bad">${f.size} bytes — the smallest piece a provider stores is 127</span>`
          : `${(f.size / 1024).toFixed(1)} kB`}</td>
        <td><a data-drop="${i}" style="cursor:pointer">remove</a></td></tr>`).join("")}</table>
      <div class="row" style="margin-top:10px">
        <button class="b primary" id="confirmup" ${state.busy ? "disabled" : ""}>${
          state.dataSetId ? `Upload to data set #${state.dataSetId}` : "Create the data set with these"}</button>
        <button class="b" id="clearup">Clear</button></div>
    </div>` : "";
  document.querySelectorAll("a[data-drop]").forEach((a) => (a.onclick = () => {
    state.waiting.splice(Number(a.dataset.drop), 1); draw();
  }));
  const up = $("confirmup");
  if (up) up.onclick = () => run("steps", "The upload", uploadWaiting);
  const clr = $("clearup");
  if (clr) clr.onclick = () => { state.waiting = []; draw(); };

  $("cost").textContent = `${price} ${PW.CFG.token} a take` + (canPay ? "" : " — not enough in Filecoin Pay yet");
  $("deposit").disabled = state.busy;
  $("make").disabled = state.busy || !canPay || !state.dataSetId;
  $("make").textContent = state.busy ? "Working…" : state.takes.length ? "Make another take" : "Make the first take";
  $("again").disabled = state.busy || !canPay;
  $("again").textContent = state.busy ? "Working…" : "Make the next take on top";
  $("task").innerHTML = drawTask();
  $("jobs").innerHTML = drawJobs();
  $("pieces").innerHTML = drawPieces();
  $("extras").innerHTML = drawExtras();
  document.querySelectorAll("button[data-extra]").forEach((b) => (b.onclick = () =>
    run("steps", PW.CFG.jobs[b.dataset.extra]?.name ?? b.dataset.extra, () => runExtra(b.dataset.extra))));
  $("takes").innerHTML = drawTakes();
  document.querySelectorAll("a[data-save]").forEach((a) => (a.onclick = saveWithItsName));
  document.querySelectorAll("video[data-take]").forEach((v) => (v.onerror = () => {
    const slot = document.querySelector(`[data-slot="${v.dataset.take}"]`);
    if (slot) slot.innerHTML = '<div class="noplay">Not playable in a browser<br>— save it to watch</div>';
  }));

  const sel = $("setsel");
  if (sel) sel.onchange = () => { state.pick = sel.value; draw(); };
  if (sel && sel.value !== state.pick) sel.value = state.pick;
  const use = $("useset");
  if (use) use.onclick = () => (state.pick === "new"
    ? startNew()
    : run("steps", "Opening the data set", () => useSet(state.pick)));
  // The label is set here rather than only in the markup above, because that markup is deliberately not
  // re-rendered while the dropdown has focus -- which is exactly when the choice changes. Skipping the
  // rebuild kept the dropdown from closing under the pointer and left the button next to it reading
  // "Start a new one" over a data set the client had just chosen.
  if (use) {
    const nothingOpen = state.pick === "new" && !state.dataSetId;
    use.textContent = state.pick === "new" ? "Start a new one"
      : Number(state.pick) === state.dataSetId ? `Using #${state.pick}` : `Open #${state.pick}`;
    use.disabled = state.busy || nothingOpen;
    use.title = nothingOpen ? "Nothing is open — upload pictures below and they make a new data set" : "";
  }
}

$("connect").onclick = () => run("connectsteps", "Connecting", async () => {
  await PW.connect();
  let remembered = null;
  try { remembered = localStorage.getItem("takes-provider"); } catch { /* private window */ }
  if (remembered && ableProviders().some((p) => p.id === remembered)) state.provider = remembered;
  state.provider = pickProvider().id;
  await refreshMoney();
  await refreshSets();
});
$("deposit").onclick = () => run("steps", "The deposit", async () => {
  await PW.deposit($("depamt").value || "1");
  await refreshMoney();
});
$("make").onclick = () => run("steps", "The take", makeTake);
$("again").onclick = () => run("takesteps", "The next take", makeTake);

// V1's staging, copied rather than reinvented: no filtering of any kind, and a file is kept once per name
// and size. The versions I wrote instead each discarded files on a rule of their own -- a .jpg from Finder
// arrives with an empty type -- and said nothing about having done it.
function stage(list) {
  for (const f of list) if (!state.waiting.some((x) => x.name === f.name && x.size === f.size)) state.waiting.push(f);
  draw();
}

$("picker").onchange = (e) => stage([...e.target.files]);
const drop = $("drop");
drop.ondragover = (e) => { e.preventDefault(); drop.classList.add("over"); };
drop.ondragleave = () => drop.classList.remove("over");
drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove("over"); stage([...e.dataTransfer.files]); };
// A file dropped a little wide of the zone used to be opened by the browser instead, which looks exactly
// like the page ignoring it. Anywhere on the pictures card counts, and nowhere else navigates.
const card = $("setupcard");
card.ondragover = (e) => { e.preventDefault(); drop.classList.add("over"); };
card.ondragleave = () => drop.classList.remove("over");
card.ondrop = (e) => { e.preventDefault(); drop.classList.remove("over"); stage([...e.dataTransfer.files]); };
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => e.preventDefault());

draw();
setInterval(() => { if (!state.busy && PW.me) refresh().catch(() => {}); }, 8000);
