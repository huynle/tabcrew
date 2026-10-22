import { ensureToken } from "../token.js";
import { migrateDefaultHome } from "../home.js";
import { doctor } from "./doctor.js";
import { tabcrewPaths } from "./paths.js";
import { runMcp } from "./mcp.js";
import { installAll, setup } from "./setup.js";
import type { System } from "./system.js";
import { uninstall } from "./uninstall.js";

export const CLI_USAGE = `usage: tabcrew <command> [options]

commands:
  setup       install the daemon service, pairing host and harness entries
                --yes                  no questions (key from $OPENROUTER_API_KEY)
                --no-harness           skip OpenCode / Claude Code
                --from-source <repo>   run from a built checkout (development)
  doctor      check the installation   (--online also validates the OpenRouter key)
  token       print the auth token
  mcp         MCP stdio server for hub mode (locked-down Chrome; no service, no ~/.tabcrew)
                --port N               extension port for a newly started hub (default 8775)
                --idle-minutes N       a new hub exits N minutes after its last client (default 10)
                reset-pin              forget the hub pin, then "Trust this hub" in the popup
  update      reinstall the runtime from this package and restart the service
  uninstall   remove the service, pairing host and runtime
                --purge                also delete token, env, sessions and logs
                --yes                  also remove harness entries without asking
  help        show this help

Home: $TABCREW_HOME or ~/.tabcrew.`;

interface Flags {
  readonly yes: boolean;
  readonly noHarness: boolean;
  readonly purge: boolean;
  readonly online: boolean;
  readonly fromSource?: string;
}

const ALLOWED: Record<string, readonly string[]> = {
  setup: ["--yes", "-y", "--no-harness", "--from-source"],
  doctor: ["--online"],
  token: [],
  update: ["--from-source"],
  uninstall: ["--purge", "--yes", "-y"],
  // Parsed by parseMcpArgs (values, a subcommand, and errors that must stay off stdout).
  mcp: ["--port", "--idle-minutes", "reset-pin", "--help", "-h"],
};

function parseFlags(command: string, args: readonly string[]): Flags | string {
  let yes = false;
  let noHarness = false;
  let purge = false;
  let online = false;
  let fromSource: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const [name, inline] = arg.startsWith("--") && arg.includes("=") ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)] : [arg, undefined];
    if (!ALLOWED[command].includes(name)) return `unknown option for ${command}: ${arg}`;
    if (name === "--yes" || name === "-y") yes = true;
    else if (name === "--no-harness") noHarness = true;
    else if (name === "--purge") purge = true;
    else if (name === "--online") online = true;
    else if (name === "--from-source") {
      fromSource = inline ?? args[++i];
      if (!fromSource) return "--from-source needs a repository directory";
    }
  }
  return { yes, noHarness, purge, online, fromSource };
}

export async function cliMain(argv: readonly string[], sys: System): Promise<number> {
  const [command, ...rest] = argv;
  if (command === undefined || command === "help" || command === "--help" || command === "-h") {
    sys.out(CLI_USAGE);
    return command === undefined ? 2 : 0;
  }
  if (!(command in ALLOWED)) {
    sys.out(`unknown command: ${command}\n\n${CLI_USAGE}`);
    return 2;
  }
  if (command === "mcp") {
    // stdout is the MCP channel here: runMcp writes only relayed bytes to it (diagnostics -> stderr).
    return runMcp(rest, {
      pathOptions: { env: sys.env, home: sys.homedir, uid: sys.uid, platform: sys.platform },
      runtimeDir: sys.runtimeDir,
      out: sys.out,
    });
  }
  const flags = parseFlags(command, rest);
  if (typeof flags === "string") {
    sys.out(flags);
    return 2;
  }
  switch (command) {
    case "setup":
      return setup(sys, { yes: flags.yes, harness: !flags.noHarness, fromSource: flags.fromSource });
    case "doctor":
      return doctor(sys, { online: flags.online });
    case "token": {
      const paths = tabcrewPaths(sys);
      migrateDefaultHome(paths.home, sys.homedir);
      sys.out(ensureToken(paths.home));
      return 0;
    }
    case "update": {
      const paths = tabcrewPaths(sys);
      ensureToken(paths.home);
      const ok = await installAll(sys, paths, flags.fromSource);
      return ok ? 0 : 1;
    }
    case "uninstall":
      return uninstall(sys, { purge: flags.purge, yes: flags.yes });
  }
  return 2;
}
