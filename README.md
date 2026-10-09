# PieceWork — compute on Filecoin Onchain Cloud

The storage provider that already holds your data, and proves it with PDP, also sells you compute over it.
You pay through Filecoin Pay, and the provider is paid only when it delivers.

Nothing you store has to move. The program goes to the data.

**Try it:** [lucaniz.github.io/foc-compute-poc/client](https://lucaniz.github.io/foc-compute-poc/client/) — a page
with no server behind it. Your wallet signs; your browser talks to the provider and to the chain. You need
MetaMask on Filecoin Calibration and some test tokens; the faucet links appear once you connect.

A research prototype, on a test network, unaudited. It is used: a colleague's image-remix app runs on this
contract, paid per generation, on a storage provider's spare GPU.

## Two ways to buy

**Per job.** You name a price and a deadline. The provider runs the program next to your files and writes the
results back into your data set as new pieces. It is paid only if they arrive before the deadline; otherwise
you take the money back. Delivery is the payment condition, and the chain can check it: new, live pieces in
your data set, before the deadline.

**Per epoch.** You pay for a service to keep running — a rate per 30-second epoch, from the moment the
provider says it is ready until you close it. Closing it stops the charge at that epoch, not at the end of
some notice period.

The second one is the interesting half, because it changes what you are buying. You stop ordering work and
start buying a property of your data set that stays true:

| Service | What it keeps true |
|---|---|
| **Keep it searchable** | every document you add is turned into vectors, so search by meaning never goes stale |
| **Keep it clean** | nothing is stored without a redacted copy beside it |
| **Keep it answering** | drop in a file whose name starts with `ask`, and the answer comes back as a file |

You add a document and the results appear. There is no second transaction and nothing to remember.

## Bring your own program

Nothing about the jobs is fixed by the protocol. The contract takes the program's identity as an opaque
`bytes32`, never inspects it, and conditions payment purely on delivery. What has been fixed is each
provider's own catalogue — which is now a policy a provider opts into rather than a limit of the design.

A client names its program by content address and the provider runs exactly that code, with **no network**,
the client's files read-only, and a ceiling on time, cores and memory. Two ways to hand it over:

- **From a registry** — `ghcr.io/you/thing@sha256:…`, which the provider pulls.
- **As a piece** — `docker save` writes the program to a file, the file goes into your own data set like any
  other, and travels with the job. **No registry, no account, nothing public.** The provider loads it and
  checks it is the image the chain pinned before running it.

The second removes the last thing that had to live outside Filecoin.

## What a provider offers

Each job runs in a container with your files read-only at `/in`, results at `/out`, and no network.

| Job | What it does |
|---|---|
| `pii-redact:v1` | finds personal and financial data (Presidio + spaCy) and writes a redacted copy plus a report |
| `embed:v1` | turns documents into vectors, so they can be searched by meaning |
| `query:v1` | runs your SQL over the csv/parquet/json already in your data set — gigabytes in, rows out |
| `transcode:v1` | re-encodes your video where it is stored, and returns something much smaller |
| `transcribe:v1` | turns speech in audio and video into text, with the time stamped on every paragraph — so embed and search answer with the moment it was said, not just the file |
| `indexer:v1` | a plain keyword index — the simple one, for checking the plumbing |

Two of these have a GPU twin — `embed-gpu:v1` and `transcribe-gpu:v1` — the same code against a card instead
of a processor. `poc/jobs/transcribe/bench.sh` times the same recording three ways so the hardware and the
model can be told apart, and a storage provider has now run it on his own machines, over 94.7 minutes of audio:

| | | |
|---|---|---|
| `small`, 2× EPYC 7282 (64 threads) | 10.7 min | 9× real time |
| `small`, RTX A4000 | 4.4 min | 22× real time |
| `large-v3-turbo`, RTX A4000 | 6.3 min | 15× real time |

The card is worth about 2.4× on the same model; the better model gives about 1.4× of that back. That is a good
deal less than the twenty-to-forty times this file used to claim, which compared a card against a laptop. What
the card actually buys is throughput on hardware that is otherwise idle — around 360 hours of audio a day on
turbo — and whether that beats what the same card earns elsewhere is a question about price, which no
benchmark answers.

A provider adds a job by putting an image in its catalogue. Nobody's permission is required, and nothing on
chain changes.

## What the client controls

- **Which files a job reads** — the whole data set, or the ones it picks.
- **What happens to them afterwards**: keep everything (the default), keep only the newest result, or replace
  the originals — in which case the contract lets the provider remove *exactly* the pieces the client listed,
  once each, and only after delivering. The client can take that permission back with `revokeRemoval` while it
  is unused.
- **Its own files**: a client can delete anything in a data set it pays for, with no provider involved,
  because Warm Storage accepts the payer's own signature.

## What the contract guarantees

S for sessions, J for jobs; each line is a test.

| | |
|---|---|
| **S1** | If the client's money runs out mid-session, the provider is still paid for the time served, plus at most the safety margin (`rate × lockupPeriod`). |
| **S2** | The client never pays more than that margin beyond the service it received. |
| **S3** | Only the operator the client approved (ComputeService) can charge it, within the limits it set. |
| **S4** | Stop means stop: the client pays exactly the epochs used, and the margin is released. |
| **J1** | Deliver before the deadline and the provider is paid the price. |
| **J2** | Deliver nothing and the client gets the full price back. |
| **J3** | The provider is paid at most once, and never more than the price held. |

**What it does not guarantee: correctness.** The chain shows that something new arrived in your data set
before the deadline. It does not show that the program ran, or ran honestly. For a redaction you can read the
output; for a SQL query you can re-run it; for an embedding you cannot. Proving the computation itself is a
different problem, and a real one.

## On Filecoin Calibration

`ComputeService` is deployed at
[`0x432248a2e0338cf61cb52dfed314b28b4b15074d`](https://filecoin-testnet.blockscout.com/address/0x432248a2e0338cf61cb52dfed314b28b4b15074d),
beside FilOz's own Calibration deployment of Filecoin Pay, PDPVerifier and Warm Storage. Earlier deployments
are listed in `poc/calibnet.json`.

Providers running it:

- **@TippyFlits** — `ezpdpz-calib` (registry id 9) and `ezpdpz-calib2` (registry id 2), real Curio nodes with
  PDP, in the UK. The second one runs image generation on an RTX A4000 for someone else's application.
- **A stand-in on a laptop**, so the whole thing can be shown and new jobs can be tried without conscripting
  anyone's hardware.

What has actually happened on chain, rather than in a diagram: jobs delivered and paid on both providers;
jobs left to expire and refunded; sessions billed to the epoch and stopped on request; a client deleting its
own files; a provider clearing away the files a job read, after the client allowed it; and a client's own
program, which no provider offers, run and paid for.

## Running it yourself

**The page.** Serve `poc/web/` with any static server (`python3 -m http.server 8099`) and open it with
MetaMask on Calibration. No build step; `viem` and `synapse-core` come from a CDN.

**The provider kit.** `cd poc/provider-kit && ./setup.sh`, point it at your Curio and the key it already uses
for PDP, then `node kit.mjs --config kit.config.json`. It watches the chain, runs the jobs, stores results
through your own Curio and claims the payment. Bring-your-own is off until you turn it on.

**The client kit.** `cd poc/client-kit && ./setup.sh`, then `node console.mjs --config client.config.json`.
A local console, and `piecework` on the command line driving the same API the page uses.

**Everything on one machine, with no chain fees.** `cd poc && node start.mjs` runs a local chain with the real
FOC contracts at the versions deployed on Calibration and mainnet, plus ComputeService and a provider. Every
button is a real transaction. See [DEMO.md](DEMO.md). Needs Node 20+, Docker, and for the local-chain mode
[Foundry](https://getfoundry.sh) and the submodule (`git clone --recurse-submodules`).

## The tests

```sh
cd contracts && forge test      # 44 tests: Filecoin Pay mechanics, and ComputeService against it
cd integration && forge test    # 12 tests: ComputeService with the real FOC contracts
```

`integration/` runs ComputeService together with the contracts deployed on Calibration and mainnet —
filecoin-services @ `4cbbea4` (Warm Storage v1.4.0), its PDPVerifier, and Filecoin Pay v1.0.0. Only the USDFC
token and the FVM precompiles are stand-ins; the signatures are real EIP-712 signatures. It tests the thing
the whole design rests on: a client attaches ComputeService to its data set, and ComputeService then lets a
provider add pieces only while that client has an open job or a running session with it — and not a block
longer.

## Where it is

Both payment models, the file lifecycle, refunds, and a client's own program are exercised end to end on
Calibration, with an independent storage provider on his own hardware.

Open questions, in the order they matter:

- **Correctness, not just delivery.** See above. The honest limit of the design.
- **What a provider's spare GPU is worth.** Sealing cards sit idle once a provider stops sealing, but they are
  not free — many are already earning on other networks. The price that would bring that capacity back is
  unknown, and only a provider can answer it.
- **Catalogue jobs are pinned by name, not by code.** A client ordering `pii-redact:v1` is trusting the
  provider's label; bring-your-own already pins the real digest, and the catalogue should too.
- **Compute provider ≠ storage provider.** Today the contract pays only the provider holding the data set.
  Separating them needs read delegation.
