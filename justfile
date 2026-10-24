set shell := ["sh", "-uc"]

# Show available recipes.
default:
    @just --list

# Install dependencies and build every package.
install:
    npm install
    npm run build

# Build shared, daemon, cli (bundles) and the extension dev build (in that order).
build:
    npm run build

# Typecheck every package.
typecheck:
    npm run typecheck

# Run the offline unit tests of every package (no browser, no paid API).
test:
    npm test

# Remove build outputs.
clean:
    npm run clean

# Full local check: typecheck, test, build, then a dependency audit.
verify: typecheck test build
    npm audit --audit-level=moderate

# Build and check the Chrome Web Store package (extension/dist-store + zip: no "key", no maps, no eval).
build-store:
    npm run build:store

# Everything CI and the release workflow check, without publishing anything.
release-check: typecheck test build
    npm run build:store
    npm pack --dry-run -w tabcrew
    for f in daemon/scripts/*.mjs cli/build.mjs extension/scripts/*.mjs store/scripts/*.mjs scripts/*.mjs; do node --check "$f"; done
    npm audit --audit-level=moderate

# Release steps:
#   1. just bump X.Y.Z && just release-check
#   2. git commit -am "chore: release X.Y.Z"
#   3. git tag vX.Y.Z && git push && git push --tags
#   4. .github/workflows/release.yml publishes `tabcrew` to npm and creates the GitHub release
#      with the store zip; upload that zip to the Chrome Web Store by hand (store/SUBMIT.md).

# Set one version in every package.json and the extension manifest, e.g. `just bump 0.5.0`.
bump version:
    node scripts/bump-version.mjs {{version}}

# Re-render the extension icons and the Chrome Web Store screenshots (headless Chrome, temp profile).
store-assets:
    node extension/scripts/render-icons.mjs
    node store/scripts/render-screenshots.mjs

# Development install: run the service from this checkout (launchd, pairing host, harnesses).
setup-dev:
    node daemon/dist/index.js setup --from-source "$(pwd)"

# Check the local installation.
doctor:
    node daemon/dist/index.js doctor

# Print the daemon's auth token (only needed for manual setups; pairing is automatic).
token:
    node daemon/dist/index.js token

# Show what `npm publish -w tabcrew` would ship.
pack:
    npm pack --dry-run -w tabcrew

# Live check against the running daemon and extension: basic tools.
smoke:
    node daemon/scripts/smoke.mjs

# Live check: three sessions in parallel stay isolated.
isolation:
    node daemon/scripts/isolation.mjs

# Live check: freshness and occlusion guards on local fixture pages.
guards:
    node daemon/scripts/guards.mjs

# Page-script check in a throwaway headless Chrome (no daemon, no extension): scroll areas,
# modals, clip-aware elements and scroll-into-view on extension/test-fixtures/modal.html.
page-check:
    cd extension && npx tsx scripts/page-check.ts

# Live check: concurrent calls across sessions and tabs.
concurrency:
    node daemon/scripts/concurrency.mjs

# Paid live check: Jev browse on real sites (uses OpenRouter credits).
live:
    node daemon/scripts/live-browse.mjs

# Hub mode (locked-down Chrome): the same live checks through `tabcrew mcp` (starts the hub if needed).
# Needs `just build` and the extension connected in hub mode; no daemon, token or ~/.tabcrew.

# Hub mode live check: basic tools over the stdio shim.
hub-smoke:
    TABCREW_TRANSPORT=shim node daemon/scripts/smoke.mjs

# Hub mode live check: three agents, one shim each, stay isolated.
hub-isolation:
    TABCREW_TRANSPORT=shim node daemon/scripts/isolation.mjs

# Hub mode live check: concurrent calls from three shims.
hub-concurrency:
    TABCREW_TRANSPORT=shim node daemon/scripts/concurrency.mjs

# Paid (cents) hub mode check: one browse on Wikipedia with the popup's model provider (any OpenAI-compatible provider).
live-hub-model:
    TABCREW_TRANSPORT=shim node daemon/scripts/live-hub-model.mjs

# Online mode phase 0 spike (throwaway headless Chromium, simulated relay + one public wss echo):
# extension wss to an outside host without host_permissions, and launchWebAuthFlow with the dev ID.
spike-online:
    node spikes/online-relay/run.mjs

# Online relay, local: in-memory store on 127.0.0.1:8790 with the real OAuth apps (secrets from the keychain).
relay-dev: build
    eval "$(relay/scripts/dev-env.sh)" && RELAY_STORE=memory RELAY_HOST=127.0.0.1 node relay/dist/main.js

# Online relay, local: Docker Compose with Postgres (same OAuth apps).
relay-up:
    eval "$(relay/scripts/dev-env.sh)" && docker compose -f relay/docker-compose.yml up --build

# Relay store tests against real Postgres (TEST_DATABASE_URL), e.g. from `just relay-up`'s database.
relay-test-pg url:
    cd relay && TEST_DATABASE_URL={{url}} npx vitest run src/store.test.ts
