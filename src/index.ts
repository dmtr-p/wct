import { parseArgs } from "node:util";
import { closeCommand } from "./commands/close";
import { completionsCommand } from "./commands/completions";
import { downCommand } from "./commands/down";
import { initCommand } from "./commands/init";
import { listCommand } from "./commands/list";
import { openCommand } from "./commands/open";
import { COMMANDS } from "./commands/registry";
import { statusCommand } from "./commands/status";
import { upCommand } from "./commands/up";
import * as logger from "./utils/logger";
import { type CommandResult, err } from "./utils/result";

const { version: VERSION } = require("../package.json");

type Handler = (
  positionals: string[],
  values: Record<string, unknown>,
) => Promise<CommandResult> | CommandResult;

const HANDLERS: Record<string, Handler> = {
  close: (positionals, values) => {
    const branch = positionals[1];
    if (!branch) {
      return err(
        "Missing branch name\n\nUsage: wct close <branch> [-y|--yes] [-f|--force]",
        "missing_branch_arg",
      );
    }

    return closeCommand({
      branch,
      yes: !!values.yes,
      force: !!values.force,
    });
  },
  completions: (positionals) => completionsCommand(positionals[1]),
  down: () => downCommand(),
  init: () => initCommand(),
  list: () => listCommand(),
  open: (positionals, values) => {
    const branch = positionals[1];
    if (!branch) {
      return err(
        "Missing branch name\n\nUsage: wct open <branch> [-e|--existing] [-b|--base <branch>]",
        "missing_branch_arg",
      );
    }

    return openCommand({
      branch,
      existing: !!values.existing,
      base: values.base as string | undefined,
      noIde: !!values["no-ide"],
    });
  },
  status: () => statusCommand(),
  up: (_positionals, values) => upCommand({ noIde: !!values["no-ide"] }),
};

function buildHelp(): string {
  const commandLabels = COMMANDS.map((cmd) =>
    cmd.args ? `${cmd.name} ${cmd.args}` : cmd.name,
  );
  const labelWidth = Math.max(
    18,
    ...commandLabels.map((label) => label.length),
  );
  const commandLines = COMMANDS.map(
    (cmd, i) => `  ${commandLabels[i].padEnd(labelWidth)}  ${cmd.description}`,
  );

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
  const handler = HANDLERS[command];

  if (!handler) {
    handleResult(
      err(`Unknown command: ${command}\n${HELP}`, "unknown_command"),
    );
    return;
  }

  const result = await handler(positionals, values as Record<string, unknown>);
  handleResult(result);
}

main().catch((err) => {
  logger.error(err.message ?? String(err));
  process.exit(1);
});
