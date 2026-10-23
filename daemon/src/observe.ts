import type { V2Action, V2Snapshot } from "@tabcrew/shared/v2";
import { DaemonError } from "./errors.js";

/** Operations an agent may request from `act`. Never selectors, coordinates or code. */
export const OPERATIONS = ["CLICK", "TYPE_TEXT", "SELECT", "SCROLL_UP", "SCROLL_DOWN", "WAIT"] as const;
export type Operation = (typeof OPERATIONS)[number];
export type ElementOperation = "CLICK" | "TYPE_TEXT" | "SELECT";
export type ControlOperation = "SCROLL_UP" | "SCROLL_DOWN" | "WAIT";
export type ScrollOperation = "SCROLL_UP" | "SCROLL_DOWN";

const ELEMENT_OPERATIONS: Readonly<Record<string, ElementOperation>> = {
  click: "CLICK",
  fill: "TYPE_TEXT",
  select: "SELECT",
};
/** Snapshot control ids: page scroll (`scroll_down`), scroll area n (`scroll_down_<n>`), wait. */
const SCROLL_ID = /^scroll_(down|up)(?:_([1-9]\d*))?$/;
/** Scroll target of the page; scroll areas are "s1".."s5". */
export const PAGE_TARGET = "page";

export const MAX_TYPE_TEXT = 2000;
const OPTION_SEPARATOR = " → ";

export interface JevOption {
  /** `"<element index>:<n>"`, the SELECT target. */
  readonly index: string;
  readonly label: string;
  readonly value: string;
}

export interface JevElement {
  readonly index: number;
  readonly role?: string;
  readonly label: string;
  /** Current value; for a select, the currently selected option label(s). Omitted when empty. */
  value?: string;
  readonly checked?: string;
  readonly selected?: string;
  readonly expanded?: string;
  readonly operations: ElementOperation[];
  readonly options?: JevOption[];
}

export interface JevControl {
  readonly operation: ControlOperation;
  readonly label: string;
  /**
   * Scroll only: "s<n>" for a scroll area (a dialog or panel), "page" for the page when it is not
   * the first listed control of its operation. Omitted for the page when it is listed first.
   */
  readonly target?: string;
}

/** The agent-facing table plus the private maps from (operation, target) to snapshot actions. */
export interface ActionSpace {
  readonly elements: JevElement[];
  readonly controls: JevControl[];
  /** operation -> target ("3" or "3:2") -> snapshot action. */
  readonly targets: ReadonlyMap<ElementOperation, ReadonlyMap<string, V2Action>>;
  /** The first listed action per control operation (what a control without a target runs). */
  readonly controlActions: ReadonlyMap<ControlOperation, V2Action>;
  /** Scroll operation -> target ("page", "s1", …) -> snapshot action, in listed order. */
  readonly scrollTargets: ReadonlyMap<ScrollOperation, ReadonlyMap<string, V2Action>>;
}

