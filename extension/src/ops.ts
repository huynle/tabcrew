import type { V2Request, V2SessionRef } from "@tabcrew/shared/v2";
import type { CdpManager } from "./cdp.js";
import { OpError } from "./errors.js";
import { navigateTab, readText, type NavigateDeps } from "./navigate.js";
import type { PageController } from "./snapshot/controller.js";
import type { Placement } from "./config.js";
import { requireTabId, type TabManager } from "./tabs.js";

export const BACKGROUND_SCREENSHOT_TIMEOUT =
  "tab is in the background and Chrome did not paint it in time; retry, or open the session with session_open({foreground: true})";

/** CDP commands that issue a navigation: navigate releases its window lock once one of them answered. */
const NAVIGATION_COMMANDS: ReadonlySet<string> = new Set(["Page.navigate", "Page.reload", "Page.navigateToHistoryEntry"]);

export interface OpDeps {
  tabs: TabManager;
  cdp: CdpManager;
  page: PageController;
  /** Test hook: how long navigate waits for the load event. */
  navigateWaitMs?: number;
}

/** Route one daemon request to its handler. Throws OpError for typed failures. */
export async function handleRequest(req: V2Request, deps: OpDeps): Promise<unknown> {
  const args = (req.args ?? {}) as Record<string, unknown>;
  const session = req.session;
  switch (req.op) {
    case "tab_create": {
      const info = await deps.tabs.tabCreate(session, args);
      // Attach now (focus emulation keeps the background tab rendering) so the first
      // screenshot/snapshot does not pay for attaching and waking a hidden renderer.
      deps.cdp.ensureAttached(info.tab_id).catch(() => undefined);
      return info;
    }
    case "tab_list":
      return deps.tabs.tabList(session);
    case "tab_close":
      return deps.tabs.tabClose(session, args);
    case "session_close":
      return deps.tabs.sessionClose(session);
    case "session_release":
      return deps.tabs.releaseSession(
        session,
        async (tabId) => {
          await deps.cdp.detach(tabId);
          deps.page.forget(tabId);
        },
        args,
      );
    case "group_rename":
      return deps.tabs.groupRename(session, args);
    case "group_list":
      return deps.tabs.groupList(session);
    case "screenshot": {
      const tabId = requireTabId(args);
      return withPage(deps, session, tabId, (tab, placement) => {
        // Background tabs are not activated, and Chrome may not paint a hidden tab.
        const background = !tab.active;
        return deps.cdp.screenshot(tabId, args, background ? { timeoutMessage: BACKGROUND_SCREENSHOT_TIMEOUT } : {});
      });
    }
    case "snapshot": {
      const tabId = requireTabId(args);
      return withPage(deps, session, tabId, () => deps.page.snapshot(tabId));
    }
    case "act": {
      const tabId = requireTabId(args);
      return withPage(deps, session, tabId, () => deps.page.act(tabId, args));
    }
    case "navigate": {
      const tabId = requireTabId(args);
      return withPage(deps, session, tabId, (_tab, _placement, release) =>
        navigateTab(
          {
            cdp: releasingCdp(deps.cdp, release),
            forgetSnapshot: (id) => deps.page.forget(id),
            getTab: (id) => chrome.tabs.get(id),
            ...(deps.navigateWaitMs !== undefined && { waitMs: deps.navigateWaitMs }),
          },
          tabId,
          args,
        ),
      );
    }
    case "read_text": {
      const tabId = requireTabId(args);
      return withPage(deps, session, tabId, () =>
        readText((id, method, params) => deps.cdp.send(id, method, params), tabId, args, deps.page.sleep),
      );
    }
    case "debug_logs": {
      const tabId = requireTabId(args);
      // Reading buffers does not drive the page: no activation, no window lock.
      await deps.tabs.assertOwned(session, tabId);
      const result = deps.cdp.logs.query(tabId, args);
      // Attaching (lazily) starts capture for a tab that has not been attached yet.
      if (!deps.cdp.isAttached(tabId)) deps.cdp.ensureAttached(tabId).catch(() => undefined);
      return result;
    }
    default:
      throw new OpError("invalid_args", `unknown op: ${String(req.op)}`);
  }
}

/**
 * Ownership check, then, only for `foreground` sessions (`session_open({foreground: true})`) outside
 * `user_window`, the window's FIFO page lock around "activate the tab + run the op": Chrome only
 * renders a window's active tab at full speed, so foreground agents take turns. By default tabs
 * stay in the background and are never activated: they must not take over the user's view.
 * Ownership is checked again once the lock is held (the session may have finished meanwhile).
 * `release` lets an op give the lock back early (navigate: once the navigation was issued).
 */
async function withPage<T>(
  deps: OpDeps,
  session: V2SessionRef,
  tabId: number,
  run: (tab: chrome.tabs.Tab, placement: Placement | undefined, release: () => void) => Promise<T>,
): Promise<T> {
  const first = await deps.tabs.assertOwned(session, tabId);
  const placement = await deps.tabs.placementFor(session.short_id);
  if (placement === "user_window" || session.foreground !== true) return run(first, placement, () => undefined);
  let result!: Promise<T>;
  await deps.tabs.pageLocks.run(`window:${first.windowId}`, async () => {
    const tab = await deps.tabs.assertOwned(session, tabId);
    await deps.tabs.activate(tab);
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    result = run(tab, placement, release);
    await Promise.race([result.then(noop, noop), released]);
  });
  return result;
}

function noop(): void {}

/** The CDP calls navigate makes; the lock is released as soon as a navigation command answered. */
function releasingCdp(cdp: CdpManager, release: () => void): NavigateDeps["cdp"] {
  return {
    ensureAttached: (tabId) => cdp.ensureAttached(tabId),
    waitForEvent: (tabId, match, timeoutMs) => cdp.waitForEvent(tabId, match, timeoutMs),
    send: async <R>(tabId: number, method: string, params?: Record<string, unknown>): Promise<R> => {
      try {
        return await cdp.send<R>(tabId, method, params);
      } finally {
        if (NAVIGATION_COMMANDS.has(method)) release();
      }
    },
  };
}
