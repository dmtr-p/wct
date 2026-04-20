// src/tui/hooks/useModalActions.ts

import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type { StartWorktreeSessionResult } from "../../commands/worktree-session";
import { startWorktreeSession } from "../../commands/worktree-session";
import { toWctError } from "../../errors";
import type { OpenModalResult } from "../components/OpenModal";
import type { UpModalResult } from "../components/UpModal";
import { tuiRuntime } from "../runtime";
import { resolveSelectedWorktreeIndex } from "../tree-helpers";
import {
  Mode,
  type PendingAction,
  type PRInfo,
  pendingKey,
  type TreeItem,
} from "../types";
import type { RepoInfo } from "./useRegistry";

export interface ModalActionDeps {
  treeItems: TreeItem[];
  filteredRepos: RepoInfo[];
  selectedIndex: number;
  mode: Mode;
  prData: Map<string, PRInfo>;

  openModalRepoProject: string;
  openModalRepoPath: string;

  setMode: (m: Mode) => void;
  setSelectedIndex: Dispatch<SetStateAction<number>>;
  setPendingActions: Dispatch<SetStateAction<Map<string, PendingAction>>>;
  setOpenModalBase: (v: string | undefined) => void;
  setOpenModalProfiles: (v: string[]) => void;
  setOpenModalRepoProject: (v: string) => void;
  setOpenModalRepoPath: (v: string) => void;
  setOpenModalPRList: (v: PRInfo[]) => void;

  showActionError: (msg: string) => void;
  clearActionError: () => void;
  handleStartResult: (
    result: StartWorktreeSessionResult,
    autoSwitch: boolean,
  ) => Promise<void>;
  refreshAll: () => Promise<void>;

  upModalReturnModeRef: MutableRefObject<Mode>;
  upModalReturnSelectedIndexRef: MutableRefObject<number>;
}

export function createPrepareOpenModal(deps: ModalActionDeps) {
  return () => {
    const selected = deps.treeItems[deps.selectedIndex];
    let base: string | undefined;
    let profiles: string[] = [];
    let project = "";
    let repoPath = "";
    if (selected) {
      const repo = deps.filteredRepos[selected.repoIndex];
      if (repo) {
        profiles = repo.profileNames;
        project = repo.project;
        repoPath = repo.repoPath;
      }
      if (
        repo &&
        (selected.type === "worktree" || selected.type === "detail")
      ) {
        const wt = repo.worktrees[selected.worktreeIndex];
        if (wt) {
          base = wt.branch;
        }
      }
    }
    deps.setOpenModalBase(base);
    deps.setOpenModalProfiles(profiles);
    deps.setOpenModalRepoProject(project);
    deps.setOpenModalRepoPath(repoPath);
    const prs: PRInfo[] = [];
    for (const [key, pr] of deps.prData) {
      if (key.startsWith(`${project}/`)) {
        prs.push(pr);
      }
    }
    deps.setOpenModalPRList(prs);
    deps.setMode(Mode.OpenModal);
  };
}

export function createHandleOpen(deps: ModalActionDeps) {
  return (opts: OpenModalResult) => {
    deps.setMode(Mode.Navigate);
    const args = ["open", opts.branch];
    if (opts.base) args.push("--base", opts.base);
    if (opts.pr) args.push("--pr", opts.pr);
    if (opts.profile) args.push("--profile", opts.profile);
    if (opts.prompt) args.push("--prompt", opts.prompt);
    if (opts.existing) args.push("--existing");
    if (opts.noIde) args.push("--no-ide");
    if (opts.noAttach) args.push("--no-attach");

    const project = deps.openModalRepoProject || "unknown";
    const key = pendingKey(project, opts.branch);
    deps.setPendingActions((prev) =>
      new Map(prev).set(key, {
        type: "opening",
        branch: opts.branch,
        project,
      }),
    );

    const clearPending = () => {
      deps.setPendingActions((prev) => {
        const next = new Map(prev);
        next.delete(key);
        return next;
      });
    };

    let proc: ReturnType<typeof Bun.spawn>;
    try {
      proc = Bun.spawn(["wct", ...args], {
        cwd: deps.openModalRepoPath || undefined,
        stdout: "ignore",
        stderr: "ignore",
      });
    } catch (error) {
      deps.showActionError(toWctError(error).message);
      clearPending();
      return;
    }

    proc.exited
      .then((code) => {
        if (code !== 0) {
          // Show error briefly, then clear
          setTimeout(clearPending, 5000);
        } else {
          // Success: trigger immediate refresh so real worktree appears
          deps
            .refreshAll()
            .catch((error) => {
              deps.showActionError(toWctError(error).message);
            })
            .finally(clearPending);
        }
      })
      .catch((error) => {
        deps.showActionError(toWctError(error).message);
        clearPending();
      });
  };
}

export function createPrepareUpModal(deps: ModalActionDeps) {
  return () => {
    const worktreeIndex = resolveSelectedWorktreeIndex(
      deps.treeItems,
      deps.selectedIndex,
    );
    if (worktreeIndex === null) return;

    const item = deps.treeItems[worktreeIndex];
    if (!item || item.type !== "worktree") return;

    const repo = deps.filteredRepos[item.repoIndex];
    const wt = repo?.worktrees[item.worktreeIndex];
    if (!repo || !wt) return;

    const worktreeKey = pendingKey(repo.project, wt.branch);
    deps.upModalReturnSelectedIndexRef.current = deps.selectedIndex;
    deps.upModalReturnModeRef.current =
      deps.mode.type === "Expanded"
        ? Mode.Expanded(worktreeKey)
        : Mode.Navigate;
    deps.setMode(Mode.UpModal(wt.path, worktreeKey, repo.profileNames));
  };
}

export function createHandleUpSubmit(deps: ModalActionDeps) {
  return (result: UpModalResult) => {
    if (deps.mode.type !== "UpModal") return;

    const { worktreePath, worktreeKey } = deps.mode;
    deps.clearActionError();
    deps.setSelectedIndex(deps.upModalReturnSelectedIndexRef.current);
    deps.setMode(deps.upModalReturnModeRef.current);

    const branch = worktreeKey.split("/").slice(1).join("/");
    const project = worktreeKey.split("/")[0] ?? "unknown";
    deps.setPendingActions((prev) =>
      new Map(prev).set(worktreeKey, {
        type: "starting",
        branch,
        project,
      }),
    );

    void (async () => {
      try {
        const startResult = await tuiRuntime.runPromise(
          startWorktreeSession({
            path: worktreePath,
            profile: result.profile,
            noIde: result.noIde,
          }),
        );
        await deps.handleStartResult(startResult, result.autoSwitch);
      } catch (error) {
        deps.showActionError(toWctError(error).message);
        await deps.refreshAll();
      } finally {
        deps.setPendingActions((prev) => {
          const next = new Map(prev);
          next.delete(worktreeKey);
          return next;
        });
      }
    })();
  };
}

export function useModalActions(deps: ModalActionDeps) {
  return {
    prepareOpenModal: createPrepareOpenModal(deps),
    handleOpen: createHandleOpen(deps),
    prepareUpModal: createPrepareUpModal(deps),
    handleUpSubmit: createHandleUpSubmit(deps),
  };
}
