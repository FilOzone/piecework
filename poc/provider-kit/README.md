# PieceWork provider kit

This lets a storage provider that runs Curio with PDP sell compute over the data sets it already stores. Clients order a job on-chain through the ComputeService contract. The kit runs the job in a container next to the data, stores the results in the client's data set through Curio, and gets paid through Filecoin Pay.

It runs next to Curio and needs no change to Curio. It uses the same Curio HTTP API as every FOC client (through FilOz's Synapse library):
- `GET /piece/<cid>` to read the client's files;
- `POST /pdp/piece` and `PUT /pdp/piece/upload/<id>` to upload a result;
- `POST /pdp/data-sets/<id>/pieces` to add it to the client's data set.

## What you need

- Curio with PDP enabled on Calibration, registered as a PDP provider (the Filecoin docs' "Install & Run PDP" guide), with its public HTTPS URL.
- The private key of the address you registered with, in a file readable only by you. The contract only pays, and only accepts results from, the provider that holds the client's data set. The key stays on your machine.
- A little tFIL on that address for gas: a few transactions per job.
- Docker, and Node.js 20 or later.

## Set up

One command, which checks Node and Docker, installs the dependencies, builds the job image and writes the config:

```bash
cd poc/provider-kit
./setup.sh
```

It asks two things: your Curio service URL, and the path to a file holding your provider key. Add `--start` to start the kit straight away, or pass both answers on the command line:

```bash
./setup.sh --curio https://calib.example.net --key ~/.piecework-kit/provider.key --start
```

By hand, if you prefer: `npm install`, `docker build -t piecework/pii-redact:v1 ../jobs/pii-redact`, then copy `kit.config.example.json` to `kit.config.json` and set `curioUrl` and `providerKeyFile` in it.

## Run

```bash
node kit.mjs --config kit.config.json
```

On start it checks that Curio answers, shows your gas balance, and checks the job images are present. Then it waits for jobs. Each job prints what it does: fetching inputs, running the program, storing results, getting paid.

While it runs, open the dashboard at http://localhost:8090. It shows whether Curio answers, your gas balance, the job types ready on this machine, every job with its stage, run time, price and transactions, what you have earned, and the log. It listens only on this machine unless you set `dashboardHost` in the config.

## Job types

`jobs.json` lists the programs the kit runs. Each one is a container that reads `/in` and writes `/out`, and runs with `--network none`.
- `pii-redact:v1` finds and redacts personal and account data in financial documents (Microsoft Presidio, CPU). Outputs `pii-report.txt` and `redacted-documents.txt`.
- `indexer:v1` is a small search index, for testing.

## Testing with a client

`test-client.mjs` plays the client against one provider:
1. it creates a data set with the provider and stores the sample documents through Curio;
2. it makes ComputeService the data set's authorizer;
3. it orders the PII job and waits until it is delivered and paid.

It needs a client key with USDFC deposited in Filecoin Pay, and approvals for Warm Storage and ComputeService.

## Limits of this version

- Jobs only. Pay-for-time sessions still run from the demo program.
- Input files are named `piece-<id>.txt`; the original file names are not passed yet.
- Storage proofs are Curio's job and work as usual. The kit only adds results.
