# TabCrew Online mode: hosted multi-tenant relay

Date: 2026-10-23. Status: design agreed, not implemented. Brain decision: `x9gw9rop`.

## Why

TabCrew has two ways to connect, and both are local-only by design:

- **Daemon mode**: a launchd daemon on `127.0.0.1:8770` (MCP over HTTP, bearer token) and `8771` (extension WebSocket). Pairing uses native messaging.
- **Hub mode** (offline): MCP clients start `tabcrew mcp` (stdio), which shares one hub. The extension connects to `127.0.0.1:8775` with Origin + a trust-on-first-use pin. Model calls go through the extension.

The extension always dials `ws://127.0.0.1`, and the daemon rejects any non-loopback `Host`. To control a browser on another machine you need SSH, and every machine needs a local install.

Online mode adds a third option: sign in once in the extension, point any MCP client at `https://tabcrew.huynle.com/mcp`, and drive any of your signed-in browsers from anywhere, with nothing installed but the extension.

## Decisions

- **Audience.** A public multi-tenant service: anyone can sign up.
- **Sign-in.** GitHub and Google OAuth. The relay is the OAuth authorization server for MCP clients (standard MCP authorization: discovery metadata, dynamic client registration, PKCE). The extension signs in with `chrome.identity.launchWebAuthFlow`.
- **Model for `browse`.** Users bring their own key, kept in the extension. The relay reuses hub mode's `model_call` frames, so it never sees the key. No hosted model and no billing.
- **Approach A: the TabCrew core runs on the server.** Sessions, MCP tools and the browse loop run on the relay, isolated per user and browser. Rejected alternatives:
  - **B: a tunnel to a local daemon.** It still needs a local install, and the relay sees plaintext anyway, because standard MCP clients can't do end-to-end encryption.
  - **C: logic in the extension, with a relay that only routes.** MV3 service-worker lifetimes make long browse loops fragile, and it rewrites the most-tested code.
- **Several browsers per user.** Each signed-in browser is named. `session_open` takes an optional `browser`; the default is the most recently active browser that is online.
- **Existing modes.** Daemon mode and hub mode stay as they are.

## Architecture

### New package `relay/`

A Node service built from `shared` and `daemon`, deployed to the huynle.com k3s cluster as `tabcrew.huynle.com`.

- **Auth server.**
  - It handles GitHub and Google login and links identities to one TabCrew user.
  - MCP clients get standard MCP OAuth. The extension gets a token bound to one browser.
- **Endpoints.**
  - `https://tabcrew.huynle.com/mcp`: MCP over streamable HTTP.
  - `wss://tabcrew.huynle.com/ext`: extension sockets.
  - OAuth endpoints and `/.well-known` metadata.
  - A small account page that lists browsers and MCP clients, with revoke buttons.
  - TLS ends at the cluster ingress.
- **Tenant manager.**
  - A tenant is keyed by `(user_id, browser_id)` and owns one `RunningCore`: `SessionRegistry`, `ExtensionBridge`, scheduler, `ObservationCache` and browse runtime.
  - Each user has a directory of their browsers: name, online state, last seen, extension version.
  - Tenants are created on first use and evicted after a period idle.
- **Storage.** Postgres holds users, linked identities, OAuth clients, hashed refresh tokens and registered browsers. Session state stays in memory per tenant, as in the daemon.

### Daemon package changes

- Split `startDaemon`'s core setup into a function that needs no home directory, port or launchd.
- `ExtensionBridge` gains an entry point that attaches an already-authenticated socket, so the relay can authenticate and route sockets itself.
- A new `BridgeAuth` kind, `relay`, joins `token` and `hub`.

### Extension changes

- The connection setting becomes **Auto / Daemon / Hub / Online**.
- The bridge can dial `wss://` to a configurable relay URL (default `tabcrew.huynle.com`).
- The popup gains:
  - **Sign in with GitHub / Google**
  - a browser name
  - the status line "Online · tabcrew.huynle.com · home-mac"
  - **Pause agents**
  - **Sign out**
- The manifest gains the `identity` permission.
- Online mode doesn't use native messaging, so it also works on Chrome where native messaging is blocked.

## Connection and mode selection

1. **Extension sign-in.**
   1. `launchWebAuthFlow` opens the relay's login page.
   2. The relay redirects to `https://<extension-id>.chromiumapp.org/` with a one-time code.
   3. The extension exchanges the code (PKCE) for a refresh token bound to this browser plus a short-lived access token.
   4. The bridge connects to `/ext` with the access token. The relay attaches the socket to the user's tenant and sends the usual welcome, including session handover.
2. **Agent sign-in.** OpenCode/Claude Code get a remote MCP entry with only the URL and OAuth turned on. The client runs the login itself on its first call.
3. **Auto picks the first available of:**
   1. **Daemon**, when a daemon token is saved.
   2. **Online**, when the user is signed in.
   3. **Hub** otherwise.

   Daemon comes first so an existing local setup never starts sending pages to the cloud without the user choosing it. Any mode can still be forced.

## Data flow and tools

1. `/mcp` auth middleware maps the bearer token to a `user_id`. The token is the only input to tenant routing.
2. `session_open { browser? }` picks the named browser, or else the most recently active one that is online. The new session handle is bound to that tenant.
3. Later calls with that handle go to the same tenant. A handle that belongs to another user gets `bad_session`, the same as an unknown handle.
4. The tenant's bridge forwards requests to its browser and returns the replies.
5. `browse` runs on the relay. Each model step is a `model_call` to the extension, which calls the user's provider directly.

Tools: a new `browser_list` (name, online, last seen, extension version) and an optional `browser` on `session_open`. All other tools are unchanged.

