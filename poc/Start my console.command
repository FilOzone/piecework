#!/bin/zsh
# Double-click this file in Finder to open your own client console, signed with the wallet in your browser
# (MetaMask). Close the window to stop it.
cd "$(dirname "$0")/client-kit"
export PATH="$PATH:$HOME/.local/bin:/usr/local/bin:/opt/homebrew/bin"
[ -d node_modules ] || npm install --no-audit --no-fund
[ -f client.config.json ] || node -e '
const fs = require("fs");
const c = JSON.parse(fs.readFileSync("client.config.example.json", "utf8"));
c.signer = "browser"; delete c.comment;
fs.writeFileSync("client.config.json", JSON.stringify(c, null, 2) + "\n");
console.log("Wrote client.config.json (signing with your browser wallet).");
'
PORT=$(node -p 'JSON.parse(require("fs").readFileSync("client.config.json","utf8")).port ?? 8070')
(sleep 2; open "http://localhost:$PORT") &
node console.mjs --config client.config.json
