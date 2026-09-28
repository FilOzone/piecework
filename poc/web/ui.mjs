// The page. All of the thinking is in app.mjs; this draws it and keeps a little state in the browser.
const V = new URL(import.meta.url).searchParams.get("v") ?? "";
const PW = await import(`./app.mjs${V ? "?v=" + V : ""}`);

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const CFG = PW.CFG;

// what this browser remembers: which provider, which data set, and the jobs it has ordered
const store = {
  get: (k, d) => { try { return JSON.parse(localStorage.getItem("pw-" + k)) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem("pw-" + k, JSON.stringify(v)); } catch { /* private window */ } },
};

let me = null, money = null, pick = store.get("provider", CFG.providers[0].id);
let set = null, jobs = {}, picked = new Set(), busy = null, error = null, blockNow = 0;
let jobType = Object.keys(CFG.jobs)[0], policy = "keep";
let wrongChain = false;
let typed = { dep: "1", label: "" }; // what the visitor has typed, kept across re-renders
let waiting = []; // files chosen but not yet uploaded, gathered from wherever they came from
let sessions = {}, service = Object.keys(CFG.services ?? {})[0];
let mySets = null; // the data sets this wallet owns at the chosen provider, found on the chain
async function checkChain() {
  if (!window.ethereum || !me) return;
  const at = await window.ethereum.request({ method: "eth_chainId" }).catch(() => null);
  const now = at !== "0x" + CFG.chainId.toString(16);
  if (now !== wrongChain) { wrongChain = now; render(); }
}

PW.reportSteps((text) => { busy = text; render(); });

async function run(what, fn) {
  busy = what; error = null; render();
  try { return await fn(); }
  catch (e) { error = e.shortMessage ?? e.message ?? String(e); }
  finally { busy = null; render(); }
}

$("csaddr").textContent = CFG.computeService;

// ---------------------------------------------------------------- drawing

