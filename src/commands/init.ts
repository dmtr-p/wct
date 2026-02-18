import { join } from "node:path";
import { CONFIG_FILENAME } from "../config/loader";
import * as logger from "../utils/logger";
import { type CommandResult, err, ok } from "../utils/result";

const TEMPLATE = `# wct configuration
# See documentation at: https://github.com/dmtr-p/wct
version: 1

# Base directory for worktrees (supports ~ expansion)
worktree_dir: ".."

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
  name: vscode
  command: "code $WCT_WORKTREE_DIR"
  # command: "cursor $WCT_WORKTREE_DIR"
  # fork_workspace: true  # (vscode only) copy VS Code workspace state to worktree; requires main repo opened in VS Code once

# Tmux session configuration
tmux:
  windows:
    - name: "dev"
      split: "horizontal"
      panes:
        - command: "bun run dev"
        - {}  # empty shell
    # - name: "shell"
    #   command: ""
`;

export async function initCommand(): Promise<CommandResult> {
  const cwd = process.cwd();
  const configPath = join(cwd, CONFIG_FILENAME);

  const file = Bun.file(configPath);
  if (await file.exists()) {
    logger.warn(`${CONFIG_FILENAME} already exists`);
    return ok();
  }

  try {
    await Bun.write(configPath, TEMPLATE);
  } catch (e) {
    return err(
      `Failed to create ${CONFIG_FILENAME}: ${e instanceof Error ? e.message : String(e)}`,
      "init_error",
    );
  }

  logger.success(`Created ${CONFIG_FILENAME}`);
  logger.info("Edit the config file to customize your workflow");
  return ok();
}
