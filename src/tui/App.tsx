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
  confirmModalRowCount,
  type ConfirmMode,
  isConfirmMode,
} from "./components/ConfirmModal";
import { OpenModal } from "./components/OpenModal";
import { PrActionsModal } from "./components/PrActionsModal";
import { ShortcutsModal } from "./components/ShortcutsModal";
import { StatusBar, statusBarRowCount } from "./components/StatusBar";
import { TreeView } from "./components/TreeView";
import { UpModal } from "./components/UpModal";
import { useActionError } from "./hooks/useActionError";
import { useAgents } from "./hooks/useAgents";
import { useGitHub } from "./hooks/useGitHub";
import { useGuardedInput } from "./hooks/useGuardedInput";
import { useModalActions } from "./hooks/useModalActions";
import { useMouse } from "./hooks/useMouse";
import { usePrActions } from "./hooks/usePrActions";
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
  mouseClickTargetId,
  type MouseEvent,
  resolveHoverItemIndex,
  resolveMouseAction,
  resolveTreeDoubleClickAction,
} from "./input/mouse";
import type { NavigateContext } from "./input/navigate";
import { handleNavigateInput } from "./input/navigate";
import { createTerminalInput } from "./input/terminal-input";
import type { LifecycleState } from "./lifecycle";
import {
  createLifecycleClaims,
  isLifecycleActive,
  workspaceIdentityKey,
} from "./lifecycle";
import {
  buildTreeItems,
  buildTreeRows,
  findOwningWorktreeIndex,
  insertConfirmationRows,
  isWorktreeEffectivelyExpanded,
  isWorktreeLifecycleActive,
  reconcileExpandedWorkspaceKeys,
  resolveConfirmationAnchorItemIndex,
  resolveStatusBarProps,
  resolveTreeReturnMode,
  treeItemId,
} from "./tree-helpers";
import type {
  ReturnDestination,
  ReturnSlot,
  TreeNavigationSnapshot,
} from "./tree-navigation";
import { Mode } from "./types";
import { toSingleLine } from "./utils/truncate";

// Share the chrome height with mouse hit-testing so viewport rows align.
const TOP_CHROME_ROWS = HEADER_OFFSET;

interface ConfirmationReturnContext {
  slot: ReturnSlot;
  returnMode: Mode;
}

