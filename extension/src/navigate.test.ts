import { beforeEach, describe, expect, it } from "vitest";
import type { V2Request } from "@tabcrew/shared/v2";
import { CdpManager } from "./cdp.js";
import { MAX_READ_TEXT, parseNavigate, READ_TEXT_SOURCE, readText } from "./navigate.js";
import { handleRequest } from "./ops.js";
import { PageController } from "./snapshot/controller.js";
import { TabManager } from "./tabs.js";
import { createFakeChrome, type FakeChrome } from "./test/fakes.js";

const alice = { short_id: "aaaa1111", label: "alice" };
const bob = { short_id: "bbbb2222", label: "bob" };
const aliceFg = { ...alice, foreground: true as const };

let fake: FakeChrome;
let tabs: TabManager;
let cdp: CdpManager;
let page: PageController;
let commands: { method: string; params?: Record<string, unknown> }[];
/** How the fake page reacts to each command; return value is the CDP response. */
let onCommand: (tabId: number, method: string, params?: Record<string, unknown>) => unknown;
let history: { currentIndex: number; entries: { id: number; url: string }[] };

const call = (session: typeof alice, op: V2Request["op"], args: object = {}, navigateWaitMs = 200) =>
  handleRequest({ type: "request", id: "x", op, session, args } as V2Request, { tabs, cdp, page, navigateWaitMs });

/** The page "loads" asynchronously after a navigation command, like Chrome. */
function loadSoon(tabId: number, url: string) {
  setTimeout(() => {
    const t = fake.tabs.get(tabId);
    if (t) {
      t.url = url;
      t.title = `Title of ${url}`;
    }
    cdp.handleEvent(tabId, "Page.frameNavigated", { frame: { id: "main", url } });
    cdp.handleEvent(tabId, "Page.loadEventFired", { timestamp: 1 });
  }, 5);
}

beforeEach(() => {
  fake = createFakeChrome();
  fake.install();
  tabs = new TabManager(() => undefined);
  cdp = new CdpManager();
  page = new PageController({ send: (t, m, p) => cdp.send(t, m, p), isMac: async () => true, sleep: async () => undefined });
  commands = [];
  history = { currentIndex: 0, entries: [{ id: 1, url: "https://a.test/" }] };
  onCommand = (tabId, method, params) => {
    if (method === "Page.navigate") {
      loadSoon(tabId, String(params!.url));
      return { frameId: "main", loaderId: "L2" };
    }
    if (method === "Page.reload") {
      loadSoon(tabId, fake.tabs.get(tabId)!.url);
      return {};
    }
    if (method === "Page.getNavigationHistory") return history;
    if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main" } } };
    if (method === "Page.navigateToHistoryEntry") {
      const entry = history.entries.find((e) => e.id === params!.entryId)!;
      loadSoon(tabId, entry.url);
      return {};
    }
    return {};
  };
  const base = fake.chrome.debugger.sendCommand.getMockImplementation()!;
  fake.chrome.debugger.sendCommand.mockImplementation(async (target, method, params) => {
    await base(target, method, params); // keeps the "not attached" check
    commands.push({ method, params: params as Record<string, unknown> | undefined });
    return onCommand(target.tabId, method, params as Record<string, unknown> | undefined) as never;
  });
});

async function ownedTab(url = "https://a.test/"): Promise<number> {
  const info = (await call(alice, "tab_create", { url })) as { tab_id: number };
  return info.tab_id;
}

const sent = (method: string) => commands.filter((c) => c.method === method);

describe("parseNavigate", () => {
  it.each([
    [{ url: "https://x.test/a?b=1" }, { action: "url", url: "https://x.test/a?b=1" }],
    [{ url: "http://x.test", action: "url" }, { action: "url", url: "http://x.test/" }],
    [{ action: "back" }, { action: "back" }],
    [{ action: "forward" }, { action: "forward" }],
    [{ action: "reload" }, { action: "reload" }],
  ])("%j", (args, expected) => {
    expect(parseNavigate(args)).toEqual(expected);
  });

  it.each([
    [{}],
    [{ action: "url" }],
    [{ action: "home" }],
    [{ action: 3 }],
    [{ url: "javascript:alert(1)" }],
    [{ url: "file:///etc/passwd" }],
    [{ url: "chrome://settings" }],
    [{ url: "data:text/html,hi" }],
    [{ url: "/relative" }],
    [{ url: 42 }],
    [{ url: "https://x.test", action: "back" }],
  ])("rejects %j with invalid_args", (args) => {
    expect(() => parseNavigate(args)).toThrow(expect.objectContaining({ code: "invalid_args" }));
  });
});

