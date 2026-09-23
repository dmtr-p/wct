// src/tui/App.tsx

import { Box, type Key, render, Text, useApp, useWindowSize } from "ink";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AddProjectModal } from "./components/AddProjectModal";
import {
  type ConfirmMode,
  confirmModalRowCount,
  isConfirmMode,
} from "./components/ConfirmModal";
import { OpenModal } from "./components/OpenModal";
import { ShortcutsModal } from "./components/ShortcutsModal";
import { StatusBar, statusBarRowCount } from "./components/StatusBar";
import { TreeView } from "./components/TreeView";
import { UpModal } from "./components/UpModal";
import { useActionError } from "./hooks/useActionError";
import { useGitHub } from "./hooks/useGitHub";
import { useGuardedInput } from "./hooks/useGuardedInput";
import { useModalActions } from "./hooks/useModalActions";
import { useMouse } from "./hooks/useMouse";
import { useProjectActions } from "./hooks/useProjectActions";
import { useRefresh } from "./hooks/useRefresh";
import type { RepoInfo } from "./hooks/useRegistry";
import { useRegistry } from "./hooks/useRegistry";
import { useSessionActions } from "./hooks/useSessionActions";
import { useTextEditing } from "./hooks/useTextEditing";
import { useTmux } from "./hooks/useTmux";
import { useTreeNavigation } from "./hooks/useTreeNavigation";
import { executeConfirmKill } from "./input/confirm-kill";
import type { ExpandedContext } from "./input/expanded";
import { handleExpandedInput } from "./input/expanded";
import {
  ADD_PROJECT_BUTTON_LABEL,
  detectDoubleClick,
  HEADER_OFFSET,
  isAddProjectButtonPress,
  isAddProjectButtonTarget,
  type MouseClickHistory,
  type MouseEvent,
  mouseClickTargetId,
  resolveHoverItemIndex,
  resolveMouseAction,
  resolveTreeDoubleClickAction,
} from "./input/mouse";
import type { NavigateContext } from "./input/navigate";
import { handleNavigateInput } from "./input/navigate";
import type { LifecycleState } from "./lifecycle";
import {
  createLifecycleClaims,
  isLifecycleActive,
  lifecycleKey,
} from "./lifecycle";
import {
  buildTreeItems,
  buildTreeRows,
  findOwningWorktreeIndex,
  insertConfirmationRows,
  isWorktreeEffectivelyExpanded,
  isWorktreeLifecycleActive,
  reconcileDiscoveredWorkspaceKeys,
  reconcileExpandedWorktreeKeys,
  resolveConfirmationAnchorItemIndex,
  resolveStatusBarProps,
  resolveTreeReturnMode,
  treeItemId,
  workspaceIdentityKeysForDisplayKey,
} from "./tree-helpers";
import type {
  ReturnDestination,
  ReturnPosition,
  TreeNavigationSnapshot,
} from "./tree-navigation";
import { Mode, type PRInfo } from "./types";
import { toSingleLine } from "./utils/truncate";

// Top chrome above the tree: the `wct` header line + a blank spacer line. Same
// 2 rows the mouse hit-test skips, so it is sourced from a single constant to
// keep windowing and hit-testing aligned.
const TOP_CHROME_ROWS = HEADER_OFFSET;

function confirmationPosition(mode: ConfirmMode): ReturnPosition {
  switch (mode.type) {
    case "ConfirmKill":
      return "kill";
    case "ConfirmDown":
      return "down";
    case "ConfirmClose":
    case "ConfirmCloseForce":
      return "close";
    case "ConfirmDeleteProject":
      return "delete-project";
  }
}

