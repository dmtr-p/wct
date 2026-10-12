import { join } from "node:path";
import { Effect, FileSystem } from "effect";
import { CONFIG_FILENAME } from "../config/loader";
import type { WctServices } from "../effect/services";
import { commandError, type WctError } from "../errors";
import * as logger from "../utils/logger";

export { initCommandDef as commandDef } from "../cli/command-metadata";

const TEMPLATE = `# wct configuration
# See documentation at: https://github.com/dmtr-p/wct
version: 1

# Base directory for worktrees (supports ~ expansion)
worktree_dir: ".."

# Prefix for worktree directory names created by wct open
# project_name: "myapp"

# Directory used for setup/down commands and tmux panes (relative to each worktree)
# work_dir: "apps/web"

# Gitignored files/directories to copy from the main repository during Open
copy:
  - .env
  - .env.local

# Commands to run during open, before starting tmux (in order)
setup:
  - name: "Install dependencies"
    command: "bun install"
  # - name: "Generate types"
  #   command: "bun run codegen"
  #   optional: true  # report failures as optional warnings

# Commands to run after stopping tmux, before worktree removal (in order)
# down:
#   - name: "Stop containers"
#     command: "docker compose down"

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

export const initCommand: Effect.Effect<void, WctError, WctServices> =
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const cwd = process.cwd();
    const configPath = join(cwd, CONFIG_FILENAME);

    const exists = yield* Effect.mapError(fs.exists(configPath), (error) =>
      commandError(
        "init_error",
        `Failed to check for existing ${CONFIG_FILENAME}`,
        error,
      ),
    );

    if (exists) {
      yield* logger.warn(`${CONFIG_FILENAME} already exists`);
      return;
    }

    yield* Effect.mapError(fs.writeFileString(configPath, TEMPLATE), (error) =>
      commandError(
        "init_error",
        `Failed to create ${CONFIG_FILENAME}: ${error instanceof Error ? error.message : String(error)}`,
        error,
      ),
    );

    yield* logger.success(`Created ${CONFIG_FILENAME}`);
    yield* logger.info("Run 'wct projects add' to show this repo in the TUI");
    yield* logger.info("Edit the config file to customize your workflow");
  });