describe("navigate", () => {
  it("opens a URL with Page.navigate, waits for the load event and returns the tab info", async () => {
    const tab = await ownedTab();
    const info = await call(alice, "navigate", { tab_id: tab, url: "https://b.test/page" });
    expect(info).toEqual({ tab_id: tab, url: "https://b.test/page", title: "Title of https://b.test/page" });
    expect(sent("Page.navigate")).toEqual([{ method: "Page.navigate", params: { url: "https://b.test/page", transitionType: "typed" } }]);
  });

  it("clears the tab's snapshot cache", async () => {
    const tab = await ownedTab();
    (page as unknown as { states: Map<number, unknown> }).states.set(tab, { fingerprint: "old", raw: {} });
    await call(alice, "navigate", { tab_id: tab, action: "reload" });
    expect(page.latest(tab)).toBeUndefined();
    expect(sent("Page.reload")).toHaveLength(1);
  });

  it("goes back through the navigation history", async () => {
    const tab = await ownedTab("https://b.test/");
    history = {
      currentIndex: 1,
      entries: [
        { id: 11, url: "https://a.test/" },
        { id: 12, url: "https://b.test/" },
      ],
    };
    const info = await call(alice, "navigate", { tab_id: tab, action: "back" });
    expect(sent("Page.navigateToHistoryEntry")).toEqual([{ method: "Page.navigateToHistoryEntry", params: { entryId: 11 } }]);
    expect(info).toMatchObject({ url: "https://a.test/" });
  });

  it.each(["back", "forward"] as const)("%s with no history entry → target_invalid, nothing sent", async (action) => {
    const tab = await ownedTab();
    await expect(call(alice, "navigate", { tab_id: tab, action })).rejects.toMatchObject({ code: "target_invalid" });
    expect(sent("Page.navigateToHistoryEntry")).toHaveLength(0);
  });

  it("finishes on a same-document history move (no load event)", async () => {
    const tab = await ownedTab();
    history = { currentIndex: 1, entries: [{ id: 1, url: "https://a.test/#x" }, { id: 2, url: "https://a.test/#y" }] };
    onCommand = (tabId, method) => {
      if (method === "Page.getNavigationHistory") return history;
      if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main" } } };
      if (method === "Page.navigateToHistoryEntry") {
        setTimeout(() => {
          cdp.handleEvent(tabId, "Page.navigatedWithinDocument", { frameId: "child", url: "x" });
          cdp.handleEvent(tabId, "Page.navigatedWithinDocument", { frameId: "main", url: "https://a.test/#x" });
        }, 5);
      }
      return {};
    };
    const started = Date.now();
    await call(alice, "navigate", { tab_id: tab, action: "back" }, 5_000);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("does not wait when Page.navigate stays in the same document (no loaderId)", async () => {
    const tab = await ownedTab();
    onCommand = (_t, method) => (method === "Page.navigate" ? { frameId: "main" } : {});
    const started = Date.now();
    await call(alice, "navigate", { tab_id: tab, url: "https://a.test/#frag" }, 5_000);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("returns the current state when the load event does not come in time", async () => {
    const tab = await ownedTab();
    onCommand = (_t, method) => (method === "Page.navigate" ? { frameId: "main", loaderId: "L9" } : {});
    const info = await call(alice, "navigate", { tab_id: tab, url: "https://slow.test/" }, 30);
    expect(info).toMatchObject({ tab_id: tab, url: "https://a.test/" });
  });

  it("reports outcome_unknown when the command fails after dispatch", async () => {
    const tab = await ownedTab();
    onCommand = (_t, method) => {
      if (method === "Page.navigate") throw new Error("Inspected target navigated or closed");
      return {};
    };
    await expect(call(alice, "navigate", { tab_id: tab, url: "https://b.test/" })).rejects.toMatchObject({ code: "outcome_unknown" });
  });

  it("rejects bad URLs with invalid_args before touching the page", async () => {
    const tab = await ownedTab();
    await expect(call(alice, "navigate", { tab_id: tab, url: "javascript:alert(1)" })).rejects.toMatchObject({ code: "invalid_args" });
    expect(sent("Page.navigate")).toHaveLength(0);
  });

  it("by default navigates in the background: never activates the tab", async () => {
    await ownedTab();
    const second = await ownedTab("https://c.test/");
    await call(alice, "navigate", { tab_id: second, action: "reload" });
    expect(sent("Page.reload")).toHaveLength(1);
    expect(fake.chrome.tabs.update).not.toHaveBeenCalled();
    expect(fake.tabs.get(second)!.active).toBe(false);
  });

  it("checks ownership and activates the tab without focusing", async () => {
    const first = await ownedTab();
    const second = await ownedTab("https://c.test/");
    await expect(call(bob, "navigate", { tab_id: first, action: "reload" })).rejects.toMatchObject({ code: "tab_not_owned" });
    expect(sent("Page.reload")).toHaveLength(0);
    expect(fake.tabs.get(second)!.active).toBe(false);
    await call(aliceFg, "navigate", { tab_id: second, action: "reload" });
    expect(fake.chrome.tabs.update).toHaveBeenCalledWith(second, { active: true });
    expect(fake.chrome.windows.update).not.toHaveBeenCalled();
  });
});

describe("read_text", () => {
  let body: string;
  let lastExpression: string;

  beforeEach(() => {
    body = "Example Domain\nThis domain is for use in documentation examples.";
    onCommand = (_t, method, params) => {
      if (method !== "Runtime.evaluate") return {};
      lastExpression = String(params!.expression);
      const max = Number(/text\.slice\(0, (\d+)\)/.exec(lastExpression)![1]);
      return { result: { type: "object", value: { text: body.slice(0, max), url: "https://example.com/", title: "Example Domain" } } };
    };
  });

  it("returns the whole document's innerText with url and title", async () => {
    const tab = await ownedTab();
    expect(await call(alice, "read_text", { tab_id: tab })).toEqual({
      text: body,
      url: "https://example.com/",
      title: "Example Domain",
    });
    // innerText (rendered text of the whole body) never includes input values.
    expect(lastExpression).toContain("innerText");
    expect(lastExpression).not.toMatch(/\.value\b/);
    expect(lastExpression).toContain("text.slice(0, 20000)");
  });

  it("truncates to max_length and caps it at 100000", async () => {
    const tab = await ownedTab();
    body = "x".repeat(150_000);
    expect(((await call(alice, "read_text", { tab_id: tab, max_length: 10 })) as { text: string }).text).toBe("x".repeat(10));
    expect(((await call(alice, "read_text", { tab_id: tab, max_length: 500_000 })) as { text: string }).text).toHaveLength(MAX_READ_TEXT);
  });

  it("validates max_length", async () => {
    const tab = await ownedTab();
    for (const max_length of [0, -1, 1.5, "10"]) {
      await expect(call(alice, "read_text", { tab_id: tab, max_length })).rejects.toMatchObject({ code: "invalid_args" });
    }
  });

  it("checks ownership", async () => {
    const tab = await ownedTab();
    await expect(call(bob, "read_text", { tab_id: tab })).rejects.toMatchObject({ code: "tab_not_owned" });
  });

  it("retries while the document is navigating, then fails with stale_page", async () => {
    let n = 0;
    const send = async () => {
      n++;
      return n < 3 ? { exceptionDetails: { text: "Execution context was destroyed." } } : { result: { value: { text: "ok", url: "u", title: "t" } } };
    };
    expect(await readText(send, 1, {}, async () => undefined)).toEqual({ text: "ok", url: "u", title: "t" });
    const never = async () => ({ exceptionDetails: { text: "Execution context was destroyed." } });
    await expect(readText(never, 1, {}, async () => undefined)).rejects.toMatchObject({ code: "stale_page" });
  });

  it("the page script reads innerText of the body, in a real DOM-like object", () => {
    const fn = new Function("document", "location", `return ${READ_TEXT_SOURCE(5)}`) as (d: unknown, l: unknown) => unknown;
    const doc = { body: { innerText: "Hello world" }, title: "T" };
    expect(fn(doc, { href: "https://x/" })).toEqual({ text: "Hello", url: "https://x/", title: "T" });
  });
});
