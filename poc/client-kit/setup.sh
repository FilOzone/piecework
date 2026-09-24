#!/bin/sh
# One-command setup for the PieceWork client kit: your own console for buying compute
# from the storage provider that holds your data.
#
#   ./setup.sh                       asks for the key file to use
#   ./setup.sh --key ~/.piecework-client/client.key --start
#
# It checks Node, installs the dependencies, writes client.config.json, and (with --start) opens the console.
# Nothing leaves your machine: the key path is only written into the config.
set -e
cd "$(dirname "$0")"

KEY=""; START=""
while [ $# -gt 0 ]; do
  case "$1" in
    --key) KEY="$2"; shift 2 ;;
    --start) START=1; shift ;;
    -h|--help) sed -n '2,9p' "$0"; exit 0 ;;
    *) echo "unknown option: $1"; exit 1 ;;
  esac
done

say() { printf '\n== %s\n' "$1"; }
fail() { printf '\n!! %s\n' "$1"; exit 1; }

say "Checking what is needed"
command -v node >/dev/null 2>&1 || fail "Node.js is not installed. Install Node 20 or later, then run this again."
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
[ "$NODE_MAJOR" -ge 20 ] || fail "Node.js $NODE_MAJOR is too old; version 20 or later is needed."
command -v npm >/dev/null 2>&1 || fail "npm is not installed (it usually comes with Node.js)."
echo "Node $(node -p 'process.versions.node'), npm $(npm -v) - fine."

say "Installing the kit's dependencies (about a minute)"
npm install --silent --no-audit --no-fund

if [ -z "$KEY" ]; then
  printf '\nPath to a file holding the private key of the wallet you want to pay with.\n'
  printf 'It stays on this machine. On Calibration this should be a test wallet with test tFIL and USDFC.\n'
  printf 'Path [~/.piecework-client/client.key]: '
  read -r KEY
  [ -n "$KEY" ] || KEY="~/.piecework-client/client.key"
fi
KEY_EXPANDED=$(printf '%s' "$KEY" | sed "s|^~|$HOME|")
[ -f "$KEY_EXPANDED" ] || fail "No file at $KEY_EXPANDED. Put the key there (one line, 0x...), then run this again."
chmod 600 "$KEY_EXPANDED" 2>/dev/null || true

say "Writing client.config.json"
node -e '
const fs = require("fs");
const example = JSON.parse(fs.readFileSync("client.config.example.json", "utf8"));
example.clientKeyFile = process.argv[1];
fs.writeFileSync("client.config.json", JSON.stringify(example, null, 2) + "\n");
const { privateKeyToAccount } = require("viem/accounts");
const key = fs.readFileSync(process.argv[1].replace(/^~/, process.env.HOME), "utf8").trim();
console.log("Paying wallet:", privateKeyToAccount(key).address);
' "$KEY"
echo "Config written. Edit client.config.json to change the network, the port, or the ComputeService address."
echo "Edit providers.json to add the provider you want to buy from."

say "Ready"
echo "Start the console with:   node console.mjs --config client.config.json"
echo "Then open http://localhost:8070"
if [ -n "$START" ]; then
  say "Starting"
  exec node console.mjs --config client.config.json
fi
