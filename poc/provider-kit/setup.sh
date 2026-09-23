#!/bin/sh
# One-command setup for the PieceWork provider kit, for a storage provider already running Curio with PDP.
#
#   ./setup.sh                                  asks for your Curio URL and key file
#   ./setup.sh --curio https://sp.example --key ~/.piecework-kit/provider.key --start
#
# It checks Node and Docker, installs the kit's dependencies, builds the job image, writes kit.config.json,
# and (with --start) starts the kit. Nothing leaves your machine: the key path is only written into the config.
set -e
cd "$(dirname "$0")"

CURIO=""; KEY=""; START=""
while [ $# -gt 0 ]; do
  case "$1" in
    --curio) CURIO="$2"; shift 2 ;;
    --key) KEY="$2"; shift 2 ;;
    --start) START=1; shift ;;
    -h|--help) sed -n '2,8p' "$0"; exit 0 ;;
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
docker info >/dev/null 2>&1 || fail "Docker is not running. Start Docker, then run this again."
echo "Node $(node -p 'process.versions.node'), npm $(npm -v), Docker $(docker version --format '{{.Server.Version}}' 2>/dev/null) - fine."

say "Installing the kit's dependencies (about a minute)"
npm install --silent --no-audit --no-fund

say "Building the job image (a few minutes the first time)"
docker build -q -t piecework/pii-redact:v1 ../jobs/pii-redact >/dev/null
echo "piecework/pii-redact:v1 ready."

if [ -z "$CURIO" ]; then
  printf '\nYour Curio service URL (the one in your provider registration, e.g. https://calib.example.net): '
  read -r CURIO
fi
CURIO=$(printf '%s' "$CURIO" | sed 's:/*$::')
case "$CURIO" in http://*|https://*) ;; *) fail "That does not look like a URL: $CURIO" ;; esac

if [ -z "$KEY" ]; then
  printf '\nPath to a file holding the private key of your provider address (the one Curio uses for PDP).\n'
  printf 'It stays on this machine; the kit signs with it because the contract only pays the provider\n'
  printf 'that holds the client data set. Path: '
  read -r KEY
fi
KEY_EXPANDED=$(printf '%s' "$KEY" | sed "s|^~|$HOME|")
[ -f "$KEY_EXPANDED" ] || fail "No file at $KEY_EXPANDED. Put the key there (one line, 0x...), then run this again."
chmod 600 "$KEY_EXPANDED" 2>/dev/null || true

say "Checking your Curio answers"
if command -v curl >/dev/null 2>&1; then
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$CURIO/pdp/ping" || echo 000)
  [ "$code" = "200" ] || echo "Warning: $CURIO/pdp/ping answered $code. The kit will keep trying; check the URL if jobs fail."
fi

say "Writing kit.config.json"
node -e '
const fs = require("fs");
const example = JSON.parse(fs.readFileSync("kit.config.example.json", "utf8"));
example.curioUrl = process.argv[1];
example.providerKeyFile = process.argv[2];
fs.writeFileSync("kit.config.json", JSON.stringify(example, null, 2) + "\n");
const { privateKeyToAccount } = require("viem/accounts");
const key = fs.readFileSync(process.argv[2].replace(/^~/, process.env.HOME), "utf8").trim();
console.log("Provider address from your key:", privateKeyToAccount(key).address);
' "$CURIO" "$KEY"
echo "Config written. Edit kit.config.json if you want to change the network or the dashboard port."

say "Ready"
echo "Start the kit with:   node kit.mjs --config kit.config.json"
echo "Then open the dashboard at http://localhost:8090"
if [ -n "$START" ]; then
  say "Starting"
  exec node kit.mjs --config kit.config.json
fi
