import type { Key } from "ink";
import { Mode, type Mode as TuiMode } from "../types";

export interface ConfirmCloseContext {
  mode: TuiMode;
  returnMode: TuiMode;
  returnSelectedIndex: number;
  setMode: (mode: TuiMode) => void;
  setSelectedIndex: (index: number) => void;
  executeClose: (
    sessionName: string,
    branch: string,
    worktreePath: string,
    worktreeKey: string,
    repoPath: string,
    project: string,
    force: boolean,
  ) => void;
}

export function handleConfirmCloseInput(
  ctx: ConfirmCloseContext,
  _input: string,
  key: Key,
) {
  const { mode } = ctx;
  if (mode.type !== "ConfirmClose" && mode.type !== "ConfirmCloseForce") {
    return;
  }

  if (key.escape) {
    ctx.setSelectedIndex(ctx.returnSelectedIndex);
    ctx.setMode(ctx.returnMode);
    return;
  }

  if (key.return) {
    if (mode.type === "ConfirmClose" && mode.changedFiles > 0) {
      ctx.setMode(
        Mode.ConfirmCloseForce(
          mode.sessionName,
          mode.branch,
          mode.worktreePath,
          mode.worktreeKey,
          mode.repoPath,
          mode.project,
        ),
      );
      return;
    }

    ctx.executeClose(
      mode.sessionName,
      mode.branch,
      mode.worktreePath,
      mode.worktreeKey,
      mode.repoPath,
      mode.project,
      mode.type === "ConfirmCloseForce",
    );
  }
}
