# TabCrew

[![npm](https://img.shields.io/npm/v/tabcrew)](https://www.npmjs.com/package/tabcrew)
[![CI](https://github.com/huynle/tabcrew/actions/workflows/ci.yml/badge.svg)](https://github.com/huynle/tabcrew/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

TabCrew lets AI agents use your real browser. One local daemon serves many agents at once, and each agent works in its own isolated browser session: its own window and tab group, its own tabs, and no access to anyone else's tabs.

Agents can drive pages step by step (`observe` / `act`) or hand a whole goal to `browse`. `browse` runs the [jev-ultrafast](https://github.com/browser-use/jev-ultrafast) loop (observe the page, choose one operation and target, act, repeat) using Jev through OpenRouter's Decisions API, plus a small text model for the values it types.

TabCrew was previously called ChromeUse. It is not affiliated with or endorsed by Google.

## Install

You need macOS, Node.js 20+, Google Chrome (or Chromium, Brave, Edge) and, for `browse`, an [OpenRouter](https://openrouter.ai) API key.

1. **Install the local daemon:**

   ```sh
   npx tabcrew setup
   ```

2. **Install the extension** from the Chrome Web Store: *listing pending review* (link will appear here).
   Until the store listing is live, install it manually: download `tabcrew-extension-unpacked-<version>.zip` from the [latest release](https://github.com/huynle/tabcrew/releases/latest), unzip it to a permanent folder, open `chrome://extensions`, turn on **Developer mode**, choose **Load unpacked** and select that folder. It pairs automatically.

3. **Check:** the extension pairs with the daemon automatically (no token to copy) and its popup shows **connected**. Run `npx tabcrew doctor` any time.

4. **Add your OpenRouter key** if you skipped it during setup: open the popup, expand **Advanced** and paste it under **OpenRouter API key**. The models can be changed there too.

Your agents (OpenCode, Claude Code, or any MCP client) can now call `session_open` and the other [tools](#tools). Remove everything with `npx tabcrew uninstall --purge`.

TabCrew has no servers and no telemetry; see the [privacy policy](https://github.com/huynle/tabcrew/blob/main/docs/privacy.md) and [Security](#security).

### What setup does

1. Moves an existing `~/.chromeuse` into `~/.tabcrew` (leaving a `~/.chromeuse` symlink) and creates the token (`~/.tabcrew/token`, mode 600).
2. Asks for your OpenRouter key (hidden input), checks it with a free OpenRouter call and stores it in `~/.tabcrew/env` (mode 600). Press Enter to skip and add it later in the extension popup (**Advanced**); until then `browse` reports `model_error`.
3. Copies the self-contained runtime (`daemon.mjs`, `pair-host.mjs`) into `~/.tabcrew/app/`, so nothing depends on the npx cache.
4. Writes `~/Library/LaunchAgents/com.tabcrew.daemon.plist`, removes the old `com.chromeuse.daemon` job if present, starts the service and waits for `/health`.
5. Registers the `com.tabcrew.pair` native messaging host for Chrome (and Chromium, Brave, Edge if installed).
6. Asks before adding TabCrew to OpenCode (`~/.config/opencode/opencode.json[c]`, comments preserved) and Claude Code (`claude mcp add`, user scope).

Options: `--yes` (no questions; the key comes from `$OPENROUTER_API_KEY`), `--no-harness`, `--from-source <repo>` (development).

## CLI

| Command | Does |
| --- | --- |
| `tabcrew setup` | Install or repair everything (idempotent). |
| `tabcrew doctor [--online]` | Check Node, home permissions, token, key (`--online` validates it), launchd job, `/health`, extension connection, pairing host and harness entries. Prints a one-line fix per problem; exits non-zero on failure. |
| `tabcrew token` | Print the token (the only command that does). |
| `tabcrew update` | Reinstall the runtime from the current package and restart the service. |
| `tabcrew uninstall [--purge] [--yes]` | Stop and remove the service, pairing host and runtime. `--purge` also deletes token, env, sessions, config and logs; `--yes` also removes the harness entries. |

The background service is macOS-only for now; on other platforms `setup` stops with "not supported yet" after preparing the home, and `token`/`doctor` still work.

## Architecture

```
agent harnesses (OpenCode, Claude Code, ...)
        │  MCP over streamable HTTP, Authorization: Bearer <token>
        ▼
daemon  (127.0.0.1:8770, launchd: com.tabcrew.daemon, runtime in ~/.tabcrew/app)
        │  sessions, tab ownership, per-tab queues, Jev browse loop
        │  WebSocket 127.0.0.1:8771 (same token)
        ▼
extension offscreen document   (holds the socket)
        │  chrome.runtime port
        ▼
extension service worker       (windows, tab groups, placement, pairing)
        │  chrome.debugger, one attachment per tab
        ▼
tabs
```

The popup's settings requests (`ext_request` / `ext_response`) use the same socket: the extension asks, the daemon answers.

Pairing: when the extension has no token (or the daemon rejects it with 4401), the service worker calls `chrome.runtime.sendNativeMessage("com.tabcrew.pair", {type: "get_token"})`. Chrome starts `~/.tabcrew/app/pair-host` only for extension IDs in the host manifest's `allowed_origins`; the host re-checks the caller, replies `{token}` and exits. While unpaired the popup shows **not paired: run npx tabcrew setup** and pairing is retried every minute. A token can still be entered by hand under the popup's **Advanced** section.

| Path | Contents |
| --- | --- |
| `daemon/` | Node daemon: HTTP MCP endpoint, sessions, scheduler, Jev loop; the `tabcrew` CLI (`src/cli/`) and pairing host (`src/pair/`) |
| `cli/` | The publishable `tabcrew` npm package: esbuild bundles `dist/cli.mjs`, `dist/daemon.mjs`, `dist/pair-host.mjs` |
| `extension/` | MV3 extension: offscreen socket, service worker, CDP snapshot/act, popup, pairing |
| `shared/` | Protocol types and product constants (`@tabcrew/shared/v2`, `@tabcrew/shared/product`) |
| `docs/` | Design records (`plans/`) and the privacy policy (`privacy.md`) |
| `store/` | Chrome Web Store kit: listing, permission justifications, screenshots, submission checklist |
| `scripts/` | Release helpers (`bump-version.mjs`) |

## Development

Requires the same as [Install](#install), plus [just](https://github.com/casey/just) (optional; every recipe is a plain npm command).

```sh
just install                 # npm install && npm run build
just setup-dev               # tabcrew setup --from-source $(pwd): launchd runs daemon/dist/index.js
```

Load the extension: open `chrome://extensions`, enable Developer mode, choose **Load unpacked** and select `extension/dist`. Development builds carry a public `key` in their manifest, so their ID is always `aejgcpbbemekfbmmkabpbgdkgmddfamo` and the pairing host accepts them. `npm run build:store -w extension` writes `extension/dist-store/` and `extension/tabcrew-extension-<version>.zip` without `key` for the Chrome Web Store; once the store assigns an ID, add it to `TABCREW_EXTENSION_IDS.store` in `shared/src/product.ts` and rerun `tabcrew setup` (or `update`) so the host manifest allows it.

`node daemon/dist/index.js` runs the daemon in the foreground; `node daemon/dist/index.js <command>` runs any `tabcrew` command from the checkout.

### Releasing

1. `just bump X.Y.Z` (sets the version in every `package.json` and `extension/manifest.json`), then `just release-check` (typecheck, tests, builds, store package check, `npm pack --dry-run`, audit).
2. Commit, then `git tag vX.Y.Z && git push && git push --tags`.
3. `.github/workflows/release.yml` publishes `tabcrew` to npm with provenance (needs the `NPM_TOKEN` secret; skipped with a warning without it) and creates a GitHub release with `tabcrew-extension-X.Y.Z.zip` attached.
4. Upload that zip to the Chrome Web Store by hand: see [`store/SUBMIT.md`](store/SUBMIT.md). The listing text, permission justifications, icon and screenshots live in [`store/`](store/); `just store-assets` re-renders the images.

## Harness configuration

`tabcrew setup` does this for you. By hand: point any MCP client that supports remote (streamable HTTP) servers at `http://127.0.0.1:8770/mcp` with the bearer token. OpenCode:

```jsonc
{
  "mcp": {
    "servers": {
      "tabcrew": {
        "type": "remote",
        "url": "http://127.0.0.1:8770/mcp",
        "headers": { "Authorization": "Bearer {file:~/.tabcrew/token}" },
        "oauth": false,
        "timeout": { "catalog": 30000, "execution": 600000 }
      }
    }
  }
}
```

Claude Code:

```sh
claude mcp add --transport http --scope user tabcrew http://127.0.0.1:8770/mcp --header "Authorization: Bearer $(npx tabcrew token)"
```

## Tools

Every tool except `session_open` takes the `session` handle; tab tools also take `tab_id`.

| Tool | Purpose |
| --- | --- |
| `session_open` | Open a private session (optional `label` shown on the tab group) and get its handle. |
| `session_close` | Finish the session and hand its tabs to the user; the agent loses control of them. |
| `tab_create` | Open a background tab in the session, optionally at a URL. Returns `tab_id`. |
| `tab_list` | List the session's own tabs. |
| `tab_close` | Close one of the session's tabs. |
| `screenshot` | Capture the visible part of a tab (jpeg or png). |
| `observe` | URL, title, visible text, numbered element table with supported operations, and a fingerprint for `act`. |
| `act` | One operation (`CLICK`, `TYPE_TEXT`, `SELECT`, `SCROLL_UP`, `SCROLL_DOWN`, `WAIT`) against the latest observation; returns `stale_page` if the page changed. |
| `browse` | Let Jev pursue a natural-language goal until DONE, BLOCKED, no progress, `max_steps` or Stop. Returns status, step trace, final page and model usage/cost. |
| `navigate` | Open an http(s) URL, or go back/forward/reload; waits for load (up to 15 s). |
| `read_text` | Full text of the page (not just the visible part), up to `max_length`. |
| `debug_logs` | Recent console messages or network requests of a tab. |

## Agent etiquette

- Call `session_open` once per agent or subagent, and never share the handle.
- Prefer `browse` for multi-step goals and `observe` / `act` for precise control. `browse` returning DONE is a claim, so check the page with `observe`, `read_text` or `screenshot`.
- Close throwaway tabs with `tab_close` when you are done with them.
- Call `session_close` when finished. Remaining tabs move into the user's window as a collapsed `✓ <label>` group for review. Sessions left open are handed over the same way when the agent's connection ends or after the idle timeout.

## Extension popup

- Connection status (`not paired: run npx tabcrew setup` until pairing succeeds). While the daemon is not connected, a box shows the `npx tabcrew setup` command (with a copy button) and a link to these install steps.
- Placement setting: new agent tabs open in **their own window** (default, fastest) or in **my current window**. Agents never switch your current tab.
- Active sessions, each with **Show** (bring its window to the front) and **Stop**, plus **Stop all**.
- **Finished** list of handed-over sessions, with **Close** per session and **Close all finished**.
- **Advanced** (needs a connected daemon):
  - **OpenRouter API key** (for `browse`): status (not set, `Set …abcd`, or set by the environment and read-only), Save and Remove. Saving checks the key with a free OpenRouter call; a rejected key is not saved.
  - **Models**: Jev model and text model; empty means the default.
  - **Text model override** (optional): a separate API key and an OpenAI-compatible base URL (empty means OpenRouter).
  - Manual token entry and the daemon port.

  The popup sends these values over the local socket to the daemon, which stores them (see [Configuration](#configuration)) and uses them from the next `browse` on, without a restart. The extension never stores the keys, and the daemon only ever returns their last 4 characters.

  If the installed service is too old for these settings, the popup says so, shows `npx tabcrew@latest setup` to update it and disables the settings; sessions and the connection controls keep working.

## Configuration

The daemon reads `~/.tabcrew/config.toml` (or `$TABCREW_HOME/config.toml`). Environment variables override it. The old `CHROMEUSE_*` names are still read when the `TABCREW_*` variable is unset (deprecated).

| `config.toml` key | Environment variable | Default |
| --- | --- | --- |
| `mcp_port` | `TABCREW_MCP_PORT` | `8770` |
| `extension_port` | `TABCREW_EXTENSION_PORT` | `8771` |
| `idle_timeout_minutes` (0 disables) | `TABCREW_IDLE_TIMEOUT_MINUTES` | `30` |
| `browse_concurrency` (1–64) | `TABCREW_BROWSE_CONCURRENCY` | `8` |
| `jev_model` | `JEV_MODEL` | `typesafe/jev-1.13` |
| `text_model` | `TEXT_MODEL` | `inception/mercury-2.5` |
| `decision_provider` | `DECISION_PROVIDER` | `chat` if `decision_model` is set, else `jev` |
| `decision_model` | `DECISION_MODEL` | none |
| `allowed_origins` (array) | `TABCREW_ALLOWED_ORIGINS` (comma-separated) | none |

The following settings come from the environment (or `~/.tabcrew/env`) only:

| Variable | Meaning | Default |
| --- | --- | --- |
| `OPENROUTER_API_KEY` | Key for Jev and the text model | required for `browse` |
| `TEXT_MODEL_API_KEY` | Separate key for the text model | OpenRouter key |
| `TEXT_MODEL_BASE_URL` | OpenAI-compatible base URL for the text model | OpenRouter |
| `TEXT_MODEL_REASONING` | Reasoning effort for the text model, or `none` | `none` |
| `TEXT_MODEL_FALLBACK` | Second text model tried once if the first is slow or fails; `none` disables | `google/gemini-2.5-flash-lite` |
| `TEXT_MODEL_TIMEOUT_MS` | Per-attempt budget for the text model (500–60000) | `3000` |
| `DECISION_MODEL_API_KEY` | Separate key for chat decisions | OpenRouter key |
| `DECISION_MODEL_BASE_URL` | OpenAI-compatible base URL for chat decisions | OpenRouter |
| `DECISION_MODEL_REASONING` | Reasoning effort for chat decisions, or `none` | `none` |
| `TABCREW_HOME` | Home directory for token, config, env, logs and runtime | `~/.tabcrew` |
| `TABCREW_LOG` | `debug` for verbose logs, `silent` for none | info |

### Choosing who decides each `browse` step

By default Jev picks every step through OpenRouter's Decisions API. To try a standard chat model instead, set `decision_model` to any chat-completion model, for example in `~/.tabcrew/config.toml`:

```toml
decision_model = "anthropic/claude-haiku-5.5"
# decision_provider = "auto"   # keep Jev, use the chat model only when the Decisions API is unavailable
```

- `jev`: Jev only (the default when `decision_model` is unset).
- `chat`: the chat model decides every step. It sees the same page state, operations and targets Jev does, and replies with JSON (`operation`, `target`, `confidence`, `reason`). A reply naming an operation or target that was not offered stops the run with `model_error`; nothing is guessed.
- `auto`: Jev first. The first time the Decisions API is unreachable, times out or answers 404/408/429/5xx (after retries), the run switches to the chat model for its remaining steps. Other Jev errors, such as a rejected key, still stop the run.

Steps decided by a chat model carry `decider` (the model) and `reason` in the `browse` result; `probability` and `confidence` are then the model's self-reported confidence, not a calibrated distribution. The text helper still fills `TYPE_TEXT` values. Restart the daemon after changing these (`launchctl kickstart -k gui/$(id -u)/com.tabcrew.daemon`); the popup does not edit them yet.

The extension popup (**Advanced**) edits a few of these for you: `OPENROUTER_API_KEY`, `TEXT_MODEL_API_KEY` and `TEXT_MODEL_BASE_URL` in `~/.tabcrew/env`, and `jev_model` / `text_model` in `config.toml` (only those lines change). A value set in the daemon's own environment (for example `JEV_MODEL` in the launchd job or your shell) wins over both files, so the popup shows it as read-only.

## Security

- Both ports bind to `127.0.0.1` only.
- The MCP endpoint requires `Authorization: Bearer <token>`; the extension socket requires the same token. The token lives in `~/.tabcrew/token`, readable only by its owner.
- Requests with an `Origin` header not listed in `allowed_origins` are rejected, so web pages cannot call the daemon; the extension socket only accepts `chrome-extension://` origins. On both ports the `Host` header must be `127.0.0.1`, `localhost` or `[::1]` (DNS rebinding).
- The extension ships no remote code; the page scripts it evaluates through the debugger are fixed constants in its bundle.
- `debug_logs` never stores headers, cookies, bodies or query strings.
- API keys are read from the environment or `~/.tabcrew/env` only; a key in `config.toml` is ignored with a warning. Keys entered in the popup go over the token-authenticated local socket to the daemon, which writes them to `~/.tabcrew/env` (mode 600); the extension does not store them, and the daemon never sends a key back in full (only its last 4 characters).
- The pairing host only answers TabCrew extension IDs (checked by Chrome via `allowed_origins` and again by the host) and never logs the token.
- Agents act in your real, signed-in browser. Only connect agents you trust.

See [`SECURITY.md`](SECURITY.md) for the threat model and how to report vulnerabilities privately, and the [privacy policy](https://github.com/huynle/tabcrew/blob/main/docs/privacy.md) for what data goes where.

## Testing

```sh
just verify          # typecheck + offline tests + build (+ npm audit)
```

Unit tests never open a browser, call a paid API, or touch your real home directory: the CLI tests run setup/doctor/uninstall against a temp HOME with fake `launchctl`, `claude` and `fetch`. The live scripts need the daemon running and the extension connected:

| Recipe | Checks | Cost |
| --- | --- | --- |
| `just smoke` | sessions, tabs, screenshot, navigate, read_text, debug_logs | free |
| `just isolation` | three parallel sessions stay isolated | free |
| `just guards` | freshness and occlusion guards on local fixture pages | free |
| `just concurrency` | latency of concurrent calls across sessions | free |
| `just live` | `browse` on Wikipedia and Google Flights | **paid** (OpenRouter) |

Measured on the development machine: the 3-agent isolation run went from 20.6 s to 1.95 s after moving the socket into the offscreen document; live `browse` takes about 3.6–10 s on Wikipedia and 10–20 s on Google Flights.

## Known limitations

- Scrolling inside inner panels is not supported; `SCROLL_UP` / `SCROLL_DOWN` scroll the page.
- Jev does not yet close popups or overlays that cover its target.
- `tab_create` returns before the page has loaded; use `navigate` or `browse` next.
- Background tabs are slower in "My current window" placement because Chrome throttles tabs you aren't looking at.
- No iframes, shadow DOM, canvas content or file uploads.

## Recovering ChromeUse v1

The previous native-messaging version (gateway, stdio MCP server, native host, v1 extension) was removed. Restore it with:

```sh
git checkout v1-final
```

## License

MIT. See `LICENSE`.
