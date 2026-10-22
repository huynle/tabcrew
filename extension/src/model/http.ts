/**
 * HTTP helpers shared by the model_call proxy (service worker) and the popup's provider test:
 * request headers, fetch options, a size-capped body reader and secret redaction. No chrome.* use.
 */

import type { ProviderSettings } from "./settings.js";

export const MAX_REPLY_BYTES = 1_000_000;

/** `text` with every secret (4+ characters) replaced by `[redacted]`. */
export function redactSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) if (secret.length >= 4) out = out.split(secret).join("[redacted]");
  return out;
}

/** The secrets of a provider configuration: the key and every custom header value. */
export function providerSecrets(settings: Pick<ProviderSettings, "api_key" | "headers">): string[] {
  return [settings.api_key, ...Object.values(settings.headers)].sort((a, b) => b.length - a.length);
}

/** Request headers: custom headers first, then the ones TabCrew controls. */
export function providerHeaders(settings: Pick<ProviderSettings, "api_key" | "headers">, json: boolean): Record<string, string> {
  return {
    ...settings.headers,
    ...(json ? { "Content-Type": "application/json" } : {}),
    Accept: "application/json",
    Authorization: `Bearer ${settings.api_key}`,
  };
}

/** Fetch options shared by every provider request (no cookies, no redirects, no referrer). */
export const PROVIDER_FETCH_INIT = { credentials: "omit", redirect: "error", cache: "no-store", referrerPolicy: "no-referrer" } as const;

export class ReplyTooLargeError extends Error {
  constructor(readonly limit: number) {
    super(`model reply larger than ${limit} bytes`);
  }
}

/** The response body as text, refusing more than `limit` bytes. */
export async function readCapped(response: Response, limit: number): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel().catch(() => undefined);
    throw new ReplyTooLargeError(limit);
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => undefined);
      throw new ReplyTooLargeError(limit);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

export function parseJsonOrNull(text: string): unknown {
  try {
    return text ? (JSON.parse(text) as unknown) : null;
  } catch {
    return null;
  }
}

/** A user-facing message for a failed fetch (timeout, oversize, network/TLS), secrets redacted. */
export function fetchFailure(err: unknown, origin: string, timeoutMs: number, secrets: readonly string[]): string {
  const name = err instanceof Error || err instanceof DOMException ? err.name : "";
  if (name === "TimeoutError" || name === "AbortError") return `model call timed out after ${timeoutMs} ms`;
  if (err instanceof ReplyTooLargeError) return err.message;
  const detail = err instanceof Error ? err.message : String(err);
  return redactSecrets(`model request to ${origin} failed: ${detail}`, secrets).slice(0, 400);
}
