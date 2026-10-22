/**
 * In-memory fakes for the chrome.* APIs this extension uses, plus a fake WebSocket.
 * Just enough behaviour to exercise tab groups, windows, storage and chrome.debugger.
 */

import { vi } from "vitest";
import type { SocketLike } from "../bridge.js";
import type { PortLike } from "../relay-protocol.js";

interface FakeTab {
  id: number;
  windowId: number;
  groupId: number;
  url: string;
  title: string;
  active: boolean;
  openerTabId?: number;
  index: number;
}
interface FakeWindow {
  id: number;
  type: "normal" | "popup";
  focused: boolean;
  incognito: boolean;
}
interface FakeGroup {
  id: number;
  windowId: number;
  title: string;
  collapsed: boolean;
}

type StorageChanges = Record<string, { oldValue?: unknown; newValue?: unknown }>;

/** Like Chrome, set/remove report changes through `storage.onChanged` (asynchronously). */
function storageArea(area: string, onChanged: { fire: (changes: StorageChanges, area: string) => void }) {
  let data: Record<string, unknown> = {};
  const notify = (changes: StorageChanges) => {
    if (Object.keys(changes).length > 0) queueMicrotask(() => onChanged.fire(changes, area));
  };
  return {
    get: vi.fn(async (keys?: string | string[] | null) => {
      if (keys == null) return { ...data };
      const list = Array.isArray(keys) ? keys : [keys];
      const out: Record<string, unknown> = {};
      for (const k of list) if (k in data) out[k] = structuredClone(data[k]);
      return out;
    }),
    set: vi.fn(async (items: Record<string, unknown>) => {
      const changes: StorageChanges = {};
      for (const [k, v] of Object.entries(items)) changes[k] = { oldValue: data[k], newValue: structuredClone(v) };
      data = { ...data, ...structuredClone(items) };
      notify(changes);
    }),
    remove: vi.fn(async (keys: string | string[]) => {
      const changes: StorageChanges = {};
      for (const k of Array.isArray(keys) ? keys : [keys]) {
        if (k in data) changes[k] = { oldValue: data[k] };
        delete data[k];
      }
      notify(changes);
    }),
    _data: () => data,
  };
}

function event<A extends unknown[]>() {
  const listeners: ((...args: A) => void)[] = [];
  return {
    addListener: (fn: (...args: A) => void) => listeners.push(fn),
    removeListener: () => undefined,
    fire: (...args: A) => listeners.forEach((fn) => fn(...args)),
  };
}

