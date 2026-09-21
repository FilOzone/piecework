#!/bin/zsh
# Point the stable link https://lucaniz.github.io/foc-compute-poc at the current demo tunnel address.
# Usage: ./update-forward.sh https://<words>.trycloudflare.com
set -e
NEW="$1"
[[ "$NEW" =~ ^https://[a-z0-9-]+\.trycloudflare\.com$ ]] || { echo "usage: $0 https://<words>.trycloudflare.com"; exit 1; }
DIR="$HOME/.foc-compute-poc/forward"
[ -d "$DIR/.git" ] || gh repo clone lucaniz/foc-compute-poc "$DIR" -- -q
cd "$DIR"
git -c credential.helper='!gh auth git-credential' pull -q
OLD=$(grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' index.html | head -1)
[ "$OLD" = "$NEW" ] && { echo "already pointing to $NEW"; exit 0; }
sed -i '' "s|$OLD|$NEW|g" index.html
git commit -qam "Forward to $NEW"
git -c credential.helper='!gh auth git-credential' push -q
echo "stable link now forwards to $NEW (live in about a minute)"
