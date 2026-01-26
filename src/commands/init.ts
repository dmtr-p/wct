import { join } from "node:path";
import { CONFIG_FILENAME } from "../config/loader";
import * as logger from "../utils/logger";

const TEMPLATE = `# wct configuration
# See documentation at: https://github.com/your-org/wct
version: 1

# Base directory for worktrees (supports ~ expansion)
worktree_dir: "../worktrees"

# Project name (used for tmux session naming: "project-branch")
# project_name: "myapp"

# Files/directories to copy to new worktree
copy:
  - .env
  - .env.local
  # - CLAUDE.md
  # - .vscode/settings.json

# Commands to run after worktree creation (in order)
setup:
  - name: "Install dependencies"
    command: "bun install"
  # - name: "Generate types"
  #   command: "bun run codegen"
  #   optional: true  # continue if fails

# IDE command (environment variables available: WCT_WORKTREE_DIR, WCT_MAIN_DIR, WCT_BRANCH, WCT_PROJECT)
ide:
  command: "code $WCT_WORKTREE_DIR"
  # command: "cursor $WCT_WORKTREE_DIR"

# Tmux session configuration
tmux:
  # Layout: "panes" (splits in one window) or "windows" (separate windows)
  layout: "panes"

  # For "panes" layout - split direction: "horizontal" or "vertical"
  split: "horizontal"

  # Panes/windows to create
  panes:
    - name: "dev"
      command: "bun run dev"
    - name: "shell"
      command: ""  # empty = just a shell
`;

export async function initCommand(): Promise<void> {
	const cwd = process.cwd();
	const configPath = join(cwd, CONFIG_FILENAME);

	const file = Bun.file(configPath);
	if (await file.exists()) {
		logger.warn(`${CONFIG_FILENAME} already exists`);
		return;
	}

	await Bun.write(configPath, TEMPLATE);
	logger.success(`Created ${CONFIG_FILENAME}`);
	logger.info("Edit the config file to customize your workflow");
}
