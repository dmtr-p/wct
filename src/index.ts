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
import { type CommandResult, err } from "./utils/result";

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
      const optConfig: { type: "boolean" | "string"; short?: string } = {
        type: opt.type,
      };
      if (opt.short) {
        optConfig.short = opt.short;
      }
      options[opt.name] = optConfig;
    }
  }
  return options;
}

function handleResult(result: CommandResult): void {
  if (!result.success) {
    logger.error(result.error.message);
    process.exit(1);
  }
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
    case "init": {
      await initCommand();
      break;
    }

    case "up": {
      const result = await upCommand({ noIde: !!values["no-ide"] });
      handleResult(result);
      break;
    }

    case "down": {
      const result = await downCommand();
      handleResult(result);
      break;
    }

    case "list": {
      await listCommand();
      break;
    }

    case "open": {
      const branch = positionals[1];
      if (!branch) {
        handleResult(
          err(
            "Missing branch name\n\nUsage: wct open <branch> [-e|--existing] [-b|--base <branch>]",
            "missing_branch_arg",
          ),
        );
        return;
      }
      const result = await openCommand({
        branch,
        existing: !!values.existing,
        base: values.base as string | undefined,
        noIde: !!values["no-ide"],
      });
      handleResult(result);
      break;
    }

    case "close": {
      const branch = positionals[1];
      if (!branch) {
        handleResult(
          err(
            "Missing branch name\n\nUsage: wct close <branch> [-y|--yes] [-f|--force]",
            "missing_branch_arg",
          ),
        );
        return;
      }
      const result = await closeCommand({
        branch,
        yes: !!values.yes,
        force: !!values.force,
      });
      handleResult(result);
      break;
    }

    case "completions": {
      const result = completionsCommand(positionals[1]);
      handleResult(result);
      break;
    }

    default: {
      handleResult(
        err(`Unknown command: ${command}\n${HELP}`, "unknown_command"),
      );
      break;
    }
  }
}

main().catch((err) => {
  logger.error(err.message ?? String(err));
  process.exit(1);
});
