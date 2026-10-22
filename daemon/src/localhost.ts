import { isTabcrewExtensionOrigin } from "@tabcrew/shared/product";

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * DNS-rebinding guard: a `Host` header must name the loopback interface. A missing header is
 * accepted (browsers always send one; local non-browser clients may not).
 */
export function hostAllowed(host: string | undefined): boolean {
  if (!host) return true;
  const name = host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : host.split(":")[0];
  return LOCAL_HOSTS.has(name.toLowerCase());
}

/**
 * Extension socket handshake: only browser extensions (`chrome-extension://`, used by Chrome,
 * Chromium, Brave and Edge) or non-browser clients without an Origin may connect. Web pages
 * (http/https), sandboxed frames ("null") and file:// pages are refused before the token check.
 */
export function extensionOriginAllowed(origin: string | undefined): boolean {
  if (origin === undefined || origin === "") return true;
  return /^chrome-extension:\/\/[a-p]{32}\/?$/.test(origin);
}

/**
 * Hub extension socket handshake: the Origin must be present and one of `allowed` (TabCrew extension
 * origins, compared after `normalizeOrigin`). A hub has no token, so non-browser clients without an
 * Origin are refused too.
 */
export function hubOriginAllowed(origin: string | undefined, allowed: readonly string[]): boolean {
  return isTabcrewExtensionOrigin(origin, allowed);
}
