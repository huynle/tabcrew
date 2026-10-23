import { runHub } from "./hub/main.js";
import { log } from "./log.js";
import { printToken, runDaemon } from "./serve.js";

// Entry point of the installed runtime (~/.tabcrew/app/daemon.mjs), started by launchd.
const USAGE = `usage: daemon.mjs [run|hub|token|help]

  (none), run   run the TabCrew daemon
  hub           run a hub for \`tabcrew mcp\` (no launchd, no ~/.tabcrew; see: hub --help)
  token         print the auth token
  help          show this help

Home is $TABCREW_HOME or ~/.tabcrew. Manage the service with: npx tabcrew setup | doctor | uninstall`;

/** Let stdout/stderr drain, but never linger after the hub stopped (a stray handle must not keep it alive). */
function exitAfterHub(code: number): void {
  process.exitCode = code;
  setTimeout(() => process.exit(code), 2_000).unref();
}

async function main(command: string | undefined): Promise<void> {
  switch (command) {
    case "hub":
      exitAfterHub(await runHub(process.argv.slice(3)));
      return;
    case undefined:
    case "run":
      await runDaemon();
      return;
    case "token":
      printToken();
      return;
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(`${USAGE}\n`);
      return;
    default:
      process.stderr.write(`unknown command: ${command}\n${USAGE}\n`);
      process.exitCode = 2;
  }
}

main(process.argv[2]).catch((err) => {
  log.error(`fatal: ${(err as Error).message}`);
  process.exit(1);
});