export function createFakeChrome() {
  let nextId = 100;
  const windows = new Map<number, FakeWindow>();
  const tabs = new Map<number, FakeTab>();
  const groups = new Map<number, FakeGroup>();
  const attachedDebuggee = new Set<number>();
  /** Window Chrome reports from getLastFocused (the user's focus); null when there is none. */
  let lastFocusedId: number | null = null;
  const focusWindow = (id: number) => {
    for (const w of windows.values()) w.focused = w.id === id;
    lastFocusedId = id;
  };

  const tabOut = (t: FakeTab) => ({ ...t, pinned: false, highlighted: false, incognito: false, selected: false, discarded: false, autoDiscardable: true, frozen: false });
  const notFound = (what: string, id: number) => new Error(`No ${what} with id: ${id}.`);

  const onActivated = event<[{ tabId: number; windowId: number }]>();
  /** Chrome keeps exactly one active tab per window. */
  const setActive = (tab: FakeTab, changed = !tab.active) => {
    for (const t of tabs.values()) if (t.windowId === tab.windowId) t.active = false;
    tab.active = true;
    if (changed) onActivated.fire({ tabId: tab.id, windowId: tab.windowId });
  };
  const ensureActive = () => {
    for (const w of windows.values()) {
      const inWin = [...tabs.values()].filter((t) => t.windowId === w.id);
      if (inWin.length > 0 && !inWin.some((t) => t.active)) inWin[inWin.length - 1]!.active = true;
    }
  };

  const dropEmpty = () => {
    for (const g of [...groups.values()]) {
      if (![...tabs.values()].some((t) => t.groupId === g.id)) groups.delete(g.id);
    }
    for (const w of [...windows.values()]) {
      if (![...tabs.values()].some((t) => t.windowId === w.id)) {
        windows.delete(w.id);
        if (lastFocusedId === w.id) lastFocusedId = null;
      }
    }
    ensureActive();
  };

  const addTab = (props: Partial<FakeTab> & { windowId: number }): FakeTab => {
    const tab: FakeTab = {
      id: nextId++,
      groupId: -1,
      url: "about:blank",
      title: "",
      active: false,
      index: [...tabs.values()].filter((t) => t.windowId === props.windowId).length,
      ...props,
    };
    tabs.set(tab.id, tab);
    if (tab.active) setActive(tab, true);
    return tab;
  };

  const addWindow = (props: Partial<FakeWindow> = {}): FakeWindow => {
    const win: FakeWindow = { id: nextId++, type: "normal", focused: false, incognito: false, ...props };
    windows.set(win.id, win);
    if (win.focused) focusWindow(win.id);
    return win;
  };

  const offscreenDocs = new Set<string>();
  const storageChanged = event<[StorageChanges, string]>();
  const onConnect = event<[FakePort]>();
  const ports: FakePort[] = [];
  const grantedOrigins = new Set<string>();
  const permissionState = { answer: true };

  const chrome = {
    runtime: {
      getManifest: () => ({ version: "0.3.0" }),
      getURL: (path: string) => `chrome-extension://fake/${path}`,
      getPlatformInfo: vi.fn(async () => ({ os: "mac" })),
      ContextType: { OFFSCREEN_DOCUMENT: "OFFSCREEN_DOCUMENT" },
      getContexts: vi.fn(async (filter: { documentUrls?: string[] }) => {
        // A real round trip, so concurrent callers interleave.
        await new Promise((resolve) => setTimeout(resolve, 0));
        return [...offscreenDocs]
          .filter((url) => !filter.documentUrls || filter.documentUrls.includes(url))
          .map((documentUrl) => ({ contextType: "OFFSCREEN_DOCUMENT", documentUrl }));
      }),
      /** Opens a port to this context's onConnect listeners; returns the caller's end. */
      connect: vi.fn((info: { name: string }) => {
        const [caller, listener] = createPortPair(info.name);
        ports.push(caller);
        onConnect.fire(listener);
        return caller;
      }),
      onConnect,
      /** Default: no native host installed (Chrome's error message). Tests override per case. */
      sendNativeMessage: vi.fn(async (_host: string, _message: unknown): Promise<unknown> => {
        throw new Error("Specified native messaging host not found.");
      }),
      onMessage: event<[unknown, unknown, (response: unknown) => void]>(),
      onStartup: event<[]>(),
      onInstalled: event<[unknown]>(),
    },
    offscreen: {
      Reason: { WORKERS: "WORKERS" },
      createDocument: vi.fn(async (params: { url: string; reasons: string[]; justification: string }) => {
        await new Promise((resolve) => setTimeout(resolve, 0));
        const url = `chrome-extension://fake/${params.url}`;
        if (offscreenDocs.size > 0) throw new Error("Only a single offscreen document may be created.");
        offscreenDocs.add(url);
      }),
      closeDocument: vi.fn(async () => {
        offscreenDocs.clear();
      }),
    },
    storage: { local: storageArea("local", storageChanged), session: storageArea("session", storageChanged), onChanged: storageChanged },
    windows: {
      get: vi.fn(async (id: number) => {
        const w = windows.get(id);
        if (!w) throw notFound("window", id);
        return { ...w };
      }),
      create: vi.fn(async (data: { url?: string; focused?: boolean; type?: "normal" | "popup" }) => {
        const win = addWindow({ type: data.type ?? "normal", focused: data.focused ?? true });
        const tab = addTab({ windowId: win.id, url: data.url ?? "chrome://newtab/", active: true });
        return { ...win, tabs: [tabOut(tab)] };
      }),
      update: vi.fn(async (id: number, props: { focused?: boolean } = {}) => {
        const w = windows.get(id);
        if (!w) throw notFound("window", id);
        if (props.focused) focusWindow(id);
        return { ...w };
      }),
      getLastFocused: vi.fn(async (_opts?: { windowTypes?: string[] }) => {
        const w = lastFocusedId !== null ? windows.get(lastFocusedId) : undefined;
        if (!w) throw new Error("No last-focused window");
        return { ...w };
      }),
      getAll: vi.fn(async (opts?: { windowTypes?: string[] }) =>
        [...windows.values()].filter((w) => !opts?.windowTypes || opts.windowTypes.includes(w.type)).map((w) => ({ ...w })),
      ),
      onRemoved: event<[number]>(),
      onFocusChanged: event<[number]>(),
    },
    tabs: {
      get: vi.fn(async (id: number) => {
        const t = tabs.get(id);
        if (!t) throw notFound("tab", id);
        return tabOut(t);
      }),
      query: vi.fn(async (q: { groupId?: number; windowId?: number; active?: boolean }) =>
        [...tabs.values()]
          .filter(
            (t) =>
              (q.groupId === undefined || t.groupId === q.groupId) &&
              (q.windowId === undefined || t.windowId === q.windowId) &&
              (q.active === undefined || t.active === q.active),
          )
          .map(tabOut),
      ),
      create: vi.fn(async (props: { windowId: number; url?: string; active?: boolean }) => {
        if (!windows.has(props.windowId)) throw notFound("window", props.windowId);
        return tabOut(addTab({ windowId: props.windowId, url: props.url ?? "chrome://newtab/", active: props.active ?? true }));
      }),
      remove: vi.fn(async (ids: number | number[]) => {
        for (const id of Array.isArray(ids) ? ids : [ids]) {
          if (!tabs.delete(id)) throw notFound("tab", id);
        }
        dropEmpty();
      }),
      ungroup: vi.fn(async (ids: number | number[]) => {
        for (const id of Array.isArray(ids) ? ids : [ids]) {
          const t = tabs.get(id);
          if (!t) throw notFound("tab", id);
          t.groupId = -1;
        }
        dropEmpty();
      }),
      group: vi.fn(async (opts: { groupId?: number; tabIds: number | number[]; createProperties?: { windowId?: number } }) => {
        const ids = Array.isArray(opts.tabIds) ? opts.tabIds : [opts.tabIds];
        let group: FakeGroup;
        if (opts.groupId !== undefined) {
          const g = groups.get(opts.groupId);
          if (!g) throw notFound("group", opts.groupId);
          group = g;
        } else {
          const first = tabs.get(ids[0]!);
          group = { id: nextId++, windowId: opts.createProperties?.windowId ?? first!.windowId, title: "", collapsed: false };
          groups.set(group.id, group);
        }
        for (const id of ids) {
          const t = tabs.get(id);
          if (!t) throw notFound("tab", id);
          t.groupId = group.id;
          if (t.windowId !== group.windowId) {
            t.windowId = group.windowId;
            t.active = false;
          }
        }
        dropEmpty();
        return group.id;
      }),
      move: vi.fn(async (id: number, props: { windowId?: number }) => {
        const t = tabs.get(id);
        if (!t) throw notFound("tab", id);
        if (props.windowId !== undefined && props.windowId !== t.windowId) {
          t.windowId = props.windowId;
          t.active = false;
        }
        dropEmpty();
        return tabOut(t);
      }),
      update: vi.fn(async (id: number, props: { active?: boolean }) => {
        const t = tabs.get(id);
        if (!t) throw notFound("tab", id);
        if (props.active) setActive(t);
        return tabOut(t);
      }),
      onCreated: event<[chrome.tabs.Tab]>(),
      onRemoved: event<[number]>(),
      onActivated,
    },
    tabGroups: {
      get: vi.fn(async (id: number) => {
        const g = groups.get(id);
        if (!g) throw notFound("group", id);
        return { ...g, color: "grey" };
      }),
      query: vi.fn(async () => [...groups.values()].map((g) => ({ ...g, color: "grey" }))),
      update: vi.fn(async (id: number, props: { title?: string; collapsed?: boolean }) => {
        const g = groups.get(id);
        if (!g) throw notFound("group", id);
        Object.assign(g, props);
        return { ...g };
      }),
      /** Moves the whole group to the end of another window; the group keeps its id. */
      move: vi.fn(async (id: number, props: { windowId?: number; index: number }) => {
        const g = groups.get(id);
        if (!g) throw notFound("group", id);
        if (props.windowId !== undefined && props.windowId !== g.windowId) {
          const dest = windows.get(props.windowId);
          if (!dest) throw notFound("window", props.windowId);
          let index = [...tabs.values()].filter((t) => t.windowId === dest.id).length;
          for (const t of tabs.values()) {
            if (t.groupId !== id) continue;
            t.windowId = dest.id;
            t.active = false;
            t.index = index++;
          }
          g.windowId = dest.id;
        }
        dropEmpty();
        return { ...g, color: "grey" };
      }),
    },
    debugger: {
      attach: vi.fn(async (target: { tabId: number }) => {
        if (!tabs.has(target.tabId)) throw new Error(`No tab with given id ${target.tabId}.`);
        if (attachedDebuggee.has(target.tabId)) throw new Error("Another debugger is already attached");
        attachedDebuggee.add(target.tabId);
      }),
      sendCommand: vi.fn(async (target: { tabId: number }, method: string, _params?: object) => {
        if (!attachedDebuggee.has(target.tabId)) throw new Error("Debugger is not attached to the tab");
        if (method === "Page.getLayoutMetrics") return { cssVisualViewport: { clientWidth: 1280, clientHeight: 720 } };
        if (method === "Page.captureScreenshot") return { data: "SU1BR0U=" };
        return {};
      }),
      detach: vi.fn(async (target: { tabId: number }) => {
        if (!attachedDebuggee.delete(target.tabId)) throw new Error("Debugger is not attached to the tab");
      }),
      onDetach: event<[{ tabId?: number }, string]>(),
      onEvent: event<[{ tabId?: number }, string, unknown]>(),
    },
    alarms: { create: vi.fn(async () => undefined), onAlarm: event<[{ name: string }]>() },
    /** Granted optional host permissions live in `grantedOrigins`; `request` grants unless `permissionAnswer` is false. */
    permissions: {
      request: vi.fn(async (p: { origins?: string[] }) => {
        if (!permissionState.answer) return false;
        for (const o of p.origins ?? []) grantedOrigins.add(o);
        return true;
      }),
      contains: vi.fn(async (p: { origins?: string[] }) => (p.origins ?? []).every((o) => grantedOrigins.has(o))),
      remove: vi.fn(async (p: { origins?: string[] }) => {
        let removed = false;
        for (const o of p.origins ?? []) removed = grantedOrigins.delete(o) || removed;
        return removed;
      }),
    },
  };

  return {
    chrome,
    windows,
    tabs,
    groups,
    attachedDebuggee,
    offscreenDocs,
    ports,
    grantedOrigins,
    /** What the user answers to the next `chrome.permissions.request` prompts. */
    set permissionAnswer(answer: boolean) {
      permissionState.answer = answer;
    },
    addWindow,
    addTab,
    focusWindow,
    setActive: (tabId: number) => setActive(tabs.get(tabId)!),
    install() {
      (globalThis as unknown as { chrome: unknown }).chrome = chrome;
    },
  };
}

