# PieceWork in the browser

A client for buying compute from the storage provider that holds your data, with nothing running on anyone's
server. Four static files: the page, its logic, the contract interfaces, and a configuration file.

Open it and it asks for your wallet. From there your browser talks directly to two things: a public Filecoin
node, and the Curio of the provider you picked. Your files go from your machine to that provider. Your wallet
signs and pays. Whoever hosts this page never sees any of it.

## Running it

Any static web server will do, because that is all it needs:

```
python3 -m http.server 8099      # then open http://localhost:8099
```

It can equally be served from GitHub Pages, from an S3 bucket, or from Filecoin itself.

## What a visitor needs

- MetaMask (or another injected wallet) on Filecoin Calibration — the page offers to add the network.
- Test tFIL for gas and test USDFC to pay with. The page shows the faucet links when either runs low.
- A provider that is reachable and allows browsers to talk to it. The one in `config.json` does; if you add
  another, its Curio must send `access-control-allow-origin`, or the browser will refuse to call it.

## The files

| File | What it is |
|---|---|
| `index.html` | the page |
| `ui.mjs` | what it draws, and what it remembers in this browser (the provider, the data set, your jobs) |
| `app.mjs` | data sets, files, jobs, money — the chain and the provider, nothing else |
| `config.json` | contracts, providers, the jobs on offer, faucet links |
| `abi.json` | the parts of the contracts this page calls |

`viem` and FilOz's `synapse-core` are loaded from a CDN, so there is no build step and nothing to install.

## What it does not do yet

Pay-for-time sessions, protecting files from removal, and taking a granted permission back. Those exist in
the contract and in the kits; they are not on this page.
