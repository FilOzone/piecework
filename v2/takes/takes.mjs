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
const state = { provider: null, dataSetId: null, sets: [], money: null,
                pictures: [], takes: [], busy: false, note: "" };

// The provider is chosen, not asked for: the first that actually offers this job. A page about one job has
// no business showing a dropdown when only one entry in it can run anything.
function pickProvider() {
  const able = PW.CFG.providers.filter((p) => !p.offers || p.offers.includes(JOB));
  if (!able.length) throw new Error(`no provider in this configuration offers ${JOB}`);
  return able[0];
}

function say(where, text) { const el = $(where); if (el) el.textContent = text || ""; }

async function run(where, label, fn) {
  if (state.busy) return;
  state.busy = true; state.note = ""; draw();
  PW.reportSteps((s) => say(where, s));
  try {
    await fn();
    say(where, "");
  } catch (e) {
    say(where, `${label} failed: ${e?.shortMessage ?? e?.message ?? e}`);
  }
  PW.reportSteps(() => {});
  state.busy = false; draw();
}

async function refreshMoney() { state.money = await PW.money().catch(() => null); }

async function refreshSets() {
  if (!state.provider) return;
  state.sets = await PW.findDataSets(state.provider).catch(() => []);
}

// A typed prompt becomes the file the job reads. The job is unchanged and still looks for prompt.json in
// its inputs, exactly as it does when a command line puts one there: the page's convenience did not leak
// into the thing being demonstrated.
function promptFile() {
  const body = JSON.stringify(
    { prompt: $("prompt").value.trim(), seconds: 4, fps: 12, seed: state.takes.length }, null, 2);
  return new File([body], "prompt.json", { type: "application/json" });
}

async function useSet(id) {
  state.dataSetId = Number(id);
  const s = await PW.readSet(state.provider, state.dataSetId, PW.CFG.jobs);
  // Without this the provider's results are refused by Warm Storage after the job has already run.
  if (!s.canReceiveResults) await PW.allowResults(state.dataSetId);
  await refresh();
}

async function makeTake() {
  const p = pickProvider();
  state.provider = p.id;
  if (!state.dataSetId) {
    const files = [...state.pictures, promptFile()];
    if (!files.length) throw new Error("add at least one picture first");
    const set = await PW.createSet(p.id, files, "Takes");
    state.dataSetId = Number(set.dataSetId ?? set);
    await PW.allowResults(state.dataSetId);
  } else {
    const add = [...state.pictures, promptFile()];
    await PW.addFiles(state.provider, state.dataSetId, add);
  }
  state.pictures = [];
  await order();
}

async function order() {
  const s = await PW.readSet(state.provider, state.dataSetId, PW.CFG.jobs);
  // Everything the job reads: the pictures, the prompt, and the takes so far. Which of them is the parent
  // is the job's decision, not the page's.
  const ids = Object.entries(s.files ?? {})
    .filter(([, f]) => f.live && (/\.(jpe?g|png|webp|bmp)$/i.test(f.name)
      || /^prompt\.json$/i.test(f.name) || /^version-\d+\.mp4$/i.test(f.name)))
    .map(([pid]) => pid);
  if (!ids.length) throw new Error("this data set has no pictures in it yet");
  await PW.order(state.provider, state.dataSetId, JOB, "keep-inputs", ids);
  await refresh();
}

async function nextTake() {
  await PW.addFiles(state.provider, state.dataSetId, [promptFile()]);
  await order();
}

// Read the data set back and assemble the takes: the video, and the manifest saying what it came from.
async function refresh() {
  await refreshMoney();
  if (!state.dataSetId) return draw();
  const s = await PW.readSet(state.provider, state.dataSetId, PW.CFG.jobs);
  const files = Object.entries(s.files ?? {}).map(([pieceId, f]) => ({ pieceId, ...f }));
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
  const opts = state.sets.map((s) =>
    `<option value="${s.id}" ${s.id === state.dataSetId ? "selected" : ""}>#${s.id}${s.label ? ` · ${esc(s.label)}` : ""}</option>`).join("");
  return `${state.sets.length ? `<select id="setsel"><option value="">Start a new one</option>${opts}</select>` : ""}
    ${state.sets.length && !state.dataSetId ? '<button class="b small" id="useset">Open it</button>' : ""}`;
}

function drawTakes() {
  return state.takes.map((t) => {
    const m = t.manifest;
    const parent = m?.from?.parent;
    const parentTake = parent && state.takes.find((x) => x.manifest?.produced?.name === parent.name);
    const matches = parentTake && parentTake.manifest.produced.sha256 === parent.sha256;
    return `<div class="take">
      <video controls muted playsinline preload="metadata" src="${esc(PW.fileUrl(state.provider, t.video.cid))}"></video>
      <div>
        <h3>Take ${t.n}${t.n === state.takes[0].n ? ' <span class="pill ok">newest</span>' : ""}</h3>
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
  $("setpick").innerHTML = drawSets();
  $("setnote").textContent = state.dataSetId
    ? `Using data set #${state.dataSetId} at ${PW.CFG.providers.find((p) => p.id === state.provider)?.name ?? state.provider}.`
    : "Your first take makes a data set. Everything after that goes into the same one, which is what lets a take be built on the one before.";
  $("thumbs").innerHTML = state.pictures.map((f) =>
    `<img src="${URL.createObjectURL(f)}" alt="${esc(f.name)}" title="${esc(f.name)}">`).join("");
  $("cost").textContent = `${price} ${PW.CFG.token} a take` + (canPay ? "" : " — not enough in Filecoin Pay yet");
  $("deposit").disabled = state.busy;
  $("make").disabled = state.busy || !canPay || (!state.pictures.length && !state.dataSetId);
  $("make").textContent = state.busy ? "Working…" : state.dataSetId ? "Make another take" : "Make the first take";
  $("again").disabled = state.busy || !canPay;
  $("again").textContent = state.busy ? "Working…" : "Make the next take on top";
  $("takes").innerHTML = drawTakes();

  const sel = $("setsel");
  if (sel) sel.onchange = () => { if (sel.value) run("steps", "Opening the data set", () => useSet(sel.value)); };
  const use = $("useset");
  if (use) use.onclick = () => { const v = $("setsel")?.value; if (v) run("steps", "Opening the data set", () => useSet(v)); };
}

$("connect").onclick = () => run("connectsteps", "Connecting", async () => {
  await PW.connect();
  state.provider = pickProvider().id;
  await refreshMoney();
  await refreshSets();
});
$("deposit").onclick = () => run("steps", "The deposit", async () => {
  await PW.deposit($("depamt").value || "1");
  await refreshMoney();
});
$("make").onclick = () => run("steps", "The take", makeTake);
$("again").onclick = () => run("takesteps", "The next take", nextTake);

const addPictures = (list) => {
  state.pictures.push(...[...list].filter((f) => /^image\//.test(f.type)));
  draw();
};
$("picker").onchange = (e) => addPictures(e.target.files);
const drop = $("drop");
drop.ondragover = (e) => { e.preventDefault(); drop.classList.add("over"); };
drop.ondragleave = () => drop.classList.remove("over");
drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove("over"); addPictures(e.dataTransfer.files); };

draw();
setInterval(() => { if (!state.busy && state.dataSetId) refresh().catch(() => {}); }, 8000);