function render() {
  $("task").innerHTML = busy ? `<div class="task"><b><span class="spin"></span>${esc(busy)}</b>
      <div class="muted">Each step is a real transaction on Filecoin Calibration and waits for a block, about 30 seconds.
      If nothing seems to happen, open your wallet: it may be holding a request without showing it.
      <button class="b" id="giveup" style="padding:4px 10px;margin-left:8px">Stop waiting</button></div></div>`
    : error ? `<div class="task err"><b>Failed</b><div>${esc(error)}</div></div>` : "";

  if ($("giveup")) $("giveup").onclick = () => { busy = null; error = "You stopped waiting. If you confirmed in your wallet, the transaction may still go through — reload in a minute to see."; render(); };
  $("who").innerHTML = me
    ? `You are <code>${esc(me)}</code>${wrongChain ? ` · <span class="pill bad">your wallet is on another network — switch it to Filecoin ${esc(CFG.network)}</span>` : ` · Filecoin ${esc(CFG.network)}`}`
    : "Not connected.";
  $("wallet").hidden = !!me;
  if (!me) {
    $("wallet").innerHTML = `<h2>Connect your wallet</h2>
      <p class="muted">Everything below is signed by you: creating a data set, adding files, ordering work, taking your money back.
      You need MetaMask on Filecoin Calibration, with test tFIL for gas and test USDFC to pay with — the links appear once you connect.</p>
      <button class="b primary" id="connect">Connect wallet</button>`;
    $("connect").onclick = () => run("Connecting", async () => { me = await PW.connect(); store.set("me", me); await refreshMoney(); });
    for (const id of ["money", "setcard", "ordercard", "timecard", "jobscard"]) $(id).hidden = true;
    return;
  }

  // money
  $("money").hidden = false;
  const low = Number(money?.wallet ?? 0) < 5 || Number(money?.gas ?? 0) < 5 || Number(money?.available ?? 0) < 1;
  $("money").innerHTML = `<div class="row" style="justify-content:space-between">
      <div><b>${Number(money?.available ?? 0).toFixed(3)} ${esc(CFG.token)}</b> in Filecoin Pay <span class="muted">(this is what pays for jobs)</span><br>
        <span class="muted">${Number(money?.wallet ?? 0).toFixed(3)} ${esc(CFG.token)} and ${Number(money?.gas ?? 0).toFixed(3)} tFIL in your wallet</span></div>
      <div class="row"><input type="text" id="dep" value="${esc(typed.dep)}" style="width:80px"><button class="b" id="depbtn" ${busy ? "disabled" : ""}>Move into Filecoin Pay</button></div>
    </div>
    ${low ? `<p class="muted" style="margin:10px 0 0">Running low. Paste <code>${esc(me)}</code> into
      ${Object.entries(CFG.faucets).map(([k, v]) => `<a href="${esc(v)}" target="_blank" rel="noopener">${esc(k)}</a>`).join(" · ")}.
      They arrive in your wallet; then move some into Filecoin Pay.</p>` : ""}`;
  $("dep").oninput = (e) => { typed.dep = e.target.value; };
  $("depbtn").onclick = () => {
    const amount = $("dep").value.trim();
    if (!/^\d+(\.\d+)?$/.test(amount) || Number(amount) <= 0) return alert("How much? A number, for example 3.");
    if (Number(amount) > Number(money?.wallet ?? 0)) return alert(`Your wallet holds ${Number(money?.wallet ?? 0).toFixed(3)} ${CFG.token}; you asked to move ${amount}.`);
    run(`Moving ${amount} ${CFG.token} into Filecoin Pay`, async () => { await PW.deposit(amount); await refreshMoney(); });
  };

  // provider and data set
  $("setcard").hidden = false;
  const p = CFG.providers.find((x) => x.id === pick) ?? CFG.providers[0];
  const files = Object.entries(set?.files ?? {}).sort((a, b) => Number(a[0]) - Number(b[0]));
  $("setcard").innerHTML = `<h2>Your data at ${esc(p.name)}</h2>
    <p class="muted">${esc(p.note ?? "")}</p>
    ${CFG.providers.length > 1 ? `<div class="row"><select id="prov">${CFG.providers.map((x) =>
      `<option value="${esc(x.id)}" ${x.id === pick ? "selected" : ""}>${esc(x.name)}</option>`).join("")}</select></div>` : ""}
    ${set && !set.canReceiveResults ? `<div class="task err" style="margin-bottom:12px"><b>This data set cannot receive job results yet</b>
      <div class="muted">A job over it would run and then fail to deliver. One signature fixes it — only you can give it, because you pay for the data set.</div>
      <button class="b primary" id="allowres" style="margin-top:8px" ${busy ? "disabled" : ""}>Allow job results</button></div>` : ""}
    ${set ? `<p class="muted">${set.label ? `<b>${esc(set.label)}</b> (data set #${set.dataSetId})` : `Data set #${set.dataSetId}`}: ${files.length} pieces. Tick files to run a job over just those, or to remove them.
       You can hold as many data sets with a provider as you like — one per project, or a throwaway one for jobs that replace files.</p>
      <div class="tw"><table><thead><tr><th style="width:26px"></th><th>Piece</th><th>File</th><th>What</th></tr></thead><tbody>
      ${files.map(([pid, f]) => `<tr>
        <td><input type="checkbox" data-id="${pid}" ${picked.has(pid) ? "checked" : ""}></td>
        <td>#${pid}</td>
        <td><a href="${esc(PW.fileUrl(p.id, f.cid))}" target="_blank" rel="noopener">${esc(f.name)}</a></td>
        <td>${f.kind === "output" ? '<span class="pill ok">job result</span>' : '<span class="muted">your file</span>'}${
          f.removing ? ' <span class="pill off">removal scheduled</span>'
          : f.removable ? ' <span class="pill warn">you allowed removal</span>' : ""}</td></tr>`).join("")}
      </tbody></table></div>
      <div class="row" style="margin-top:12px">
        <label class="b">Choose files<input type="file" hidden multiple id="picker"></label>
        <button class="b" id="rm" ${picked.size && !busy ? "" : "disabled"}>Remove ${picked.size || ""} selected</button>
        <button class="b" id="forget">Switch data set, or start a new one</button></div>
      <div class="drop" id="drop" style="margin-top:12px">Drop files here to add them to data set #${set.dataSetId}</div>
      ${waiting.length ? `<div class="card" style="margin-top:12px;background:var(--surface-2)">
      <b>${waiting.length} file${waiting.length > 1 ? "s" : ""} ready to upload</b>
      <div class="tw"><table><tbody>${waiting.map((f, i) => `<tr><td>${esc(f.name)}</td>
        <td class="muted">${(f.size / 1024).toFixed(1)} kB</td>
        <td><a data-drop="${i}">remove</a></td></tr>`).join("")}</tbody></table></div>
      <div class="row" style="margin-top:10px">
        <button class="b primary" id="confirmup" ${busy ? "disabled" : ""}>${set ? `Upload to data set #${set.dataSetId}` : "Create the data set with these"}</button>
        <button class="b" id="clearup">Clear</button></div></div>` : ""}`
    : `<p class="muted">Two ways to start: open a data set you already have with this provider, or make a new one from files you drop here.
        Making one costs a small reserve in Filecoin Pay, which you get back if you ever close it.</p>
      ${mySets === null ? '<p class="muted">Looking for data sets you already have here…</p>'
        : mySets.length ? `<div class="row"><select id="mysets">${mySets.map((x) => `<option value="${x.id}">${esc(x.label || `Data set #${x.id}`)}${x.label ? ` — #${x.id}` : ""}</option>`).join("")}</select>
            <button class="b primary" id="openmine" ${busy ? "disabled" : ""}>Open it</button>
            <span class="muted">or make a new one below</span></div>`
        : '<p class="muted">You have no data set with this provider yet.</p>'}
      <div class="row" style="margin-top:12px">
        <input type="text" id="label" value="${esc(typed.label ?? "")}" placeholder="name it, e.g. Q3 contracts" style="width:220px">
        <label class="b primary">Choose files<input type="file" hidden multiple id="newpicker"></label>
        <span class="muted">or drop them below</span></div>
      <div class="drop" id="drop" style="margin-top:8px">Drop files here to create a data set with them</div>
      ${waiting.length ? `<div class="card" style="margin-top:12px;background:var(--surface-2)">
      <b>${waiting.length} file${waiting.length > 1 ? "s" : ""} ready to upload</b>
      <div class="tw"><table><tbody>${waiting.map((f, i) => `<tr><td>${esc(f.name)}</td>
        <td class="muted">${(f.size / 1024).toFixed(1)} kB</td>
        <td><a data-drop="${i}">remove</a></td></tr>`).join("")}</tbody></table></div>
      <div class="row" style="margin-top:10px">
        <button class="b primary" id="confirmup" ${busy ? "disabled" : ""}>${set ? `Upload to data set #${set.dataSetId}` : "Create the data set with these"}</button>
        <button class="b" id="clearup">Clear</button></div></div>` : ""}`}`;
  if ($("prov")) $("prov").onchange = (e) => { pick = e.target.value; store.set("provider", pick); set = null; mySets = null; render(); lookUpSets(); };
  if (!set && mySets === null && !busy) lookUpSets();
  if ($("openmine")) $("openmine").onclick = () => {
    const id = $("mysets").value;
    const label = (mySets.find((x) => String(x.id) === String(id)) ?? {}).label ?? "";
    run(`Reading data set #${id} from the chain`, async () => { set = { ...(await PW.readSet(pick, id, jobs)), label }; store.set("set-" + pick, id); });
  };
  if ($("allowres")) $("allowres").onclick = () => run("Allowing job results", async () => {
    await PW.allowResults(set.dataSetId);
    set = { ...(await PW.readSet(pick, set.dataSetId, jobs)), label: set.label };
  });
  if ($("forget")) $("forget").onclick = () => { set = null; store.set("set-" + pick, null); render(); };
  if ($("picker")) $("picker").onchange = (e) => { stage([...e.target.files]); e.target.value = ""; };
  if ($("label")) $("label").oninput = (e) => { typed.label = e.target.value; };
  if ($("newpicker")) $("newpicker").onchange = (e) => { stage([...e.target.files]); e.target.value = ""; };
  if ($("confirmup")) $("confirmup").onclick = () => { const list = waiting; waiting = []; addFiles(list); };
  if ($("clearup")) $("clearup").onclick = () => { waiting = []; render(); };
  document.querySelectorAll("a[data-drop]").forEach((a) => (a.onclick = () => { waiting.splice(Number(a.dataset.drop), 1); render(); }));
  if ($("rm")) $("rm").onclick = () => {
    if (!confirm(`Remove ${picked.size} file(s)? PDP drops them at the provider's next proving period. This cannot be undone.`)) return;
    run("Removing files", async () => { await PW.removeFiles(pick, set.dataSetId, [...picked]); picked = new Set(); set = await PW.readSet(pick, set.dataSetId, jobs); });
  };
  document.querySelectorAll("input[type=checkbox][data-id]").forEach((b) => (b.onchange = () => {
    b.checked ? picked.add(b.dataset.id) : picked.delete(b.dataset.id); render();
  }));
  const drop = $("drop");
  if (drop) {
    drop.ondragover = (e) => { e.preventDefault(); drop.classList.add("over"); };
    drop.ondragleave = () => drop.classList.remove("over");
    drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove("over"); stage([...e.dataTransfer.files]); };
  }

  // ordering
  $("ordercard").hidden = !set;
  if (set) {
    const spec = CFG.jobs[jobType];
    const exts = spec.inputExtensions ?? [spec.inputExtension ?? ""];
  const eligible = files.filter(([, f]) => exts.some((e) => f.name.endsWith(e)));
    const use = picked.size ? [...picked] : eligible.map(([pid]) => pid);
    $("ordercard").innerHTML = `<h2>Order a job</h2>
      <p class="muted">The price is held in Filecoin Pay. The provider runs the program next to your files, adds the results to your data set,
      and is paid only if it does so before the deadline. If it does not, you take the money back.</p>
      <div class="row">
        <select id="jt">${Object.entries(CFG.jobs).map(([t, j]) => `<option value="${esc(t)}" ${t === jobType ? "selected" : ""}>${esc(j.name)} — ${esc(j.price)} ${esc(CFG.token)}</option>`).join("")}</select>
        <select id="pol">${CFG.policies.map((x) => `<option value="${esc(x.id)}" ${x.id === policy ? "selected" : ""}>${esc(x.label)}</option>`).join("")}</select>
        <button class="b primary" id="orderbtn" ${busy || !use.length || !set.canReceiveResults ? "disabled" : ""}>Order</button>
      </div>
      <p class="muted" style="margin:8px 0 0">It will read <b>${use.length} file${use.length === 1 ? "" : "s"}</b>${picked.size ? " (the ones you ticked)" : ` — every ${esc(exts.join(", "))} file in the data set`}.
      ${policy === "replace-inputs" ? "After delivery the provider may remove exactly those files. This cannot be undone." : "Nothing is removed."}</p>`;
    $("jt").onchange = (e) => { jobType = e.target.value; render(); };
    $("pol").onchange = (e) => { policy = e.target.value; render(); };
    $("orderbtn").onclick = () => {
      if (policy === "replace-inputs" && !confirm("The provider will be allowed to remove the files this job reads, once it has delivered. Continue?")) return;
      run("Ordering the job", async () => {
        const r = await PW.order(pick, set.dataSetId, jobType, policy, use);
        jobs[r.jobId] = { ...r, jobId: r.jobId, type: jobType, provider: pick, dataSetId: set.dataSetId,
          inputs: use.length, price: CFG.jobs[jobType].price, status: "waiting", fromBlock: Number(r.fromBlock ?? blockNow) };
        picked = new Set();
        await refreshMoney();
        poll();
      });
    };
  }

  // pay for time
  const svc = CFG.services ?? {};
  const live = Object.entries(sessions).filter(([, x]) => x.status !== "closed");
  $("timecard").hidden = !set || !Object.keys(svc).length;
  if (!$("timecard").hidden) {
    const spec = svc[service];
    $("timecard").innerHTML = `<h2>Or pay for time instead</h2>
      <p class="muted">The other way to buy: a rate per epoch for a service running next to your files, rather than a price for a result.
      Nothing is charged until the provider says it is running, and closing it stops the charge at that epoch.</p>
      <div class="row">
        <select id="svc">${Object.entries(svc).map(([t, x]) => `<option value="${esc(t)}" ${t === service ? "selected" : ""}>${esc(x.name)} — ${esc(x.rate)} ${esc(CFG.token)} per epoch</option>`).join("")}</select>
        <button class="b primary" id="startsvc" ${busy || live.length ? "disabled" : ""}>Start it</button>
        <span class="muted">${live.length ? "One at a time here." : `about ${(Number(spec.rate) * 120).toFixed(2)} ${esc(CFG.token)} an hour · 1 epoch = 30 s`}</span>
      </div>
      <p class="muted" style="margin:8px 0 0">${esc(spec.note ?? "")}</p>
      ${Object.keys(sessions).length ? `<div class="tw" style="margin-top:12px"><table>
        <thead><tr><th>Session</th><th>Status</th><th>Running</th><th>Spent</th><th></th></tr></thead><tbody>
        ${Object.entries(sessions).sort((a, b) => Number(b[0]) - Number(a[0])).map(([id, x]) => `<tr>
          <td>#${esc(id)} ${esc(svc[x.type]?.name ?? x.type)}<br><span class="muted">${esc(x.rate)} ${esc(CFG.token)} per epoch</span></td>
          <td><span class="pill ${x.status === "running" ? "ok" : x.status === "closed" ? "off" : ""}">${esc(x.status ?? "…")}</span></td>
          <td>${x.epochs ? `${x.epochs} epochs (~${Math.round(x.epochs / 2)} min)` : "—"}</td>
          <td>${esc(x.spent ?? "0")} ${esc(CFG.token)}</td>
          <td>${x.status === "closed"
            ? (x.tx ? `<a href="${esc(CFG.explorer + x.tx)}" target="_blank" rel="noopener">opened</a>` : "")
            : `<button class="b" data-stop="${esc(id)}" ${busy ? "disabled" : ""}>Stop and stop paying</button>`}</td></tr>`).join("")}
        </tbody></table></div>` : ""}`;
    $("svc").onchange = (e) => { service = e.target.value; render(); };
    $("startsvc").onclick = () => run("Starting the service", async () => {
      const r = await PW.openSession(pick, set.dataSetId, service);
      sessions[r.sessionId] = { ...r, sessionId: r.sessionId, type: service, rate: svc[service].rate, status: "waiting for the provider" };
      await refreshMoney();
    });
    document.querySelectorAll("button[data-stop]").forEach((b) => (b.onclick = () => run("Stopping the service", async () => {
      await PW.closeSession(b.dataset.stop);
      sessions[b.dataset.stop].status = "closed";
      await refreshMoney();
    })));
  }

  // jobs
  const list = Object.entries(jobs).sort((a, b) => Number(b[0]) - Number(a[0]));
  $("jobscard").hidden = !list.length;
  if (list.length) $("jobscard").innerHTML = `<h2>Your jobs</h2><div class="tw"><table>
    <thead><tr><th>Job</th><th>Status</th><th>Results</th><th></th></tr></thead><tbody>
    ${list.map(([id, j]) => `<tr>
      <td>#${esc(id)} ${esc(CFG.jobs[j.type]?.name ?? j.type)}<br><span class="muted">${j.inputs} files · ${esc(CFG.jobs[j.type]?.price ?? "")} ${esc(CFG.token)} · data set #${esc(j.dataSetId)}</span></td>
      <td><span class="pill ${esc(j.status)}">${esc({ waiting: "waiting for the provider", paid: "delivered and paid", refunded: "refunded" }[j.status] ?? j.status)}</span>
        ${j.status === "waiting" && blockNow && j.deadline > blockNow ? `<div class="muted">${j.deadline - blockNow} blocks left</div>`
          : j.status === "waiting" && blockNow ? '<div class="muted">deadline passed</div>' : ""}</td>
      <td>${(j.outputs ?? []).map((o) => `<a href="${esc(PW.fileUrl(j.provider, o.cid))}" target="_blank" rel="noopener">${esc(o.name)}</a>`).join("<br>")}</td>
      <td>${j.tx ? `<a href="${esc(CFG.explorer + j.tx)}" target="_blank" rel="noopener">ordered</a>` : ""}
        ${j.paidTx ? ` · <a href="${esc(CFG.explorer + j.paidTx)}" target="_blank" rel="noopener">paid</a>` : ""}
        ${j.status === "waiting" && blockNow && j.deadline < blockNow ? `<div><button class="b" data-refund="${esc(id)}">Get my money back</button></div>` : ""}</td>
    </tr>`).join("")}</tbody></table></div>`;
  document.querySelectorAll("button[data-refund]").forEach((b) => (b.onclick = () => run("Cancelling the job", async () => {
    await PW.refund(b.dataset.refund);
    jobs[b.dataset.refund].status = "refunded";
    await refreshMoney();
  })));
}

