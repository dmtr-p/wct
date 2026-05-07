import { Data } from "effect";

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
  | "unknown_command"
  | "init_error"
  | "pr_error"
  | "gh_not_installed"
  | "registry_error"
  | "pr_cache_error";

export class WctCommandError extends Data.TaggedError("WctCommandError")<{
  code: ErrorCode | "unexpected_error";
  details: string;
  cause?: unknown;
}> {
  override get message(): string {
    return this.details;
  }
}

export type WctError = WctCommandError;

export function commandError(
  code: ErrorCode | "unexpected_error",
  details: string,
  cause?: unknown,
): WctCommandError {
  return new WctCommandError({ code, details, cause });
}

export function toWctError(
  error: unknown,
  fallback = "Unexpected command failure",
): WctCommandError {
  if (error instanceof WctCommandError) {
    return error;
  }

  if (error instanceof Error) {
    return commandError("unexpected_error", error.message || fallback, error);
  }

  return commandError(
    "unexpected_error",
    typeof error === "string" ? error : fallback,
    error,
  );
}
