// PieceWork client kit: your own console for buying compute from the storage provider that holds your data.
//
//   node console.mjs --config client.config.json      then open http://localhost:8070
//
// It runs on your machine, with your own wallet. What it does:
//   1. creates data sets at a provider's Curio and puts your files in them (you sign, Curio submits);
//   2. orders jobs through ComputeService: the price is held in Filecoin Pay until the provider delivers;
//   3. shows the results, read back from the provider, and refunds you if the deadline passes;
//   4. removes files you no longer want (you sign, the provider submits, PDP drops them next proving period).
//
// Your files go straight from this machine to the provider you picked. Your key is read from a file here and
// never leaves it; it signs the same EIP-712 messages any FOC client signs.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { createPublicClient, http, fallback, getAddress } from "viem";
import { filecoinCalibration, filecoin } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { createPilot } from "./pilot.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
const cfgFile = arg("--config") ?? path.join(HERE, "client.config.json");
if (!fs.existsSync(cfgFile)) {
  console.error(`No configuration at ${cfgFile}. Copy client.config.example.json to client.config.json and fill it in, or run ./setup.sh.`);
  process.exit(1);
}
const cfg = JSON.parse(fs.readFileSync(cfgFile, "utf8"));
const home = (p) => p.replace(/^~/, os.homedir());
const chain = cfg.network === "mainnet" ? filecoin : filecoinCalibration;
const say = (...a) => console.log(`${new Date().toISOString().slice(11, 19)} ${a.join(" ")}`);

const account = privateKeyToAccount(fs.readFileSync(home(cfg.clientKeyFile), "utf8").trim());
const transport = fallback(cfg.rpc.map((u) => http(u)), { retryCount: 2 });
const pub = createPublicClient({ chain, transport, pollingInterval: 4000 });

const RUN = home(cfg.workDir ?? "~/.piecework-client");
fs.mkdirSync(RUN, { recursive: true });

const ABI = JSON.parse(fs.readFileSync(path.join(HERE, "abi.json"), "utf8"));
for (const k of Object.keys(ABI)) if (k !== "Errors") ABI[k] = [...ABI[k], ...ABI.Errors]; // decode nested reverts
const C = { ...cfg.contracts, cs: getAddress(cfg.computeService) };
const NET = { rpc: cfg.rpc[0], rpcBackup: cfg.rpc[1] ?? cfg.rpc[0], token: cfg.token ?? "USDFC", explorer: cfg.explorer, chain };

const pilot = createPilot({
  HERE, RUN, NET, C, ABI, pub, demoAcct: account, say,
  paths: { providers: path.join(HERE, "providers.json"), jobs: path.join(HERE, "jobs.json"), samples: path.join(HERE, "samples") },
});

// ---------------------------------------------------------------- the page and its API

const PAGE = path.join(HERE, "client.html");
const reason = (e) => e?.shortMessage ?? e?.message ?? String(e);

createServer(async (req, res) => {
  const json = (code, body) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  try {
    const url = new URL(req.url, "http://x");
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/client.html")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(fs.readFileSync(PAGE));
    }
    let m;
    if (req.method === "GET" && url.pathname === "/api/pilot/state") return json(200, await pilot.state());
    if (req.method === "GET" && (m = url.pathname.match(/^\/api\/pilot\/file\/(\d+)\/(\d+)$/))) {
      const b = await pilot.file(m[1], m[2]);
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" }); return res.end(b);
    }
    if (req.method === "POST") {
      const chunks = []; for await (const ch of req) chunks.push(ch);
      const a = JSON.parse(Buffer.concat(chunks).toString() || "{}");
      if (url.pathname === "/api/pilot/new-set") { await pilot.createSet(a.provider, { files: a.files, label: a.label }); return json(200, { ok: true }); }
      if (url.pathname === "/api/pilot/add-files") { await pilot.addFiles(a.dataSetId, a.files); return json(200, { ok: true }); }
      if (url.pathname === "/api/pilot/remove-files") { await pilot.removeFiles(a.dataSetId, a.pieceIds); return json(200, { ok: true }); }
      if (url.pathname === "/api/pilot/order") { await pilot.order(a.dataSetId, a.type, a.policy); return json(200, { ok: true }); }
      if (url.pathname === "/api/pilot/expire") { await pilot.expire(a.jobId); return json(200, { ok: true }); }
    }
    res.writeHead(404); res.end("not found");
  } catch (e) { say("error:", reason(e)); json(400, { error: reason(e) }); }
}).listen(cfg.port ?? 8070, "127.0.0.1", () => {
  say(`PieceWork client console. You are ${account.address} on Filecoin ${cfg.network === "mainnet" ? "mainnet" : "Calibration"}.`);
  say(`Providers: ${JSON.parse(fs.readFileSync(path.join(HERE, "providers.json"), "utf8")).map((p) => p.id).join(", ")}`);
  say(`Open http://localhost:${cfg.port ?? 8070}  (Ctrl+C to stop)`);
});
