/**
 * TabCrew product constants shared by the daemon, the `tabcrew` CLI, the pairing host and the
 * extension.
 */

export const PRODUCT_NAME = "TabCrew";

/** Chrome native messaging host that hands the daemon token to the extension. */
export const NATIVE_HOST_NAME = "com.tabcrew.pair";

/** launchd label of the daemon service (macOS). */
export const LAUNCHD_LABEL = "com.tabcrew.daemon";
/** launchd label used by ChromeUse, removed on setup. */
export const LEGACY_LAUNCHD_LABEL = "com.chromeuse.daemon";

export interface TabCrewExtensionIds {
  /** Fixed ID of unpacked development builds (from the public `key` in extension/dev-key.pub). */
  readonly dev: string;
  /**
   * ID the Chrome Web Store assigned to the published extension. Null (or anything that is not a
   * 32-letter a-p ID) is skipped, so only the dev ID can pair.
   */
  readonly store: string | null;
}

export const TABCREW_EXTENSION_IDS: TabCrewExtensionIds = {
  dev: "aejgcpbbemekfbmmkabpbgdkgmddfamo",
  store: "bahebfheemnjhfnelblbiejbjljapgpa",
};

/** Every known extension ID (placeholders skipped). */
export function tabcrewExtensionIds(ids: TabCrewExtensionIds = TABCREW_EXTENSION_IDS): string[] {
  return [ids.dev, ids.store].filter((id): id is string => typeof id === "string" && /^[a-p]{32}$/.test(id));
}

/** `chrome-extension://<id>/` origins allowed to launch the pairing host. */
export function tabcrewExtensionOrigins(ids: TabCrewExtensionIds = TABCREW_EXTENSION_IDS): string[] {
  return tabcrewExtensionIds(ids).map((id) => `chrome-extension://${id}/`);
}

/**
 * An origin in comparable form: trimmed, lowercase, without trailing slashes (Chrome sends the
 * WebSocket `Origin` header as `chrome-extension://<id>`, native messaging manifests use `.../`).
 * Null for anything that is not a non-empty string.
 */
export function normalizeOrigin(origin: unknown): string | null {
  if (typeof origin !== "string") return null;
  const normalized = origin.trim().toLowerCase().replace(/\/+$/, "");
  return normalized || null;
}

/** Whether a WebSocket `Origin` is one of the allowed TabCrew extension origins (exact match after normalizing). */
export function isTabcrewExtensionOrigin(origin: unknown, allowed: readonly string[] = tabcrewExtensionOrigins()): boolean {
  const normalized = normalizeOrigin(origin);
  return normalized !== null && allowed.some((o) => normalizeOrigin(o) === normalized);
}

/** The extension's Chrome Web Store listing. */
export const CHROME_WEB_STORE_URL = "https://chromewebstore.google.com/detail/tabcrew/bahebfheemnjhfnelblbiejbjljapgpa";

/** Message the extension sends to the pairing host, and its replies. */
export type PairRequest = { readonly type: "get_token" };
export type PairResponse = { readonly token: string } | { readonly error: string };
