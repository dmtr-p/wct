import { basename, join } from "node:path";
import { Effect, FileSystem } from "effect";
import { CONFIG_FILENAME } from "../config/loader";
import type { WctServices } from "../effect/services";
import { commandError, type WctError } from "../errors";
import { RegistryService } from "../services/registry-service";
import { WorktreeService } from "../services/worktree-service";
import * as logger from "../utils/logger";
import type { CommandDef } from "./command-def";

export const commandDef: CommandDef = {
  name: "init",
  description: "Generate a starter .wct.yaml config file",
};

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

export function initCommand(): Effect.Effect<void, WctError, WctServices> {
  return Effect.gen(function* () {
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

    // Auto-register repo in TUI registry
    const mainDir = yield* Effect.catch(
      WorktreeService.use((service) => service.getMainRepoPath()),
      () => Effect.succeed(null),
    );
    if (mainDir) {
      yield* Effect.catch(
        RegistryService.use((service) =>
          service.register(mainDir, basename(mainDir)),
        ),
        () => Effect.void,
      );
    }

    yield* logger.info("Edit the config file to customize your workflow");
  });
}
