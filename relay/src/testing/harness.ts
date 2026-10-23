import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { githubProvider, googleProvider } from "../auth/providers.js";
import { startRelay, type RelayOptions, type RunningRelay } from "../server.js";
import { MemoryStore } from "../store/memory.js";
import type { Store } from "../store/types.js";

export const EXT_ID = "aejgcpbbemekfbmmkabpbgdkgmddfamo";
export const EXT_ORIGIN = `chrome-extension://${EXT_ID}`;
export const EXT_REDIRECT = `https://${EXT_ID}.chromiumapp.org/cb`;

export interface FakeUser {
  readonly id: string;
  readonly login: string;
  readonly email: string;
  readonly name: string;
}

/**
 * A fake GitHub + Google: `authorize` immediately redirects back with a code for `current`; token
 * and user endpoints answer for that code. Paths mirror the real providers' shapes.
 */
export class FakeProvider {
  current: FakeUser = { id: "1001", login: "alice", email: "alice@example.com", name: "Alice" };
  readonly tokenRequests: Record<string, string>[] = [];
  private readonly codes = new Map<string, FakeUser>();
  private readonly tokens = new Map<string, FakeUser>();
  private server: Server | null = null;
  url = "";

  async start(): Promise<void> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((r) => this.server!.listen(0, "127.0.0.1", r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async close(): Promise<void> {
    this.server?.closeAllConnections();
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
  }

  private async handle(req: IncomingMessage, res: import("node:http").ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", this.url);
    const body = await readForm(req);
    const json = (status: number, value: unknown) => {
      res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
    };
    const user = () => this.tokens.get((req.headers.authorization ?? "").replace(/^Bearer /i, ""));
    switch (url.pathname) {
      case "/gh/authorize":
      case "/google/authorize": {
        const code = randomBytes(8).toString("hex");
        this.codes.set(code, this.current);
        const back = new URL(url.searchParams.get("redirect_uri")!);
        back.searchParams.set("code", code);
        back.searchParams.set("state", url.searchParams.get("state") ?? "");
        res.writeHead(302, { location: back.toString() }).end();
        return;
      }
      case "/gh/token":
      case "/google/token": {
        this.tokenRequests.push(body);
        const u = this.codes.get(body.code ?? "");
        this.codes.delete(body.code ?? "");
        if (!u) return json(400, { error: "bad_verification_code" });
        const token = randomBytes(8).toString("hex");
        this.tokens.set(token, u);
        return json(200, { access_token: token, token_type: "bearer" });
      }
      case "/gh/api/user": {
        const u = user();
        return u ? json(200, { id: Number(u.id), login: u.login, name: u.name, email: null }) : json(401, {});
      }
      case "/gh/api/user/emails": {
        const u = user();
        return u ? json(200, [{ email: u.email, primary: true, verified: true }]) : json(401, {});
      }
      case "/google/userinfo": {
        const u = user();
        return u ? json(200, { sub: `g-${u.id}`, email: u.email, email_verified: true, name: u.name }) : json(401, {});
      }
      default:
        return json(404, {});
    }
  }
}

function readForm(req: IncomingMessage): Promise<Record<string, string>> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString("utf8")))));
  });
}

export interface TestRelay {
  readonly relay: RunningRelay;
  readonly fake: FakeProvider;
  readonly store: Store;
  readonly url: string;
  readonly port: number;
  close(): Promise<void>;
}

export async function startTestRelay(options: Partial<RelayOptions> = {}): Promise<TestRelay> {
  const fake = new FakeProvider();
  await fake.start();
  const store = options.store ?? new MemoryStore();
  const relay = await startRelay({
    store,
    signingKey: randomBytes(32),
    providers: [
      githubProvider({
        clientId: "gh-client",
        clientSecret: "gh-secret",
        endpoints: { authorize: `${fake.url}/gh/authorize`, token: `${fake.url}/gh/token`, api: `${fake.url}/gh/api` },
      }),
      googleProvider({
        clientId: "google-client",
        clientSecret: "google-secret",
        endpoints: { authorize: `${fake.url}/google/authorize`, token: `${fake.url}/google/token`, userinfo: `${fake.url}/google/userinfo` },
      }),
    ],
    offlineWaitMs: 300,
    helloTimeoutMs: 500,
    host: "127.0.0.1",
    port: 0,
    ...options,
  });
  return {
    relay,
    fake,
    store,
    url: relay.url,
    port: relay.port,
    async close() {
      await relay.close();
      await fake.close();
    },
  };
}

