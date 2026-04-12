// src/tui/App.tsx

import { basename } from "node:path";
import { Box, type Key, render, Text, useApp, useInput, useStdout } from "ink";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatSessionName } from "../services/tmux";
import { OpenModal, type OpenModalResult } from "./components/OpenModal";
import { StatusBar } from "./components/StatusBar";
import { TreeView } from "./components/TreeView";
import { useGitHub } from "./hooks/useGitHub";
import { useRefresh } from "./hooks/useRefresh";
import { type RepoInfo, useRegistry } from "./hooks/useRegistry";
import { useTmux } from "./hooks/useTmux";
import {
  Mode,
  type PaneInfo,
  type PendingAction,
  type PRInfo,
  pendingKey,
  type TreeItem,
} from "./types";

interface BuildTreeOptions {
  repos: RepoInfo[];
  expandedRepos: Set<string>;
  expandedWorktreeKey: string | null;
  prData: Map<string, PRInfo>;
  panes: Map<string, PaneInfo[]>;
  jumpToPane: (paneId: string) => void;
}

interface ResolveSelectedPaneOptions {
  repos: RepoInfo[];
  items: TreeItem[];
  panes: Map<string, PaneInfo[]>;
  selectedIndex: number;
}

interface SelectedPaneResolution {
  pane: PaneInfo;
  label: string;
  worktreeKey: string;
}

interface ResolveStatusBarPropsOptions {
  mode: Mode;
  items: TreeItem[];
  selectedIndex: number;
}

interface ResolveExpandedRightArrowActionOptions {
  repos: RepoInfo[];
  items: TreeItem[];
  selectedIndex: number;
  expandedRepos: Set<string>;
}

interface ResolveRecoveredSelectionIndexOptions {
  prevTree: TreeItem[];
  treeItems: TreeItem[];
  prevSelectionId: string | null;
  selectedIndex: number;
  repos: RepoInfo[];
  skipIdentityRecovery?: boolean;
}

interface ResolveCloseSelectedWorktreeActionOptions {
  mode: Mode;
  repos: RepoInfo[];
  items: TreeItem[];
  selectedIndex: number;
}

type ExpandedRightArrowAction =
  | { type: "noop" }
  | { type: "expand-repo"; repoId: string }
  | { type: "expand-worktree"; nextMode: Mode; nextSelectedIndex: number };

type CloseSelectedWorktreeAction =
  | { type: "noop" }
  | {
      type: "close-worktree";
      worktreeIndex: number;
      worktreeKey: string;
      nextMode?: Mode;
      nextSelectedIndex?: number;
    };

export interface ResolvedStatusBarProps {
  mode: Mode;
  selectedPaneRow?: boolean;
}

export function buildTreeItems({
  repos,
  expandedRepos,
  expandedWorktreeKey,
  prData,
  panes,
  jumpToPane,
}: BuildTreeOptions): TreeItem[] {
  const items: TreeItem[] = [];
  for (let ri = 0; ri < repos.length; ri++) {
    const repo = repos[ri];
    if (!repo) {
      continue;
    }

    items.push({ type: "repo", repoIndex: ri });
    if (expandedRepos.has(repo.id)) {
      for (let wi = 0; wi < repo.worktrees.length; wi++) {
        items.push({ type: "worktree", repoIndex: ri, worktreeIndex: wi });

        const wt = repo.worktrees[wi];
        if (!wt) continue;
        const wtKey = pendingKey(repo.project, wt.branch);
        if (wtKey !== expandedWorktreeKey) continue;

        const sessionName = formatSessionName(basename(wt.path));

        // PR data for this worktree
        const pr = prData.get(wtKey);
        if (pr) {
          items.push({
            type: "detail",
            repoIndex: ri,
            worktreeIndex: wi,
            detailKind: "pr",
            label: `PR #${pr.number}: ${pr.title} (${pr.state})`,
            action: () =>
              Bun.spawn(["gh", "pr", "view", "--web", String(pr.number)], {
                cwd: repo.repoPath,
              }),
          });
          for (const check of pr.checks) {
            items.push({
              type: "detail",
              repoIndex: ri,
              worktreeIndex: wi,
              detailKind: "check",
              label: check.name,
              meta: { state: check.state },
            });
          }
        }

        // Panes for this worktree
        const sessionPanes = panes.get(sessionName);
        if (sessionPanes && sessionPanes.length > 0) {
          items.push({
            type: "detail",
            repoIndex: ri,
            worktreeIndex: wi,
            detailKind: "pane-header",
            label: `Panes (${sessionPanes.length})`,
          });
          for (const pane of sessionPanes) {
            items.push({
              type: "detail",
              repoIndex: ri,
              worktreeIndex: wi,
              detailKind: "pane",
              label: `${pane.window}:${pane.paneIndex} ${pane.command}`,
              meta: {
                paneId: pane.paneId,
                zoomed: pane.zoomed,
                active: pane.active,
              },
              action: () => jumpToPane(pane.paneId),
            });
          }
        }
      }
    }
  }
  return items;
}

