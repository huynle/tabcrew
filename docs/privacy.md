---
title: TabCrew privacy policy
---

# TabCrew privacy policy

Effective date: October 25, 2026. Applies to the TabCrew browser extension and the `tabcrew` command-line tool (the local "daemon", and in hub mode the local "hub" started by `tabcrew mcp`), version 0.4.0 and later, and to the TabCrew Online relay at `https://tabcrew.huynle.com` (extension version 0.6.0 and later).

## The short version

- In its local modes (daemon and hub), TabCrew has no servers and no accounts, and the developer never receives any of your data.
- **Online mode is optional** and off unless you choose it. It connects your browser to the TabCrew relay at `tabcrew.huynle.com`, run by the developer, so that your agents can reach your browsers from anywhere. You sign in with GitHub or Google. The relay stores a small account record and, if you set them, your model provider settings with your API key, encrypted (see [Online mode](#online-mode-tabcrew-relay)). It passes agent commands and the content of agent tabs between your agents and your browser, without storing that content, and sends page content to your model provider when you use `browse`.
- There are no analytics, telemetry, crash reports, ads or tracking, in any mode.
- In daemon and hub mode, the extension only talks to the TabCrew daemon or hub running on your own computer (`127.0.0.1`). In hub mode, and in Online mode when you choose this browser's own provider, it also talks to the AI model provider **you** configured in its popup. In Online mode it also talks to the relay. It talks to no one else.
- If you use the `browse` tool, the content of the agent's page goes to the AI model provider **you** configured, using **your** API key. In daemon mode the daemon on your computer sends it; in hub mode the extension sends it directly. Nothing else leaves your computer because of TabCrew.

## What TabCrew is

TabCrew lets AI agents that you run on your own computer (for example OpenCode or Claude Code) use your browser. It has two parts, both running only on your machine:

1. **The extension**, which opens tabs for agents, reads those tabs, and clicks or types in them when an agent asks.
2. **The daemon**, installed with `npx tabcrew setup`, which your agents connect to. It is free and open source.

   In **hub mode** (for browsers where native messaging is blocked), there is no installed daemon. Instead, your agent tool starts `tabcrew mcp`, which runs the same software as a "hub" while agents use it. In this mode the extension keeps the model provider settings and makes the model calls itself.

   In **Online mode**, the extension connects to the TabCrew relay instead, and your agents connect to the relay's MCP address (`https://tabcrew.huynle.com/mcp`). The software that runs on your computer in the other modes runs on the relay for you. See [Online mode](#online-mode-tabcrew-relay).

## What the extension accesses, and why

| Data | When | Where it goes |
| --- | --- | --- |
| Text, links, buttons and form fields of pages in **agent tabs** | When an agent calls `observe`, `read_text`, `act` or `browse` | Only to the daemon on your computer |
| Screenshots of **agent tabs** | When an agent calls `screenshot` | Only to the daemon on your computer |
| Console messages and request metadata of **agent tabs** (method, origin and path, status, type; never headers, cookies, bodies or query strings) | When an agent calls `debug_logs` | Only to the daemon on your computer |
| Titles, URLs, windows and tab group membership of tabs | To keep each agent inside its own tabs and show sessions and groups in the popup | Stays in the browser, or goes to the daemon on your computer |
| Which agent session owns which tab, and which tab groups and window are TabCrew's (tab, group and window ids, and session IDs) | When agents open, finish or close tabs | Stored in the extension's local storage on your computer, so agents stay isolated even after the extension reloads. Wiped when the browser restarts. Never sent anywhere else |
| The names of TabCrew tab groups (the default "TabCrew" group, groups you create or rename in the popup, groups agents ask for) | When you or an agent create or rename a group | Stored in the extension's local storage and shown as Chrome tab group titles; group names an agent uses are also kept with its session on the daemon or hub on your computer |
| The daemon's access token | Fetched once from your computer by pairing (or typed by you) | Stored in the extension's local storage on your computer |
| Your settings (tab placement, default group name, what happens to an agent's tabs when it finishes, connection mode, daemon or hub port) | When you change them | Stored in the extension's local storage on your computer |
| Hub mode: the pairing secret ("pin") shared with the hub | Created on first connection | Stored in the extension's local storage and in a private file on your computer (`~/Library/Application Support/TabCrew/hub-pin` on macOS). Never sent anywhere else |
| Hub mode: model provider settings (base URL, API key, optional headers, model names) | When you click Save under **Model provider** | Stored in the extension's local storage on your computer, not synced. The key and headers are sent only to that provider, with each model call. The popup never shows the saved key again (only its last 4 characters) |
| Hub mode: unsaved changes to the model provider form, including an API key you typed | While you type, so they survive Chrome closing the popup for its permission prompt | Kept in the extension's session storage (in memory, never synced) until you click Save or Remove, or the browser restarts (also cleared when the extension is reloaded). Never sent anywhere |
| Daemon mode: API keys and model names you enter under **Advanced** | When you click Save | Sent over the local connection to the daemon on your computer, which stores them in `~/.tabcrew/env` or `config.toml`. The extension never stores them; the daemon shows only a key's last 4 characters back |

Agents can only reach tabs they opened themselves, even when several agents share one tab group. Your own tabs and tab groups are never read or changed unless you give a tab to an agent, which TabCrew does not do on its own; a tab you drag into a TabCrew group stays yours. Password, file and hidden form fields are excluded from what agents observe.

Chrome may show TabCrew's tab groups as saved groups on the bookmarks bar. That is Chrome's own saved tab groups feature, stored by Chrome like any other tab group; TabCrew doesn't create bookmarks.

## What the daemon sends off your computer

Daemon mode. Only one thing, and only if you use it: when an agent calls `browse`, the daemon sends the current agent page's visible text and its list of controls, plus the agent's goal, to the model provider you set up (OpenRouter by default, or a provider you configure). It uses your own API key, which is stored in `~/.tabcrew/env` on your computer (whether you entered it during setup or in the extension popup) and never sent anywhere else. That provider's privacy policy applies to that data. If you do not add a key, `browse` is disabled and nothing is sent.

`tabcrew setup`, `tabcrew doctor --online` and saving a key in the extension popup also make one free request to OpenRouter to check that your key is valid.

## What the extension sends off your computer in hub mode

In hub mode, the hub on your computer prepares the same `browse` requests. The extension sends them directly to the provider you saved under **Model provider** (for example OpenRouter, OpenAI or Anthropic), using your key and headers, and only to that provider's `/chat/completions` address. Chrome asks you to allow access to that provider's site the first time you click **Load models**, **Test** or **Save**, and nothing goes there until you allow it. **Load models** asks the same provider for its list of models (with the key and headers in the form). **Test** makes two small requests to it: it lists the models, and sends a tiny chat message. Once access is granted, opening the popup lists the models again by itself. If you set no provider, `browse` is disabled and nothing is sent. Nothing else changes: TabCrew still has no servers and no telemetry, and the developer receives nothing.

## Online mode (TabCrew relay)

Online mode is for using your browsers from agents on other computers, or through an MCP gateway. You turn it on in the popup (**Connection → Online**), give the browser a name and sign in. The relay at `https://tabcrew.huynle.com` is run by the TabCrew developer on their own server.

**Signing in.** You sign in with GitHub or Google, in a browser window. TabCrew asks GitHub for your public profile and email address (`read:user user:email`), and Google for your basic profile and email address (`openid email profile`). It never sees your GitHub or Google password and never asks for access to anything else. The extension uses Chrome's `identity` permission only to show that sign-in window. Agents (MCP clients) sign in the same way, through the relay's sign-in page.

**What the relay stores** (in its database):

| Data | Why | How long |
| --- | --- | --- |
| Your account: the sign-in provider (GitHub or Google) and its user ID, your verified email address and display name, if the provider returns them | To know which browsers and agents are yours | Until your account is deleted |
| The names you give your browsers | So agents can pick a browser, and so you can see and revoke them | Until you revoke the browser or your account is deleted |
| The agents (MCP clients) you signed in: their name and the address they return to after sign-in | So they can refresh their sign-in, and so you can see and revoke them | Until revoked or deleted |
| Sign-in tokens, stored only as one-way hashes | To keep the extension and your agents signed in | Until they expire, are replaced or are revoked |
| One-time sign-in steps and codes | To finish a sign-in | 10 minutes and 1 minute |
| Your model settings, if you set them on the **Model settings** page: provider address, API key, optional extra headers and model names | So the relay can call your model provider for `browse` from any of your browsers. Encrypted (AES-256-GCM) with a key only the relay server has; the API key is never shown again (only its last 4 characters) and never sent to your browsers | Until you click **Remove** or your account is deleted |

**What passes through the relay without being stored.** Your agents' tool calls and their answers travel through the relay: the text, links, buttons and form fields of agent tabs, screenshots, console messages and request metadata, page URLs and titles, and the agent sessions themselves (labels, group names, which tabs belong to which session). The relay keeps them in memory only while they are in use. An agent session ends when the agent closes it, when you stop it in the popup, or after 30 minutes without use. The relay never writes page content, screenshots or typed text to its database or its logs. The connections are encrypted (HTTPS), but the relay itself handles this data unencrypted, as any MCP server does. If you add the relay to an MCP gateway, that gateway handles it too.

**Model provider and `browse`.** If you set a provider on the relay's **Model settings** page, the relay itself sends the `browse` requests (the agent's goal, and the current page's visible text and list of controls) to that provider, with your key and headers, and only to that provider's `/models` and `/chat/completions` addresses. **Load models** and **Test** on that page ask the same provider for its model list and send a tiny chat message. The relay only connects to providers on the public internet over HTTPS. That provider's privacy policy applies to what it receives. If a browser uses its own provider instead (popup: **Use this browser's own provider**), the extension makes those calls directly, as in hub mode, and the relay never receives that key. Without either, `browse` is disabled and nothing is sent.

**Logs.** The relay logs sign-in steps (for example "Google sign-in ok"), browser connections and disconnections, refused requests, and errors, with times. Logs never contain page content, typed text, tokens, codes or keys. The web server in front of the relay may log standard request details (IP address, time, address requested). Logs are kept on the developer's server and rotated.

**Backups.** The relay's database (the stored data above, not page content) is backed up every night to storage the developer controls.

**Your controls.** `https://tabcrew.huynle.com/account` lists your browsers and agents, with **Revoke** buttons; revoking one disconnects it and deletes its sign-in. **Sign out** in the popup ends the browser's sign-in, and **Pause agents in this browser** stops agents from using it. To delete your account and everything stored for it, open an issue (see Contact) or use the support email shown on the Google sign-in screen; deletion is done within 30 days, and removed from backups as they rotate.

The developer does not look at the data passing through the relay, except to investigate a problem you report, and never shares or sells it.

## What is stored on your computer

Daemon mode: in `~/.tabcrew/` (readable only by your user account), the access token, your API key (if you added one), the list of open agent sessions (with their labels and group names), optional configuration, and service logs. Logs contain session IDs, tool names and timings; they never contain page text, typed values, tokens or keys. `npx tabcrew uninstall --purge` deletes all of it.

Hub mode uses no `~/.tabcrew`. It keeps the list of open agent sessions, its logs and its runtime files in a private per-user temporary folder, and the pairing pin in `~/Library/Application Support/TabCrew/` (macOS). The provider settings and key stay in the extension's local storage; unsaved changes to them stay in its session storage until you save or remove them, or the browser restarts.

In Online mode the extension keeps the relay address, the browser's name, its sign-in token (`v2:online`) and whether it uses its own provider in its local storage, and its own provider settings, if you set any, as in hub mode.

In every mode the extension's local storage also holds your settings, the TabCrew group names, and which tabs, groups and window belong to which agent session (ids only, wiped when the browser restarts).

Removing the extension deletes its local storage.

## Sharing and selling

TabCrew does not sell, rent or share your data with anyone. In the local modes the developer does not collect it in the first place; in Online mode the relay keeps only the account data and model settings described above. Data is used only to do what you or your agents ask TabCrew to do in your browser.

## Children

TabCrew is a developer tool and is not directed at children.

## Changes

Changes to this policy are published in this file in the TabCrew repository, with a new effective date. The full history is public on GitHub.

## Contact

Questions or concerns: open an issue at <https://github.com/huynle/tabcrew/issues>. For security problems, please use private vulnerability reporting as described in [SECURITY.md](https://github.com/huynle/tabcrew/blob/main/SECURITY.md).

TabCrew is an independent open-source project. It is not affiliated with, endorsed by, or sponsored by Google.
