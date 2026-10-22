# Chrome Web Store: privacy practices and permission justifications

Paste into the Developer Dashboard **Privacy** tab. Verified against the built store manifest (`extension/dist-store/manifest.json`, printed by `npm run build:store`):

```
permissions:               ["debugger", "tabs", "tabGroups", "storage", "alarms", "offscreen", "nativeMessaging"]
host_permissions:          none
optional_host_permissions: ["https://*/*", "http://localhost/*", "http://127.0.0.1/*"]
```

No install-time host permissions. The `debugger` API attaches to agent tabs without them; this was verified live on Wikipedia and Google Flights. Optional host permissions are requested at runtime for one origin at a time: in hub mode, the user's own model provider, when the user clicks Save or Test under **Model provider**. There are also no `content_scripts`, no `web_accessible_resources`, no `externally_connectable`, default MV3 content security policy, no `key`.

## Single purpose description

```
TabCrew lets AI agents that the user runs on their own computer operate the user's browser in isolated, agent-owned tabs. It receives commands only from the TabCrew daemon or hub on the same computer (127.0.0.1). It opens and groups tabs for each agent session, reads those tabs, performs clicks, typing and navigation in them, and hands finished tabs back to the user. In hub mode, it also sends the model requests for the agent's "browse" tool to the one AI model provider the user configured in the popup. Everything the extension does serves this one purpose.
```

## Permission justifications

### debugger

```
TabCrew drives web pages for the user's local AI agents through the Chrome DevTools Protocol. chrome.debugger is attached only to tabs that an agent session opened (never to the user's own tabs) to: read the page structure and visible text (Runtime.evaluate of TabCrew's own bundled, read-only snapshot script), dispatch real mouse and keyboard input for clicks and typing (Input.dispatchMouseEvent / Input.dispatchKeyEvent / Input.insertText), navigate, go back/forward and reload while waiting for the page to load (Page.navigate / Page.reload), capture screenshots (Page.captureScreenshot), and collect console messages and request metadata for the agent's debugging tool. The debugger is detached when the session ends or the tab is handed to the user. No other API offers trusted input events and reliable page state for automation.
```

### tabs

```
Used to create background tabs for agent sessions, move them between windows, read their URL, title and loading state so agents know where they are, close them when the agent asks, and bring a session's window to the front when the user clicks "Show" in the popup. The extension never changes which tab the user is looking at.
```

### tabGroups

```
Each agent session is shown as its own named, colored tab group so the user can see at a glance which tabs belong to which agent. When an agent finishes, its group is retitled "✓ <task>", collapsed and moved into the user's window for review. Group titles are also how sessions are recovered after a browser restart.
```

### storage

```
chrome.storage.local keeps the user's settings (where new agent tabs open, the connection mode, the local daemon or hub port) and the access token for the user's own local daemon, obtained by pairing. In hub mode (used where native messaging is blocked), it also keeps the pairing secret shared with the local hub, and the model provider settings the user enters in the popup: base URL, API key, optional headers and model names. Those are used only to call that provider. In daemon mode, API keys typed into the popup are not stored by the extension: they are passed to the local daemon, which keeps them on disk. chrome.storage.session keeps rebuildable runtime state (which tab groups belong to which session, finished groups listed in the popup). Nothing is synced or sent to any server.
```

### Optional host permissions (https://*/*, http://localhost/*, http://127.0.0.1/*)

```
Only used in hub mode, where the extension makes the model calls for the agent's "browse" tool itself. When the user saves (or tests) a model provider under Advanced → Model provider, the popup calls chrome.permissions.request for that provider's origin only, for example https://llm.example.com/* or https://openrouter.ai/*. The extension then sends POST requests only to {that base URL}/chat/completions (and, for the Test button, GET {base URL}/models), with the user's own API key, credentials omitted and redirects refused. No origin is granted at install, nothing is requested without a user click, and the extension never reads or changes web pages through host permissions (agent tabs are driven through chrome.debugger). http://localhost and http://127.0.0.1 are listed so a user can point it at a model server on their own computer. The pattern list has to be broad because the provider is chosen by the user.
```

### alarms

```
A one-minute alarm keeps the connection to the local TabCrew daemon alive and retries pairing while the daemon is not set up yet. Manifest V3 service workers are suspended when idle; the alarm wakes it so agents' commands are not lost.
```