/**
 * Compute a stable identity string for a tree item using repo id and branch,
 * so selection can be recovered after background refreshes that shift indices.
 */
export function treeItemId(item: TreeItem, repos: RepoInfo[]): string | null {
  const repo = repos[item.repoIndex];
  if (!repo) return null;
  if (item.type === "repo") return `repo:${repo.id}`;
  const wt = repo.worktrees[item.worktreeIndex];
  if (!wt) return null;
  if (item.type === "worktree") return `wt:${repo.id}/${wt.branch}`;
  const base = `detail:${repo.id}/${wt.branch}/${item.detailKind}`;
  if (item.detailKind === "pane" && item.meta?.paneId)
    return `${base}/${item.meta.paneId}`;
  if (item.detailKind === "check") return `${base}/${item.label}`;
  return base;
}

/**
 * Compute the adjusted selectedIndex after all detail rows are removed from the
 * tree (e.g. when exiting Expanded mode or switching expanded worktree).
 *
 * - If the cursor is on a detail row, snap to its parent worktree.
 * - Otherwise subtract the number of detail rows before the cursor.
 */
export function adjustIndexForDetailCollapse(
  items: TreeItem[],
  selectedIndex: number,
): number {
  const current = items[selectedIndex];

  if (current?.type === "detail") {
    return findOwningWorktreeIndex(items, selectedIndex) ?? 0;
  }

  let detailsBefore = 0;
  for (let i = 0; i < selectedIndex; i++) {
    if (items[i]?.type === "detail") detailsBefore++;
  }
  return selectedIndex - detailsBefore;
}

export function resolveRecoveredSelectionIndex({
  prevTree,
  treeItems,
  prevSelectionId,
  selectedIndex,
  repos,
  skipIdentityRecovery = false,
}: ResolveRecoveredSelectionIndexOptions): number | null {
  if (prevTree === treeItems || !prevSelectionId || skipIdentityRecovery) {
    return null;
  }

  const currentItem = treeItems[selectedIndex];
  if (currentItem && treeItemId(currentItem, repos) === prevSelectionId) {
    return null;
  }

  for (let i = 0; i < treeItems.length; i++) {
    const candidate = treeItems[i];
    if (candidate && treeItemId(candidate, repos) === prevSelectionId) {
      return i;
    }
  }

  if (treeItems.length === 0) {
    return 0;
  }

  if (selectedIndex >= treeItems.length) {
    return treeItems.length - 1;
  }

  return null;
}

export function resolveSelectedWorktreeIndex(
  items: TreeItem[],
  selectedIndex: number,
): number | null {
  const selected = items[selectedIndex];
  if (!selected) {
    return null;
  }

  if (selected.type === "worktree") {
    return selectedIndex;
  }

  if (selected.type === "detail") {
    return findOwningWorktreeIndex(items, selectedIndex);
  }

  return null;
}