Lifetimes:
- **Browser socket drops.** Its sessions wait (45 s, as in hub mode), then fail with `extension_offline`.
- **Tenant idle.** It is evicted, and its tabs are handed back to the user.
- **Relay restart.** Extensions reconnect, and sessions are recovered from the welcome-frame handover.

Limits per user: number of browsers, concurrent sessions and request rate. There are also caps on screenshot and page-text size and on WebSocket frame size.

## Security and privacy

- **Threat.** A compromised relay, or a stolen token, can open any URL in a signed-in browser using the user's cookies. Mitigations:
  - **Opt-in per browser.** Online mode is used only after the user signs in on that browser.
  - **The extension enforces its own rules.** Agents can only touch tabs they created, and Chrome's debugger banner stays visible. **Pause agents** refuses every relay request immediately. Revoking a browser on the account page disconnects it.
- **Tokens.**
  - Access tokens last about 15 minutes and are scoped to MCP or to the extension.
  - Refresh tokens rotate and are stored only as hashes. Reuse revokes the token family.
  - Tokens are bound to their audience, so an extension token can't call `/mcp` and an MCP token can't connect as a browser.
- **Isolation.** Tenant lookup lives in one place and uses only the verified token. Tests probe cross-user handles, session IDs and browser names, and expect the same errors as missing ones.
- **Abuse.** Sign-up only through GitHub/Google, per-user and per-IP rate limits, payload caps, and an admin switch to disable an account.
- **Privacy.**
  - Page snapshots, text and screenshots pass through the relay in plaintext. They are held in memory only, never logged and never stored.
  - `docs/privacy.md`, `store/listing.md` and `store/permissions.md` get an Online-mode section that says so plainly.
- **Store.** The new `identity` permission and the off-device data flow both need justifying in the store submission.

## Failure handling

| Situation | What the user sees |
|---|---|
| Relay unreachable | Popup: **relay offline**, retries with backoff; never silently switches mode |
| Access token expired | Refreshed silently |
| Refresh fails or token revoked | Popup: **Sign in again** |
| Browser offline | Tools return `extension_offline` naming the browser |
| No model provider in the extension | `browse` fails with the hub-mode model-settings error |
| Agents paused | Tools return an error saying the user paused agents in that browser |

## Testing

- **Relay, vitest.**
  - OAuth flows: PKCE, dynamic client registration, refresh rotation and reuse, audience mixups.
  - Tenant routing, the cross-user isolation matrix, limits, and restart recovery.
  - Uses a fake GitHub/Google provider and the fake extension in `daemon/src/testing/helpers.ts`.
- **Extension, vitest.** Online connection, sign-in state, Auto priority, Pause agents, refresh failures.
- **Live.**
  - `TABCREW_TRANSPORT=relay` for `smoke`, `isolation`, `concurrency` and `guards`.
  - A new `just relay-tenants` that uses two accounts and two browsers and proves neither can reach the other.
- **Regression.** Daemon and hub mode unit tests and live checks stay green at every phase.

## Deployment

- The k3s/Flux paved road: an immutable image built in CI, a reviewed infra change, end-to-end release evidence.
- Postgres: use the cluster's existing instance if there is one, otherwise add a small one.
- The GitHub and Google OAuth apps are created by the owner. Their callback URLs:
  - `https://tabcrew.huynle.com/auth/github/callback`
  - `https://tabcrew.huynle.com/auth/google/callback`
- Secrets go through the cluster's existing secret handling.
- **OAuth apps (created 2026-10-23).** Both list the production callback and the local dev relay on `http://127.0.0.1:8790`. Secrets are only in the owner's macOS login keychain (account `tabcrew`), never in the repo.

  | Provider | Where | Client ID | Keychain service |
  |---|---|---|---|
  | GitHub OAuth App "TabCrew" | org `huynle`, app 3958704 | `Ov23liX9R1TeuvVbbVca` | `tabcrew-github-client-secret` |
  | Google web client "TabCrew" | GCP project `tabcrew-online` | `941319505392-v7dnp29e6fisgh9kg0nqtrlcfiqepvic.apps.googleusercontent.com` | `tabcrew-google-client-secret` |

  The Google consent screen is External and in **Testing**: only listed test users can sign in until it is published to production (basic `openid email profile` scopes need no verification).

## Rollout

Each phase is merged and verified before the next.

0. **Spike.**
   - Confirm an MV3 extension can open `wss://` to an outside host with no new `host_permissions`.
   - Confirm `launchWebAuthFlow` works with the fixed dev extension ID.
   - If either fails, revisit this design.
1. **Refactor the core.** Split the core out of `startDaemon` and add the bridge entry point for already-authenticated sockets. No behavior change; all existing tests and live checks pass.
2. **Relay skeleton.** Auth server, one tenant per user, `/mcp` and `/ext`, run locally with Docker.
3. **Extension Online mode.** Sign-in, popup, Auto priority, Pause agents.
4. **Multiple browsers and hardening.** `browser_list`, `session_open { browser }`, limits, the isolation suite, the account page.
5. **Ship.** Deploy to `tabcrew.huynle.com`; privacy, store listing and permissions updates; release 0.6.0; store submission.

## Out of scope

Hosted models and billing, end-to-end encryption, teams or shared browsers, Windows/Linux packaging changes.

## Consequences

- For Online mode only, this revises two earlier decisions: "each machine needs a local daemon" (`mq09yp1m`) and "the MCP endpoint is local-only" (`cm2zfqg2`).
- TabCrew becomes an operated public service with an on-call surface: uptime, abuse handling, security response.
- The privacy story changes from "nothing leaves your machine" to "nothing leaves your machine unless you sign in to Online mode".
