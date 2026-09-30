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

## Running a program the client brought

The contract has never decided what a job is: it records the image digest and never reads it, and it pays on
delivery — new, live pieces in the client's data set before the deadline. What has always decided is this kit,
which ran only the images in `jobs.json` and refused everything else. That refusal was for want of a policy,
not for want of a mechanism.

The policy lives in your config, and it is off unless you turn it on:

```json
"bringYourOwnJob": {
  "enabled": true,
  "minPrice": "0.5",
  "maxSeconds": 600,
  "cpus": "2",
  "memory": "4g"
}
```

With it on, a job naming a digest you do not recognise is accepted if the client is offering at least
`minPrice`. The client's own reference — where the image can be pulled from — arrives as a `job-spec.json`
piece listed among the job's inputs, so it comes with the files and is pinned by the job. The kit pulls
`<repository>@sha256:<the digest the client put on chain>`, which means a spec naming a hostile repository
cannot substitute different code: the daemon refuses any image whose content does not match the digest.

What the program gets: the client's chosen files read-only at `/in`, an empty `/out`, and nothing else. **No
network**, so it cannot reach the internet, your machine, or anything but those two folders — a program you
have never seen cannot take the client's data anywhere. It runs under `--cpus`, `--memory` and a process
limit, and it is removed by force when `maxSeconds` is up.

Everything the program leaves in `/out` is added to the client's data set and is what the client pays for. A
program that writes nothing delivers nothing, so the client's money returns at the deadline and you are paid
nothing for the time.

**What this does not do.** It does not stop a program from using its whole allowance, and it does not protect
you from a container escape — that is the daemon's job and the kernel's, and if you are uncomfortable running
unknown code at all, leave `enabled` false. It is a real decision, not a checkbox.