export function resolveCloseSelectedWorktreeAction({
  mode,
  repos,
  items,
  selectedIndex,
}: ResolveCloseSelectedWorktreeActionOptions): CloseSelectedWorktreeAction {
  const worktreeIndex = resolveSelectedWorktreeIndex(items, selectedIndex);
  if (worktreeIndex === null) {
    return { type: "noop" };
  }

  const selectedWorktree = items[worktreeIndex];
  if (!selectedWorktree || selectedWorktree.type !== "worktree") {
    return { type: "noop" };
  }

  const repo = repos[selectedWorktree.repoIndex];
  const worktree = repo?.worktrees[selectedWorktree.worktreeIndex];
  if (!repo || !worktree) {
    return { type: "noop" };
  }

  const worktreeKey = pendingKey(repo.project, worktree.branch);
  if (
    (mode.type === "Expanded" ||
      mode.type === "ConfirmKill" ||
      mode.type === "ConfirmDown") &&
    mode.worktreeKey === worktreeKey
  ) {
    return {
      type: "close-worktree",
      worktreeIndex,
      worktreeKey,
      nextMode: Mode.Navigate,
      nextSelectedIndex: adjustIndexForDetailCollapse(items, selectedIndex),
    };
  }

  return {
    type: "close-worktree",
    worktreeIndex,
    worktreeKey,
  };
}

export function resolveExpandedRightArrowAction({
  repos,
  items,
  selectedIndex,
  expandedRepos,
}: ResolveExpandedRightArrowActionOptions): ExpandedRightArrowAction {
  const current = items[selectedIndex];
  if (!current) {
    return { type: "noop" };
  }

  const repo = repos[current.repoIndex];
  if (!repo) {
    return { type: "noop" };
  }

  if (current.type === "repo") {
    if (expandedRepos.has(repo.id)) {
      return { type: "noop" };
    }

    return { type: "expand-repo", repoId: repo.id };
  }

  if (current.type !== "worktree") {
    return { type: "noop" };
  }

  const worktree = repo.worktrees[current.worktreeIndex];
  if (!worktree) {
    return { type: "noop" };
  }

  return {
    type: "expand-worktree",
    nextMode: Mode.Expanded(pendingKey(repo.project, worktree.branch)),
    nextSelectedIndex: adjustIndexForDetailCollapse(items, selectedIndex),
  };
}

export function findOwningWorktreeIndex(
  items: TreeItem[],
  selectedIndex: number,
): number | null {
  const selected = items[selectedIndex];
  if (!selected) {
    return null;
  }

  if (selected.type === "worktree") {
    return selectedIndex;
  }

  if (selected.type !== "detail") {
    return null;
  }

  for (let i = selectedIndex - 1; i >= 0; i--) {
    const candidate = items[i];
    if (candidate?.type === "worktree") {
      return i;
    }
  }

  return null;
}

export function resolveSelectedPane({
  repos,
  items,
  panes,
  selectedIndex,
}: ResolveSelectedPaneOptions): SelectedPaneResolution | null {
  const selected = items[selectedIndex];
  if (
    !selected ||
    selected.type !== "detail" ||
    selected.detailKind !== "pane"
  ) {
    return null;
  }

  const repo = repos[selected.repoIndex];
  const worktree = repo?.worktrees[selected.worktreeIndex];
  if (!repo || !worktree) {
    return null;
  }

  const sessionName = formatSessionName(basename(worktree.path));
  const sessionPanes = panes.get(sessionName);
  if (!sessionPanes) {
    return null;
  }

  const paneId = selected.meta?.paneId;
  if (!paneId) {
    return null;
  }

  const pane = sessionPanes.find((candidate) => candidate.paneId === paneId);

  if (!pane) {
    return null;
  }

  return {
    pane,
    label: selected.label,
    worktreeKey: pendingKey(repo.project, worktree.branch),
  };
}

export function resolveStatusBarProps({
  mode,
  items,
  selectedIndex,
}: ResolveStatusBarPropsOptions): ResolvedStatusBarProps {
  return {
    mode,
    selectedPaneRow:
      items[selectedIndex]?.type === "detail" &&
      items[selectedIndex]?.detailKind === "pane",
  };
}

