import type { V2Snapshot } from "@tabcrew/shared/v2";

/** A realistic snapshot in the shape produced by the jev-ultrafast snapshot.js port. */
export function flightsSnapshot(fingerprint = "fp-flights-1"): V2Snapshot {
  const from = { node: 11, role: "combobox", label: "Where from?", value: "Zürich" };
  const sort = { node: 12, role: "combobox", label: "Sort by", current_value: "Best" };
  return {
    url: "https://flights.example/search",
    title: "Flights",
    viewport: { w: 1280, h: 800 },
    scroll: { y: 0, height: 2400 },
    text: "Search flights\nWhere from?\nSort by",
    actions: [
      { id: "e1", kind: "fill", ...from },
      { id: "e2", kind: "click", ...from, label: "Open Where from?" },
      { id: "e3", kind: "click", node: 13, role: "button", label: "Search", value: "" },
      { id: "e4", kind: "select", ...sort, label: "Sort by → Price", value: "price" },
      { id: "e5", kind: "select", ...sort, label: "Sort by → Duration", value: "duration" },
      { id: "e6", kind: "select", ...sort, label: "Sort by → Departure time", value: "departure" },
      { id: "e7", kind: "click", node: 14, role: "checkbox", label: "Nonstop only", value: "on", checked: "true" },
      { id: "e8", kind: "click", node: 15, role: "checkbox", label: "Refundable", value: "on", checked: "false" },
      { id: "e9", kind: "click", node: 16, role: "button", label: "Passengers", value: "", expanded: "false" },
      { id: "scroll_down", kind: "scroll", label: "Scroll down" },
      { id: "wait", kind: "wait", label: "Wait for the page to update" },
    ],
    omitted_actions: 3,
    fingerprint,
  };
}

/**
 * An open "Provider settings" modal whose body scrolls (scroll area 1). Before scrolling, the
 * "Preview sync" button is below the dialog's fold; `scrolled` is the page after one area scroll.
 * The page behind is locked, so there is no page scroll.
 */
export function modalSnapshot(scrolled = false, fingerprint = scrolled ? "fp-modal-2" : "fp-modal-1"): V2Snapshot {
  const area = { node: 40, label: 'Scroll down in "Provider settings" dialog' };
  return {
    url: "https://canis.example/providers",
    title: "Providers",
    viewport: { w: 1280, h: 800 },
    scroll: { y: 0, height: 2400 },
    text: scrolled ? "Provider settings\nNotes\nPreview sync" : "Provider settings\nProvider name\nBase URL",
    actions: [
      ...(scrolled
        ? [
            { id: "e1", kind: "fill" as const, node: 31, role: "textbox", label: "Notes", value: "" },
            { id: "e2", kind: "click" as const, node: 31, role: "textbox", label: "Open Notes", value: "" },
            { id: "e3", kind: "click" as const, node: 32, role: "button", label: "Preview sync", value: "" },
          ]
        : [
            { id: "e1", kind: "fill" as const, node: 21, role: "textbox", label: "Provider name", value: "canis-ai" },
            { id: "e2", kind: "click" as const, node: 21, role: "textbox", label: "Open Provider name", value: "canis-ai" },
          ]),
      { id: scrolled ? "e4" : "e3", kind: "click", node: 50, role: "button", label: "Save", value: "" },
      { id: "scroll_down_1", kind: "scroll", ...area },
      ...(scrolled ? [{ id: "scroll_up_1", kind: "scroll" as const, node: 40, label: 'Scroll up in "Provider settings" dialog' }] : []),
      { id: "wait", kind: "wait", label: "Wait for the page to update" },
    ],
    omitted_actions: 0,
    fingerprint,
  };
}

/** No modal: the page scrolls, and so do two side panels (scroll areas 1 and 2). */
export function panelsSnapshot(fingerprint = "fp-panels-1"): V2Snapshot {
  return {
    url: "https://mail.example/inbox",
    title: "Inbox",
    viewport: { w: 1280, h: 800 },
    scroll: { y: 0, height: 2400 },
    text: "Inbox\nActivity",
    actions: [
      { id: "e1", kind: "click", node: 1, role: "link", label: "Compose", value: "" },
      { id: "scroll_down", kind: "scroll", label: "Scroll down" },
      { id: "scroll_down_1", kind: "scroll", node: 60, label: 'Scroll down in "Messages" panel' },
      { id: "scroll_down_2", kind: "scroll", node: 61, label: 'Scroll down in "Activity" panel' },
      { id: "scroll_up_2", kind: "scroll", node: 61, label: 'Scroll up in "Activity" panel' },
      { id: "wait", kind: "wait", label: "Wait for the page to update" },
    ],
    omitted_actions: 0,
    fingerprint,
  };
}
