/**
 * Outbound HTTPS to a user's model provider, guarded against SSRF: https only, no redirects, and
 * every address the host name resolves to must be public (checked in the socket's DNS lookup, so a
 * name cannot resolve to a public address for a check and a private one for the connection).
 * Replies are capped in size and time. Errors never contain request headers (the API key).
 *
 * The operator may list provider aliases (RELAY_PROVIDER_ALIASES): exact host names whose https
 * requests go to an operator-set origin on the relay's own network instead (e.g. an in-cluster
 * service). Users cannot add aliases; every other host keeps the public-address guard.
 */
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { request as httpRequest, type ClientRequest, type IncomingMessage, type RequestOptions } from "node:http";
import { request } from "node:https";
import { BlockList, isIP } from "node:net";

export const MAX_REPLY_BYTES = 4 * 1024 * 1024;

const blocked = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  blocked.addSubnet(net, prefix, "ipv4");
}
for (const [net, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["64:ff9b::", 96],
  ["100::", 64],
  ["2001:db8::", 32],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  blocked.addSubnet(net, prefix, "ipv6");
}

/** True for an address on the public internet (not private, loopback, link-local, reserved...). */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !blocked.check(address, "ipv4");
  if (family === 6) {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
    if (mapped) return isPublicAddress(mapped[1]!);
    const hex = /^(?:0{0,4}:){0,5}:?ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(address);
    if (hex) {
      const hi = parseInt(hex[1]!, 16);
      const lo = parseInt(hex[2]!, 16);
      return isPublicAddress(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
    }
    return !blocked.check(address, "ipv6");
  }
  return false;
}

export class EgressError extends Error {}

export interface HttpReply {
  readonly status: number;
  readonly text: string;
}

export interface HttpRequest {
  readonly method: "GET" | "POST";
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body?: string;
  readonly timeoutMs: number;
}

export type HttpClient = (req: HttpRequest) => Promise<HttpReply>;

type LookupFn = (hostname: string, options: { all: true }, cb: (err: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void) => void;

/** The production client. `lookup` is injectable for tests. */
export function publicHttpsClient(lookup: LookupFn = dnsLookup as unknown as LookupFn): HttpClient {
  return (req) =>
    new Promise<HttpReply>((resolve, reject) => {
      let url: URL;
      try {
        url = new URL(req.url);
      } catch {
        return reject(new EgressError("invalid URL"));
      }
      if (url.protocol !== "https:") return reject(new EgressError("only https:// providers are allowed"));
      const host = url.hostname.replace(/^\[|\]$/g, "");
      if (isIP(host) && !isPublicAddress(host)) return reject(new EgressError(`${url.host} is not a public address`));
      exchange(request, url, req, resolve, reject, {
          lookup: ((hostname: string, _options: unknown, cb: (err: Error | null, address: string | LookupAddress[], family?: number) => void) => {
            lookup(hostname, { all: true }, (err, addresses) => {
              if (err) return cb(err, "");
              if (!addresses.length || addresses.some((a) => !isPublicAddress(a.address))) {
                return cb(new EgressError(`${hostname} resolves to a non-public address`), "");
              }
              const all = (_options as { all?: boolean } | undefined)?.all;
              if (all) cb(null, addresses);
              else cb(null, addresses[0]!.address, addresses[0]!.family);
            });
          }) as never,
      });
    });
}

type RequestFn = (url: URL, options: RequestOptions, cb: (res: IncomingMessage) => void) => ClientRequest;

/** One request/reply with the size and time caps; never follows redirects. */
function exchange(
  send: RequestFn,
  url: URL,
  req: HttpRequest,
  resolve: (reply: HttpReply) => void,
  reject: (err: Error) => void,
  extra: RequestOptions = {},
): void {
  const r = send(
    url,
    {
      method: req.method,
      headers: { ...req.headers, ...(req.body !== undefined && { "content-length": Buffer.byteLength(req.body) }) },
      timeout: req.timeoutMs,
      ...extra,
    },
    (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_REPLY_BYTES) {
          r.destroy(new EgressError("the provider's reply is too large"));
          return;
        }
        chunks.push(chunk);
      });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }));
      res.on("error", (err) => reject(err));
    },
  );
  r.on("timeout", () => r.destroy(new EgressError(`no reply within ${Math.round(req.timeoutMs / 1000)} s`)));
  r.on("error", (err) => reject(err instanceof EgressError ? err : new EgressError(describe(err))));
  if (req.body !== undefined) r.write(req.body);
  r.end();
}

/** Host name (lower case, https on the default port) -> origin on the relay's network (http or https, no path). */
export type ProviderAliases = ReadonlyMap<string, string>;

const HOST_NAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

/** Parse RELAY_PROVIDER_ALIASES: comma-separated `host=origin`, e.g. `api.example.com=http://llm.ns.svc.cluster.local`. */
export function parseProviderAliases(value: string): Map<string, string> {
  const aliases = new Map<string, string>();
  for (const raw of value.split(",")) {
    const entry = raw.trim();
    if (!entry) continue;
    const bad = (why: string): never => {
      throw new Error(`RELAY_PROVIDER_ALIASES: "${entry}": ${why}`);
    };
    const eq = entry.indexOf("=");
    if (eq < 0) bad("write host=origin");
    const host = entry.slice(0, eq).trim().toLowerCase();
    const target = entry.slice(eq + 1).trim();
    if (!HOST_NAME.test(host)) bad("the left side must be a plain host name (no scheme, port or path)");
    let url: URL;
    try {
      url = new URL(target);
    } catch {
      return bad("the right side must be an http(s) origin, e.g. http://service.namespace.svc.cluster.local");
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") bad("the origin must be http:// or https://");
    if (url.username || url.password) bad("the origin must not contain credentials");
    if (url.pathname !== "/" || url.search || url.hash || !/^https?:\/\/[^/?#]+\/?$/i.test(target)) bad("the origin must not have a path, query or fragment");
    aliases.set(host, url.origin);
  }
  return aliases;
}

/** Requests to a listed host (https, default port) go to its internal origin; everything else to `fallback`. */
export function aliasedClient(aliases: ProviderAliases, fallback: HttpClient): HttpClient {
  if (aliases.size === 0) return fallback;
  return (req) => {
    let url: URL;
    try {
      url = new URL(req.url);
    } catch {
      return fallback(req);
    }
    const origin = url.protocol === "https:" && url.port === "" ? aliases.get(url.hostname.toLowerCase()) : undefined;
    if (!origin) return fallback(req);
    const target = new URL(`${url.pathname}${url.search}`, origin);
    return new Promise<HttpReply>((resolve, reject) =>
      exchange((target.protocol === "https:" ? request : httpRequest) as RequestFn, target, req, resolve, reject),
    );
  };
}

/** The host names of `base_url` that this relay reaches through an alias (for the settings page). */
export function aliasedHost(aliases: ProviderAliases, baseUrl: string): string | null {
  try {
    const url = new URL(baseUrl);
    const host = url.hostname.toLowerCase();
    return url.protocol === "https:" && url.port === "" && aliases.has(host) ? host : null;
  } catch {
    return null;
  }
}

function describe(err: Error & { code?: string }): string {
  if (err.code === "ENOTFOUND") return "the provider's host name does not resolve";
  if (err.code === "ECONNREFUSED") return "the provider refused the connection";
  if (err.code === "ECONNRESET") return "the provider closed the connection";
  if (err.code && /CERT|SSL|TLS/i.test(err.code)) return "the provider's TLS certificate is not valid";
  return err.code ? `network error (${err.code})` : "network error";
}