export type FakeChrome = ReturnType<typeof createFakeChrome>;

export class FakeSocket implements SocketLike {
  static instances: FakeSocket[] = [];
  readyState = 0;
  sent: string[] = [];
  closed: { code?: number } | null = null;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number; reason?: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }

  send(data: string): void {
    if (this.readyState !== 1) throw new Error("not open");
    this.sent.push(data);
  }
  close(code?: number): void {
    this.closed = { code };
    this.readyState = 3;
  }

  // --- test helpers ---
  serverOpen(): void {
    this.readyState = 1;
    this.onopen?.({});
  }
  serverSend(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
  serverClose(code: number): void {
    this.readyState = 3;
    this.onclose?.({ code });
  }
  frames(): Record<string, unknown>[] {
    return this.sent.map((s) => JSON.parse(s) as Record<string, unknown>);
  }
}

/** One end of a fake `chrome.runtime.Port`. Messages are delivered asynchronously, like Chrome. */
export class FakePort implements PortLike {
  peer: FakePort | null = null;
  connected = true;
  received: unknown[] = [];
  private messageListeners: ((message: unknown) => void)[] = [];
  private disconnectListeners: (() => void)[] = [];
  readonly onMessage = { addListener: (fn: (message: unknown) => void) => void this.messageListeners.push(fn) };
  readonly onDisconnect = { addListener: (fn: () => void) => void this.disconnectListeners.push(fn) };