export function App() {
  const { exit } = useApp();
  const { columns: termCols, rows: termRows } = useWindowSize();
  const { disableMouse } = useMouse();
  const { repos, loading, refresh: refreshRegistry } = useRegistry();
  const {
    prData,
    errors: githubErrors,
    refresh: refreshGitHub,
    refreshingProjects,
  } = useGitHub(repos);
  const {
    client: tmuxClient,
    sessions,
    panes,
    error: tmuxError,
    switchSession,
    detachClient,
    jumpToPane,
    zoomPane,
    killPane,
    refreshSessions,
    discoverClient,
  } = useTmux();

  const navigation = useTreeNavigation(() => navigationSnapshot);
  const selectedIndex = navigation.selectedIndex;
  const selectTreeItem = useCallback(
    (itemIndex: number) => navigation.dispatch({ type: "select", itemIndex }),
    [navigation.dispatch],
  );
  const captureTreePosition = useCallback(
    (position: ReturnPosition, preserveSelection?: boolean) =>
      navigation.dispatch({ type: "capture", position, preserveSelection }),
    [navigation.dispatch],
  );
  const restoreTreePosition = useCallback(
    (position: ReturnPosition, destination?: ReturnDestination) =>
      navigation.dispatch({ type: "restore", position, destination }),
    [navigation.dispatch],
  );
  const [openModalBase, setOpenModalBase] = useState<string | undefined>();
  const [openModalProfiles, setOpenModalProfiles] = useState<string[]>([]);
  const [openModalRepoProject, setOpenModalRepoProject] = useState("");
  const [openModalRepoPath, setOpenModalRepoPath] = useState("");
  const [mode, setMode] = useState<Mode>(Mode.Navigate);
  // The live `mode`, for async continuations that must not act on a stale
  // render-time capture.
  const modeRef = useRef<Mode>(mode);
  const [expandedWorktreeKeys, setExpandedWorktreeKeys] = useState<Set<string>>(
    new Set(),
  );
  // Identity-scoped presentation overrides. A successful `open` adds its
  // discovered Workspace; collapsing a shared display key can also migrate
  // the other matching Workspaces here so only the selected identity closes.
  const [discoveredWorkspaceKeys, setDiscoveredWorkspaceKeys] = useState<
    Set<string>
  >(new Set());
  const [searchQuery, setSearchQuery] = useState("");
  const searchEditing = useTextEditing(
    searchQuery,
    setSearchQuery,
    mode.type === "Search",
  );
  const [isAddProjectButtonHovered, setIsAddProjectButtonHovered] =
    useState(false);
  const [lastHoverPosition, setLastHoverPosition] = useState<{
    col: number;
    row: number;
  } | null>(null);
  const { actionError, showActionError, clearActionError } = useActionError();
  // Keyed by Workspace Identity (main repository path + branch), never by
  // the project display name, so two repos sharing a display name can't
  // clobber each other's progress.
  const [lifecycle, setLifecycle] = useState<LifecycleState>(new Map());
  // External handoffs such as `tmux switch-client` can detach the terminal
  // immediately. They need a commit barrier, not merely a queued state
  // update, so the last frame the user sees cannot retain a progress row.
  const lifecycleRef = useRef(lifecycle);
  const lifecycleCleanupWaitersRef = useRef<Map<string, Set<() => void>>>(
    new Map(),
  );
  const waitForLifecyclePresentationCleanup = useCallback(
    (repoPath: string, branch: string): Promise<void> => {
      const key = lifecycleKey(repoPath, branch);
      if (!lifecycleRef.current.has(key)) return Promise.resolve();
      return new Promise((resolve) => {
        const waiters = lifecycleCleanupWaitersRef.current.get(key);
        if (waiters) {
          waiters.add(resolve);
        } else {
          lifecycleCleanupWaitersRef.current.set(key, new Set([resolve]));
        }
      });
    },
    [],
  );
  // Created once per App and shared by every verb: it decides, synchronously
  // and before any state is written, whether an identity is already in flight.
  const lifecycleClaimsRef = useRef(createLifecycleClaims());
  const lifecycleClaims = lifecycleClaimsRef.current;
  const confirmDownReturnModeRef = useRef<Mode>(Mode.Navigate);
  const confirmCloseReturnModeRef = useRef<Mode>(Mode.Navigate);
  const confirmDeleteProjectReturnModeRef = useRef<Mode>(Mode.Navigate);
  const upModalReturnModeRef = useRef<Mode>(Mode.Navigate);
  const searchReturnModeRef = useRef<Mode>(Mode.Navigate);
  const shortcutsReturnModeRef = useRef<Mode>(Mode.Navigate);
  const modalReturnModeRef = useRef<Mode>(Mode.Navigate);
  const confirmPendingRef = useRef(false);
  const confirmKillAttemptRef = useRef(0);
  const lastMouseClickRef = useRef<MouseClickHistory | null>(null);

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

  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);

  useLayoutEffect(() => {
    lifecycleRef.current = lifecycle;
  }, [lifecycle]);

  useEffect(() => {
    for (const [key, waiters] of lifecycleCleanupWaitersRef.current) {
      if (lifecycle.has(key)) continue;
      lifecycleCleanupWaitersRef.current.delete(key);
      for (const resolve of waiters) resolve();
    }
  }, [lifecycle]);

  useEffect(() => {
    setExpandedWorktreeKeys((previous) =>
      reconcileExpandedWorktreeKeys(previous, repos),
    );
    setDiscoveredWorkspaceKeys((previous) =>
      reconcileDiscoveredWorkspaceKeys(previous, repos),
    );
  }, [repos]);

  useEffect(() => {
    if (
      mode.type !== "Expanded" ||
      expandedWorktreeKeys.has(mode.worktreeKey)
    ) {
      return;
    }
    const remainingKey = expandedWorktreeKeys.values().next().value;
    setMode(
      typeof remainingKey === "string"
        ? Mode.Expanded(remainingKey)
        : Mode.Navigate,
    );
  }, [expandedWorktreeKeys, mode]);

  const treeItems = useMemo(
    () =>
      buildTreeItems({
        repos: filteredRepos,
        expandedWorktreeKeys,
        discoveredWorkspaceKeys,
        lifecycle,
        prData,
        panes,
        jumpToPane,
      }),
    [
      filteredRepos,
      expandedWorktreeKeys,
      discoveredWorkspaceKeys,
      lifecycle,
      prData,
      panes,
      jumpToPane,
    ],
  );

  const statusBarProps = resolveStatusBarProps({
    mode,
    items: treeItems,
    selectedIndex,
    repos: filteredRepos,
  });
  const selectedWorktreeIndex = findOwningWorktreeIndex(
    treeItems,
    selectedIndex,
  );
  const selectedWorktree =
    selectedWorktreeIndex === null
      ? undefined
      : treeItems[selectedWorktreeIndex];
  const selectedWorktreeRepo =
    selectedWorktree?.type === "worktree"
      ? filteredRepos[selectedWorktree.repoIndex]
      : undefined;
  const selectedWorktreeData =
    selectedWorktree?.type === "worktree"
      ? selectedWorktreeRepo?.worktrees[selectedWorktree.worktreeIndex]
      : undefined;
  const canCollapse = Boolean(
    selectedWorktreeRepo &&
      selectedWorktreeData &&
      !isLifecycleActive(
        lifecycle,
        selectedWorktreeRepo.repoPath,
        selectedWorktreeData.branch,
      ) &&
      isWorktreeEffectivelyExpanded({
        expandedWorktreeKeys,
        discoveredWorkspaceKeys,
        lifecycle,
        project: selectedWorktreeRepo.project,
        repoPath: selectedWorktreeRepo.repoPath,
        branch: selectedWorktreeData.branch,
      }),
  );

  const repoError = statusBarProps.selectedProject
    ? githubErrors.get(statusBarProps.selectedProject)
    : undefined;

  // The shared visual-row model drives both windowing here and the row-by-row
  // render in TreeView. Logical items are not 1:1 with terminal rows.
  const baseRows = useMemo(
    () =>
      buildTreeRows({
        items: treeItems,
        repos: filteredRepos,
        expandedWorktreeKeys,
        discoveredWorkspaceKeys,
        lifecycle,
        maxWidth: termCols,
      }),
    [
      treeItems,
      filteredRepos,
      expandedWorktreeKeys,
      discoveredWorkspaceKeys,
      lifecycle,
      termCols,
    ],
  );

  const confirmationMode = isConfirmMode(mode) ? mode : null;
  const confirmationWidth = Math.min(termCols, 60);
  const confirmationAnchorItemIndex = useMemo(
    () => resolveConfirmationAnchorItemIndex(mode, treeItems, filteredRepos),
    [mode, treeItems, filteredRepos],
  );
  const rows = useMemo(() => {
    if (!confirmationMode || confirmationAnchorItemIndex === null) {
      return baseRows;
    }
    return insertConfirmationRows(
      baseRows,
      confirmationAnchorItemIndex,
      confirmModalRowCount(confirmationMode, confirmationWidth),
    );
  }, [
    baseRows,
    confirmationMode,
    confirmationAnchorItemIndex,
    confirmationWidth,
  ]);

  // Bottom chrome: optional tmux/action error line (mutually exclusive, so at
  // most one row) + the StatusBar's rows — counted by statusBarRowCount, the
  // helper co-located with StatusBar's render branches so the budget cannot
  // drift from what it renders. Every chrome line renders with wrap="truncate"
  // AND is collapsed to a single line (toSingleLine), so each one is exactly
  // one terminal row at any width and for any message — otherwise the budget
  // would under-count, and the overflowing layout would misalign mouse
  // hit-testing.
  //
  // Form modals replace the StatusBar but budget the SAME virtual row count
  // as the now-hidden default shortcut footer (zero, or one repo-error row):
  // viewportRows must not change when a modal opens, or the clamp/keep-visible
  // effects would rewrite a wheel-scrolled offset the user expects back on
  // cancel. Confirmation modals are anchored inside the tree's visual-row
  // model. A form modal being taller than the budgeted chrome is
  // absorbed by the tree box's overflowY="hidden" clipping (see the render
  // below), which keeps the modal fully on-screen without inflating the
  // viewport.
  const bottomChromeRowsForRepoError = (hasRepoError: boolean) =>
    statusBarRowCount(mode, hasRepoError) + (tmuxError || actionError ? 1 : 0);
  const bottomChromeRows = bottomChromeRowsForRepoError(Boolean(repoError));

  const viewportRows = Math.max(
    0,
    termRows - TOP_CHROME_ROWS - bottomChromeRows,
  );

  const navigationSnapshot: TreeNavigationSnapshot = {
    items: treeItems,
    repos: filteredRepos,
    rows,
    viewportRows,
    viewportRowsForSelection: (itemIndex) => {
      const targetStatus = resolveStatusBarProps({
        mode,
        items: treeItems,
        selectedIndex: itemIndex,
        repos: filteredRepos,
      });
      const hasRepoError = Boolean(
        targetStatus.selectedProject &&
          githubErrors.get(targetStatus.selectedProject),
      );
      return Math.max(
        0,
        termRows - TOP_CHROME_ROWS - bottomChromeRowsForRepoError(hasRepoError),
      );
    },
    searchQuery,
    lifecycle,
    confirming: confirmationMode !== null,
    confirmationPosition: confirmationMode
      ? confirmationPosition(confirmationMode)
      : null,
  };
  const effectiveScrollOffset =
    navigation.effectiveScrollOffset(navigationSnapshot);

  // Derived from the last raw pointer position rather than stored directly,
  // so a mode change or tree reshape with no intervening mouse move can't
  // leave a stale row hovered.
  const hoveredItemIndex = useMemo(() => {
    if (!lastHoverPosition) return null;
    return resolveHoverItemIndex(
      { kind: "move", col: lastHoverPosition.col, row: lastHoverPosition.row },
      {
        mode,
        rows,
        effectiveScrollOffset,
        viewportRows,
        treeItems,
        repos: filteredRepos,
      },
    );
  }, [
    lastHoverPosition,
    mode,
    rows,
    effectiveScrollOffset,
    viewportRows,
    treeItems,
    filteredRepos,
  ]);

  useEffect(() => {
    if (!confirmationMode || confirmationAnchorItemIndex !== null) return;
    restoreTreePosition(confirmationPosition(confirmationMode));
    switch (mode.type) {
      case "ConfirmKill":
        confirmKillAttemptRef.current += 1;
        confirmPendingRef.current = false;
        setMode(Mode.Expanded(mode.worktreeKey));
        return;
      case "ConfirmDown":
        setMode(confirmDownReturnModeRef.current);
        return;
      case "ConfirmClose":
      case "ConfirmCloseForce":
        setMode(confirmCloseReturnModeRef.current);
        return;
      case "ConfirmDeleteProject":
        setMode(confirmDeleteProjectReturnModeRef.current);
        return;
    }
  }, [
    confirmationMode,
    confirmationAnchorItemIndex,
    mode,
    restoreTreePosition,
  ]);

  // Resolves the registry snapshot this refresh observed (or `null` when it
  // failed and the previous repos were kept), so a lifecycle can reconcile
  // against what it just validated instead of a stale `repos` capture.
  const refreshAll = useCallback(async (): Promise<RepoInfo[] | null> => {
    const [refreshedRepos] = await Promise.all([
      refreshRegistry(),
      refreshSessions(),
      discoverClient(),
    ]);
    return refreshedRepos;
  }, [refreshRegistry, refreshSessions, discoverClient]);

  // The poll/watch path only needs the side effect, not the resolved snapshot.
  const pollRefresh = useCallback(async (): Promise<void> => {
    await refreshAll();
  }, [refreshAll]);

  useRefresh(pollRefresh);

  const expandWorktree = useCallback((worktreeKey: string) => {
    setExpandedWorktreeKeys((previous) => {
      const next = new Set(previous);
      next.add(worktreeKey);
      return next;
    });
    setMode(Mode.Expanded(worktreeKey));
  }, []);

  const collapseWorktree = useCallback(
    (worktreeKey: string, repoPath: string, branch: string) => {
      const workspaceIdentityKey = lifecycleKey(repoPath, branch);
      const preservedWorkspaceKeys = expandedWorktreeKeys.has(worktreeKey)
        ? workspaceIdentityKeysForDisplayKey(repos, worktreeKey)
        : new Set<string>();
      preservedWorkspaceKeys.delete(workspaceIdentityKey);

      setExpandedWorktreeKeys((previous) => {
        const next = new Set(previous);
        next.delete(worktreeKey);
        return next;
      });
      setDiscoveredWorkspaceKeys((previous) => {
        const next = new Set(previous);
        next.delete(workspaceIdentityKey);
        for (const preserved of preservedWorkspaceKeys) next.add(preserved);
        if (
          next.size === previous.size &&
          [...next].every((key) => previous.has(key))
        ) {
          return previous;
        }
        return next;
      });
    },
    [expandedWorktreeKeys, repos],
  );

  const markWorkspaceDiscovered = useCallback(
    (workspaceIdentityKey: string) => {
      setDiscoveredWorkspaceKeys((previous) => {
        if (previous.has(workspaceIdentityKey)) return previous;
        const next = new Set(previous);
        next.add(workspaceIdentityKey);
        return next;
      });
    },
    [],
  );

  const openModalPRList = useMemo(() => {
    const prs: PRInfo[] = [];
    for (const [key, pr] of prData) {
      if (key.startsWith(`${openModalRepoProject}/`)) {
        prs.push(pr);
      }
    }
    return prs;
  }, [prData, openModalRepoProject]);

  const openModalOnRefresh = useCallback(
    (signal?: AbortSignal) => {
      void refreshGitHub(openModalRepoProject, signal);
    },
    [refreshGitHub, openModalRepoProject],
  );

  const sessionActions = useSessionActions({
    treeItems,
    filteredRepos,
    sessions,
    selectedIndex,
    mode,
    lifecycle,
    lifecycleClaims,
    captureTreePosition,
    restoreTreePosition,
    setMode,
    modeRef,
    setLifecycle,
    showActionError,
    clearActionError,
    switchSession,
    detachClient,
    discoverClient,
    refreshSessions,
    refreshAll,
    confirmDownReturnModeRef,
    confirmCloseReturnModeRef,
  });

  const modalActions = useModalActions({
    treeItems,
    filteredRepos,
    selectedIndex,
    mode,
    openModalRepoProject,
    openModalRepoPath,
    lifecycle,
    lifecycleClaims,
    setLifecycle,
    setMode,
    captureTreePosition,
    restoreTreePosition,
    setOpenModalBase,
    setOpenModalProfiles,
    setOpenModalRepoProject,
    setOpenModalRepoPath,
    markWorkspaceDiscovered,
    waitForLifecyclePresentationCleanup,
    showActionError,
    clearActionError,
    switchSession,
    discoverClient,
    startWorkspace: sessionActions.startWorkspace,
    refreshAll,
    upModalReturnModeRef,
    modalReturnModeRef,
  });

  const projectActions = useProjectActions({
    treeItems,
    filteredRepos,
    repos,
    selectedIndex,
    mode,
    lifecycle,
    captureTreePosition,
    restoreTreePosition,
    setMode,
    showActionError,
    clearActionError,
    refreshAll,
    switchClientAwayFromSessions: sessionActions.switchClientAwayFromSessions,
    confirmDeleteProjectReturnModeRef,
  });

  const setTreeInputMode = useCallback(
    (nextMode: Mode) => {
      if (nextMode.type === "Search") {
        searchReturnModeRef.current = resolveTreeReturnMode(mode);
      }
      setMode(nextMode);
    },
    [mode],
  );

  const navCtx: NavigateContext = {
    treeItems,
    filteredRepos,
    selectedIndex,
    tmuxClient,
    lifecycle,
    setMode: setTreeInputMode,
    setSearchQuery,
    expandWorktree,
    navigateTree: (direction) =>
      navigation.dispatch({ type: "move", direction }),
    prepareOpenModal: modalActions.prepareOpenModal,
    prepareUpModal: modalActions.prepareUpModal,
    prepareAddProjectModal: modalActions.prepareAddProjectModal,
    handleSpaceSwitch: sessionActions.handleSpaceSwitch,
    handleDownSelectedWorktree: sessionActions.handleDownSelectedWorktree,
    handleCloseSelectedWorktree: sessionActions.handleCloseSelectedWorktree,
    prepareDeleteProject: projectActions.prepareDeleteProject,
    refreshRepo: (project: string) => void refreshGitHub(project),
  };

  const expCtx: ExpandedContext = {
    ...navCtx,
    panes,
    selectTreeItem,
    captureTreePosition,
    zoomPane,
    killPane,
    refreshSessions,
    collapseWorktree,
  };

  function handleSearchInput(input: string, key: Key) {
    if (key.escape) {
      setMode(searchReturnModeRef.current);
      setSearchQuery("");
    } else if (key.return) {
      setMode(searchReturnModeRef.current);
    } else {
      searchEditing.handleInput(input, key);
    }
  }

  function cancelConfirm() {
    if (!isConfirmMode(mode)) return;
    // A confirmed destructive action keeps ownership of the modal until its
    // async work settles. Leaving now would make the action look cancelled
    // while it continues in the background, and its completion could later
    // overwrite whatever mode or selection the user moved to.
    if (confirmPendingRef.current) return;
    restoreTreePosition(confirmationPosition(mode));
    switch (mode.type) {
      case "ConfirmKill":
        confirmKillAttemptRef.current += 1;
        confirmPendingRef.current = false;
        setMode(Mode.Expanded(mode.worktreeKey));
        return;
      case "ConfirmDown":
        setMode(confirmDownReturnModeRef.current);
        return;
      case "ConfirmClose":
      case "ConfirmCloseForce":
        setMode(confirmCloseReturnModeRef.current);
        return;
      case "ConfirmDeleteProject":
        setMode(confirmDeleteProjectReturnModeRef.current);
        return;
    }
  }

  function submitConfirm() {
    if (confirmationAnchorItemIndex === null) {
      cancelConfirm();
      return;
    }
    switch (mode.type) {
      case "ConfirmKill": {
        if (confirmPendingRef.current) return;
        confirmPendingRef.current = true;
        const attempt = ++confirmKillAttemptRef.current;
        const { paneId, worktreeKey } = mode;
        clearActionError();
        void executeConfirmKill({
          paneId,
          killPane,
          refreshSessions,
          isCurrent: () => confirmKillAttemptRef.current === attempt,
          showActionError,
          onSuccess: () => {
            restoreTreePosition("kill", "owning-worktree");
            setMode(Mode.Expanded(worktreeKey));
          },
        }).finally(() => {
          if (confirmKillAttemptRef.current === attempt) {
            confirmPendingRef.current = false;
          }
        });
        return;
      }
      case "ConfirmDown": {
        if (confirmPendingRef.current) return;
        confirmPendingRef.current = true;
        void sessionActions
          .executeDown(
            mode.sessionName,
            mode.branch,
            mode.worktreePath,
            mode.repoPath,
            mode.project,
          )
          .finally(() => {
            confirmPendingRef.current = false;
          });
        return;
      }
      case "ConfirmClose":
      case "ConfirmCloseForce": {
        if (confirmPendingRef.current) return;
        confirmPendingRef.current = true;
        void sessionActions
          .executeClose(
            mode.sessionName,
            mode.branch,
            mode.worktreePath,
            mode.worktreeKey,
            mode.repoPath,
            mode.project,
            mode.type === "ConfirmCloseForce",
          )
          .finally(() => {
            confirmPendingRef.current = false;
          });
        return;
      }
      case "ConfirmDeleteProject": {
        if (confirmPendingRef.current) return;
        confirmPendingRef.current = true;
        void projectActions
          .executeDeleteProject(mode.repoPath, mode.project)
          .finally(() => {
            confirmPendingRef.current = false;
          });
        return;
      }
    }
  }

  function handleConfirmInput(key: Key) {
    if (key.escape) cancelConfirm();
    else if (key.return) submitConfirm();
  }

  function handleMouse(event: MouseEvent) {
    if (event.kind === "move" || event.kind === "press") {
      setIsAddProjectButtonHovered(
        isAddProjectButtonTarget(event, mode, termCols),
      );
    }

    if (event.kind === "move") {
      setLastHoverPosition({ col: event.col, row: event.row });
    }

    if (isAddProjectButtonPress(event, mode, termCols)) {
      lastMouseClickRef.current = null;
      modalActions.prepareAddProjectModal();
      return;
    }

    const action = resolveMouseAction(event, {
      mode,
      rows,
      effectiveScrollOffset,
      viewportRows,
      treeItems,
      repos: filteredRepos,
    });
    switch (action.kind) {
      case "none":
        if (event.kind === "press") lastMouseClickRef.current = null;
        return;
      case "scroll":
        lastMouseClickRef.current = null;
        navigation.dispatch({ type: "wheel", delta: action.delta });
        return;
      case "select": {
        selectTreeItem(action.itemIndex);
        const target = treeItems[action.itemIndex];
        if (!target) return;
        const itemId = treeItemId(target, filteredRepos);
        const targetId = itemId && mouseClickTargetId(itemId, action.rowIndex);
        if (!targetId) return;
        const detection = detectDoubleClick(
          lastMouseClickRef.current,
          targetId,
          Date.now(),
        );
        lastMouseClickRef.current = detection.history;
        if (!detection.isDoubleClick) return;

        // Same refusal as `canCollapse`: a double-click on a Workspace under
        // an active lifecycle must not write the stored expansion preference.
        if (
          target.type === "worktree" &&
          isWorktreeLifecycleActive(target, filteredRepos, lifecycle)
        ) {
          return;
        }
        const doubleClickAction = resolveTreeDoubleClickAction(
          target,
          filteredRepos,
          expandedWorktreeKeys,
          discoveredWorkspaceKeys,
        );
        switch (doubleClickAction.type) {
          case "expand-worktree":
            expandWorktree(doubleClickAction.worktreeKey);
            return;
          case "collapse-worktree":
            collapseWorktree(
              doubleClickAction.worktreeKey,
              doubleClickAction.repoPath,
              doubleClickAction.branch,
            );
            return;
          case "activate-detail":
            doubleClickAction.action();
            return;
          case "noop":
            return;
        }
        return;
      }
    }
  }

  // useGuardedInput parses mouse events out of the string Ink already forwards
  // (no second stdin listener, ADR 0002) and swallows ANY SGR mouse sequence
  // in EVERY mode — including release/motion/extra-button sequences, and
  // multi-sequence strings from Ink's paste-fallback path (normal stdin
  // delivery is one sequence per event) — so no escape garble ever reaches
  // the handler below (or any other useGuardedInput handler, e.g. the modals'
  // text inputs). Actionable events arrive via onMouseEvent, in order.
  useGuardedInput(
    (input, key) => {
      // Double-clicks require consecutive mouse presses. Any keyboard event
      // breaks the pair, even when it leaves the same row selected.
      lastMouseClickRef.current = null;

      // Ctrl+C exits from EVERY mode (parity with Ink's default), but through
      // the same disable-mouse-first sequence as `q`: startTui renders with
      // exitOnCtrlC: false precisely so Ctrl+C reaches this handler instead
      // of Ink's own \x03 shortcut, whose handleExit turns off raw mode
      // before React unmount — too late for the unmount-cleanup disable, so
      // mouse reports emitted in that window would echo as escape garbage on
      // the shell prompt after exit.
      if (key.ctrl && input === "c") {
        disableMouse();
        exit();
        return;
      }

      if (
        input === "q" &&
        mode.type !== "OpenModal" &&
        mode.type !== "UpModal" &&
        mode.type !== "AddProjectModal" &&
        mode.type !== "Search" &&
        mode.type !== "ConfirmKill" &&
        mode.type !== "ConfirmDown" &&
        mode.type !== "ConfirmClose" &&
        mode.type !== "ConfirmCloseForce" &&
        mode.type !== "ConfirmDeleteProject"
      ) {
        // Disable mouse reporting BEFORE exit(): Ink's handleExit turns off raw
        // mode before React unmount, so the unmount-cleanup disable is too late.
        disableMouse();
        exit();
        return;
      }

      if (
        input === "?" &&
        (mode.type === "Navigate" || mode.type === "Expanded")
      ) {
        shortcutsReturnModeRef.current = mode;
        setMode(Mode.Shortcuts);
        return;
      }

      switch (mode.type) {
        case "Navigate":
          return handleNavigateInput(navCtx, input, key);
        case "Search":
          return handleSearchInput(input, key);
        case "Shortcuts":
          if (key.escape) setMode(shortcutsReturnModeRef.current);
          return;
        case "OpenModal":
        case "UpModal":
        case "AddProjectModal":
          return;
        case "Expanded":
          return handleExpandedInput(expCtx, input, key);
        case "ConfirmKill":
        case "ConfirmDown":
        case "ConfirmClose":
        case "ConfirmCloseForce":
        case "ConfirmDeleteProject":
          return handleConfirmInput(key);
      }
    },
    { onMouseEvent: handleMouse },
  );

  if (loading) {
    return (
      <Box flexDirection="column">
        <Text bold>wct</Text>
        <Text dimColor>Loading...</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" height={termRows}>
      {/* Every sibling of the tree box is flexShrink={0}: when the content
          exceeds termRows, the tree box must be the ONLY thing Yoga shrinks —
          otherwise the header/spacer lines get squeezed to zero height and
          later rows paint over them. */}
      <Box flexDirection="column" flexShrink={0}>
        <Box justifyContent="space-between">
          <Text bold>wct</Text>
          <Text bold color="cyan" inverse={isAddProjectButtonHovered}>
            {ADD_PROJECT_BUTTON_LABEL}
          </Text>
        </Box>
        <Text> </Text>
      </Box>
      {/* overflowY="hidden" + flexShrink is what lets a true modal exceed the
          budgeted bottom-chrome rows: Yoga shrinks THIS box and the excess
          tree rows clip cleanly at its bottom edge, instead of the
          overflowing frame painting over the modal. The inner flexShrink={0}
          wrapper keeps the rows at their natural height so they overflow (and
          clip) rather than being squeezed into interleaved garbage. In the
          interactive layout the tree content equals the budget exactly, so
          nothing is ever clipped there. */}
      <Box
        flexDirection="column"
        flexGrow={1}
        flexShrink={1}
        overflowY="hidden"
      >
        <Box flexDirection="column" flexShrink={0}>
          <TreeView
            repos={filteredRepos}
            sessions={sessions}
            selectedIndex={selectedIndex}
            items={treeItems}
            rows={rows}
            hoveredItemIndex={hoveredItemIndex}
            lifecycle={lifecycle}
            prData={prData}
            panes={panes}
            expandedWorktreeKeys={expandedWorktreeKeys}
            discoveredWorkspaceKeys={discoveredWorkspaceKeys}
            maxWidth={termCols}
            refreshingProjects={refreshingProjects}
            errors={githubErrors}
            scrollOffset={effectiveScrollOffset}
            viewportRows={viewportRows}
            confirmation={
              confirmationMode
                ? {
                    mode: confirmationMode,
                    width: confirmationWidth,
                    onConfirm: submitConfirm,
                    onCancel: cancelConfirm,
                  }
                : undefined
            }
          />
        </Box>
      </Box>
      {/* flexShrink={0} pins the bottom area (form modal or status chrome) to
          its natural height so the tree box above is the only child Yoga
          shrinks. Confirmations render inside the tree instead. */}
      <Box flexDirection="column" flexShrink={0}>
        {mode.type === "Shortcuts" ? (
          <ShortcutsModal
            width={Math.min(termCols, 60)}
            onHide={() => setMode(shortcutsReturnModeRef.current)}
          />
        ) : mode.type === "OpenModal" ? (
          <OpenModal
            visible
            width={Math.min(termCols, 60)}
            defaultBase={openModalBase ?? ""}
            profileNames={openModalProfiles}
            repoProject={openModalRepoProject}
            repoPath={openModalRepoPath}
            prList={openModalPRList}
            isRefreshing={refreshingProjects.has(openModalRepoProject)}
            onRefresh={openModalOnRefresh}
            onSubmit={modalActions.handleOpen}
            onCancel={() => setMode(modalReturnModeRef.current)}
          />
        ) : mode.type === "UpModal" ? (
          <UpModal
            visible
            width={Math.min(termCols, 60)}
            profileNames={mode.profileNames}
            onSubmit={modalActions.handleUpSubmit}
            onCancel={() => {
              restoreTreePosition("up");
              setMode(upModalReturnModeRef.current);
            }}
          />
        ) : mode.type === "AddProjectModal" ? (
          <AddProjectModal
            visible
            width={Math.min(termCols, 60)}
            onSubmit={modalActions.handleAddProject}
            onCancel={() => setMode(modalReturnModeRef.current)}
          />
        ) : (
          <Box flexDirection="column">
            {tmuxError && !actionError ? (
              <Text color="yellow" wrap="truncate">
                {toSingleLine(tmuxError)}
              </Text>
            ) : null}
            {actionError ? (
              <Text color="red" wrap="truncate">
                {toSingleLine(actionError)}
              </Text>
            ) : null}
            {!confirmationMode ? (
              <StatusBar
                {...statusBarProps}
                searchQuery={searchQuery}
                searchCursor={searchEditing.cursor}
                hasClient={tmuxClient !== null}
                canCollapse={canCollapse}
                repoError={repoError}
              />
            ) : null}
          </Box>
        )}
      </Box>
    </Box>
  );
}

export async function startTui(): Promise<void> {
  // exitOnCtrlC stays OFF: the guarded input dispatcher in App owns Ctrl+C so
  // it can write MOUSE_DISABLE before Ink turns raw mode off (Ink's built-in
  // \x03 shortcut disables raw mode before React unmount, which would leak
  // mouse reports onto the shell — the same ordering bug the `q` path avoids).
  const instance = render(<App />, {
    alternateScreen: true,
    exitOnCtrlC: false,
  });
  await instance.waitUntilExit();
}