export interface Observation {
  readonly url: string;
  readonly title: string;
  readonly text: string;
  readonly elements: JevElement[];
  readonly controls: JevControl[];
  readonly fingerprint: string;
  readonly omitted_actions: number;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * Port of jev-ultrafast `action_space`: one numbered element per DOM node, with per-operation
 * targets. A node with fill + "Open <label>" click gets one index offering TYPE_TEXT and CLICK;
 * each selectable option of a select becomes the SELECT target `"<index>:<n>"`.
 */
export function actionSpace(actions: readonly V2Action[]): ActionSpace {
  const elements: JevElement[] = [];
  const indexByNode = new Map<string, number>();
  const targets = new Map<ElementOperation, Map<string, V2Action>>();
  const controlActions = new Map<ControlOperation, V2Action>();
  const scrollTargets = new Map<ScrollOperation, Map<string, V2Action>>();
  const controls: JevControl[] = [];

  for (const action of actions) {
    if (!action || typeof action.id !== "string") continue;
    const scroll = SCROLL_ID.exec(action.id);
    if (scroll) {
      const operation: ScrollOperation = scroll[1] === "down" ? "SCROLL_DOWN" : "SCROLL_UP";
      const target = scroll[2] ? `s${scroll[2]}` : PAGE_TARGET;
      let group = scrollTargets.get(operation);
      if (!group) {
        group = new Map();
        scrollTargets.set(operation, group);
      }
      if (group.has(target)) continue;
      const first = group.size === 0;
      group.set(target, action);
      if (first) controlActions.set(operation, action);
      const label = str(action.label) ?? operation;
      controls.push(first && target === PAGE_TARGET ? { operation, label } : { operation, label, target });
      continue;
    }
    if (action.id === "wait") {
      if (!controlActions.has("WAIT")) {
        controlActions.set("WAIT", action);
        controls.push({ operation: "WAIT", label: str(action.label) ?? "WAIT" });
      }
      continue;
    }
    const operation = ELEMENT_OPERATIONS[action.kind];
    if (!operation) continue;
    const label = str(action.label) ?? "";
    const nodeKey = action.node !== undefined ? `n${action.node}` : `a${action.id}`;
    let index = indexByNode.get(nodeKey);
    if (index === undefined) {
      index = elements.length + 1;
      indexByNode.set(nodeKey, index);
      const cut = action.kind === "select" ? label.lastIndexOf(OPTION_SEPARATOR) : -1;
      const element: JevElement = {
        index,
        ...(action.role !== undefined && { role: action.role }),
        label: cut >= 0 ? label.slice(0, cut) : label,
        ...(action.checked !== undefined && { checked: action.checked }),
        ...(action.selected !== undefined && { selected: action.selected }),
        ...(action.expanded !== undefined && { expanded: action.expanded }),
        operations: [],
        ...(action.kind === "select" && { options: [] }),
      };
      const value = action.kind === "select" ? action.current_value : action.value;
      if (value) element.value = value;
      elements.push(element);
    }
    const element = elements[index - 1];
    if (!element.operations.includes(operation)) element.operations.push(operation);
    let group = targets.get(operation);
    if (!group) {
      group = new Map();
      targets.set(operation, group);
    }
    let target = String(index);
    if (action.kind === "select") {
      const options = (element as { options?: JevOption[] }).options ?? [];
      target = `${index}:${options.length + 1}`;
      const cut = label.lastIndexOf(OPTION_SEPARATOR);
      options.push({ index: target, label: cut >= 0 ? label.slice(cut + OPTION_SEPARATOR.length) : label, value: str(action.value) ?? "" });
    }
    group.set(target, action);
  }
  return { elements, controls, targets, controlActions, scrollTargets };
}

/** Scroll operations with more than one target (page and/or areas): the ones that need a target choice. */
export function scrollChoices(space: ActionSpace): ReadonlyMap<ScrollOperation, ReadonlyMap<string, V2Action>> {
  return new Map([...space.scrollTargets].filter(([, group]) => group.size > 1));
}

/** Validate the extension's snapshot just enough to build a table from it. */
export function checkSnapshot(value: unknown): V2Snapshot {
  const snap = value as Partial<V2Snapshot> | null;
  if (!snap || typeof snap !== "object" || !Array.isArray(snap.actions) || typeof snap.fingerprint !== "string" || !snap.fingerprint) {
    throw new DaemonError("internal", "extension returned an invalid snapshot");
  }
  return snap as V2Snapshot;
}

export function toObservation(snapshot: V2Snapshot, space: ActionSpace): Observation {
  return {
    url: str(snapshot.url) ?? "",
    title: str(snapshot.title) ?? "",
    text: str(snapshot.text) ?? "",
    elements: space.elements,
    controls: space.controls,
    fingerprint: snapshot.fingerprint,
    omitted_actions: Number.isInteger(snapshot.omitted_actions) ? snapshot.omitted_actions : 0,
  };
}

interface Cached {
  readonly fingerprint: string;
  readonly space: ActionSpace;
}

/** The latest observation per (session, tab). A newer observe replaces it; a successful act clears it. */
export class ObservationCache {
  private readonly entries = new Map<string, Cached>();

