# Chrome Web Store listing: TabCrew

Paste each block into the matching field of the Developer Dashboard (**Store listing** tab). Text inside the fences is meant to be copied verbatim.

## Item name

```
TabCrew
```

(Taken from the manifest `name`.)

## Summary (manifest `description`, max 132 characters)

The dashboard shows the manifest description as the summary. Current value (114 characters):

```
Gives your local AI agents their own isolated tabs in your browser, driven by the TabCrew daemon on this computer.
```

## Description

```
TabCrew lets the AI agents you run on your own computer (OpenCode, Claude Code or any other MCP client) use your real browser, safely side by side.

EVERY AGENT GETS ITS OWN TABS
Each agent opens a private session: its own window and tab group, its own tabs. Agents can't see or touch your tabs, and they can't see or touch each other's. Run several at once.

YOU STAY IN CONTROL
• The toolbar popup lists every running session. Show brings its window to the front; Stop ends it immediately; Stop all ends everything.
• Choose where agent tabs open: in their own window (default, out of your way) or in your current window. Agents never switch the tab you are looking at.
• When an agent finishes, its tabs move into your window as a collapsed "✓ task" group for you to review, and the agent loses access to them.

WHAT AGENTS CAN DO
Agents read pages as a numbered list of buttons, links and fields, then click, type, select and scroll, one checked step at a time. Or they hand over a whole goal with "browse", which runs a fast observe → decide → act loop until the goal is done. They can also navigate, read a page's full text, take screenshots, and read console and network diagnostics of their own tabs.

REQUIRES THE FREE LOCAL TABCREW DAEMON
This extension does nothing on its own. It connects only to the TabCrew daemon running on your computer (127.0.0.1). Install it with one command (macOS, Node.js 20 or newer):

    npx tabcrew setup

Setup installs the background service, pairs the extension automatically (no token to copy) and can add TabCrew to OpenCode and Claude Code for you. "browse" needs your own OpenRouter API key, which you can add during setup or later in the popup's Advanced section (it is stored by the local service, not in Chrome); everything else works without one.

LOCKED-DOWN OR CORPORATE CHROME? HUB MODE
If your browser policy blocks native messaging, or you don't want a background service, your agent tool can start TabCrew itself ("tabcrew mcp"; see the README). All settings then live in this extension's popup. That includes the AI model provider for "browse": any OpenAI-compatible endpoint, such as OpenRouter or your company's gateway, with your own key and optional headers. The key is stored only in this browser. The extension calls that provider directly, and Chrome asks you to allow access to the provider's site when you save.

PRIVACY
No accounts, no analytics, no tracking, no TabCrew servers. Page content goes only to the TabCrew service on your own computer and, if you use "browse", to the AI model provider you configured with your own key. In hub mode the extension sends it to that provider directly. Privacy policy: https://github.com/huynle/tabcrew/blob/main/docs/privacy.md

OPEN SOURCE
MIT licensed. Source code, documentation and issue tracker: https://github.com/huynle/tabcrew

Only connect agents you trust: they act in your signed-in browser.

TabCrew is an independent open-source project. It is not affiliated with, endorsed by, or sponsored by Google.
```

## Category

`Developer Tools` (dashboard: Category → Developer Tools).

## Language

`English (United States)`.

## Graphic assets

| Field | File | Size |
| --- | --- | --- |
| Store icon | `store/assets/icon-128.png` | 128×128 (96 px artwork, 16 px transparent padding) |
| Screenshots (upload in this order) | `store/screenshots/1-sessions.png`, `2-placement.png`, `3-finished-group.png`, `4-agent-browse.png` | 1280×800 |
| Small promo tile | `store/screenshots/promo-small-440x280.png` | 440×280 |
| Marquee promo tile | none (optional) | |

Regenerate with `node extension/scripts/render-icons.mjs` and `node store/scripts/render-screenshots.mjs`. The screenshots are mockups rendered from `store/screenshots/src/*.html`, styled like the real popup.

## Additional fields

| Field | Value |
| --- | --- |
| Official URL | none (needs a verified domain; leave empty) |
| Homepage URL | `https://github.com/huynle/tabcrew` |
| Support URL | `https://github.com/huynle/tabcrew/issues` |
| Mature content | No |
| Privacy policy URL (Privacy tab) | `https://github.com/huynle/tabcrew/blob/main/docs/privacy.md` |
