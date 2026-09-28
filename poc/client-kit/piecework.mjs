#!/usr/bin/env node
// PieceWork from the command line, or from a program.
//
// The console's page and this tool speak the same HTTP API (api.mjs): anything you can do by clicking, you
// can do from a script, a cron job or an agent. Point it at a running console with --url or PIECEWORK_URL.
//
//   piecework status                                  who you are, what you have, what is running
//   piecework files <dataSet>                         the files in a data set
//   piecework add <dataSet> <file>...                 put files in (they are uploaded to the provider)
//   piecework rm <dataSet> <piece>...                 remove files (you sign, the provider submits)
//   piecework keep <dataSet> <piece>...               never remove these, whatever a job asks for
//   piecework order <dataSet> <job> [options]         order a job
//   piecework get <dataSet> <piece> [-o <file>]       read a result back from the provider
//   piecework session start <dataSet> <service>       start paying by the epoch
//   piecework session stop <id>                       stop, and stop paying
//   piecework deposit <amount>                        move USDFC from your wallet into Filecoin Pay
//   piecework providers                               who you can buy from
//   piecework watch                                   follow what the console is doing
//
// Options for `order`:
//   --files 3,4,7      only these pieces (default: every file of yours the program can read)
//   --policy keep | replace-inputs | replace-previous
//   --wait             wait for delivery and print the result pieces
//
// Anywhere: --json prints the raw answer, for feeding another program. Exit code is 1 on failure, so
// `piecework order … --wait && do-something` behaves the way a shell expects.

import fs from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const v = argv[i + 1];
  argv.splice(i, v && !v.startsWith("--") ? 2 : 1);
  return v && !v.startsWith("--") ? v : true;
};
const JSON_OUT = !!flag("json", false);
const BASE = String(flag("url", process.env.PIECEWORK_URL ?? "http://localhost:8070")).replace(/\/$/, "");

const die = (msg) => { console.error(msg); process.exit(1); };
const out = (obj, text) => { if (JSON_OUT) console.log(JSON.stringify(obj, null, 2)); else text?.(); };

async function api(path, body) {
  const r = await fetch(BASE + path, body === undefined ? {} : {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }).catch((e) => die(`cannot reach the console at ${BASE} (${e.message}). Is it running?`));
  const text = await r.text();
  let j;
  try { j = JSON.parse(text); } catch { return text; }
  if (j?.error) die(j.error);
  return j;
}
const state = () => api("/api/pilot/state");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Every action returns as soon as the work starts; the console reports it as a task.
async function follow({ quiet } = {}) {
  let last = "";
  for (;;) {
    const s = await state();
    const t = s.task;
    if (!t) return s;
    const step = t.steps?.[t.steps.length - 1]?.text ?? t.title;
    if (!quiet && !JSON_OUT && step !== last) { console.error(`  ${step}`); last = step; }
    if (t.done) {
      if (t.error) die(`failed: ${t.error}`);
      return state();
    }
    await sleep(3000);
  }
}

const setOf = (s, id) => {
  for (const p of s.providers) for (const x of p.sets) if (String(x.dataSetId) === String(id)) return { ...x, provider: p };
  die(`you have no data set #${id}. Try: piecework status`);
};

