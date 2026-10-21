// Takes: one job, one loop, and the chain of versions made visible.
//
// This is not a second client. It imports the V1 browser client's module unchanged and drives a single job
// through it — connect, create a data set, add files, order, read results. Everything about contracts,
// Filecoin Pay, Curio and the chain is V1's code; what is here is the part V1's generic catalogue page
// cannot show, which is a chain of takes where each one names the take it was built on.
//
// Two things it does that the generic page does not, and both are the reason it exists:
//
//   The prompt is a text box. In V1 a prompt is a file the client has to write and upload, which is a poor
//   first experience for the one job where the prompt is the point. Here it is typed, and turned into
//   prompt.json in the browser before upload — the job is unchanged and still reads a file.
//
//   The lineage is drawn. version-N.json records every input by sha256 and names its parent; V1 lists it
//   as a filename. Here the parent hash of take N is shown against the hash take N-1 published for itself,
//   so a visitor can see them match rather than being told they do.
import * as PW from "./app.mjs";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const short = (h) => (h ? `${h.slice(0, 10)}…${h.slice(-6)}` : "—");

const JOB = "video-gen:v1";
const state = { provider: null, dataSetId: null, pictures: [], takes: [], busy: false };

// The provider to use: the first one that actually offers this job. A page about one job has no reason to
// ask the visitor to choose a provider that cannot run it.
function pickProvider() {
  const able = PW.CFG.providers.filter((p) => !p.offers || p.offers.includes(JOB));
  if (!able.length) throw new Error(`no provider in this configuration offers ${JOB}`);
  return able[0];
}

function say(text) { $("steps").textContent = text || ""; }

async function run(label, fn) {
  if (state.busy) return;
  state.busy = true;
  draw();
  PW.reportSteps((s) => say(s));
  try {
    await fn();
  } catch (e) {
    say(`${label} failed: ${e?.shortMessage ?? e?.message ?? e}`);
    state.busy = false;
    draw();
    return;
  }
  PW.reportSteps(() => {});
  state.busy = false;
  draw();
}

// A typed prompt becomes the file the job reads. The job is not changed to suit the page: it still looks
// for prompt.json in its inputs, exactly as it does when a command line puts one there.
function promptFile() {
  const text = $("prompt").value.trim();
  const body = JSON.stringify({ prompt: text, seconds: 4, fps: 12, seed: state.takes.length }, null, 2);
  return new File([body], "prompt.json", { type: "application/json" });
}

async function firstTake() {
  const p = pickProvider();
  state.provider = p.id;
  const files = [...state.pictures, promptFile()];
  const set = await PW.createSet(p.id, files, "Takes");
  state.dataSetId = set.dataSetId ?? set;
  await PW.allowResults(state.dataSetId);
  await orderOne();
}

async function orderOne() {
  const s = await PW.readSet(state.provider, state.dataSetId, PW.CFG.jobs);
  // Everything this job reads: the pictures, the prompt, and the previous takes. The job itself decides
  // which of them is the parent; the page does not have to be clever about it.
  const ids = Object.entries(s.files ?? {})
    .filter(([, f]) => f.live && /\.(jpe?g|png|webp|bmp)$/i.test(f.name)
      || /^prompt\.json$/i.test(f.name) || /^version-\d+\.mp4$/i.test(f.name))
    .map(([pid]) => pid);
  await PW.order(state.provider, state.dataSetId, JOB, "keep-inputs", ids);
  await refresh();
}

async function nextTake() {
  // A new prompt means a new prompt.json; uploading it replaces what the next take reads.
  await PW.addFiles(state.provider, state.dataSetId, [promptFile()]);
  await orderOne();
}

// Read the data set back and assemble the takes: the video, and the manifest that says what it came from.
async function refresh() {
  if (!state.dataSetId) return;
  const s = await PW.readSet(state.provider, state.dataSetId, PW.CFG.jobs);
  const files = Object.entries(s.files ?? {}).map(([pid, f]) => ({ pieceId: pid, ...f }));
  const videos = files.filter((f) => /^version-\d+\.mp4$/i.test(f.name));
  const manifests = files.filter((f) => /^version-\d+\.json$/i.test(f.name));
  const takes = [];
  for (const v of videos) {
    const n = Number(v.name.match(/\d+/)[0]);
    const m = manifests.find((x) => x.name === `version-${n}.json`);
    let manifest = null;
    if (m) {
      manifest = await fetch(PW.fileUrl(state.provider, m.cid)).then((r) => r.json()).catch(() => null);
    }
    takes.push({ n, video: v, manifest });
  }
  state.takes = takes.sort((a, b) => b.n - a.n);
  draw();
}

function drawTakes() {
  if (!state.takes.length) return "";
  return state.takes.map((t) => {
    const m = t.manifest;
    const parent = m?.from?.parent;
    const parentTake = parent && state.takes.find((x) => x.manifest?.produced?.name === parent.name);
    const matches = parentTake && parentTake.manifest.produced.sha256 === parent.sha256;
    return `<div class="take">
      <video controls muted playsinline preload="metadata" src="${esc(PW.fileUrl(state.provider, t.video.cid))}"></video>
      <div>
        <h3>Take ${t.n} ${t.n === state.takes[0].n ? '<span class="pill ok">newest</span>' : ""}</h3>
        ${m?.prompt ? `<div class="muted">“${esc(m.prompt)}”</div>` : ""}
        ${m ? `<div class="lineage">this take   ${esc(short(m.produced.sha256))}
built on    ${parent ? `<span class="parent">${esc(parent.name)}  ${esc(short(parent.sha256))}</span>` : "nothing — this is the first take"}
${parent ? (matches ? "            ✓ matches the hash that take published for itself"
                    : "            ✗ does not match any take here") : ""}
from        ${esc((m.from.images ?? []).map((i) => i.name).join(", "))}
frames      ${m.produced.frames}${m.produced.carriedFromParent ? ` (${m.produced.carriedFromParent} carried from the take before)` : ""}</div>` : '<div class="muted">no manifest yet</div>'}
      </div>
    </div>`;
  }).join("");
}

function draw() {
  const connected = !!PW.me;
  $("connectcard").hidden = connected;
  $("setupcard").hidden = !connected;
  $("takescard").hidden = !state.takes.length;
  $("thumbs").innerHTML = state.pictures.map((f) =>
    `<img src="${URL.createObjectURL(f)}" alt="${esc(f.name)}" title="${esc(f.name)}">`).join("");
  const spec = PW.CFG.jobs[JOB];
  $("cost").textContent = spec ? `${spec.price} ${PW.CFG.token} a take` : "";
  $("make").disabled = state.busy || !state.pictures.length || !!state.dataSetId;
  $("make").textContent = state.busy ? "Working…" : "Make the first take";
  $("again").disabled = state.busy;
  $("again").textContent = state.busy ? "Working…" : "Make the next take on top";
  $("takes").innerHTML = drawTakes();
}

$("connect").onclick = () => run("Connecting", async () => { await PW.connect(); });
$("make").onclick = () => run("The first take", firstTake);
$("again").onclick = () => run("The next take", nextTake);

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
