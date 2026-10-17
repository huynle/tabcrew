# Security Policy

TabCrew is a local browser automation tool for trusted users and trusted agents. It is not a sandbox for untrusted prompts, untrusted agents, or untrusted MCP clients.

## Supported versions

The project is pre-1.0. Security fixes go into the latest release (npm `tabcrew` and the Chrome Web Store extension) and the default branch.

## Reporting a vulnerability

Please do not open a public issue for security problems.

1. Use GitHub private vulnerability reporting: <https://github.com/huynle/tabcrew/security/advisories/new> (repository **Security** tab → **Report a vulnerability**).
2. If that is unavailable, open a regular issue that only asks for a private contact channel, without details.
3. Include the affected component (`daemon/`, `extension/`, `cli/`, `shared/`) and version, reproduction steps, impact, and any suggested fix.

Expect an acknowledgement within a week. Fixes are released as a new version and credited in the release notes unless you prefer otherwise.

## Threat model

**Trusted:** the local machine and user account, the browser profile, and every MCP client that holds the daemon token.

**Untrusted:** web pages (including pages agents visit), other local user accounts, other browser extensions, and anything arriving over the network.

**Assets:** the user's signed-in browser sessions, page content, the daemon token, and the OpenRouter (model provider) API key.

### What protects them

Daemon (`127.0.0.1:8770` MCP over HTTP, `127.0.0.1:8771` extension WebSocket):

- Both servers bind to `127.0.0.1` only.
- The MCP endpoint requires `Authorization: Bearer <token>`, compared in constant time (SHA-256 then `timingSafeEqual`). The extension socket requires the same token in its first frame and closes with 4401 otherwise, or after a 5 s hello timeout.
- DNS rebinding and cross-site requests: any request whose `Host` header is not `127.0.0.1`, `localhost` or `[::1]` is refused, on both servers. HTTP requests with an `Origin` not listed in `allowed_origins` (empty by default) are refused, including `/health`. WebSocket handshakes are refused unless the `Origin` is absent or a `chrome-extension://` origin, so web pages, sandboxed (`null`) and `file://` pages cannot connect.
- The daemon sends no CORS headers, so web pages cannot read its responses. MCP request bodies are capped at 4 MiB.
- The token is 32 random bytes in `~/.tabcrew/token` (0600); `~/.tabcrew` is 0700; `env` (API keys) and `sessions.json` are 0600. The daemon refuses to load an `env` file readable by group or others, and ignores API keys placed in `config.toml`.
- Logs carry session short IDs, tool names, step counts and timings only: never tokens, keys, session handles, page text, goals or typed values.
- Settings over the extension socket: after a valid hello, the client may send `ext_request` frames to read and change the OpenRouter key, the text-model key and base URL (written to `env`) and `jev_model` / `text_model` (written to `config.toml`). This adds no new trust: any token holder can already run `browse` and could edit those files as the user. Keys are never returned in full (source and last 4 characters only); a new OpenRouter key is checked with OpenRouter before it is saved; values set in the daemon's real environment cannot be changed this way; both files are written atomically with mode 0600; logs name the changed fields only.

Sessions:

- Each agent's session handle is an unguessable secret; sessions can reach only their own tabs. Handed-over tabs leave the agent's control.

Pairing host (`com.tabcrew.pair`, native messaging):

- Chrome starts it only for extension IDs in its manifest's `allowed_origins` (exact `chrome-extension://<id>/` origins of the published and development builds), and the host checks the caller origin again. It answers one `get_token` request, never logs the token, and exits. Any process running as the user can already read `~/.tabcrew/token`, so pairing does not widen access.

Extension:

- No remote code: everything is bundled; no `eval` or `new Function` (the store build check fails if they appear). Page-inspection scripts run in agent tabs through `chrome.debugger` `Runtime.evaluate` are fixed constants shipped in the bundle, with only JSON-encoded numbers and strings interpolated.
- Default Manifest V3 content security policy, no content scripts, no `externally_connectable`, no web-accessible resources.
- The snapshot skips password, file and hidden inputs. `debug_logs` builds each entry field by field: no headers, cookies, bodies or query strings, and never calls `Network.getResponseBody`.
- The extension talks only to the daemon on `127.0.0.1`.
- The extension holds no API keys and makes no model calls. A key typed into the popup is relayed to the daemon and never written to extension storage or logged.

CLI:

- `setup` asks before editing OpenCode or Claude Code configuration (`--yes` opts in explicitly) and preserves existing entries and comments. The API key prompt is hidden. Only `tabcrew token` prints the token; command output is redacted otherwise.

### Known limitations

- **Claude Code registration passes the token on a command line.** `claude mcp add --header "Authorization: Bearer <token>"` has no option to read headers from a file or the environment, so the token is visible in the process list (to any local account on macOS) for the second that command runs, and Claude Code then stores it in plain text in `~/.claude.json`. OpenCode reads it from `~/.tabcrew/token` instead. If you share the machine with other accounts, skip the Claude Code step and add the server yourself, or rotate the token afterwards (delete `~/.tabcrew/token` and rerun `npx tabcrew setup`).
- An unauthenticated local client can open a WebSocket and send one large frame before the hello is rejected (frames up to 64 MiB are accepted because screenshots travel this way). This is a local memory-pressure issue only.
- `/health` answers without a token (version and whether the extension is connected) for `tabcrew doctor`; it is still subject to the `Host` and `Origin` checks.
- Agents act with your full browser identity. A prompt-injected or malicious agent holding the token can do anything you can do on the sites it visits.

## Important risks

An agent with the token can, in your signed-in browser:

- Read page content and capture screenshots.
- Click, type, and select on any site.
- Read console messages and request metadata of its tabs.
- Send page content to the configured model provider when it uses `browse`.

Use caution on admin panels, payment flows, private accounts, and pages with sensitive data. Consider a dedicated browser profile for automation. Do not expose the daemon ports beyond localhost.