const commands = {
  async status() {
    const s = await state();
    out(s, () => {
      console.log(`client   ${s.client ?? "(no wallet connected)"}`);
      console.log(`money    ${Number(s.available).toFixed(3)} ${s.token} in Filecoin Pay, ${Number(s.wallet ?? 0).toFixed(3)} in the wallet`);
      for (const p of s.providers) {
        console.log(`provider ${p.id}  ${p.reachable ? "up" : "DOWN"}  ${p.name}`);
        for (const x of p.sets) console.log(`           data set #${x.dataSetId}  ${Object.keys(x.files).length} pieces  ${x.label ?? ""}`);
      }
      for (const j of s.jobs ?? []) console.log(`job #${j.id}  ${j.status}  ${j.name ?? j.type}  ${j.price} ${s.token}`);
      for (const x of s.sessions ?? []) console.log(`session #${x.id}  ${x.status}  ${x.epochs ?? 0} epochs  ${x.spent ?? 0} ${s.token}`);
      if (s.task && !s.task.done) console.log(`busy: ${s.task.title}`);
    });
  },

  async providers() {
    const s = await state();
    out(s.providers, () => s.providers.forEach((p) =>
      console.log(`${p.id.padEnd(12)} ${p.reachable ? "up  " : "DOWN"} ${p.address ?? ""} ${p.curioUrl ?? ""}`)));
  },

  async files([id]) {
    if (!id) die("which data set? piecework files <dataSet>");
    const set = setOf(await state(), id);
    const rows = Object.entries(set.files).sort((a, b) => Number(a[0]) - Number(b[0]));
    out(set.files, () => rows.forEach(([pid, f]) => console.log(
      `${String("#" + pid).padEnd(6)} ${f.name.padEnd(34)} ${f.kind === "output" ? "result" : "yours"}`
      + `${f.protected ? "  kept" : ""}${f.removable ? "  removable" : ""}${f.removing ? "  removal scheduled" : ""}`)));
  },

  async add([id, ...paths]) {
    if (!id || !paths.length) die("piecework add <dataSet> <file>...");
    const files = paths.map((p) => {
      if (!fs.existsSync(p)) die(`no such file: ${p}`);
      return { name: path.basename(p), data: fs.readFileSync(p).toString("base64") };
    });
    await api("/api/pilot/add-files", { dataSetId: Number(id), files, protect: !!flag("keep", false) });
    await follow();
    await commands.files([id]);
  },

  async rm([id, ...pieces]) {
    if (!id || !pieces.length) die("piecework rm <dataSet> <piece>...");
    await api("/api/pilot/remove-files", { dataSetId: Number(id), pieceIds: pieces });
    await follow();
  },

  async keep([id, ...pieces]) {
    if (!id || !pieces.length) die("piecework keep <dataSet> <piece>...");
    await api("/api/pilot/protect-files", { dataSetId: Number(id), pieceIds: pieces, on: !flag("off", false) });
    await commands.files([id]);
  },

  async order([id, type]) {
    if (!id || !type) die("piecework order <dataSet> <job> [--files 3,4] [--policy replace-inputs] [--wait]");
    const pieceIds = flag("files", null);
    const wait = !!flag("wait", false);
    const before = (await state()).jobs?.[0]?.id;
    await api("/api/pilot/order", {
      dataSetId: Number(id), type, policy: flag("policy", "keep"),
      pieceIds: pieceIds && pieceIds !== true ? String(pieceIds).split(",").map((x) => x.trim()) : null,
    });
    const s = await follow();
    const job = s.jobs?.find((j) => j.id !== before) ?? s.jobs?.[0];
    if (!job) die("the job was ordered but could not be found; try piecework status");
    if (!JSON_OUT) console.error(`  job #${job.id} ordered (${job.inputs} files, ${job.price} ${s.token})`);
    if (!wait) return out(job, () => console.log(job.id));
    for (;;) {
      const now = (await state()).jobs.find((j) => j.id === job.id);
      if (now.status === "paid") {
        return out(now, () => now.outputs.forEach((o) => console.log(`#${o.pieceId}  ${o.name}`)));
      }
      if (now.status === "expired") die(`job #${job.id} was not delivered; the money is back with you`);
      if (now.status === "late") die(`job #${job.id} passed its deadline undelivered; run: piecework refund ${job.id}`);
      await sleep(5000);
    }
  },

  async refund([jobId]) {
    if (!jobId) die("piecework refund <job>");
    await api("/api/pilot/expire", { jobId: String(jobId) });
    await follow();
  },

  async get([id, piece]) {
    if (!id || !piece) die("piecework get <dataSet> <piece> [-o <file>]");
    const r = await fetch(`${BASE}/api/pilot/file/${id}/${piece}`);
    if (!r.ok) die(`the provider did not return that piece (HTTP ${r.status})`);
    const body = Buffer.from(await r.arrayBuffer());
    const o = flag("o", null) ?? flag("out", null);
    if (o && o !== true) { fs.writeFileSync(String(o), body); console.error(`wrote ${body.length} bytes to ${o}`); }
    else process.stdout.write(body);
  },

  async session([what, a, b]) {
    if (what === "start") {
      if (!a || !b) die("piecework session start <dataSet> <service>");
      await api("/api/pilot/open-session", { dataSetId: Number(a), type: b });
      await follow();
      return commands.status();
    }
    if (what === "stop") {
      if (!a) die("piecework session stop <id>");
      await api("/api/pilot/close-session", { sessionId: String(a) });
      await follow();
      return commands.status();
    }
    die("piecework session start <dataSet> <service> | stop <id>");
  },

  async deposit([amount]) {
    if (!amount) die("piecework deposit <amount>");
    await api("/api/pilot/deposit", { amount: String(amount) });
    await follow();
    return commands.status();
  },

  async jobs() {
    const s = await state();
    out(s.jobs, () => (s.jobs ?? []).forEach((j) =>
      console.log(`#${j.id}  ${j.status.padEnd(9)} ${(j.name ?? j.type ?? "").padEnd(46)} ${j.price} ${s.token}`)));
  },

  async watch() {
    for (;;) {
      const s = await state();
      const t = s.task;
      console.log(t ? `${t.done ? (t.error ? "failed" : "done") : "…"}  ${t.title}  ${t.steps?.[t.steps.length - 1]?.text ?? ""}${t.error ? `  (${t.error})` : ""}` : "idle");
      await sleep(5000);
    }
  },

  help() {
    const lines = fs.readFileSync(new URL(import.meta.url)).toString().split("\n").slice(1); // after the shebang
    const head = lines.slice(0, lines.findIndex((l) => !l.startsWith("//")));
    console.log(head.slice(1).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
  },
};

const cmd = argv.shift() ?? "help";
Promise.resolve((commands[cmd] ?? commands.help)(argv)).catch((e) => die(e.shortMessage ?? e.message));