export function App() {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const termCols = stdout?.columns ?? 80;
  const termRows = stdout?.rows ?? 24;
  const { repos, loading, refresh: refreshRegistry } = useRegistry();
  const { prData } = useGitHub(repos);
  const {
    client,
    sessions,
    panes,
    error: tmuxError,
    switchSession,
    jumpToPane,
    zoomPane,
    killPane,
    refreshSessions,
    discoverClient,
  } = useTmux();

  const [expandedRepos, setExpandedRepos] = useState<Set<string>>(new Set());
  const [didInitialExpand, setDidInitialExpand] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [openModalBase, setOpenModalBase] = useState<string | undefined>();
  const [openModalProfiles, setOpenModalProfiles] = useState<string[]>([]);
  const [openModalRepoProject, setOpenModalRepoProject] = useState("");
  const [openModalRepoPath, setOpenModalRepoPath] = useState("");
  const [mode, setMode] = useState<Mode>(Mode.Navigate);
  const [searchQuery, setSearchQuery] = useState("");
  const [pendingActions, setPendingActions] = useState<
    Map<string, PendingAction>
  >(new Map());
  const confirmDownReturnModeRef = useRef<Mode>(Mode.Navigate);
  const confirmDownReturnSelectedIndexRef = useRef<number>(0);

  // Auto-expand all repos on first load
  useEffect(() => {
    if (!didInitialExpand && repos.length > 0) {
      setExpandedRepos(new Set(repos.map((r) => r.id)));
      setDidInitialExpand(true);
    }
  }, [repos, didInitialExpand]);

  // Reset selection when search query changes
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally re-run on searchQuery change
  useEffect(() => {
    setSelectedIndex(0);
  }, [searchQuery]);

  const filteredRepos = useMemo(() => {
    if (!searchQuery) return repos;
    const q = searchQuery.toLowerCase();
    return repos
      .map((repo) => ({
        ...repo,
        worktrees: repo.worktrees.filter(
          (wt) =>
            wt.branch.toLowerCase().includes(q) ||
            repo.project.toLowerCase().includes(q),
        ),
      }))
      .filter(
        (repo) =>
          repo.worktrees.length > 0 || repo.project.toLowerCase().includes(q),
      );
  }, [repos, searchQuery]);

  const expandedWorktreeKey =
    mode.type === "Expanded" ||
    mode.type === "ConfirmKill" ||
    (mode.type === "ConfirmDown" &&
      confirmDownReturnModeRef.current.type === "Expanded")
      ? mode.worktreeKey
      : null;

  const treeItems = useMemo(
    () =>
      buildTreeItems({
        repos: filteredRepos,
        expandedRepos,
        expandedWorktreeKey,
        prData,
        panes,
        jumpToPane,
      }),
    [
      filteredRepos,
      expandedRepos,
      expandedWorktreeKey,
      prData,
      panes,
      jumpToPane,
    ],
  );

  // Identity-based selection recovery: when the tree structure changes
  // (background refresh, async worktree add/remove), find the previously-
  // selected item by stable identity instead of blindly clamping by length.
  const prevTreeRef = useRef(treeItems);
  const prevSelectionIdRef = useRef<string | null>(null);
  const prevSearchQueryRef = useRef(searchQuery);

  useEffect(() => {
    const prevTree = prevTreeRef.current;
    const prevId = prevSelectionIdRef.current;
    const prevSearchQuery = prevSearchQueryRef.current;
    const searchQueryChanged = prevSearchQuery !== searchQuery;

    // Snapshot current state for the next cycle before any mutations
    prevTreeRef.current = treeItems;
    prevSearchQueryRef.current = searchQuery;

    if (searchQueryChanged) {
      // Search transitions intentionally reset the cursor to the first match.
      prevSelectionIdRef.current = null;
      return;
    }

    const item = treeItems[selectedIndex];
    prevSelectionIdRef.current = item ? treeItemId(item, filteredRepos) : null;

    const recoveredIndex = resolveRecoveredSelectionIndex({
      prevTree,
      treeItems,
      prevSelectionId: prevId,
      selectedIndex,
      repos: filteredRepos,
    });
    if (recoveredIndex !== null && recoveredIndex !== selectedIndex) {
      setSelectedIndex(recoveredIndex);
    }
  }, [treeItems, selectedIndex, filteredRepos, searchQuery]);

  const statusBarProps = resolveStatusBarProps({
    mode,
    items: treeItems,
    selectedIndex,
  });

  const refreshAll = useCallback(async () => {
    await Promise.all([refreshRegistry(), refreshSessions(), discoverClient()]);
  }, [refreshRegistry, refreshSessions, discoverClient]);

  useRefresh(refreshAll);

  const toggleExpanded = useCallback((repoId: string) => {
    setExpandedRepos((prev) => {
      const next = new Set(prev);
      if (next.has(repoId)) {
        next.delete(repoId);
      } else {
        next.add(repoId);
      }
      return next;
    });
  }, []);

  const [openModalPRList, setOpenModalPRList] = useState<PRInfo[]>([]);

  function prepareOpenModal() {
    const selected = treeItems[selectedIndex];
    let base: string | undefined;
    let profiles: string[] = [];
    let project = "";
    let repoPath = "";
    if (selected) {
      const repo = filteredRepos[selected.repoIndex];
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
    setOpenModalBase(base);
    setOpenModalProfiles(profiles);
    setOpenModalRepoProject(project);
    setOpenModalRepoPath(repoPath);
    const prs: PRInfo[] = [];
    for (const [key, pr] of prData) {
      if (key.startsWith(`${project}/`)) {
        prs.push(pr);
      }
    }
    setOpenModalPRList(prs);
    setMode(Mode.OpenModal);
  }

  function handleOpen(opts: OpenModalResult) {
    setMode(Mode.Navigate);
    const args = ["open", opts.branch];
    if (opts.base) args.push("--base", opts.base);
    if (opts.pr) args.push("--pr", opts.pr);
    if (opts.profile) args.push("--profile", opts.profile);
    if (opts.prompt) args.push("--prompt", opts.prompt);
    if (opts.existing) args.push("--existing");
    if (opts.noIde) args.push("--no-ide");
    if (opts.noAttach) args.push("--no-attach");

    const project = openModalRepoProject || "unknown";
    const key = pendingKey(project, opts.branch);
    setPendingActions((prev) =>
      new Map(prev).set(key, {
        type: "opening",
        branch: opts.branch,
        project,
      }),
    );

    const proc = Bun.spawn(["wct", ...args], {
      cwd: openModalRepoPath || undefined,
      stdout: "ignore",
      stderr: "ignore",
    });

    proc.exited.then((code) => {
      if (code !== 0) {
        // Show error briefly, then clear
        setTimeout(() => {
          setPendingActions((prev) => {
            const next = new Map(prev);
            next.delete(key);
            return next;
          });
        }, 5000);
      } else {
        // Success: trigger immediate refresh so real worktree appears
        refreshAll().then(() => {
          setPendingActions((prev) => {
            const next = new Map(prev);
            next.delete(key);
            return next;
          });
        });
      }
    });
  }

  /** Move selection up or down in the flat tree list, skipping headers */
  function navigateTree(direction: 1 | -1) {
    setSelectedIndex((prev) => {
      let next = prev + direction;
      while (next >= 0 && next < treeItems.length) {
        const item = treeItems[next];
        if (item?.type === "detail" && item.detailKind === "pane-header") {
          next += direction;
          continue;
        }
        return next;
      }
      return prev;
    });
  }

  /** Switch to worktree's tmux session, creating one if needed */
  function handleSpaceSwitch() {
    const item = treeItems[selectedIndex];
    if (!item) return;

    // For any detail row with an action, fire it (pane jump, PR open, etc.)
    if (item.type === "detail" && item.action) {
      item.action();
      return;
    }

    const worktreeIndex = resolveSelectedWorktreeIndex(
      treeItems,
      selectedIndex,
    );
    if (worktreeIndex === null) return;

    const resolvedItem = treeItems[worktreeIndex];
    if (!resolvedItem || resolvedItem.type !== "worktree") return;
    const repo = filteredRepos[resolvedItem.repoIndex];
    if (!repo) return;
    const wt = repo.worktrees[resolvedItem.worktreeIndex];
    if (!wt) return;
    const sessionName = formatSessionName(basename(wt.path));
    const hasSession = sessions.some((s) => s.name === sessionName);
    if (hasSession) {
      switchSession(sessionName);
    } else {
      // Create session with wct up, then switch
      const pendingActionKey = pendingKey(repo.project, wt.branch);
      setPendingActions((prev) =>
        new Map(prev).set(pendingActionKey, {
          type: "starting",
          branch: wt.branch,
          project: repo.project,
        }),
      );
      const proc = Bun.spawn(["wct", "up", "--no-attach"], {
        cwd: wt.path,
        stdio: ["ignore", "ignore", "ignore"],
      });
      proc.exited.then(async (code) => {
        if (code === 0) {
          await refreshSessions();
          switchSession(sessionName);
        }
        setPendingActions((prev) => {
          const next = new Map(prev);
          next.delete(pendingActionKey);
          return next;
        });
      });
    }
  }

  function handleCloseSelectedWorktree() {
    const action = resolveCloseSelectedWorktreeAction({
      mode,
      repos: filteredRepos,
      items: treeItems,
      selectedIndex,
    });
    if (action.type === "noop") {
      return;
    }

    if (action.nextSelectedIndex !== undefined) {
      setSelectedIndex(action.nextSelectedIndex);
    }
    if (action.nextMode) {
      setMode(action.nextMode);
    }

    const currentItem = treeItems[action.worktreeIndex];
    if (currentItem?.type !== "worktree") {
      return;
    }

    const currentRepo = filteredRepos[currentItem.repoIndex];
    if (!currentRepo) {
      return;
    }

    const currentWorktree = currentRepo.worktrees[currentItem.worktreeIndex];
    if (!currentWorktree) {
      return;
    }

    const closingSession = formatSessionName(basename(currentWorktree.path));
    if (client && client.session === closingSession) {
      const other = sessions.find((s) => s.name !== closingSession);
      if (other) {
        switchSession(other.name);
      }
    }

    const pendingActionKey = pendingKey(
      currentRepo.project,
      currentWorktree.branch,
    );
    setPendingActions((prev) =>
      new Map(prev).set(pendingActionKey, {
        type: "closing",
        branch: currentWorktree.branch,
        project: currentRepo.project,
      }),
    );

    const proc = Bun.spawn(["wct", "close", currentWorktree.branch, "--yes"], {
      cwd: currentRepo.repoPath,
      stdout: "ignore",
      stderr: "ignore",
    });
    proc.exited.then(() => {
      refreshAll().then(() => {
        setPendingActions((prev) => {
          const next = new Map(prev);
          next.delete(pendingActionKey);
          return next;
        });
      });
    });
  }

  function handleNavigateInput(input: string, key: Key) {
    if (input === "/") {
      setMode(Mode.Search);
      setSearchQuery("");
      return;
    }

    if (input === "o") {
      prepareOpenModal();
      return;
    }

    if (input === " ") {
      handleSpaceSwitch();
      return;
    }

    if (input === "d") {
      handleDownSelectedWorktree();
      return;
    }

    if (key.upArrow) {
      navigateTree(-1);
      return;
    }

    if (key.downArrow) {
      navigateTree(1);
      return;
    }

    const currentItem = treeItems[selectedIndex];
    if (!currentItem) return;

    const currentRepo = filteredRepos[currentItem.repoIndex];
    if (!currentRepo) return;

    const currentWorktree =
      currentItem.type === "worktree" && currentItem.worktreeIndex !== undefined
        ? currentRepo.worktrees[currentItem.worktreeIndex]
        : undefined;

    if (key.leftArrow && currentItem.type === "repo") {
      if (expandedRepos.has(currentRepo.id)) {
        toggleExpanded(currentRepo.id);
      }
      return;
    }

    if (key.rightArrow) {
      if (currentItem.type === "repo") {
        if (!expandedRepos.has(currentRepo.id)) {
          toggleExpanded(currentRepo.id);
        }
        return;
      }
      if (currentItem.type === "worktree" && currentWorktree) {
        setMode(
          Mode.Expanded(
            pendingKey(currentRepo.project, currentWorktree.branch),
          ),
        );
        return;
      }
    }

    if (input === "c" && currentItem.type === "worktree" && currentWorktree) {
      handleCloseSelectedWorktree();
      return;
    }
  }

  function handleSearchInput(input: string, key: Key) {
    if (key.escape) {
      setMode(Mode.Navigate);
      setSearchQuery("");
    } else if (key.backspace || key.delete) {
      setSearchQuery((q) => q.slice(0, -1));
    } else if (key.return) {
      setMode(Mode.Navigate);
    } else if (input && !key.ctrl && !key.meta) {
      setSearchQuery((q) => q + input);
    }
  }

  function handleExpandedInput(input: string, key: Key) {
    if (key.leftArrow || key.escape) {
      setSelectedIndex(adjustIndexForDetailCollapse(treeItems, selectedIndex));
      setMode(Mode.Navigate);
      return;
    }

    if (key.upArrow) {
      navigateTree(-1);
      return;
    }

    if (key.downArrow) {
      navigateTree(1);
      return;
    }

    if (key.rightArrow) {
      const action = resolveExpandedRightArrowAction({
        repos: filteredRepos,
        items: treeItems,
        selectedIndex,
        expandedRepos,
      });

      if (action.type === "expand-repo") {
        toggleExpanded(action.repoId);
        return;
      }

      if (action.type === "expand-worktree") {
        setSelectedIndex(action.nextSelectedIndex);
        setMode(action.nextMode);
      }

      return;
    }

    if (input === " ") {
      handleSpaceSwitch();
      return;
    }

    if (input === "o") {
      prepareOpenModal();
      return;
    }

    if (input === "d") {
      handleDownSelectedWorktree();
      return;
    }

    if (input === "c") {
      handleCloseSelectedWorktree();
      return;
    }

    if (input === "/") {
      setMode(Mode.Search);
      setSearchQuery("");
      return;
    }

    if (input === "z") {
      const selectedPane = resolveSelectedPane({
        repos: filteredRepos,
        items: treeItems,
        panes,
        selectedIndex,
      });
      if (!selectedPane) {
        return;
      }
      zoomPane(selectedPane.pane.paneId).then(() => refreshSessions());
      return;
    }

    if (input === "x") {
      const selectedPane = resolveSelectedPane({
        repos: filteredRepos,
        items: treeItems,
        panes,
        selectedIndex,
      });
      if (!selectedPane) {
        return;
      }
      setMode(
        Mode.ConfirmKill(
          selectedPane.pane.paneId,
          selectedPane.label,
          selectedPane.worktreeKey,
        ),
      );
    }
  }

  function handleConfirmKillInput(_input: string, key: Key) {
    if (mode.type !== "ConfirmKill") {
      return;
    }

    if (key.escape) {
      setMode(Mode.Expanded(mode.worktreeKey));
      return;
    }

    if (key.return) {
      const { paneId, worktreeKey } = mode;
      const parentIndex = findOwningWorktreeIndex(treeItems, selectedIndex);
      if (parentIndex !== null) {
        setSelectedIndex(parentIndex);
      }
      setMode(Mode.Expanded(worktreeKey));
      killPane(paneId).then(() => refreshSessions());
    }
  }

  function handleDownSelectedWorktree() {
    const worktreeIndex = resolveSelectedWorktreeIndex(
      treeItems,
      selectedIndex,
    );
    if (worktreeIndex === null) return;

    const item = treeItems[worktreeIndex];
    if (!item || item.type !== "worktree") return;

    const repo = filteredRepos[item.repoIndex];
    const wt = repo?.worktrees[item.worktreeIndex];
    if (!repo || !wt) return;

    const sessionName = formatSessionName(basename(wt.path));
    const hasSession = sessions.some((s) => s.name === sessionName);
    if (!hasSession) return;

    const worktreeKey = pendingKey(repo.project, wt.branch);
    confirmDownReturnSelectedIndexRef.current = selectedIndex;
    confirmDownReturnModeRef.current =
      mode.type === "Expanded" ? Mode.Expanded(worktreeKey) : Mode.Navigate;
    setMode(Mode.ConfirmDown(sessionName, wt.branch, wt.path, worktreeKey));
  }

  function handleConfirmDownInput(_input: string, key: Key) {
    if (mode.type !== "ConfirmDown") {
      return;
    }

    if (key.escape) {
      setSelectedIndex(confirmDownReturnSelectedIndexRef.current);
      setMode(confirmDownReturnModeRef.current);
      return;
    }

    if (key.return) {
      const { branch, worktreeKey, worktreePath } = mode;
      setSelectedIndex(confirmDownReturnSelectedIndexRef.current);
      setMode(confirmDownReturnModeRef.current);

      const project = worktreeKey.split("/")[0] ?? "unknown";
      setPendingActions((prev) =>
        new Map(prev).set(worktreeKey, {
          type: "stopping",
          branch,
          project,
        }),
      );

      const proc = Bun.spawn(["wct", "down", "--path", worktreePath], {
        stdout: "ignore",
        stderr: "ignore",
      });
      proc.exited.then(() => {
        refreshAll().then(() => {
          setPendingActions((prev) => {
            const next = new Map(prev);
            next.delete(worktreeKey);
            return next;
          });
        });
      });
    }
  }

  useInput((input, key) => {
    // Global keys (work in any mode)
    if (
      input === "q" &&
      mode.type !== "OpenModal" &&
      mode.type !== "Search" &&
      mode.type !== "ConfirmKill" &&
      mode.type !== "ConfirmDown"
    ) {
      exit();
      return;
    }

    switch (mode.type) {
      case "Navigate":
        return handleNavigateInput(input, key);
      case "Search":
        return handleSearchInput(input, key);
      case "OpenModal":
        // Modal handles its own input
        return;
      case "Expanded":
        return handleExpandedInput(input, key);
      case "ConfirmKill":
        return handleConfirmKillInput(input, key);
      case "ConfirmDown":
        return handleConfirmDownInput(input, key);
    }
  });

  if (loading) {
    return (
      <Box flexDirection="column">
        <Text bold>wct</Text>
        <Text dimColor>Loading...</Text>
      </Box>
    );
  }

  if (tmuxError) {
    return (
      <Box flexDirection="column">
        <Text bold>wct</Text>
        <Text color="yellow">{tmuxError}</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" height={termRows}>
      <Text bold>wct</Text>
      <Text> </Text>
      <Box flexDirection="column" flexGrow={1}>
        <TreeView
          repos={filteredRepos}
          sessions={sessions}
          expandedRepos={expandedRepos}
          selectedIndex={selectedIndex}
          items={treeItems}
          pendingActions={pendingActions}
          prData={prData}
          panes={panes}
          expandedWorktreeKey={expandedWorktreeKey}
          maxWidth={termCols}
        />
      </Box>
      {mode.type === "OpenModal" ? (
        <OpenModal
          visible
          width={Math.min(termCols, 60)}
          defaultBase={openModalBase ?? ""}
          profileNames={openModalProfiles}
          repoProject={openModalRepoProject}
          repoPath={openModalRepoPath}
          prList={openModalPRList}
          onSubmit={handleOpen}
          onCancel={() => setMode(Mode.Navigate)}
        />
      ) : (
        <StatusBar {...statusBarProps} searchQuery={searchQuery} />
      )}
    </Box>
  );
}

export function startTui(): Promise<void> {
  process.stdout.write("\x1b[?1049h\x1b[H");
  const instance = render(<App />);
  return instance.waitUntilExit().then(() => {
    process.stdout.write("\x1b[?1049l");
  });
}