export function App() {
  const { exit, waitUntilRenderFlush } = useApp();
  const { columns: termCols, rows: termRows } = useWindowSize();
  const { disableMouse } = useMouse();
  const { repos, loading, refresh: refreshRegistry } = useRegistry();
  const {
    prData,
    associations,
    setExplicit: setExplicitPr,
    clearExplicit: clearExplicitPr,
    openPrs,
    errors: githubErrors,
    refresh: refreshGitHub,
    refreshCurrent: refreshGitHubCurrent,
    refreshAfterCurrent: refreshGitHubAfterCurrent,
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
  const agents = useAgents(repos);

  const navigation = useTreeNavigation(() => navigationSnapshot);
  const dispatchTreeNavigation = navigation.dispatch;
  const selectedIndex = navigation.selectedIndex;
  const selectTreeItem = useCallback(
    (itemIndex: number) =>
      dispatchTreeNavigation({ type: "select", itemIndex }),
    [dispatchTreeNavigation],
  );
  const captureTreeReturnPosition = useCallback(
    (slot: ReturnSlot, preserveSelection?: boolean) =>
      dispatchTreeNavigation({ type: "capture", slot, preserveSelection }),
    [dispatchTreeNavigation],
  );
  const restoreTreeReturnPosition = useCallback(
    (slot: ReturnSlot, destination?: ReturnDestination) =>
      dispatchTreeNavigation({ type: "restore", slot, destination }),
    [dispatchTreeNavigation],
  );
  const [openModalBase, setOpenModalBase] = useState<string | undefined>();
  const [openModalProfiles, setOpenModalProfiles] = useState<string[]>([]);
  const [openModalRepoProject, setOpenModalRepoProject] = useState("");
  const [openModalRepoPath, setOpenModalRepoPath] = useState("");
  const [mode, setMode] = useState<Mode>(Mode.Navigate);
  // Async continuations must read the current mode after awaiting.
  const modeRef = useRef<Mode>(mode);
  // Manual and validated Open expansion share Workspace Identity Keys.
  const [expandedWorkspaceKeys, setExpandedWorkspaceKeys] = useState<
    Set<string>
  >(new Set());
  const [expandedPrKeys, setExpandedPrKeys] = useState<Set<string>>(new Set());
  const setPrExpanded = useCallback((key: string, expanded: boolean) => {
    setExpandedPrKeys((previous) => {
      if (previous.has(key) === expanded) return previous;
      const next = new Set(previous);
      if (expanded) next.add(key);
      else next.delete(key);
      return next;
    });
  }, []);
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
  const prActions = usePrActions({
    mode,
    setMode,
    showActionError,
    refresh: refreshGitHub,
    refreshAfterCurrent: refreshGitHubAfterCurrent,
    setExplicit: setExplicitPr,
    clearExplicit: clearExplicitPr,
  });
  const { menu: prMenu, outcome: prOutcome } = prActions;
  const [lifecycle, setLifecycle] = useState<LifecycleState>(new Map());
  // Tmux handoff must wait until progress-row removal reaches the terminal.
  const lifecycleRef = useRef(lifecycle);
  const lifecycleCleanupWaitersRef = useRef<Map<string, Set<() => void>>>(
    new Map(),
  );
  const waitForLifecyclePresentationCleanup = useCallback(
    async (repoPath: string, branch: string): Promise<void> => {
      const key = workspaceIdentityKey(repoPath, branch);
      if (lifecycleRef.current.has(key)) {
        await new Promise<void>((resolve) => {
          const waiters = lifecycleCleanupWaitersRef.current.get(key);
          if (waiters) {
            waiters.add(resolve);
          } else {
            lifecycleCleanupWaitersRef.current.set(key, new Set([resolve]));
          }
        });
      }
      // A React commit can precede Ink's throttled stdout write.
      await waitUntilRenderFlush();
    },
    [waitUntilRenderFlush],
  );
  const lifecycleClaimsRef = useRef(createLifecycleClaims());
  const lifecycleClaims = lifecycleClaimsRef.current;
  const confirmDownReturnModeRef = useRef<Mode>(Mode.Navigate);
  const confirmCloseReturnModeRef = useRef<Mode>(Mode.Navigate);
  const confirmRemoveProjectReturnModeRef = useRef<Mode>(Mode.Navigate);
  const upModalReturnModeRef = useRef<Mode>(Mode.Navigate);
  const searchReturnModeRef = useRef<Mode>(Mode.Navigate);
  const shortcutsReturnModeRef = useRef<Mode>(Mode.Navigate);
  const modalReturnModeRef = useRef<Mode>(Mode.Navigate);
  const confirmPendingRef = useRef(false);
  const confirmKillAttemptRef = useRef(0);
  const lastMouseClickRef = useRef<MouseClickHistory | null>(null);

  const confirmationReturnContext = useCallback(
    (confirmMode: ConfirmMode): ConfirmationReturnContext => {
      switch (confirmMode.type) {
        case "ConfirmKill":
          return {
            slot: "kill",
            returnMode: Mode.Expanded(confirmMode.workspaceKey),
          };
        case "ConfirmDown":
          return {
            slot: "down",
            returnMode: confirmDownReturnModeRef.current,
          };
        case "ConfirmClose":
        case "ConfirmCloseForce":
          return {
            slot: "close",
            returnMode: confirmCloseReturnModeRef.current,
          };
        case "ConfirmRemoveProject":
          return {
            slot: "remove-project",
            returnMode: confirmRemoveProjectReturnModeRef.current,
          };
      }
    },
    [],
  );

  const returnFromConfirmation = useCallback(
    (confirmMode: ConfirmMode) => {
      const context = confirmationReturnContext(confirmMode);
      restoreTreeReturnPosition(context.slot);
      if (confirmMode.type === "ConfirmKill") {
        confirmKillAttemptRef.current += 1;
        confirmPendingRef.current = false;
      }
      setMode(context.returnMode);
    },
    [confirmationReturnContext, restoreTreeReturnPosition],
  );

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
    setExpandedWorkspaceKeys((previous) =>
      reconcileExpandedWorkspaceKeys(previous, repos),
    );
  }, [repos]);

  useEffect(() => {
    if (
      mode.type !== "Expanded" ||
      expandedWorkspaceKeys.has(mode.workspaceKey)
    ) {
      return;
    }
    const remainingKey = expandedWorkspaceKeys.values().next().value;
    setMode(
      typeof remainingKey === "string"
        ? Mode.Expanded(remainingKey)
        : Mode.Navigate,
    );
  }, [expandedWorkspaceKeys, mode]);

  const treeItems = useMemo(
    () =>
      buildTreeItems({
        repos: filteredRepos,
        expandedWorkspaceKeys,
        lifecycle,
        prData,
        associations,
        expandedPrKeys,
        panes,
        agents: agents.observations,
        jumpToPane: (paneId) => {
          void jumpToPane(paneId);
        },
      }),
    [
      filteredRepos,
      expandedWorkspaceKeys,
      lifecycle,
      prData,
      associations,
      expandedPrKeys,
      panes,
      agents.observations,
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
      expandedWorkspaceKeys,
      lifecycle,
      repoPath: selectedWorktreeRepo.repoPath,
      branch: selectedWorktreeData.branch,
    }),
  );

  const repoError = statusBarProps.selectedProject
    ? githubErrors.get(
        filteredRepos[treeItems[selectedIndex]?.repoIndex ?? -1]?.repoPath ??
          "",
      )
    : undefined;

  // The shared visual-row model drives both windowing here and the row-by-row
  // render in TreeView. Logical items are not 1:1 with terminal rows.
  const baseRows = useMemo(
    () =>
      buildTreeRows({
        items: treeItems,
        repos: filteredRepos,
        expandedWorkspaceKeys,
        lifecycle,
        maxWidth: termCols,
      }),
    [treeItems, filteredRepos, expandedWorkspaceKeys, lifecycle, termCols],
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

  // Errors and PR outcomes each occupy one truncated terminal row. StatusBar
  // owns its row count so viewport budgeting follows its render branches.
  // Form modals retain the navigation footer's virtual count to preserve wheel
  // scroll position on cancel; the tree box clips any excess modal height.
  // Confirmation rows are counted inside the tree model instead.
  const bottomChromeRowsForRepoError = (hasRepoError: boolean) =>
    statusBarRowCount(mode, hasRepoError) +
    (tmuxError || actionError ? 1 : 0) +
    (prOutcome ? 1 : 0);
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
      const targetRepoPath =
        filteredRepos[treeItems[itemIndex]?.repoIndex ?? -1]?.repoPath;
      const hasRepoError = Boolean(
        targetRepoPath && githubErrors.get(targetRepoPath),
      );
      return Math.max(
        0,
        termRows - TOP_CHROME_ROWS - bottomChromeRowsForRepoError(hasRepoError),
      );
    },
    searchQuery,
    lifecycle,
    confirming: confirmationMode !== null,
    confirmationSlot: confirmationMode
      ? confirmationReturnContext(confirmationMode).slot
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
    returnFromConfirmation(confirmationMode);
  }, [confirmationMode, confirmationAnchorItemIndex, returnFromConfirmation]);

  const refreshAll = useCallback(async (): Promise<RepoInfo[] | null> => {
    const [refreshedRepos] = await Promise.all([
      refreshRegistry(),
      refreshSessions(),
      discoverClient(),
    ]);
    return refreshedRepos;
  }, [refreshRegistry, refreshSessions, discoverClient]);

  const pollRefresh = useCallback(async (): Promise<void> => {
    await refreshAll();
  }, [refreshAll]);

  useRefresh(pollRefresh);

  const expandWorktree = useCallback((workspaceKey: string) => {
    setExpandedWorkspaceKeys((previous) => {
      const next = new Set(previous);
      next.add(workspaceKey);
      return next;
    });
    setMode(Mode.Expanded(workspaceKey));
  }, []);

  const collapseWorktree = useCallback((workspaceKey: string) => {
    setExpandedWorkspaceKeys((previous) => {
      if (!previous.has(workspaceKey)) return previous;
      const next = new Set(previous);
      next.delete(workspaceKey);
      return next;
    });
  }, []);

  const markWorkspaceDiscovered = useCallback((workspaceKey: string) => {
    setExpandedWorkspaceKeys((previous) => {
      if (previous.has(workspaceKey)) return previous;
      const next = new Set(previous);
      next.add(workspaceKey);
      return next;
    });
  }, []);

  const openModalPRList = useMemo(() => {
    return openPrs.get(openModalRepoPath) ?? [];
  }, [openPrs, openModalRepoPath]);

  const openModalOnRefresh = useCallback(
    (signal?: AbortSignal, full = false) => {
      void (full ? refreshGitHub : refreshGitHubCurrent)(
        openModalRepoPath,
        signal,
      );
    },
    [refreshGitHub, refreshGitHubCurrent, openModalRepoPath],
  );

  const sessionActions = useSessionActions({
    treeItems,
    filteredRepos,
    sessions,
    selectedIndex,
    mode,
    lifecycle,
    lifecycleClaims,
    captureTreeReturnPosition,
    restoreTreeReturnPosition,
    setMode,
    modeRef,
    setLifecycle,
    waitForLifecyclePresentationCleanup,
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
    captureTreeReturnPosition,
    restoreTreeReturnPosition,
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
    captureTreeReturnPosition,
    restoreTreeReturnPosition,
    setMode,
    showActionError,
    clearActionError,
    refreshAll,
    switchClientAwayFromSessions: sessionActions.switchClientAwayFromSessions,
    confirmRemoveProjectReturnModeRef,
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
    prepareRemoveProject: projectActions.prepareRemoveProject,
    refreshRepo: (repoPath: string) => void refreshGitHub(repoPath),
  };

  const expCtx: ExpandedContext = {
    ...navCtx,
    panes,
    selectTreeItem,
    captureTreeReturnPosition,
    zoomPane,
    refreshSessions,
    collapseWorktree,
  };

  function openPrActions(item: (typeof treeItems)[number]) {
    if (item.type !== "detail") return;
    const relevant = [
      "pr",
      "pr-title",
      "pr-fact",
      "candidate-group",
      "candidate",
    ].includes(item.detailKind);
    if (!relevant) return;
    const repo = filteredRepos[item.repoIndex];
    const wt = repo?.worktrees[item.worktreeIndex];
    if (!repo || !wt) return;
    const association = associations.get(
      workspaceIdentityKey(repo.repoPath, wt.branch),
    );
    const prRow =
      item.detailKind === "pr-title" || item.detailKind === "pr-fact"
        ? treeItems.find(
            (candidate) =>
              candidate.type === "detail" &&
              candidate.detailKind === "pr" &&
              candidate.meta.prKey === item.meta.prKey &&
              candidate.repoIndex === item.repoIndex &&
              candidate.worktreeIndex === item.worktreeIndex,
          )
        : item;
    const pr =
      item.detailKind === "candidate"
        ? item.meta.pr
        : prRow?.type === "detail" && prRow.detailKind === "pr"
          ? prRow.meta.pr
          : null;
    const kind =
      item.detailKind === "candidate"
        ? "candidate"
        : item.detailKind === "candidate-group"
          ? "group"
          : "pr";
    const target = {
      repoPath: repo.repoPath,
      branch: wt.branch,
      candidates: association?.candidates ?? [],
      explicit: association?.explicit === true,
    };
    if (kind === "group") prActions.open({ ...target, kind });
    else if (pr) prActions.open({ ...target, kind, pr });
  }

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
    returnFromConfirmation(mode);
  }

  function submitConfirm() {
    if (!isConfirmMode(mode)) return;
    if (confirmationAnchorItemIndex === null) {
      cancelConfirm();
      return;
    }
    switch (mode.type) {
      case "ConfirmKill": {
        if (confirmPendingRef.current) return;
        confirmPendingRef.current = true;
        const attempt = ++confirmKillAttemptRef.current;
        const { paneId, workspaceKey } = mode;
        clearActionError();
        void executeConfirmKill({
          paneId,
          killPane,
          refreshSessions,
          isCurrent: () => confirmKillAttemptRef.current === attempt,
          showActionError,
          onSuccess: () => {
            restoreTreeReturnPosition("kill", "owning-worktree");
            setMode(Mode.Expanded(workspaceKey));
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
            mode.workspaceKey,
            mode.repoPath,
            mode.project,
            mode.type === "ConfirmCloseForce",
          )
          .finally(() => {
            confirmPendingRef.current = false;
          });
        return;
      }
      case "ConfirmRemoveProject": {
        if (confirmPendingRef.current) return;
        confirmPendingRef.current = true;
        void projectActions
          .executeRemoveProject(mode.repoPath, mode.project)
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

        if (target.type === "detail") {
          const key =
            target.detailKind === "pr"
              ? target.meta.prKey
              : target.detailKind === "candidate-group"
                ? target.meta.groupKey
                : null;
          if (key) {
            setPrExpanded(key, !expandedPrKeys.has(key));
            return;
          }
          if (
            target.detailKind === "pr-title" ||
            target.detailKind === "pr-fact" ||
            target.detailKind === "candidate"
          )
            return;
        }

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
          expandedWorkspaceKeys,
        );
        switch (doubleClickAction.type) {
          case "expand-worktree":
            expandWorktree(doubleClickAction.workspaceKey);
            return;
          case "collapse-worktree":
            collapseWorktree(doubleClickAction.workspaceKey);
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

  useGuardedInput(
    (input, key) => {
      // Double-clicks require consecutive mouse presses. Any keyboard event
      // breaks the pair, even when it leaves the same row selected.
      lastMouseClickRef.current = null;
      if (mode.type === "Navigate" || mode.type === "Expanded") {
        const item = treeItems[selectedIndex];
        if (item?.type === "detail") {
          if (input === "p") {
            openPrActions(item);
            return;
          }
          const nodeKey =
            item.detailKind === "pr"
              ? item.meta.prKey
              : item.detailKind === "candidate-group"
                ? item.meta.groupKey
                : null;
          const childKey =
            item.detailKind === "pr-title" || item.detailKind === "pr-fact"
              ? item.meta.prKey
              : item.detailKind === "candidate"
                ? item.meta.groupKey
                : null;
          if (key.return && (nodeKey || childKey)) {
            item.action?.();
            return;
          }
          if (key.rightArrow && nodeKey) {
            setPrExpanded(nodeKey, true);
            return;
          }
          if (key.leftArrow && childKey) {
            const parentIndex = treeItems.findIndex(
              (candidate) =>
                candidate.type === "detail" &&
                ((candidate.detailKind === "pr" &&
                  candidate.meta.prKey === childKey &&
                  candidate.repoIndex === item.repoIndex &&
                  candidate.worktreeIndex === item.worktreeIndex) ||
                  (candidate.detailKind === "candidate-group" &&
                    candidate.meta.groupKey === childKey &&
                    candidate.repoIndex === item.repoIndex &&
                    candidate.worktreeIndex === item.worktreeIndex)),
            );
            if (parentIndex >= 0) selectTreeItem(parentIndex);
            setPrExpanded(childKey, false);
            return;
          }
          if (key.leftArrow && nodeKey) {
            if (expandedPrKeys.has(nodeKey)) {
              setPrExpanded(nodeKey, false);
              return;
            }
            const owner = findOwningWorktreeIndex(treeItems, selectedIndex);
            const wtItem = owner === null ? undefined : treeItems[owner];
            if (wtItem?.type === "worktree") {
              const repo = filteredRepos[wtItem.repoIndex];
              const wt = repo?.worktrees[wtItem.worktreeIndex];
              if (
                repo &&
                wt &&
                owner !== null &&
                !isWorktreeLifecycleActive(wtItem, filteredRepos, lifecycle)
              ) {
                selectTreeItem(owner);
                collapseWorktree(
                  workspaceIdentityKey(repo.repoPath, wt.branch),
                );
              }
            }
            return;
          }
        }
      }

      if (key.ctrl && input === "c") {
        disableMouse();
        exit();
        return;
      }

      if (
        input === "q" &&
        mode.type !== "OpenModal" &&
        mode.type !== "PrMenu" &&
        mode.type !== "UpModal" &&
        mode.type !== "AddProjectModal" &&
        mode.type !== "Search" &&
        mode.type !== "ConfirmKill" &&
        mode.type !== "ConfirmDown" &&
        mode.type !== "ConfirmClose" &&
        mode.type !== "ConfirmCloseForce" &&
        mode.type !== "ConfirmRemoveProject"
      ) {
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
          if (key.leftArrow && canCollapse) {
            return handleExpandedInput(expCtx, input, key);
          }
          return handleNavigateInput(navCtx, input, key);
        case "Search":
          return handleSearchInput(input, key);
        case "Shortcuts":
          if (key.escape) setMode(shortcutsReturnModeRef.current);
          return;
        case "OpenModal":
        case "PrMenu":
        case "UpModal":
        case "AddProjectModal":
          return;
        case "Expanded":
          return handleExpandedInput(expCtx, input, key);
        case "ConfirmKill":
        case "ConfirmDown":
        case "ConfirmClose":
        case "ConfirmCloseForce":
        case "ConfirmRemoveProject":
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
      {/* Only the tree may shrink; otherwise rows can overwrite the header. */}
      <Box flexDirection="column" flexShrink={0}>
        <Box justifyContent="space-between">
          <Text bold>wct</Text>
          <Text bold color="cyan" inverse={isAddProjectButtonHovered}>
            {ADD_PROJECT_BUTTON_LABEL}
          </Text>
        </Box>
        <Text> </Text>
      </Box>
      {/* Clip excess tree rows when a modal exceeds the footer budget. The
          inner wrapper preserves row heights instead of squeezing them. */}
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
            associations={associations}
            panes={panes}
            agents={agents}
            expandedWorkspaceKeys={expandedWorkspaceKeys}
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
      {/* Keep footer and form heights fixed while the tree shrinks. */}
      <Box flexDirection="column" flexShrink={0}>
        {mode.type === "Shortcuts" ? (
          <ShortcutsModal
            width={Math.min(termCols, 60)}
            onHide={() => setMode(shortcutsReturnModeRef.current)}
          />
        ) : mode.type === "PrMenu" && prMenu ? (
          <PrActionsModal
            key={prMenu.screen}
            title={prActions.title}
            options={prActions.options}
            width={Math.min(termCols, 70)}
            onChoose={prActions.choose}
            onCancel={prActions.close}
          />
        ) : mode.type === "OpenModal" ? (
          <OpenModal
            visible
            width={Math.min(termCols, 60)}
            defaultBase={openModalBase ?? ""}
            profileNames={openModalProfiles}
            repoPath={openModalRepoPath}
            prList={openModalPRList}
            isRefreshing={refreshingProjects.has(openModalRepoPath)}
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
              restoreTreeReturnPosition("up");
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
            {prOutcome ? (
              <Text color="#40a02b" wrap="truncate">
                {prOutcome}
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
  // App handles Ctrl+C so mouse reporting stops before Ink releases raw mode.
  const input = createTerminalInput(process.stdin);
  try {
    const instance = render(<App />, {
      stdin: input.stdin,
      alternateScreen: true,
      exitOnCtrlC: false,
    });
    await instance.waitUntilExit();
  } finally {
    input.dispose();
  }
}
