// PieceWork client kit: your own console for buying compute from the storage provider that holds your data.
//
//   node console.mjs --config client.config.json      then open http://localhost:8070
//
// It runs on your machine. What it does:
//   1. creates data sets at a provider's Curio and puts your files in them (you sign, Curio submits);
//   2. orders jobs through ComputeService: the price is held in Filecoin Pay until the provider delivers;
//   3. shows the results, read back from the provider, and refunds you if the deadline passes;
//   4. removes files you no longer want (you sign, the provider submits, PDP drops them next proving period).
//
// Your files go straight from this machine to the provider you picked.
//
// Two ways to sign, set by "signer" in the configuration:
//   "browser"  the wallet in your browser (MetaMask). This program never sees a key: when something has to be
//              signed it puts the request on a queue, the page asks your wallet, and hands back the answer.
//   "keyfile"  a private key in a file on this machine, for running without a browser wallet.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, http, fallback, custom, getAddress, encodeFunctionData, toHex } from "viem";
import { calibration, mainnet as filecoinMainnet } from "@filoz/synapse-core/chains";
import { privateKeyToAccount, toAccount } from "viem/accounts";
import { createPilot } from "./pilot.mjs";
import { pilotRequest } from "./api.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
const cfgFile = arg("--config") ?? path.join(HERE, "client.config.json");
if (!fs.existsSync(cfgFile)) {
  console.error(`No configuration at ${cfgFile}. Copy client.config.example.json to client.config.json and fill it in, or run ./setup.sh.`);
  process.exit(1);
}
const cfg = JSON.parse(fs.readFileSync(cfgFile, "utf8"));
const home = (p) => p.replace(/^~/, os.homedir());
// Synapse checks the chain it is given, so use its own chain objects
const chain = cfg.network === "mainnet" ? filecoinMainnet : calibration;
const say = (...a) => console.log(`${new Date().toISOString().slice(11, 19)} ${a.join(" ")}`);

const transport = fallback(cfg.rpc.map((u) => http(u)), { retryCount: 2 });
const pub = createPublicClient({ chain, transport, pollingInterval: 4000 });

// ---------------------------------------------------------------- signing

// Things the page has to take to the wallet. Each one waits here until the page answers it.
const asks = new Map(); // id -> { resolve, reject, sent }
let nextAsk = 1;
function ask(kind, payload, what) {
  return new Promise((resolve, reject) => {
    const id = nextAsk++;
    asks.set(id, { id, kind, payload, what, resolve, reject, at: Date.now() });
    setTimeout(() => { if (asks.delete(id)) reject(new Error(`you did not answer the wallet request in time (${what})`)); }, 5 * 60_000);
  });
}
const pendingAsk = () => { const a = [...asks.values()][0]; return a && { id: a.id, kind: a.kind, payload: a.payload, what: a.what }; };
function answerAsk({ id, result, error }) {
  const q = asks.get(id);
  if (!q) return { error: "that request is no longer waiting" };
  asks.delete(id);
  error ? q.reject(new Error(error)) : q.resolve(result);
  return { ok: true };
}

let signer;
if (cfg.signer === "keyfile") {
  const account = privateKeyToAccount(fs.readFileSync(home(cfg.clientKeyFile), "utf8").trim());
  const wallet = createWalletClient({ chain, transport, account });
  signer = { mode: "keyfile", address: account.address, account: () => account, submit: (request) => wallet.writeContract({ ...request, account, chain }) };
} else {
  // The wallet lives in the browser. viem signs through an account whose signing methods are questions for the
  // page; transactions are sent by the page itself, because a browser wallet never hands out a signed transaction.
  let address = null;
  const account = () => toAccount({
    address,
    signMessage: ({ message }) => ask("personal_sign", { message: typeof message === "string" ? message : message.raw }, "a signature"),
    signTypedData: (typedData) => ask("eth_signTypedData_v4", typedData, "a signature for your storage provider"),
    signTransaction: () => { throw new Error("the browser wallet sends transactions itself"); },
  });
  signer = {
    mode: "browser",
    get address() { return address; },
    account,
    connect(a) { address = getAddress(a); say(`Wallet connected: ${address}`); },
    async submit(request) {
      const tx = { from: address, to: request.address, data: encodeFunctionData({ abi: request.abi, functionName: request.functionName, args: request.args }) };
      if (request.value) tx.value = toHex(request.value);
      if (request.gas) tx.gas = toHex(request.gas);
      return ask("eth_sendTransaction", [tx], `the transaction for ${request.functionName}`);
    },
  };
}

const RUN = home(cfg.workDir ?? "~/.piecework-client");
fs.mkdirSync(RUN, { recursive: true });

const ABI = JSON.parse(fs.readFileSync(path.join(HERE, "abi.json"), "utf8"));
for (const k of Object.keys(ABI)) if (k !== "Errors") ABI[k] = [...ABI[k], ...ABI.Errors]; // decode nested reverts
const C = { ...cfg.contracts, cs: getAddress(cfg.computeService) };
const NET = { rpc: cfg.rpc[0], rpcBackup: cfg.rpc[1] ?? cfg.rpc[0], token: cfg.token ?? "USDFC", explorer: cfg.explorer, chain };

const pilot = createPilot({
  HERE, RUN, NET, C, ABI, pub, signer, say,
  paths: { providers: path.join(HERE, "providers.json"), jobs: path.join(HERE, "jobs.json"), samples: path.join(HERE, "samples") },
});

// ---------------------------------------------------------------- the page and its API

const PAGE = path.join(HERE, "client.html");
const api = { pendingAsk, answer: answerAsk, get address() { return signer.address; }, connect: (a) => signer.connect?.(a) };
const reason = (e) => e?.shortMessage ?? e?.message ?? String(e);

createServer(async (req, res) => {
  // wallets want plain JSON, and typed data carries bigints (uint256 as a decimal string is what EIP-712 expects)
  const json = (code, body) => {
    if (res.headersSent) return;
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body, (k, v) => (typeof v === "bigint" ? v.toString() : v)));
  };
  try {
    const url = new URL(req.url, "http://x");
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/client.html")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(fs.readFileSync(PAGE));
    }
    if (url.pathname.startsWith("/api/pilot/")) return await pilotRequest({ pilot, req, res, url, json, signer: api });
    res.writeHead(404); res.end("not found");
  } catch (e) { say("error:", reason(e)); json(400, { error: reason(e) }); }
}).listen(cfg.port ?? 8070, "127.0.0.1", () => {
  say(`PieceWork client console on Filecoin ${cfg.network === "mainnet" ? "mainnet" : "Calibration"}.`);
  say(signer.mode === "keyfile" ? `Paying wallet: ${signer.address} (from ${cfg.clientKeyFile}).` : "Signing with the wallet in your browser: connect it on the page.");
  say(`Providers: ${JSON.parse(fs.readFileSync(path.join(HERE, "providers.json"), "utf8")).map((p) => p.id).join(", ")}`);
  say(`Open http://localhost:${cfg.port ?? 8070}  (Ctrl+C to stop)`);
});
