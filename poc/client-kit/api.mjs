// The console's HTTP interface, in one place, so the two programs that serve it (the client kit and the demo
// program) cannot drift apart. It is also the whole API: anything the page can do, a script or an agent can do
// by making the same requests.
//
//   GET  /api/pilot/state                  everything the page shows: balances, providers, data sets, jobs
//   GET  /api/pilot/ask                    a pending wallet request, when signing happens in the browser
//   GET  /api/pilot/file/<dataSet>/<piece> the file itself, read back from the provider
//   POST /api/pilot/connect                { address }                       name the wallet that pays
//   POST /api/pilot/answer                 { id, result | error }            answer a wallet request
//   POST /api/pilot/new-set                { provider, files?, label? }      create a data set with its first files
//   POST /api/pilot/adopt-set              { provider, dataSetId }           take over one you already have
//   POST /api/pilot/add-files              { dataSetId, files, protect? }    files: [{ name, data(base64) }]
//   POST /api/pilot/remove-files           { dataSetId, pieceIds }
//   POST /api/pilot/protect-files          { dataSetId, pieceIds, on }       never clear these away
//   POST /api/pilot/revoke-removal         { dataSetId, pieceIds }           take back a permission already granted
//   POST /api/pilot/order                  { dataSetId, type, policy?, pieceIds? }
//   POST /api/pilot/expire                 { jobId }                         take the money back after the deadline
//   POST /api/pilot/open-session           { dataSetId, type }               start paying by the epoch
//   POST /api/pilot/close-session          { sessionId }                     stop, and stop paying
//   POST /api/pilot/deposit                { amount }                        wallet -> Filecoin Pay
//   POST /api/pilot/add-provider           { name, address, curioUrl, note? }
//   POST /api/pilot/stop-waiting           {}
//
// Every POST returns { ok: true } as soon as the work has started; watch /api/pilot/state to see how it goes.

export async function pilotRequest({ pilot, req, res, url, json, signer }) {
  let m;
  if (req.method === "GET" && url.pathname === "/api/pilot/state") return json(200, await pilot.state());
  if (req.method === "GET" && url.pathname === "/api/pilot/ask") return json(200, { ask: signer?.pendingAsk?.() ?? null });
  if (req.method === "GET" && (m = url.pathname.match(/^\/api\/pilot\/file\/(\d+)\/(\d+)$/))) {
    const b = await pilot.file(m[1], m[2]);
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    return res.end(b);
  }
  if (req.method === "POST") {
    const chunks = [];
    for await (const ch of req) chunks.push(ch);
    const a = JSON.parse(Buffer.concat(chunks).toString() || "{}");
    switch (url.pathname) {
      case "/api/pilot/connect":
        signer?.connect?.(a.address);
        return json(200, { ok: true, client: signer?.address ?? null });
      case "/api/pilot/answer":
        return json(200, signer?.answer?.(a) ?? { ok: true });
      case "/api/pilot/new-set": await pilot.createSet(a.provider, { files: a.files, label: a.label, protect: a.protect }); return json(200, { ok: true });
      case "/api/pilot/adopt-set": await pilot.adoptSet(a.provider, a.dataSetId); return json(200, { ok: true });
      case "/api/pilot/add-files": await pilot.addFiles(a.dataSetId, a.files, a.protect); return json(200, { ok: true });
      case "/api/pilot/remove-files": await pilot.removeFiles(a.dataSetId, a.pieceIds); return json(200, { ok: true });
      case "/api/pilot/protect-files": return json(200, pilot.protectFiles(a.dataSetId, a.pieceIds, a.on !== false));
      case "/api/pilot/revoke-removal": await pilot.revokeRemoval(a.dataSetId, a.pieceIds); return json(200, { ok: true });
      case "/api/pilot/order": await pilot.order(a.dataSetId, a.type, a.policy, a.pieceIds); return json(200, { ok: true });
      case "/api/pilot/expire": await pilot.expire(a.jobId); return json(200, { ok: true });
      case "/api/pilot/open-session": await pilot.openSession(a.dataSetId, a.type); return json(200, { ok: true });
      case "/api/pilot/close-session": await pilot.closeSession(a.sessionId); return json(200, { ok: true });
      case "/api/pilot/deposit": await pilot.deposit(a.amount); return json(200, { ok: true });
      case "/api/pilot/add-provider": return json(200, { ok: true, ...(await pilot.addProvider(a)) });
      case "/api/pilot/stop-waiting": pilot.stopWaiting(); return json(200, { ok: true });
      default: break;
    }
  }
  return json(404, { error: "unknown action" });
}
