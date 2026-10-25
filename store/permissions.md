# Chrome Web Store: privacy practices and permission justifications

Paste into the Developer Dashboard **Privacy** tab. Verified against the built store manifest (`extension/dist-store/manifest.json`, printed by `npm run build:store`):

```
permissions:               ["debugger", "tabs", "tabGroups", "storage", "alarms", "offscreen", "identity", "nativeMessaging"]
host_permissions:          none
optional_host_permissions: ["https://*/*", "http://localhost/*", "http://127.0.0.1/*"]
```

No install-time host permissions. The `debugger` API attaches to agent tabs without them; this was verified live on Wikipedia and Google Flights. Optional host permissions are requested at runtime for one origin at a time: in hub mode, the user's own model provider, when the user clicks Load models, Test or Save under **Model provider**. There are also no `content_scripts`, no `web_accessible_resources`, no `externally_connectable`, default MV3 content security policy, no `key`.

## Single purpose description

```
TabCrew lets AI agents that the user runs on their own computer operate the user's browser in isolated, agent-owned tabs. It receives commands only from the TabCrew daemon or hub on the same computer (127.0.0.1), or, in the optional Online mode that the user turns on and signs in to, from the user's own account on the TabCrew relay (https://tabcrew.huynle.com), which carries commands from the user's own agents on other computers. It opens agent tabs in TabCrew's own window and tab groups, keeps track of which tabs belong to which agent session, reads those tabs, performs clicks, typing and navigation in them, and hands finished tabs back to the user. In hub mode (and in Online mode when the user chose this browser's own provider), it also sends the model requests for the agent's "browse" tool to the one AI model provider the user configured in the popup. Everything the extension does serves this one purpose.
```

## Permission justifications

### debugger

```
TabCrew drives web pages for the user's local AI agents through the Chrome DevTools Protocol. chrome.debugger is attached only to tabs that an agent session opened (never to the user's own tabs) to: read the page structure and visible text (Runtime.evaluate of TabCrew's own bundled, read-only snapshot script), dispatch real mouse and keyboard input for clicks and typing (Input.dispatchMouseEvent / Input.dispatchKeyEvent / Input.insertText), navigate, go back/forward and reload while waiting for the page to load (Page.navigate / Page.reload), capture screenshots (Page.captureScreenshot), and collect console messages and request metadata for the agent's debugging tool. The debugger is detached when the session ends or the tab is handed to the user. No other API offers trusted input events and reliable page state for automation.
```

### tabs

```
Used to create background tabs for agent sessions, move them between windows, read their URL, title and loading state so agents know where they are, close them when the agent asks, and bring a session's tab to the front when the user clicks "Show" in the popup. When several agents share TabCrew's own window, the extension switches the active tab inside that window to the tab an agent is working on, because Chrome throttles background tabs. The extension never changes which tab the user is looking at in the user's own windows.
```

### tabGroups

```
Agent tabs live in TabCrew's own named tab groups so the user can see at a glance which tabs belong to agents. By default every agent's tabs are in one shared "TabCrew" group in a TabCrew window (each agent still controls only its own tabs); agents can ask for other named groups, and the user can choose one group per agent session instead. The user can set the default group name, rename groups and create new ones in the popup, and agents can rename TabCrew's groups. When an agent finishes, its tabs stay in their group marked finished, are closed, or are collected into one collapsed "✓ <group>" group, as the user chose; a per-session group is retitled "✓ <task>", collapsed and moved into the user's window. TabCrew tracks its groups by id, never by title, and never changes the user's own tab groups.
```

### storage

```
chrome.storage.local keeps the user's settings (where new agent tabs open, the default tab group name and group names created in the popup, what happens to an agent's tabs when it finishes, the connection mode, the local daemon or hub port) and the access token for the user's own local daemon, obtained by pairing. It also keeps which tab, group and window ids belong to which agent session, so that agents stay isolated from the user's tabs and from each other even when the extension reloads; these ids are wiped when the browser starts, because Chrome assigns new ids after a restart. In hub mode (used where native messaging is blocked), it also keeps the pairing secret shared with the local hub, and the model provider settings the user saves in the popup: base URL, API key, optional headers and model names. Those are used only to call that provider. In the optional Online mode, it keeps the relay address, the browser name the user chose and the relay sign-in token (a rotating refresh token, sent only to the relay). In daemon mode, API keys typed into the popup are not stored by the extension: they are passed to the local daemon, which keeps them on disk. chrome.storage.session keeps rebuildable runtime state (session labels, finished tabs and groups listed in the popup) and, in hub mode, the user's unsaved changes to the model provider form, including a typed API key, because Chrome closes the popup while it shows the host permission prompt; that draft is deleted on Save or Remove and when the browser restarts. Nothing is synced, and nothing in storage is sent to any server except the relay sign-in token to the relay.
```

### Optional host permissions (https://*/*, http://localhost/*, http://127.0.0.1/*)

```
Only used in hub mode, where the extension makes the model calls for the agent's "browse" tool itself. When the user loads the models of, tests or saves a model provider under Advanced → Model provider, the popup calls chrome.permissions.request for that provider's origin only, for example https://openrouter.ai/* or https://api.openai.com/*. The extension then sends POST requests only to {that base URL}/chat/completions (and, for the Load models and Test buttons, GET {base URL}/models), with the user's own API key, credentials omitted and redirects refused. Once the origin is granted, opening the popup lists the models again without a prompt. No origin is granted at install, nothing is requested without a user click, and the extension never reads or changes web pages through host permissions (agent tabs are driven through chrome.debugger). http://localhost and http://127.0.0.1 are listed so a user can point it at a model server on their own computer. The pattern list has to be broad because the provider is chosen by the user.
```

### alarms

