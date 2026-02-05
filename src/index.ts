import { parseArgs } from "node:util";
import { closeCommand } from "./commands/close";
import { initCommand } from "./commands/init";
import { listCommand } from "./commands/list";
import { openCommand } from "./commands/open";
import * as logger from "./utils/logger";

const VERSION = "0.1.0";

const HELP = `
wct - Git worktree workflow automation

Usage:
  wct <command> [options]

Commands:
  open <branch>     Create worktree, run setup, start tmux session, open IDE
  close <branch>    Kill tmux session and remove worktree
  list              Show active worktrees with tmux session status
  init              Generate a starter .wct.yaml config file

Options:
  -e, --existing       Use existing branch (for 'open' command)
  -b, --base <branch>  Base branch for new worktree (for 'open' command, default: HEAD)
  -y, --yes            Skip confirmation prompt (for 'close' command)
  -f, --force          Force removal even if worktree is dirty (for 'close' command)
  -h, --help           Show this help message
  -v, --version        Show version number

Examples:
  wct init                         Create a new .wct.yaml config file
  wct open feature-auth            Create new worktree and branch from HEAD
  wct open feature-auth -e         Use existing branch
  wct open feature-auth -b main    Create new branch based on 'main'
  wct close feature-auth           Close worktree (with confirmation)
  wct close feature-auth -y        Skip confirmation
  wct list                         Show all worktrees and their status
`;

async function main(): Promise<void> {
	const { values, positionals } = parseArgs({
		args: Bun.argv.slice(2),
		options: {
			help: { type: "boolean", short: "h" },
			version: { type: "boolean", short: "v" },
			existing: { type: "boolean", short: "e" },
			base: { type: "string", short: "b" },
			yes: { type: "boolean", short: "y" },
			force: { type: "boolean", short: "f" },
		},
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

		case "list":
			await listCommand();
			break;

		case "open": {
			const branch = positionals[1];
			if (!branch) {
				logger.error("Missing branch name");
				console.log("\nUsage: wct open <branch> [-e|--existing]");
				process.exit(1);
			}
			await openCommand({
				branch,
				existing: !!values.existing,
				base: values.base,
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
