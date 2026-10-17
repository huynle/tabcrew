import { join } from "node:path";
import { loadConfig, loadEnvFile, resolveHome } from "./config.js";
import { startDaemon } from "./daemon.js";
import { migrateDefaultHome } from "./home.js";
import { log } from "./log.js";
import { ensureToken } from "./token.js";

/** Run the daemon until SIGINT/SIGTERM. Migrates ~/.chromeuse first when using the default home. */
export async function runDaemon(): Promise<void> {
  const home = resolveHome();
  const migrated = migrateDefaultHome(home);
  if (migrated.status === "migrated") {
    log.info(`migrated ${migrated.moved.length} item(s) from the ChromeUse home into ${home}`);
  }
  const loaded = loadEnvFile(home);
  if (loaded.length) log.info(`loaded ${loaded.length} variable(s) from ${join(home, "env")}`);
  const config = loadConfig();
  const daemon = await startDaemon(config, { envFileVars: loaded });
  let stopping = false;
  const stop = (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info(`received ${signal}, shutting down`);
    daemon.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));
}

/** Print the token (creating it if needed). The only command that prints it. */
export function printToken(write: (s: string) => void = (s) => process.stdout.write(s)): void {
  const home = resolveHome();
  migrateDefaultHome(home);
  write(`${ensureToken(home)}\n`);
}
