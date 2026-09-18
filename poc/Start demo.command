#!/bin/zsh
# Double-click this file in Finder to start the local demo. Close the window to stop it.
cd "$(dirname "$0")"
export PATH="$PATH:$HOME/.foundry/bin:$HOME/.local/bin:/usr/local/bin:/opt/homebrew/bin"
[ -d node_modules ] || npm install
if ! docker info >/dev/null 2>&1; then
  echo "Starting Docker…"; open -a Docker
  until docker info >/dev/null 2>&1; do sleep 2; done
fi
node start.mjs --open
