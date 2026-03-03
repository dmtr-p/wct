import { findWorktreeByBranch, isGitRepo } from "../services/worktree";
import * as logger from "../utils/logger";
import { type CommandResult, err, ok } from "../utils/result";
import type { CommandDef } from "./registry";

export const commandDef: CommandDef = {
  name: "cd",
  description: "Open a shell in a worktree directory",
  args: "<branch>",
  completionType: "worktree",
};

export async function cdCommand(branch: string): Promise<CommandResult> {
  if (!(await isGitRepo())) {
    return err("Not a git repository", "not_git_repo");
  }

  const worktree = await findWorktreeByBranch(branch);
  if (!worktree) {
    return err(
      `No worktree found for branch '${branch}'. Try: wct open ${branch}`,
      "worktree_not_found",
    );
  }

  const shell = process.env.SHELL ?? "/bin/sh";

  logger.info(`Entering ${worktree.path} (exit to return)`);

  const proc = Bun.spawn([shell], {
    cwd: worktree.path,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });

  await proc.exited;

  return ok();
}
