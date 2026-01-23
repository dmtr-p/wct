import { parseArgs } from "node:util";
import { initCommand } from "./commands/init";
import { listCommand } from "./commands/list";
import { openCommand } from "./commands/open";
import * as logger from "./utils/logger";

const VERSION = "0.1.0";

const HELP = `
tab - Git worktree workflow automation

Usage:
  tab <command> [options]

Commands:
  open <branch>    Create worktree, run setup, start tmux session, open IDE
  list             Show active worktrees with tmux session status
  init             Generate a starter .tabrc.yaml config file

Options:
  -e, --existing   Use existing branch (for 'open' command)
  -h, --help       Show this help message
  -v, --version    Show version number

Examples:
  tab init                  Create a new .tabrc.yaml config file
  tab open feature-auth     Create new worktree and branch
  tab open feature-auth -e  Use existing branch
  tab list                  Show all worktrees and their status
`;

async function main(): Promise<void> {
	const { values, positionals } = parseArgs({
		args: Bun.argv.slice(2),
		options: {
			help: { type: "boolean", short: "h" },
			version: { type: "boolean", short: "v" },
			existing: { type: "boolean", short: "e" },
		},
		allowPositionals: true,
	});

	if (values.version) {
		console.log(`tab version ${VERSION}`);
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
				console.log("\nUsage: tab open <branch> [-e|--existing]");
				process.exit(1);
			}
			await openCommand({ branch, existing: !!values.existing });
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