  constructor(readonly name: string) {}

  postMessage(message: unknown): void {
    if (!this.connected) throw new Error("Attempting to use a disconnected port object");
    const peer = this.peer!;
    const copy = JSON.parse(JSON.stringify(message)) as unknown;
    queueMicrotask(() => {
      if (!peer.connected) return;
      peer.received.push(copy);
      peer.messageListeners.forEach((fn) => fn(copy));
    });
  }

  /** Disconnects both ends; only the other end's onDisconnect fires (as in Chrome). */
  disconnect(): void {
    if (!this.connected) return;
    this.connected = false;
    const peer = this.peer!;
    peer.connected = false;
    peer.disconnectListeners.forEach((fn) => fn());
  }

  /** Test helper: the other context died (e.g. the service worker was terminated). */
  peerDied(): void {
    this.peer!.disconnect();
  }

  messages<T = Record<string, unknown>>(): T[] {
    return this.received as T[];
  }
}

export function createPortPair(name: string): [FakePort, FakePort] {
  const a = new FakePort(name);
  const b = new FakePort(name);
  a.peer = b;
  b.peer = a;
  return [a, b];
}

/** Let pending microtasks / promise chains settle. */
export async function flush(times = 20): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

/** One request seen by a `stubFetch` fetch. */
export interface FetchCall {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  /** The request body (text), or null. */
  readonly body: string | null;
  readonly init: RequestInit;
}

/**
 * A `fetch` stand-in answering through `handler` (a Response, or a value that becomes a JSON 200
 * Response). Records every call with lower-cased header names. `hang: true` from the handler never
 * answers until the request's signal aborts (rejecting like fetch does).
 */
export function stubFetch(handler: (call: FetchCall) => Response | unknown | Promise<Response | unknown>) {
  const calls: FetchCall[] = [];
  const fn = vi.fn(async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((value, name) => (headers[name] = value));
    const call: FetchCall = {
      url: String(input),
      method: (init.method ?? "GET").toUpperCase(),
      headers,
      body: typeof init.body === "string" ? init.body : null,
      init,
    };
    calls.push(call);
    if (init.signal?.aborted) throw init.signal.reason;
    const answer = await handler(call);
    if (answer && typeof answer === "object" && (answer as { hang?: unknown }).hang === true) {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init.signal;
        if (!signal) return;
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    }
    if (answer instanceof Response) return answer;
    return new Response(JSON.stringify(answer), { status: 200, headers: { "content-type": "application/json" } });
  });
  return { fetch: fn as unknown as typeof fetch, calls };
}
