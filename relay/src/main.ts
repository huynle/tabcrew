#!/usr/bin/env node
/**
 * TabCrew Online relay. Configuration (environment):
 *   RELAY_PUBLIC_URL        public base URL, e.g. https://tabcrew.huynle.com (required)
 *   RELAY_PORT              listen port (default 8790); RELAY_HOST (default 0.0.0.0)
 *   RELAY_SIGNING_KEY       hex, >= 32 bytes: signs access tokens (required)
 *   DATABASE_URL            Postgres connection string; or RELAY_STORE=memory for local runs
 *   GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET, GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET (at least one pair)
 *   TABCREW_LOG             log level (daemon logger)
 */
import { log } from "@tabcrew/daemon/dist/log.js";
import { githubProvider, googleProvider, type Provider } from "./auth/providers.js";
import { startRelay } from "./server.js";
import { MemoryStore } from "./store/memory.js";
import { PostgresStore } from "./store/postgres.js";

function fail(message: string): never {
  console.error(`tabcrew-relay: ${message}`);
  process.exit(1);
}

const env = process.env;
const publicUrl = env.RELAY_PUBLIC_URL?.trim() || fail("RELAY_PUBLIC_URL is required");
const keyHex = env.RELAY_SIGNING_KEY?.trim() ?? "";
if (!/^[0-9a-fA-F]{64,}$/.test(keyHex)) fail("RELAY_SIGNING_KEY must be at least 32 bytes of hex (openssl rand -hex 32)");

const providers: Provider[] = [];
if (env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET) {
  providers.push(githubProvider({ clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET }));
}
if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) {
  providers.push(googleProvider({ clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET }));
}
if (!providers.length) fail("configure GITHUB_CLIENT_ID/SECRET and/or GOOGLE_CLIENT_ID/SECRET");

const store =
  env.RELAY_STORE === "memory"
    ? new MemoryStore()
    : new PostgresStore(env.DATABASE_URL?.trim() || fail("DATABASE_URL is required (or RELAY_STORE=memory)"));

const relay = await startRelay({
  store,
  signingKey: Buffer.from(keyHex, "hex"),
  providers,
  publicUrl,
  host: env.RELAY_HOST || "0.0.0.0",
  port: Number(env.RELAY_PORT || 8790),
});
log.info(`sign-in providers: ${providers.map((p) => p.id).join(", ")}; store: ${env.RELAY_STORE === "memory" ? "memory" : "postgres"}`);

let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    void relay.close().then(() => process.exit(0));
  });
}
