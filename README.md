# foc-compute

Personal research prototype: **compute on Filecoin Onchain Cloud (FOC)**, paid through Filecoin Pay.

A storage provider that already stores (and proves with PDP) a client's data set also sells compute over it:

- **Sessions — pay for time.** Like renting a machine from a GPU cloud: a rate per epoch (30 s) from when the service is ready until the client stops; payment stops exactly then. A safety margin (`rate × lockupPeriod`) is set aside and only used to pay the provider if the client's funds run out.
- **Batch jobs — pay per job.** The price is escrowed when the job is posted and paid once when the outputs are committed as new PDP pieces; if the deadline passes with no outputs, the client is refunded.

Correctness of results is the client's responsibility, as with commercial GPU clouds.

## Guarantees

The labels used in tests and tables below (S = sessions, J = jobs):

| | Guarantee |
|---|---|
| **S1** | If the client's money runs out during a session, the provider is still paid: for the time served, plus at most the safety margin (`rate × lockupPeriod`). |
| **S2** | The client never pays more than the safety margin beyond the service it received. |
| **S3** | Nobody can charge the client without its approval: only the operator it approved (ComputeService), within the limits it set. |
| **S4** | Stop means stop: when the client stops, it pays exactly the epochs used, and the margin is released. |
| **J1** | If the provider delivers the outputs (new pieces in the client's data set) before the deadline, it is paid the price. |
| **J2** | If nothing is delivered by the deadline, the client gets the full price back. |
| **J3** | The provider is paid at most once, and never more than the price held for the job. |

## What runs, and where

Three ways in, for three kinds of person.

| | For | Where |
|---|---|---|
| **A web page** | anyone with a wallet — nothing installed | `poc/web/` — static files; your browser talks to the provider and the chain, and whoever hosts the page sees nothing |
| **The client kit** | a client who wants it on their own machine, scriptable | `poc/client-kit/` — a local console, plus `piecework` on the command line |
| **The provider kit** | a storage provider selling compute | `poc/provider-kit/` — one command next to an existing Curio |

And `poc/start.mjs` is the demo program: it plays a Curio provider on a laptop, so the whole thing can be shown without a second machine, and serves the guided walk-through page.

## On Filecoin Calibration (public test network)

`ComputeService` is deployed at [`0x204D9872448B0404D39C657aAEBffb17767EDdb9`](https://filecoin-testnet.blockscout.com/address/0x204D9872448B0404D39C657aAEBffb17767EDdb9) (see `poc/calibnet.json` for earlier deployments), next to FilOz's own Calibration deployment of Filecoin Pay, PDPVerifier and FWSS.

Two providers run it:

- **@TippyFlits** (`ezpdpz-calib`, registry id 9) — a real Curio node with PDP, running the provider kit.
- **A stand-in on a laptop** — the demo program pretending to be Curio, so the demo works when nobody else is up.

What has actually happened on chain, rather than in a diagram: jobs delivered and paid on both providers (PII redaction and embeddings), jobs deliberately left to expire and refunded, sessions billed to the epoch and stopped on request, a client deleting its own files, and a provider clearing away the files a job read after the client allowed it.

## The jobs

Each runs in a container with the client's files read-only at `/in`, results at `/out`, and **no network**.

| Job | What it does |
|---|---|
| `pii-redact:v1` | finds personal and financial data (Presidio + spaCy) and writes a redacted copy plus a report |
| `embed:v1` | turns documents into vectors so they can be searched by meaning (BAAI/bge-small, CPU) |
| `indexer:v1` | a plain keyword index — the simple one, for checking the plumbing |

And one service sold by the epoch rather than by the job: `workspace:v1`, a container with the data set mounted read-only, for as long as the client keeps it open.

## What the client controls

- **Which files a job reads** — the whole data set, or the ones it picks.
- **What happens to them afterwards**: keep everything (the default), keep only the newest result, or replace the originals — in which case the contract lets the provider remove *exactly* the pieces the client listed, only once each, and only after it has delivered. The client can take that permission back with `revokeRemoval` while it is unused, or mark files never to be removed.
- **Its own files**: a client can delete anything in a data set it pays for, with no provider involved, because Warm Storage accepts the payer's own signature.

## Running it yourself

**The page:** serve `poc/web/` with any static web server (`python3 -m http.server 8099`) and open it with MetaMask on Calibration. No build step; `viem` and `synapse-core` come from a CDN.

**The client kit:** `cd poc/client-kit && ./setup.sh`, then `node console.mjs --config client.config.json`, and open http://localhost:8070. Signs with your browser wallet, or with a key file if you prefer. `piecework` drives the same API from a script.

**The provider kit:** `cd poc/provider-kit && ./setup.sh`, point it at your Curio and the key it uses for PDP, then `node kit.mjs --config kit.config.json`. It watches the chain, runs the jobs, stores the results through your Curio and claims the payment.

**The demo program** (a provider stand-in, for showing it on one machine): `cd poc && node start.mjs --calibnet`, then http://localhost:8080. Needs [Node.js](https://nodejs.org) 20+ and [Docker Desktop](https://www.docker.com/products/docker-desktop/); the local-chain mode also needs [Foundry](https://getfoundry.sh) and the git submodule (`git clone --recurse-submodules`).

## Everything on one machine, with no chain fees

`node start.mjs` (without `--calibnet`) runs a local blockchain with **the real FOC contracts at the versions deployed on Calibration and mainnet** — Filecoin Pay v1.0.0, PDPVerifier, FWSS v1.4.0, the provider registry and session keys — plus `ComputeService` and a provider. The client's files are a real FWSS data set, created with the client's signature, with real piece CIDs. Every button is a real transaction. See [DEMO.md](DEMO.md).

Real there: the FOC contracts unmodified, our contract, the client's EIP-712 signatures, the piece CIDs, the containers, the settlement. Stand-ins: the USDFC token, the FVM precompiles (a stub, so fees are kept rather than burned), one-second blocks instead of thirty, and **no proofs of possession** — the demo provider runs no prover. James's node does prove; the stand-in does not.

## Contents

| Path | What |
|---|---|
| `poc/web/` | The client as a web page: no server, no build step. |
| `poc/client-kit/` | The client's own console, the `piecework` command line, and the API both use. |
| `poc/provider-kit/` | What a storage provider installs next to Curio to sell compute. |
| `poc/jobs/` | The programs themselves (PII redaction, embeddings), as container images. |
| `poc/start.mjs` | The demo program: plays a Curio provider, serves the guided page. |
| `poc/app/index.html` | The guided walk-through page. |
| `poc/data/dataset/` | The sample files in the client's data set. |
| `contracts/src/ComputeService.sol` | The operator contract: sessions (pay for time) and jobs (pay per job). |
| `poc/foc.mjs` | Deploys and drives the real FOC contracts (local), signatures, piece CIDs. |
| `contracts/src/MockPDP.sol` | Earlier stand-in for PDPVerifier, kept for the unit tests. |
| `contracts/test/ComputeService.t.sol` | Tests of ComputeService against the real Filecoin Pay (23 tests). |
| `integration/test/FwssCompute.t.sol` | ComputeService with real PDPVerifier, FWSS, provider registry, session keys (12 tests). |
| `contracts/test/ComputeGuarantees.t.sol` | Tests of the Filecoin Pay behaviour the protocol relies on (17 tests). |
| `contracts/src/IComputeService.sol` | The interface as first proposed. |
| `demo/index.html`, `demo/explore.html` | Simulations without a chain (explainer and detailed version). |
| `contracts/lib/filecoin-pay` | FilOzone/filecoin-pay, pinned at `04ded6a`, used read-only as a dependency. |

## Run the tests

```sh
cd contracts && forge test      # 42 tests: Filecoin Pay mechanics + ComputeService
cd integration && forge test    # 12 tests: ComputeService with the real FOC contracts
```

`integration/` runs ComputeService together with the contracts **deployed on calibnet and mainnet**: FilOzone/filecoin-services @ `4cbbea4` (FWSS v1.4.0), its PDPVerifier and Filecoin Pay v1.0.0 (git submodule `contracts/lib/filecoin-services`). Only the USDFC token and the FVM precompiles (FilOz's `MockFVMTest`) are stand-ins; signatures are real EIP-712 signatures. It checks the **data set authorizer**: the client attaches ComputeService to its FWSS data set (`setDataSetAuthorizer`), and ComputeService then lets the provider add pieces (job outputs) only while a job of that client with that provider is open. The client's own signatures and session keys keep working.

## Status

Running on Filecoin Calibration with FilOz's contracts and two providers, one of them an independent storage provider on his own hardware. Both payment models, the file lifecycle and refunds are exercised end to end. Open: transcoding as a third job, and whether the compute provider may be a different party from the storage provider — which needs read delegation, since today the contract pays only the provider that holds the data set.