  private static key(shortId: string, tabId: number): string {
    return `${shortId}:${tabId}`;
  }

  set(shortId: string, tabId: number, fingerprint: string, space: ActionSpace): void {
    this.entries.set(ObservationCache.key(shortId, tabId), { fingerprint, space });
  }

  /** The cached table for exactly this fingerprint, or `stale_page`. */
  require(shortId: string, tabId: number, fingerprint: string): ActionSpace {
    const entry = this.entries.get(ObservationCache.key(shortId, tabId));
    if (!entry || entry.fingerprint !== fingerprint) {
      throw new DaemonError(
        "stale_page",
        entry
          ? "fingerprint is not from your latest observe of this tab; nothing executed; call observe again"
          : "no current observation for this tab (pages must be observed again after every act); nothing executed; call observe",
      );
    }
    return entry.space;
  }

  forget(shortId: string, tabId: number): void {
    this.entries.delete(ObservationCache.key(shortId, tabId));
  }

  forgetTab(tabId: number): void {
    const suffix = `:${tabId}`;
    for (const key of this.entries.keys()) if (key.endsWith(suffix)) this.entries.delete(key);
  }

  forgetSession(shortId: string): void {
    const prefix = `${shortId}:`;
    for (const key of this.entries.keys()) if (key.startsWith(prefix)) this.entries.delete(key);
  }

  get size(): number {
    return this.entries.size;
  }
}

export interface ResolvedAct {
  readonly action: V2Action;
  /** Normalised target ("3", "3:2", scroll "s1" / "page"), or null for a control without a target. */
  readonly target: string | null;
}

const MAX_HINT_TARGETS = 15;

function listHint(values: readonly string[]): string {
  if (values.length === 0) return "none";
  const shown = values.slice(0, MAX_HINT_TARGETS).join(", ");
  return values.length > MAX_HINT_TARGETS ? `${shown}, … (${values.length} total)` : shown;
}

/** Map (operation, target) to one snapshot action from our own table, or throw `target_invalid`. */
export function resolveAct(space: ActionSpace, operation: Operation, rawTarget: string | number | undefined): ResolvedAct {
  if (operation === "SCROLL_UP" || operation === "SCROLL_DOWN" || operation === "WAIT") {
    const action = space.controlActions.get(operation);
    if (!action) {
      const available = [...new Set(space.controls.map((c) => c.operation))];
      throw new DaemonError("target_invalid", `${operation} is not available on this page; available controls: ${listHint(available)}`);
    }
    if (operation === "WAIT" || rawTarget === undefined || rawTarget === "") return { action, target: null };
    // Scroll: "page" or "s<n>" from the observe controls.
    const group = space.scrollTargets.get(operation)!;
    const target = String(rawTarget).trim().toLowerCase();
    const chosen = group.get(target);
    if (!chosen) {
      throw new DaemonError(
        "target_invalid",
        `${operation} target ${JSON.stringify(String(rawTarget)).slice(0, 24)} is not offered; valid ${operation} targets: ${listHint([...group.keys()])} (or no target for the first listed)`,
      );
    }
    return { action: chosen, target };
  }
  if (rawTarget === undefined || rawTarget === "") {
    throw new DaemonError("invalid_args", `${operation} needs a target from the observe table`);
  }
  const target = String(rawTarget).trim();
  const group = space.targets.get(operation);
  const action = group?.get(target);
  if (!action) {
    const valid = [...(group?.keys() ?? [])];
    let hint = `${operation} target ${JSON.stringify(target).slice(0, 24)} is not in the observe table; valid ${operation} targets: ${listHint(valid)}`;
    if (operation === "SELECT" && /^\d+$/.test(target)) hint += ` (SELECT targets are "<index>:<option>", e.g. "${target}:1")`;
    throw new DaemonError("target_invalid", hint);
  }
  return { action, target };
}
