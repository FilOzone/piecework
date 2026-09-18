# foc-compute

Personal research prototype: **compute on Filecoin Onchain Cloud (FOC)**, paid through Filecoin Pay.

A storage provider that already stores (and proves with PDP) a client's data set also sells compute over it:

- **Sessions — pay for time.** Like renting a machine from a GPU cloud: a rate per epoch (30 s) from when the service is ready until the client stops; payment stops exactly then. A safety margin (`rate × lockupPeriod`) is set aside and only used to pay the provider if the client's funds run out.
- **Batch jobs — pay per job.** The price is escrowed when the job is posted and paid once when the outputs are committed as new PDP pieces; if the deadline passes with no outputs, the client is refunded.

Correctness of results is the client's responsibility, as with commercial GPU clouds.

## Contents

| Path | What |
|---|---|
| `demo/index.html` | Interactive browser simulation of both flows (no chain, no wallet). |
| `contracts/src/IComputeService.sol` | Proposed contract interface (not implemented yet). |
| `contracts/test/ComputeGuarantees.t.sol` | Tests of the Filecoin Pay behaviour the protocol relies on (17 tests). |
| `contracts/lib/filecoin-pay` | FilOzone/filecoin-pay, pinned at `04ded6a`, used read-only as a dependency. |

## Run the tests

Requires [Foundry](https://getfoundry.sh).

```sh
git clone --recurse-submodules <this repo>
cd foc-compute/contracts
forge test
```

## Status

Proposal stage. Next: implement `ComputeService` and run the demo against the real contracts on a local chain.
