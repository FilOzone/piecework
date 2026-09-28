# PieceWork client kit

Your own console for buying compute from the storage provider that already holds your data.
It runs on your machine, with your own wallet. Your files go straight from here to the provider you picked.

Everything happens on Filecoin Calibration, with test tokens.

## What you need

- Node.js 20 or later.
- A wallet with test tFIL (for gas) and test USDFC (to pay for jobs), and its private key in a file on this
  machine, one line, starting with `0x`. Put it somewhere only you can read, for example
  `~/.piecework-client/client.key`.
- A provider running Curio with PDP and the PieceWork provider kit. One is listed in `providers.json`;
  add your own if you have one.

## Setting up

```
./setup.sh
```

It installs the dependencies and writes `client.config.json`. Then:

```
node console.mjs --config client.config.json
```

and open <http://localhost:8070>.

## Using it

1. **Choose a provider.** The page shows whether its Curio answers.
2. **Create a data set** with it: either the sample financial documents in `samples/`, or your own files,
   dropped on the page. You sign; the provider's Curio submits it; Filecoin Warm Storage holds a reserve
   for the data set. You can hold several data sets with the same provider.
3. **Add or remove files** at any time. Removing is your signature too: the provider submits it and PDP drops
   the pieces at its next proving period, and you stop paying for them.
4. **Order a job.** The price goes on hold in Filecoin Pay. The provider runs the program next to your files,
   writes the results back into your data set, and is paid only if it does so before the deadline. If it does
   not, you press the refund button and get everything back.
5. Every result can be read back from the provider by clicking its name.

## Driving it from a script, or from an agent

The page has no logic of its own: it calls an HTTP API (`api.mjs`), and so can anything else. `piecework`
is that API on the command line — point it at a running console with `--url` or `PIECEWORK_URL`:

```
piecework status                        who you are, what you have, what is running
piecework files 38216                   the files in a data set
piecework add 38216 report.txt          put a file in (it is uploaded to the provider)
piecework order 38216 embed:v1 --wait   order a job and wait for the result pieces
piecework get 38216 17 -o report.txt    read a result back from the provider
piecework rm 38216 3 4                  remove files (you sign, the provider submits)
piecework session start 38216 workspace:v1    start paying by the epoch
piecework deposit 3                     move USDFC from your wallet into Filecoin Pay
```

`order` takes `--files 3,4,7` to run over part of a data set, `--policy replace-inputs` to let the provider
clear away the files it read, and `--wait` to block until delivery. Every command takes `--json` for feeding
another program, and exits non-zero on failure, so a pipeline behaves the way a shell expects:

```
piecework add 38216 ./new-contracts.txt && piecework order 38216 pii-redact:v1 --wait --policy replace-inputs
```

That is: put files in, have them processed where they are stored, keep only the redacted copies. No browser
anywhere in it.

## What happens to your files after a job

When you order a job you choose one of three:

- **Keep everything** (default): nothing is ever removed.
- **Keep only the newest result**: after delivery the provider may remove the results of earlier jobs.
- **Replace the originals**: after delivery the provider may remove the files this job read. Use it when the
  redacted copies are what you want to keep.

The permission is granted by the contract only when the job has delivered, only for the pieces you listed,
and only once each. Nothing else in your data set can be touched.

## Files here

| File | What it is |
|---|---|
| `console.mjs` | the program: serves the page and talks to the chain |
| `pilot.mjs` | what the page does: data sets, files, jobs, refunds |
| `client.html` | the page |
| `providers.json` | the providers you can buy from |
| `jobs.json` | the jobs you can order, and their prices |
| `client.config.json` | your settings: network, contracts, key file, port |
| `piecework.mjs` | the same API on the command line |
| `api.mjs` | the HTTP interface, shared by the page and the command line |
| `samples/` | synthetic financial documents to try the jobs with (fake people and accounts) |

## Your key

The key is read from the file named in `client.config.json` and never leaves this machine. It signs the same
EIP-712 messages any FOC client signs (create data set, add pieces, remove pieces) and the transactions that
order and cancel jobs. Nothing in this kit ever prints it.
