# tabcrew

TabCrew gives your AI agents (OpenCode, Claude Code, any MCP client) their own isolated tabs in your real, signed-in browser. One local daemon serves many agents at once; each agent gets its own window and tab group, cannot see anyone else's tabs, and hands its tabs back to you when it is done.

This package installs and manages the local side: the daemon service, the pairing host for the browser extension, and the MCP entries for your agents.

## Requirements

- macOS (the background service installer is macOS-only for now)
- Node.js 20 or newer
- Google Chrome or another Chromium-based browser (Chromium, Brave, Edge)
- For the `browse` tool: an [OpenRouter](https://openrouter.ai) API key (everything else works without one)

## Install

```sh
npx tabcrew setup
```

Then install the **TabCrew** browser extension. The Chrome Web Store listing is pending; until then download `tabcrew-extension-unpacked-<version>.zip` from the [latest GitHub release](https://github.com/huynle/tabcrew/releases/latest), unzip it to a permanent folder, and load it with **Load unpacked** in `chrome://extensions` (Developer mode). It pairs with the daemon automatically: there is no token to copy. Check everything with:

```sh
npx tabcrew doctor
```

`setup` asks for your OpenRouter key (hidden input; Enter skips it, and you can add it later in the extension popup under **Advanced**), installs the service, registers the pairing host, and asks before adding TabCrew to OpenCode and Claude Code. Rerun it any time: it is idempotent.

## Commands

| Command | Does |
| --- | --- |
| `setup [--yes] [--no-harness]` | Install or repair everything. `--yes`: no questions (key from `$OPENROUTER_API_KEY`); `--no-harness`: leave OpenCode / Claude Code alone. |
| `doctor [--online]` | Check the installation, with a one-line fix per problem; exits non-zero on failure. `--online` also validates the key. |
| `token` | Print the daemon token (the only command that does). |
| `update` | Reinstall the runtime from this package version and restart the service. |
| `uninstall [--purge] [--yes]` | Remove the service, pairing host and runtime. `--purge`: also token, key, sessions, config and logs. `--yes`: also remove the OpenCode / Claude Code entries without asking. |

## Use it from an agent

Agents call `session_open` once, then `tab_create`, `observe` / `act` or `browse`, `read_text`, `screenshot`, and finally `session_close`, which hands the remaining tabs to you as a collapsed `✓ <label>` group. Any MCP client that supports streamable HTTP can connect to `http://127.0.0.1:8770/mcp` with `Authorization: Bearer <token>`.

## Uninstall

```sh
npx tabcrew uninstall --purge
```

Then remove the extension from your browser.

## Privacy and security

Everything lives in `~/.tabcrew` (override with `TABCREW_HOME`), readable only by you. The daemon listens on `127.0.0.1` only and requires the token. There is no telemetry. Page content leaves your computer only when an agent uses `browse`, and then only to the model provider you configured, with your key. See the [privacy policy](https://github.com/huynle/tabcrew/blob/main/docs/privacy.md) and [SECURITY.md](https://github.com/huynle/tabcrew/blob/main/SECURITY.md).

## Links

- Source and documentation: <https://github.com/huynle/tabcrew>
- Issues: <https://github.com/huynle/tabcrew/issues>

License: MIT. TabCrew is an independent project, not affiliated with or endorsed by Google.
