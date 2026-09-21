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

## Live proof of concept (local)

`poc/` runs everything on one Mac: a local blockchain with **the real FOC contracts at the versions deployed on calibnet and mainnet** (Filecoin Pay v1.0.0, PDPVerifier, FWSS v1.4.0, provider registry, session keys), our `ComputeService`, and a storage provider that runs programs in containers next to the client's files. The client's files are a real FWSS data set (created with the client's signature, pieces with real piece CIDs). Every button on the page is a real transaction.

**Demo script:** [DEMO.md](DEMO.md). **Start:** double-click `poc/Start demo.command` (or `cd poc && npm start`). The page opens at http://localhost:8080. Close the window to stop; each start is a fresh chain.

**Needs:** [Foundry](https://getfoundry.sh), [Node.js](https://nodejs.org) 20+, [Docker Desktop](https://www.docker.com/products/docker-desktop/), and the git submodule (`git clone --recurse-submodules`).

What you can do on the page:

| Flow | What happens on-chain | Guarantee |
|---|---|---|
| Deposit | `approve`, `deposit`, `setOperatorApproval` (ComputeService may open payments within limits), FWSS `setDataSetAuthorizer` (providers may add job results while a job is open) | S3 |
| Start the search assistant | `openSession` (rail with safety margin) → provider starts a container → `sessionReady` (rate starts); provider settles every 5 s | — |
| Ask a question | runs inside the provider's container, over the data set (no chain call) | — |
| Stop | `closeSession`: rate → 0, then terminate; client pays exactly the seconds used | S4 |
| Deposit only 0.03 | funds run out; provider calls `closeSession`, collects the safety margin, never more than deposited | S1, S2 |
| Order a job | `postJob` (price held) → container runs → output added to the client's FWSS data set, signed by the provider and approved by ComputeService as authorizer → `commitOutputs` (pay, then terminate) | J1, J3 |
| Job with a late provider | deadline passes → `expire` → price returned | J2 |

What is real and what is a stand-in:

| Real | Stand-in (local only) |
|---|---|
| FilecoinPayV1 v1.0.0, PDPVerifier, FWSS v1.4.0, ServiceProviderRegistry, SessionKeyRegistry (filecoin-services @ `4cbbea4`), unmodified | USDFC: a test token, `luca_usdfc` |
| `ComputeService` (this repo), including the FWSS data set authorizer | **Proofs of possession are not run**: the provider is assumed honest ("PDP proof ✓" on the page is simulated) |
| Client signatures (EIP-712, FilOz's definitions), piece CIDs (CommPv2, FilOz's library) | FVM precompiles: a stub reporting success, so FIL fees are kept instead of burned |
| Containers (Docker, no network, read-only inputs); transactions, settlement, fees | Time: 1 block = 1 epoch = 1 s (30 s on Filecoin) |

## On Filecoin Calibration (public test network)

ComputeService is deployed on calibnet at [`0x04347c64F010f256f529aC94BC8Fe7A81abDf45A`](https://calibration.filfox.info/en/address/0x04347c64F010f256f529aC94BC8Fe7A81abDf45A) (redeployed 2026-09-21 with data set ownership checks; first version at `0xb16534a9…27b5F1`) (see `poc/calibnet.json`), next to FilOz's own calibnet deployment of Filecoin Pay, PDPVerifier and FWSS. The demo provider is registered in FilOz's provider registry as **PieceWork_demo** (id 41).

**Start:** `cd poc && node start.mjs --calibnet`, then open http://localhost:8080. The page offers two ways to play the client:

- **Demo wallet (no MetaMask):** the program signs as the client with a test wallet; visitors just click.
- **MetaMask:** you sign every step with your own account on Filecoin Calibration (needs test tFIL and USDFC from the faucets).

Every step is a real calibnet transaction, linked to Filfox. One epoch is 30 s, so each step takes 30–60 s. Checked end to end on 2026-09-18: data set #37109 created with the client's signature, a job whose output was added to it through the authorizer and paid (J1), a session stopped after 3 epochs and billed exactly 3 epochs (S4).

One-time setup (already done for this repo's deployment): `--new-provider-key`, `--new-demo-client-key` (keys stay in `~/.foc-compute-poc/calibnet/`, owner-readable only, never printed), fund both addresses from the calibnet faucets, then `--register` and `--deploy`.

## Contents

| Path | What |
|---|---|
| `poc/start.mjs` | Starts the chain, installs the contracts, plays the storage provider, serves the page. |
| `poc/app/index.html` | The live page. |
| `poc/data/dataset/` | The sample files in the client's data set. |
| `contracts/src/ComputeService.sol` | The operator contract: sessions (pay for time) and jobs (pay per job). |
| `poc/foc.mjs` | Deploys and drives the real FOC contracts (local), signatures, piece CIDs. |
| `contracts/src/MockPDP.sol` | Earlier stand-in for PDPVerifier, kept for the unit tests. |
| `contracts/test/ComputeService.t.sol` | Tests of ComputeService against the real Filecoin Pay (16 tests). |
| `integration/test/FwssCompute.t.sol` | ComputeService with real PDPVerifier, FWSS, provider registry, session keys (10 tests). |
| `contracts/test/ComputeGuarantees.t.sol` | Tests of the Filecoin Pay behaviour the protocol relies on (17 tests). |
| `contracts/src/IComputeService.sol` | The interface as first proposed. |
| `demo/index.html`, `demo/explore.html` | Simulations without a chain (explainer and detailed version). |
| `contracts/lib/filecoin-pay` | FilOzone/filecoin-pay, pinned at `04ded6a`, used read-only as a dependency. |

## Run the tests

```sh
cd contracts && forge test      # 33 tests: Filecoin Pay mechanics + ComputeService
cd integration && forge test    # 10 tests: ComputeService with the real FOC contracts
```

`integration/` runs ComputeService together with the contracts **deployed on calibnet and mainnet**: FilOzone/filecoin-services @ `4cbbea4` (FWSS v1.4.0), its PDPVerifier and Filecoin Pay v1.0.0 (git submodule `contracts/lib/filecoin-services`). Only the USDFC token and the FVM precompiles (FilOz's `MockFVMTest`) are stand-ins; signatures are real EIP-712 signatures. It checks the **data set authorizer**: the client attaches ComputeService to its FWSS data set (`setDataSetAuthorizer`), and ComputeService then lets the provider add pieces (job outputs) only while a job of that client with that provider is open. The client's own signatures and session keys keep working.

## Status

Stage A (local POC) working. Stage B: running on Filecoin Calibration with FilOz's contracts, a registered demo provider and our deployed ComputeService; client via MetaMask or a demo wallet. Proofs of possession are simulated (honest-provider assumption).