function stage(list) {
  for (const f of list) if (!waiting.some((x) => x.name === f.name && x.size === f.size)) waiting.push(f);
  render();
}

function addFiles(list) {
  if (!list.length) return;
  const names = list.map((f) => f.name).join(", ");
  if (set) return run(`Adding ${names}`, async () => { await PW.addFiles(pick, set.dataSetId, list); set = await PW.readSet(pick, set.dataSetId, jobs); });
  return run(`Creating ${typed.label ? `"${typed.label}"` : "a data set"} with ${names}`, async () => {
    const id = await PW.createSet(pick, list, typed.label);
    typed.label = "";
    store.set("set-" + pick, String(id));
    set = await PW.readSet(pick, id, jobs);
  });
}

const refreshMoney = async () => { money = await PW.money().catch(() => money); };
let looking = false;
async function lookUpSets() {
  if (looking) return;
  looking = true;
  mySets = await PW.findDataSets(pick).catch((e) => { error = e.shortMessage ?? e.message; return []; });
  looking = false;
  render();
}

// Watch the chain for what the provider is doing, without asking it anything.
async function poll() {
  blockNow = await PW.block().catch(() => blockNow);
  const fromChain = await PW.findJobs().catch(() => null);
  if (fromChain) {
    const wasPaid = Object.fromEntries(Object.entries(jobs).map(([k, v]) => [k, v.status]));
    jobs = { ...jobs, ...fromChain };
    if (Object.entries(jobs).some(([k, v]) => v.status === "paid" && wasPaid[k] !== "paid")) {
      await refreshMoney();
      if (set) set = await PW.readSet(pick, set.dataSetId, jobs).catch(() => set);
    }
  }
  render();
}

// ---------------------------------------------------------------- start

(async function start() {
  render();
  if (window.ethereum) {
    const [a] = await window.ethereum.request({ method: "eth_accounts" }).catch(() => []);
    if (a) await run("Connecting", async () => {
      me = await PW.connect();
      await refreshMoney();
      jobs = await PW.findJobs().catch(() => ({}));
      sessions = await PW.findSessions().catch(() => ({}));
      const known = store.get("set-" + pick, null) ?? Object.values(jobs).find((j) => j.provider === pick)?.dataSetId;
      if (known) set = await PW.readSet(pick, known, jobs).catch(() => null);
    });
  }
  render();
  setInterval(() => { if (me && !busy) poll(); }, 10_000);
  setInterval(checkChain, 3000);
})();
