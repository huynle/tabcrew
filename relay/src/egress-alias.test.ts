import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { aliasedClient, parseProviderAliases, type HttpClient, type HttpRequest } from "./egress.js";

const req = (url: string, body?: string): HttpRequest => ({
  method: body === undefined ? "GET" : "POST",
  url,
  headers: { authorization: "Bearer sk-secret", ...(body !== undefined && { "content-type": "application/json" }) },
  ...(body !== undefined && { body }),
  timeoutMs: 2000,
});

let server: Server | null = null;
afterEach(async () => {
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = null;
});

/** An in-cluster style provider on plain http (like http://omniroute.omniroute.svc.cluster.local). */
async function internalProvider(reply: (path: string, body: string) => { status: number; body: string; location?: string }) {
  const seen: { path: string; auth: string | undefined; body: string; host: string | undefined }[] = [];
  server = createServer((r, res) => {
    let body = "";
    r.on("data", (c) => (body += c));
    r.on("end", () => {
      seen.push({ path: r.url ?? "", auth: r.headers.authorization, body, host: r.headers.host });
      const out = reply(r.url ?? "", body);
      res.writeHead(out.status, { "content-type": "application/json", ...(out.location && { location: out.location }) });
      res.end(out.body);
    });
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()));
  return { origin: `http://127.0.0.1:${(server!.address() as AddressInfo).port}`, seen };
}

describe("parseProviderAliases", () => {
  it("reads host=origin pairs, lower-cased, and allows an empty value", () => {
    expect(parseProviderAliases("")).toEqual(new Map());
    const a = parseProviderAliases(" API.ai.huynle.com = http://omniroute.omniroute.svc.cluster.local , omniroute.huynle.com=http://omniroute.omniroute.svc.cluster.local:80 ");
    expect([...a]).toEqual([
      ["api.ai.huynle.com", "http://omniroute.omniroute.svc.cluster.local"],
      ["omniroute.huynle.com", "http://omniroute.omniroute.svc.cluster.local"],
    ]);
  });

  it("rejects malformed entries: no host, a URL as host, a target with a path, credentials or another scheme", () => {
    for (const bad of [
      "=http://x.svc",
      "https://api.ai.huynle.com=http://x.svc",
      "api.ai.huynle.com",
      "api.ai.huynle.com=http://x.svc/v1",
      "api.ai.huynle.com=http://user:pw@x.svc",
      "api.ai.huynle.com=ftp://x.svc",
      "api.ai.huynle.com=not a url",
    ]) {
      expect(() => parseProviderAliases(bad), bad).toThrow(/RELAY_PROVIDER_ALIASES/);
    }
  });
});

describe("aliasedClient", () => {
  it("sends a listed host to its internal origin (same path, query, method, headers and body)", async () => {
    const p = await internalProvider((path) => ({ status: 200, body: JSON.stringify({ path }) }));
    const publicCalls: string[] = [];
    const pub: HttpClient = async (r) => (publicCalls.push(r.url), { status: 200, text: "public" });
    const client = aliasedClient(parseProviderAliases(`api.ai.huynle.com=${p.origin}`), pub);
    const got = await client(req("https://api.ai.huynle.com/v1/chat/completions?x=1", '{"model":"m"}'));
    expect(got).toEqual({ status: 200, text: JSON.stringify({ path: "/v1/chat/completions?x=1" }) });
    expect(p.seen[0]).toMatchObject({ path: "/v1/chat/completions?x=1", auth: "Bearer sk-secret", body: '{"model":"m"}' });
    expect(publicCalls).toEqual([]);
  });

  it("leaves every other host (and other ports or schemes of a listed host) to the public client", async () => {
    const p = await internalProvider(() => ({ status: 200, body: "{}" }));
    const publicCalls: string[] = [];
    const pub: HttpClient = async (r) => (publicCalls.push(r.url), { status: 200, text: "public" });
    const client = aliasedClient(parseProviderAliases(`api.ai.huynle.com=${p.origin}`), pub);
    for (const url of ["https://openrouter.ai/api/v1/models", "https://evil.api.ai.huynle.com/v1/models", "https://api.ai.huynle.com:8443/v1/models", "http://api.ai.huynle.com/v1/models"]) {
      expect((await client(req(url))).text, url).toBe("public");
    }
    expect(publicCalls).toHaveLength(4);
    expect(p.seen).toEqual([]);
  });

  it("does not follow redirects from the internal origin, and keeps the key out of errors", async () => {
    const p = await internalProvider(() => ({ status: 302, body: "", location: "http://169.254.169.254/latest" }));
    const client = aliasedClient(parseProviderAliases(`api.ai.huynle.com=${p.origin}`), async () => ({ status: 0, text: "" }));
    expect((await client(req("https://api.ai.huynle.com/v1/models"))).status).toBe(302);
    expect(p.seen).toHaveLength(1);
    server!.close();
    await new Promise((r) => setTimeout(r, 50));
    const err = await client(req("https://api.ai.huynle.com/v1/models")).catch((e: Error) => e);
    expect(String(err)).toMatch(/refused|closed|network/);
    expect(String(err)).not.toContain("sk-secret");
  });
});
