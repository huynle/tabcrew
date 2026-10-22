#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CLI_USAGE, cliMain } from "./cli/main.js";
import { realSystem } from "./cli/system.js";
import { runHub } from "./hub/main.js";
import { log } from "./log.js";
import { runDaemon } from "./serve.js";

// Development entry (daemon/dist/index.js): no command runs the daemon; other commands are the
// `tabcrew` CLI, using the bundles in <repo>/cli/dist for setup/update.
const USAGE = `usage: tabcrew-daemon [run | <tabcrew command>]

  (none), run   run the TabCrew daemon in the foreground
  hub           run a hub for \`tabcrew mcp\` in the foreground (see: hub --help)

${CLI_USAGE}`;

async function main(argv: string[]): Promise<void> {
  const command = argv[0];
  if (command === undefined || command === "run") {
    await runDaemon();
    return;
  }
  if (command === "hub") {
    const code = await runHub(argv.slice(1));
    process.exitCode = code;
    // Never linger after the hub stopped (a stray handle must not keep it alive).
    setTimeout(() => process.exit(code), 2_000).unref();
    return;
  }
  if (command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  const here = dirname(realpathSync(fileURLToPath(import.meta.url)));
  process.exitCode = await cliMain(argv, realSystem(join(here, "..", "..", "cli", "dist")));
}

main(process.argv.slice(2)).catch((err) => {
  log.error(`fatal: ${(err as Error).message}`);
  process.exit(1);
});
