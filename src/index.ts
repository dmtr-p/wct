import { parseArgs } from "node:util";
import { closeCommand } from "./commands/close";
import { completionsCommand } from "./commands/completions";
import { downCommand } from "./commands/down";
import { initCommand } from "./commands/init";
import { listCommand } from "./commands/list";
import { openCommand } from "./commands/open";
import { COMMANDS } from "./commands/registry";
import { upCommand } from "./commands/up";
import * as logger from "./utils/logger";

const { version: VERSION } = require("../package.json");

function buildHelp(): string {
  const commandLines = COMMANDS.map((cmd) => {
    const label = cmd.args ? `${cmd.name} ${cmd.args}` : cmd.name;
    return `  ${label.padEnd(18)}${cmd.description}`;
  });

  const optionLines: string[] = [];
  for (const cmd of COMMANDS) {
    if (!cmd.options) continue;
    for (const opt of cmd.options) {
      const short = opt.short ? `-${opt.short}, ` : "    ";
      const long =
        opt.type === "string"
          ? `--${opt.name} <${opt.placeholder ?? opt.name}>`
          : `--${opt.name}`;
      const suffix = `(for '${cmd.name}' command)`;
      optionLines.push(
        `  ${short}${long.padEnd(17)}${opt.description} ${suffix}`,
      );
    }
  }
  optionLines.push("  -h, --help           Show this help message");
  optionLines.push("  -v, --version        Show version number");

  return `
wct - Git worktree workflow automation

Usage:
  wct <command> [options]

Commands:
${commandLines.join("\n")}

Options:
${optionLines.join("\n")}

Examples:
  wct init                         Create a new .wct.yaml config file
  wct open feature-auth            Create new worktree and branch from HEAD
  wct up                           Start tmux + IDE in current directory
  wct down                         Kill tmux session for current directory
  wct open feature-auth -e         Use existing branch
  wct open feature-auth -b main    Create new branch based on 'main'
  wct close feature-auth           Close worktree (with confirmation)
  wct close feature-auth -y        Skip confirmation
  wct list                         Show all worktrees and their status
`;
}

const HELP = buildHelp();

function buildParseArgsOptions(): Record<
  string,
  { type: "boolean" | "string"; short?: string }
> {
  const options: Record<
    string,
    { type: "boolean" | "string"; short?: string }
  > = {
    help: { type: "boolean", short: "h" },
    version: { type: "boolean", short: "v" },
  };
  for (const cmd of COMMANDS) {
    if (!cmd.options) continue;
    for (const opt of cmd.options) {
      options[opt.name] = { type: opt.type };
      if (opt.short) {
        options[opt.name].short = opt.short;
      }
    }
  }
  return options;
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    args: Bun.argv.slice(2),
    options: buildParseArgsOptions(),
    allowPositionals: true,
  });

  if (values.version) {
    console.log(`wct version ${VERSION}`);
    return;
  }

  if (values.help || positionals.length === 0) {
    console.log(HELP);
    return;
  }

  const command = positionals[0];

  switch (command) {
    case "init":
      await initCommand();
      break;

    case "up":
      await upCommand({ noIde: !!values["no-ide"] });
      break;

    case "down":
      await downCommand();
      break;

    case "list":
      await listCommand();
      break;

    case "open": {
      const branch = positionals[1];
      if (!branch) {
        logger.error("Missing branch name");
        console.log(
          "\nUsage: wct open <branch> [-e|--existing] [-b|--base <branch>]",
        );
        process.exit(1);
      }
      await openCommand({
        branch,
        existing: !!values.existing,
        base: values.base as string | undefined,
        noIde: !!values["no-ide"],
      });
      break;
    }

    case "close": {
      const branch = positionals[1];
      if (!branch) {
        logger.error("Missing branch name");
        console.log("\nUsage: wct close <branch> [-y|--yes] [-f|--force]");
        process.exit(1);
      }
      await closeCommand({
        branch,
        yes: !!values.yes,
        force: !!values.force,
      });
      break;
    }

    case "completions":
      completionsCommand(positionals[1]);
      break;

    default:
      logger.error(`Unknown command: ${command}`);
      console.log(HELP);
      process.exit(1);
  }
}

main().catch((err) => {
  logger.error(err.message ?? String(err));
  process.exit(1);
});