export function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

export async function register(url: string, body: Record<string, unknown> = {}): Promise<{ status: number; json: any }> {
  const res = await fetch(`${url}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "Test agent", redirect_uris: ["http://127.0.0.1:9999/callback"], ...body }),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

export interface AuthorizeParams {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly challenge: string;
  readonly provider?: "github" | "google";
  readonly state?: string;
  readonly extra?: Record<string, string>;
}

/**
 * Walk the browser part of the flow (relay /authorize page -> provider button -> fake provider ->
 * relay callback) and return where the relay finally redirects the user agent.
 */
export async function authorize(url: string, p: AuthorizeParams): Promise<{ status: number; location: URL | null; body: string }> {
  const q = new URLSearchParams({
    response_type: "code",
    client_id: p.clientId,
    redirect_uri: p.redirectUri,
    code_challenge: p.challenge,
    code_challenge_method: "S256",
    state: p.state ?? "client-state",
    ...p.extra,
  });
  const page = await fetch(`${url}/authorize?${q}`, { redirect: "manual" });
  const html = await page.text();
  if (page.status !== 200) return { status: page.status, location: null, body: html };
  const href = new RegExp(`href="(/auth/${p.provider ?? "github"}\\?txn=[^"]+)"`).exec(html)?.[1];
  if (!href) throw new Error(`no ${p.provider ?? "github"} button on the sign-in page`);
  let next = new URL(href.replace(/&amp;/g, "&"), url).toString();
  // relay start -> provider authorize -> relay callback -> client redirect
  for (let i = 0; i < 3; i++) {
    const res = await fetch(next, { redirect: "manual" });
    const location = res.headers.get("location");
    if (res.status !== 302 || !location) return { status: res.status, location: null, body: await res.text() };
    next = new URL(location, next).toString();
  }
  return { status: 302, location: new URL(next), body: "" };
}

export async function token(url: string, form: Record<string, string>): Promise<{ status: number; json: any }> {
  const res = await fetch(`${url}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

/** Register an MCP client and sign `user` in: returns its access and refresh tokens. */
export async function mcpLogin(t: TestRelay, user?: FakeUser, provider: "github" | "google" = "github") {
  if (user) t.fake.current = user;
  const reg = await register(t.url);
  const { verifier, challenge } = pkce();
  const redirectUri = "http://127.0.0.1:9999/callback";
  const auth = await authorize(t.url, { clientId: reg.json.client_id, redirectUri, challenge, provider });
  const code = auth.location!.searchParams.get("code")!;
  const tok = await token(t.url, {
    grant_type: "authorization_code",
    code,
    client_id: reg.json.client_id,
    redirect_uri: redirectUri,
    code_verifier: verifier,
  });
  if (tok.status !== 200) throw new Error(`token failed: ${JSON.stringify(tok.json)}`);
  return { clientId: reg.json.client_id as string, ...(tok.json as { access_token: string; refresh_token: string }) };
}

/** Sign `user` in as the extension (client "tabcrew-extension") for browser `name`. */
export async function extLogin(t: TestRelay, user?: FakeUser, name = "home-mac") {
  if (user) t.fake.current = user;
  const { verifier, challenge } = pkce();
  const auth = await authorize(t.url, { clientId: "tabcrew-extension", redirectUri: EXT_REDIRECT, challenge, extra: { browser_name: name } });
  const code = auth.location!.searchParams.get("code")!;
  const tok = await token(t.url, {
    grant_type: "authorization_code",
    code,
    client_id: "tabcrew-extension",
    redirect_uri: EXT_REDIRECT,
    code_verifier: verifier,
  });
  if (tok.status !== 200) throw new Error(`ext token failed: ${JSON.stringify(tok.json)}`);
  return tok.json as { access_token: string; refresh_token: string; browser_id: string };
}

export async function mcpClient(url: string, accessToken: string): Promise<Client> {
  const client = new Client({ name: "test", version: "0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${accessToken}` } } }),
  );
  return client;
}
