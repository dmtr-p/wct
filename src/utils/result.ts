export type ErrorCode =
  | "not_git_repo"
  | "config_error"
  | "config_not_found"
  | "invalid_options"
  | "branch_not_found"
  | "base_branch_not_found"
  | "worktree_error"
  | "worktree_not_found"
  | "worktree_remove_failed"
  | "tmux_error"
  | "detached_head"
  | "missing_main_worktree"
  | "missing_branch_arg"
  | "missing_shell_arg"
  | "unsupported_shell"
  | "unknown_command";

export interface CommandError {
  message: string;
  code: ErrorCode;
}

export type CommandResult<T = void> = T extends void
  ? { success: true } | { success: false; error: CommandError }
  : { success: true; data: T } | { success: false; error: CommandError };

export function ok(): CommandResult<void>;
export function ok<T>(data: T): CommandResult<T>;
export function ok<T = void>(data?: T): CommandResult<T> {
  if (data === undefined) {
    return { success: true } as CommandResult<T>;
  }
  return { success: true, data } as CommandResult<T>;
}

export function err<T = void>(
  message: string,
  code: ErrorCode,
): CommandResult<T> {
  return { success: false, error: { message, code } } as CommandResult<T>;
}
