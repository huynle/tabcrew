#!/bin/sh
# Print `export` lines for a local relay, reading OAuth secrets from the macOS login keychain
# (account "tabcrew"). A dev signing key is created on first use. Usage: eval "$(relay/scripts/dev-env.sh)"
set -eu
kc() { security find-generic-password -a tabcrew -s "$1" -w 2>/dev/null || true; }
key=$(kc tabcrew-relay-dev-signing-key)
if [ -z "$key" ]; then
  key=$(openssl rand -hex 32)
  printf 'add-generic-password -U -a tabcrew -s tabcrew-relay-dev-signing-key -w %s\n' "$key" | security -i >/dev/null
fi
cat <<OUT
export RELAY_PUBLIC_URL=http://127.0.0.1:8790
export RELAY_SIGNING_KEY='$key'
export GITHUB_CLIENT_ID=Ov23liX9R1TeuvVbbVca
export GITHUB_CLIENT_SECRET='$(kc tabcrew-github-client-secret)'
export GOOGLE_CLIENT_ID=941319505392-v7dnp29e6fisgh9kg0nqtrlcfiqepvic.apps.googleusercontent.com
export GOOGLE_CLIENT_SECRET='$(kc tabcrew-google-client-secret)'
OUT