```
A one-minute alarm keeps the connection to the local TabCrew daemon alive and retries pairing while the daemon is not set up yet. Manifest V3 service workers are suspended when idle; the alarm wakes it so agents' commands are not lost.
```

### offscreen

```
An offscreen document (reason: WORKERS) holds the long-lived WebSocket connection to the TabCrew daemon or hub on 127.0.0.1 (or, in Online mode, to the user's TabCrew relay over wss), because a Manifest V3 service worker cannot keep a socket open reliably. It relays commands to the service worker and has no user-visible UI.
```

### identity

```
Used only in the optional Online mode, when the user clicks "Sign in" in the popup: chrome.identity.launchWebAuthFlow opens the TabCrew relay's sign-in page (https://tabcrew.huynle.com/authorize, OAuth 2.0 authorization code with PKCE), where the user signs in with GitHub or Google, and returns the authorization code to the extension (chrome.identity.getRedirectURL). The extension never sees the user's GitHub or Google password and does not use chrome.identity.getAuthToken or the user's Chrome profile account.
```

### nativeMessaging

```
Used only for automatic pairing with a daemon installed by "npx tabcrew setup" (never in hub mode): the extension asks the native messaging host "com.tabcrew.pair", installed on the user's computer by "npx tabcrew setup", for the access token of the user's local daemon, so the user does not have to copy a secret by hand. The host only answers TabCrew's own extension ID, returns the token and exits. No other native host is contacted.
```

## Remote code

**Are you using remote code?** `No, I am not using remote code.`

Justification, if a reviewer asks:

```
All JavaScript is bundled in the package (service-worker.js, popup/popup.js, offscreen/offscreen.js). There is no eval, new Function, remote <script> or remote import. In hub and Online mode the replies of the user's model provider are parsed as JSON data, never executed. The page-inspection scripts evaluated in agent tabs through chrome.debugger (Runtime.evaluate) are fixed string constants shipped inside service-worker.js (extension/src/snapshot/scripts.ts and extension/src/navigate.ts in the open-source repository); only JSON-encoded numbers and strings (element IDs, option values, a length limit) are interpolated into them. Messages from the local daemon, hub or (Online mode) relay are JSON commands chosen from a fixed list of operations (for example "act" with CLICK and an element number), never code.
```

## Data usage

The dashboard asks which categories of user data the item **collects** (handles off the device or for its functionality). The extension sends page data to the TabCrew daemon or hub on the same computer, and in those modes the developer receives nothing. In the optional Online mode, page data of agent tabs passes through the TabCrew relay run by the developer to the user's own agents, without being stored, and the relay stores the user's account (provider ID, email, name). When an agent uses `browse`, page content goes to the AI provider the user configured: in daemon mode the daemon (separate software the user installs) forwards it, in hub mode the extension sends it directly with the user's own key, and in Online mode the relay sends it with the key the user saved in their account (or the extension does, if the user chose this browser's own provider). Disclose conservatively:

| Category | Check? | Why |
| --- | --- | --- |
| Personally identifiable information | **Yes** | Online mode only: signing in with GitHub or Google gives the TabCrew relay the user's provider user ID, verified email address and display name, which the relay stores as the user's account. The extension itself stores only the browser name the user chose. Pages an agent visits might display other such data; it is handled as website content below. |
| Health information | No | |
| Financial and payment information | No | |
| Authentication information | **Yes** | Online mode: the relay sign-in token (rotating refresh token) is stored in chrome.storage.local and sent only to the relay. A model provider API key the user enters on the relay's Model settings web page is stored there encrypted and never sent to the extension. Hub mode: the API key (and optional headers) the user enters for their own model provider is stored in chrome.storage.local and sent only to that provider with each model call; while unsaved it is kept in chrome.storage.session (in memory) until Save, Remove or a browser restart. The daemon token and the hub pin never leave the device. Password fields are excluded from page snapshots. |
| Personal communications | No | |
| Location | No | |
| Web history | **Yes** | URLs and titles of agent-owned tabs, and request URLs (origin + path) for the agent's `debug_logs` tool, are passed to the local daemon (Online mode: to the relay, in memory only). Which tab ids belong to which agent session is kept in chrome.storage.local until the browser restarts (ids only, no URLs). |
| User activity | No | The extension does not monitor the user's clicks, keystrokes or browsing; it performs actions requested by agents in agent tabs. |
| Website content | **Yes** | Text, controls and screenshots of agent-owned tabs are passed to the local daemon or hub, or in Online mode to the user's agents through the TabCrew relay (not stored there). With `browse`, page text goes to the user's configured AI provider: sent by the daemon (daemon mode) or by the extension itself (hub mode). |

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
TabCrew needs its local daemon to do anything. To test: on macOS with Node.js 20+, run "npx tabcrew setup" (press Enter to skip the OpenRouter key; everything except "browse" works without it, and a key can be added later in the popup's Advanced section). The popup then shows "connected". From a terminal, the daemon's MCP endpoint at http://127.0.0.1:8770/mcp (bearer token: "npx tabcrew token") accepts tool calls such as session_open, tab_create and observe; each session's tabs appear in the TabCrew window, in the shared "TabCrew" tab group (or in their own window, if chosen in the popup). Hub mode (no service, for browsers that block native messaging): build the repository (npm install && npm run build) and run "node cli/dist/cli.mjs mcp" from an MCP client; the popup then shows "connected", and Advanced → Model provider asks for host access to the provider on Load models, Test or Save. Online mode (no install): in the popup set Connection to Online, enter a browser name and click Sign in (GitHub or Google); the badge shows "connected". Any MCP client with OAuth support can then use https://tabcrew.huynle.com/mcp after signing in with the same account. Source: https://github.com/huynle/tabcrew
```