### offscreen

```
An offscreen document (reason: WORKERS) holds the long-lived WebSocket connection to the TabCrew daemon on 127.0.0.1, because a Manifest V3 service worker cannot keep a socket open reliably. It relays commands to the service worker and has no user-visible UI.
```

### nativeMessaging

```
Used only for automatic pairing with a daemon installed by "npx tabcrew setup" (never in hub mode): the extension asks the native messaging host "com.tabcrew.pair", installed on the user's computer by "npx tabcrew setup", for the access token of the user's local daemon, so the user does not have to copy a secret by hand. The host only answers TabCrew's own extension ID, returns the token and exits. No other native host is contacted.
```

## Remote code

**Are you using remote code?** `No, I am not using remote code.`

Justification, if a reviewer asks:

```
All JavaScript is bundled in the package (service-worker.js, popup/popup.js, offscreen/offscreen.js). There is no eval, new Function, remote <script> or remote import. In hub mode the replies of the user's model provider are parsed as JSON data, never executed. The page-inspection scripts evaluated in agent tabs through chrome.debugger (Runtime.evaluate) are fixed string constants shipped inside service-worker.js (extension/src/snapshot/scripts.ts and extension/src/navigate.ts in the open-source repository); only JSON-encoded numbers and strings (element IDs, option values, a length limit) are interpolated into them. Messages from the local daemon are JSON commands chosen from a fixed list of operations (for example "act" with CLICK and an element number), never code.
```

## Data usage

The dashboard asks which categories of user data the item **collects** (handles off the device or for its functionality). The extension sends page data to the TabCrew daemon or hub on the same computer, and the developer receives nothing. When an agent uses `browse`, page content goes to the AI provider the user configured: in daemon mode the daemon (separate software the user installs) forwards it, and in hub mode the extension sends it directly with the user's own key. Disclose conservatively:

| Category | Check? | Why |
| --- | --- | --- |
| Personally identifiable information | No | Not requested or stored. Pages an agent visits might display such data; it is handled as website content below. |
| Health information | No | |
| Financial and payment information | No | |
| Authentication information | **Yes** | Hub mode: the API key (and optional headers) the user enters for their own model provider is stored in chrome.storage.local and sent only to that provider with each model call. The daemon token and the hub pin never leave the device. Password fields are excluded from page snapshots. |
| Personal communications | No | |
| Location | No | |
| Web history | **Yes** | URLs and titles of agent-owned tabs, and request URLs (origin + path) for the agent's `debug_logs` tool, are passed to the local daemon. |
| User activity | No | The extension does not monitor the user's clicks, keystrokes or browsing; it performs actions requested by agents in agent tabs. |
| Website content | **Yes** | Text, controls and screenshots of agent-owned tabs are passed to the local daemon or hub. With `browse`, page text goes to the user's configured AI provider: sent by the daemon (daemon mode) or by the extension itself (hub mode). |

Certifications (check all three):

- [x] I do not sell or transfer user data to third parties, outside of the approved use cases.
- [x] I do not use or transfer user data for purposes that are unrelated to my item's single purpose.
- [x] I do not use or transfer user data to determine creditworthiness or for lending purposes.

(Sending page content to the AI provider the user configured, with the user's own key, is part of the single purpose and is done at the user's request. In hub mode that provider is the only third party the extension contacts, and only after the user granted its origin.)

## Privacy policy URL

```
https://github.com/huynle/tabcrew/blob/main/docs/privacy.md
```

Source: `docs/privacy.md` in the repository.

## Notes for reviewers (optional "test instructions" field)

```
TabCrew needs its local daemon to do anything. To test: on macOS with Node.js 20+, run "npx tabcrew setup" (press Enter to skip the OpenRouter key; everything except "browse" works without it, and a key can be added later in the popup's Advanced section). The popup then shows "connected". From a terminal, the daemon's MCP endpoint at http://127.0.0.1:8770/mcp (bearer token: "npx tabcrew token") accepts tool calls such as session_open, tab_create and observe; each session's tabs appear in their own window and tab group. Hub mode (no service, for browsers that block native messaging): build the repository (npm install && npm run build) and run "node cli/dist/cli.mjs mcp" from an MCP client; the popup then shows "connected", and Advanced → Model provider asks for host access to the provider on Save. Source: https://github.com/huynle/tabcrew
```
