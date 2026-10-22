# TabCrew

[![npm](https://img.shields.io/npm/v/tabcrew)](https://www.npmjs.com/package/tabcrew)
[![CI](https://github.com/huynle/tabcrew/actions/workflows/ci.yml/badge.svg)](https://github.com/huynle/tabcrew/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

TabCrew lets AI agents use your real browser. One local daemon serves many agents at once, and each agent works in its own isolated browser session: its own window and tab group, its own tabs, and no access to anyone else's tabs.

Agents can drive pages step by step (`observe` / `act`) or hand a whole goal to `browse`. `browse` runs the [jev-ultrafast](https://github.com/browser-use/jev-ultrafast) loop (observe the page, choose one operation and target, act, repeat) using Jev through OpenRouter's Decisions API, plus a small text model for the values it types.

TabCrew was previously called ChromeUse. It is not affiliated with or endorsed by Google.

## Install

You need macOS, Node.js 20+, Google Chrome (or Chromium, Brave, Edge) and, for `browse`, an [OpenRouter](https://openrouter.ai) API key.

Is your Chrome managed by your company, with native messaging blocked? Or do you not want a background service? Use [hub mode](#locked-down--corporate-chrome-hub-mode) instead: OpenCode starts TabCrew itself, and all settings live in the extension popup.

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

## Locked-down / corporate Chrome (hub mode)

Use hub mode when `npx tabcrew setup` doesn't fit your machine. For example, Chrome policy blocks native messaging (`NativeMessagingBlocklist: ["*"]`, so the extension can't pair), or you don't want a launchd service or anything in `~/.tabcrew`. It works like ChromeUse: your MCP client (OpenCode) starts `tabcrew mcp` itself, and you configure everything in the extension popup, including the model provider for `browse`.

```
OpenCode ──stdio──▶ tabcrew mcp ──Unix socket──▶ TabCrew hub ──WebSocket 127.0.0.1:8775──▶ extension ──▶ tabs
(one shim per OpenCode)            (shared, started by the first shim)        (Origin + pin)          └─▶ your model provider (HTTPS)
```

- **The `tabcrew mcp` shim.** Each MCP client runs its own copy. The shim connects to the shared hub, or starts it in the background if none is running, and relays MCP between the client and the hub.
- **The hub.** This is the daemon code running in a different launch mode: no launchd, no token and no HTTP port. It survives the OpenCode instance that started it, and exits 10 minutes after its last client disconnects.
- **The extension.** It makes every model call itself, with the provider, key and models from the popup. The hub never sees your key.
- **What stays the same.** Sessions, tools, isolation and the popup's session controls work as in daemon mode. When an OpenCode instance exits, the sessions it opened are handed over to you.

### Set it up

1. **Build TabCrew** (Node.js 20+):

   ```sh
   git clone https://github.com/huynle/tabcrew && cd tabcrew
   npm install && npm run build      # writes cli/dist/ and extension/dist/
   ```

2. **Load the extension.** Open `chrome://extensions`, turn on **Developer mode**, choose **Load unpacked** and select `extension/dist`. The release's `tabcrew-extension-unpacked-<version>.zip` also works. The hub only accepts the extension IDs it knows, and this build always has the fixed ID `aejgcpbbemekfbmmkabpbgdkgmddfamo`.

3. **Add TabCrew to OpenCode** as a local (stdio) server, using the absolute path of your checkout (`~/.config/opencode/opencode.json[c]`):

   ```jsonc
   {
     "mcp": {
       "servers": {
         "tabcrew": {
           "type": "local",
           "command": ["node", "/absolute/path/to/tabcrew/cli/dist/cli.mjs", "mcp"],
           "timeout": { "catalog": 30000, "execution": 600000 }
         }
       }
     }
   }
   ```

   Other stdio MCP clients work the same way, for example Claude Code: `claude mcp add --scope user tabcrew -- node /absolute/path/to/tabcrew/cli/dist/cli.mjs mcp`.

4. **Start OpenCode.** Until a hub is running, the popup shows **hub not running** with the hint "Start OpenCode — TabCrew starts with it." Once the hub runs, the extension connects within a few seconds and the badge turns **connected**. The first connection pairs automatically (trust on first use; see below).

5. **Set a model provider for `browse`.** In the popup, open **Advanced → Model provider**:
   - **Provider**: Provider A (`https://llm.example.com/v1`), Provider B (`https://llm2.example.com/v1`), OpenRouter (`https://openrouter.ai/api/v1`), or Custom. Custom takes any OpenAI-compatible base URL: `https://`, or `http://` only for `localhost`/`127.0.0.1`.
   - **API key**: write-only. After saving, the popup only shows `Set …abcd`. A saved key is kept only while the base URL stays on the same origin.
   - **Headers** (optional): extra request headers, for example `OpenAI-Organization`. Up to 20; `Authorization`, `Host`, `Cookie`, `Content-Length`, `Content-Type` and `Origin` are not allowed.
   - **Decision model** (picks every `browse` step), **Text model** (fills `TYPE_TEXT` values) and an optional **Fallback text model**. After **Test** they suggest the provider's models; you can also type any name.
   - **Test**: calls `GET {base}/models` and sends a tiny JSON chat request with the decision model.
   - **Save**: stores the settings in the extension. Chrome then asks to allow access to the provider's site. Allow it, or `browse` can't reach the provider. **Remove** deletes the settings and the key.

   Without a provider, the other tools still work and `browse` returns `model_error` ("set a model provider in the TabCrew popup").

6. **Choose the connection, if needed.** **Advanced → Connection** has three modes. **Auto** (the default) uses hub mode unless this browser profile has a daemon token saved from an earlier `npx tabcrew setup`. **Hub** and **Daemon** force a mode. In hub mode the port field is labeled **Hub port** (default 8775).

The live checks for hub mode are `just hub-smoke`, `hub-isolation`, `hub-concurrency` and `live-provider` (see [Testing](#testing)).

### Trust on first use

The hub has no token. To keep a web page or another program from posing as either side, the hub and the extension pair once and remember each other:

- **First connection.** The extension creates a random secret and sends it to the hub, which stores it as its pin.
- **Later connections.** Both sides prove they hold the secret (a mutual HMAC challenge) before any real data is exchanged.
- **A hub that can't prove it.** The extension disconnects and shows **untrusted hub**. That hub might be a different program on the port, or a hub whose pin was reset.
- **When to trust again.** If you reset or reinstalled TabCrew yourself, click **Trust this hub** in the popup. If the hub already trusts another browser profile (or a reinstalled extension), first clear its pin, then click **Trust this hub**:

  ```sh
  node /absolute/path/to/tabcrew/cli/dist/cli.mjs mcp reset-pin
  ```

  The running hub picks this up without a restart. Only trust a hub you started yourself.

### Port, lifetime and options

The flags go after `mcp` in the OpenCode `command`, for example `["node", ".../cli.mjs", "mcp", "--port", "8776", "--idle-minutes", "30"]`. They only apply when that shim starts the hub; a running hub keeps its settings, and the shim prints a warning on stderr if your `--port` differs from it.

| Flag | Default | Meaning |
| --- | --- | --- |
| `--port N` | `8775` | Extension WebSocket port on `127.0.0.1`. If you change it, set the same **Hub port** in the popup. (The default is 8775, not the daemon's 8771, because another local tool may already be listening there.) |
| `--idle-minutes N` | `10` | The hub exits N minutes after its last MCP client disconnects, or N minutes after starting if no client ever connects. `0` means never. |

The next `tabcrew mcp` starts a new hub. A shim whose hub dies exits with code 1, and OpenCode shows the TabCrew server as failed: restart it (or OpenCode). Sessions that sit idle for 30 minutes are handed over to you.

### Where hub mode keeps its files

Hub mode never uses `~/.tabcrew` and installs no launchd job or native messaging host.

| What | Where |
| --- | --- |
| Runtime dir (0700): `hub.sock` (MCP socket, 0600), `hub.json` (pid, version, port, start time), `hub.log`, `hub.error` (why the last start failed), `spawn.lock`, `sessions.json` | macOS: the per-user temp dir, `"$(getconf DARWIN_USER_TEMP_DIR)tabcrew-$(id -u)"` (e.g. `/var/folders/…/T/tabcrew-501`). Linux: `$XDG_RUNTIME_DIR/tabcrew`, else `/run/user/<uid>/tabcrew`, else `/tmp/tabcrew-<uid>`. Override: `TABCREW_HUB_RUNTIME_DIR` |
| Hub pin `hub-pin` (0600) | macOS: `~/Library/Application Support/TabCrew/`. Linux: `$XDG_STATE_HOME/tabcrew/` (default `~/.local/state/tabcrew/`). Override: `TABCREW_HUB_STATE_DIR` |
| Provider settings and key, the extension's pin, connection mode, port | The extension's `chrome.storage.local` (removed with the extension) |

`node cli/dist/daemon.mjs hub --help` prints the same paths.

### Troubleshooting

| Symptom | Fix |
| --- | --- |
| OpenCode shows the TabCrew server as failed | Run the command by hand to see why: `node /absolute/path/to/tabcrew/cli/dist/cli.mjs mcp < /dev/null`. Exit codes: **1** the hub failed to start or the connection was lost (the message includes `hub.error` or the end of `hub.log`); **2** bad arguments in `command`; **3** the extension port is in use. |
| `port 8775 in use by pid P (cmd)` (exit 3, also in `hub.error`) | Stop that program, or pass `--port N` in the OpenCode `command` and set the same **Hub port** in the popup. |
| The first tool call returns `extension_offline` (after about 45 s) | The extension never connected to the hub. Check that it is loaded from `extension/dist`; that **Connection** is Auto or Hub (Auto uses daemon mode if a daemon token is saved); that the popup's **Hub port** matches `--port`; and that the badge doesn't say **untrusted hub**. Then retry. |
| Popup says **untrusted hub** | See [Trust on first use](#trust-on-first-use): **Trust this hub**, after `tabcrew mcp reset-pin` if the hub trusts another profile. |
| `browse` returns `model_error` | The message says what to fix in **Advanced → Model provider**: no provider set; access to the provider's site not granted (click Save and choose Allow); 401/403 (check the key and headers); 404 (check the base URL and model). Use **Test** to check. |
| Warning: hub version differs from `tabcrew mcp` | You rebuilt TabCrew while an old hub was still running. It is replaced after it idle-exits, or stop it now with `kill <pid>` (the pid is in `hub.json`). |

## CLI

| Command | Does |
| --- | --- |
| `tabcrew setup` | Install or repair everything (idempotent). |
| `tabcrew doctor [--online]` | Check Node, home permissions, token, key (`--online` validates it), launchd job, `/health`, extension connection, pairing host and harness entries. Prints a one-line fix per problem; exits non-zero on failure. |
| `tabcrew token` | Print the token (the only command that does). |
| `tabcrew update` | Reinstall the runtime from the current package and restart the service. |
| `tabcrew mcp [--port N] [--idle-minutes N]` | Hub mode: the stdio MCP server your MCP client launches. It connects to the shared hub, starting it if needed. See [hub mode](#locked-down--corporate-chrome-hub-mode). |
| `tabcrew mcp reset-pin` | Hub mode: forget the hub's trust-on-first-use pin (then click **Trust this hub** in the popup). |
| `tabcrew uninstall [--purge] [--yes]` | Stop and remove the service, pairing host and runtime. `--purge` also deletes token, env, sessions, config and logs; `--yes` also removes the harness entries. |

The background service is macOS-only for now (hub mode needs no service); on other platforms `setup` stops with "not supported yet" after preparing the home, and `token`/`doctor` still work.

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

In [hub mode](#locked-down--corporate-chrome-hub-mode) the top of this picture is different. Each harness runs `tabcrew mcp` (stdio), and the shims share one hub that serves MCP on a Unix socket. The hub talks to the extension over `127.0.0.1:8775` and authenticates with the extension's Origin and a trust-on-first-use pin instead of a token. The hub sends `model_call` frames, and the extension makes the provider request itself.

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

Hub mode uses a local (stdio) entry instead: see [Set it up](#set-it-up). Daemon mode: `tabcrew setup` does this for you. By hand: point any MCP client that supports remote (streamable HTTP) servers at `http://127.0.0.1:8770/mcp` with the bearer token. OpenCode:

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

- Connection status. Daemon mode shows `not paired: run npx tabcrew setup` until pairing succeeds. Hub mode shows **hub not running** (start OpenCode) or **untrusted hub** (with **Trust this hub** and the `tabcrew mcp reset-pin` command). While the daemon is not connected, a box shows the `npx tabcrew setup` command (with a copy button) and a link to these install steps.
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
- **Advanced** in hub mode: the daemon-only groups and the token field are hidden. Instead there is **Model provider**: preset, base URL, write-only API key, headers, decision/text/fallback models, **Test**, **Save** (asks Chrome for access to the provider's site) and **Remove**. These settings stay in the extension's local storage, and the extension calls the provider directly. See [hub mode](#locked-down--corporate-chrome-hub-mode).
- **Advanced → Connection**: **Auto** (hub mode unless a daemon token is saved), **Hub** or **Daemon**, plus the port of the chosen mode (**Hub port** 8775 / **Daemon port** 8771).

## Configuration

This section is about daemon mode. Hub mode reads none of these files or variables. Its only settings are the `tabcrew mcp` flags and the popup, plus `TABCREW_LOG` and the `TABCREW_HUB_RUNTIME_DIR` / `TABCREW_HUB_STATE_DIR` overrides.

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

Daemon mode:

- Both ports bind to `127.0.0.1` only.
- The MCP endpoint requires `Authorization: Bearer <token>`; the extension socket requires the same token. The token lives in `~/.tabcrew/token`, readable only by its owner.
- Requests with an `Origin` header not listed in `allowed_origins` are rejected, so web pages cannot call the daemon; the extension socket only accepts `chrome-extension://` origins. On both ports the `Host` header must be `127.0.0.1`, `localhost` or `[::1]` (DNS rebinding).
- The extension ships no remote code; the page scripts it evaluates through the debugger are fixed constants in its bundle.
- `debug_logs` never stores headers, cookies, bodies or query strings.
- API keys are read from the environment or `~/.tabcrew/env` only; a key in `config.toml` is ignored with a warning. Keys entered in the popup go over the token-authenticated local socket to the daemon, which writes them to `~/.tabcrew/env` (mode 600); the extension does not store them, and the daemon never sends a key back in full (only its last 4 characters).
- The pairing host only answers TabCrew extension IDs (checked by Chrome via `allowed_origins` and again by the host) and never logs the token.
Hub mode:

- MCP runs over a Unix socket (0600) in a private runtime dir (0700, owned by you, symlinks refused). These file permissions are the only authentication, so other user accounts can't connect. There is no token and no HTTP port.
- The extension WebSocket binds to `127.0.0.1:8775`. It only accepts the `Origin` of a known TabCrew extension ID, with the same `Host` checks as daemon mode. On top of that, both sides prove they hold the trust-on-first-use pin (a mutual HMAC challenge) before any data is exchanged, so a program squatting on the port can't drive your browser once you have paired. Click **Trust this hub** only for a hub you started yourself.
- Model calls: the hub only sends the purpose, messages, `max_tokens` (capped at 4096) and `response_format`. The extension adds the model, key and headers, and only POSTs to `{base URL}/chat/completions` of the provider you saved: no cookies, no redirects, a 1 MB reply cap and a rate limit. The key never leaves the extension, and error messages are scrubbed of the key and header values.
- The provider key is stored in plain text in the extension's `chrome.storage.local`, which belongs to your Chrome profile and is not synced, like the daemon token in daemon mode. Removing the provider in the popup (or removing the extension) deletes it.
- Nothing is written to `~/.tabcrew`.

In both modes, agents act in your real, signed-in browser. Only connect agents you trust.

See [`SECURITY.md`](SECURITY.md) for the threat model and how to report vulnerabilities privately, and the [privacy policy](https://github.com/huynle/tabcrew/blob/main/docs/privacy.md) for what data goes where.

## Testing

```sh
just verify          # typecheck + offline tests + build (+ npm audit)
```

Unit tests never open a browser, call a paid API, or touch your real home directory: the CLI tests run setup/doctor/uninstall against a temp HOME with fake `launchctl`, `claude` and `fetch`. The live scripts need the extension connected. By default they talk to the daemon over HTTP with the token from `~/.tabcrew/token`. With `TABCREW_TRANSPORT=shim` they run `node cli/dist/cli.mjs mcp` instead, exactly like OpenCode in hub mode. That needs no token, starts the hub if none is running, and passes any extra shim flags from `TABCREW_SHIM_ARGS`, e.g. `--port 8776`. With the shim, `isolation` and `concurrency` run one shim process per simulated agent.

| Recipe | Checks | Cost |
| --- | --- | --- |
| `just smoke` | sessions, tabs, screenshot, navigate, read_text, debug_logs | free |
| `just isolation` | three parallel sessions stay isolated | free |
| `just guards` | freshness and occlusion guards on local fixture pages | free |
| `just concurrency` | latency of concurrent calls across sessions | free |
| `just live` | `browse` on Wikipedia and Google Flights | **paid** (OpenRouter) |
| `just hub-smoke` | `smoke` through the hub-mode shim | free |
| `just hub-isolation` | `isolation` with one shim per agent; a session ends when its shim exits | free |
| `just hub-concurrency` | `concurrency` with one shim per agent | free |
| `just live-provider` | one `browse` on Wikipedia through the shim, using the popup's model provider (e.g. Provider). Prints status, steps, decision model, text calls and cost | **paid** (cents) |

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
