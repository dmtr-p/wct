// src/tui/App.tsx

import {
  Box,
  type Key,
  render,
  Text,
  useApp,
  useInput,
  useWindowSize,
} from "ink";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AddProjectModal } from "./components/AddProjectModal";
import { OpenModal } from "./components/OpenModal";
import { StatusBar, singleLineFooterText } from "./components/StatusBar";
import { TreeView } from "./components/TreeView";
import { UpModal } from "./components/UpModal";
import { useActionError } from "./hooks/useActionError";
import { useGitHub } from "./hooks/useGitHub";
import { useModalActions } from "./hooks/useModalActions";
import { useRefresh } from "./hooks/useRefresh";
import { useRegistry } from "./hooks/useRegistry";
import { useSessionActions } from "./hooks/useSessionActions";
import type { SessionIdeDefaults } from "./hooks/useSessionOptionsState";
import { useTerminalMouse } from "./hooks/useTerminalMouse";
import { useTmux } from "./hooks/useTmux";
import { handleConfirmCloseInput } from "./input/confirm-close";
import type { ExpandedContext } from "./input/expanded";
import { handleExpandedInput } from "./input/expanded";
import type { NavigateContext } from "./input/navigate";
import { handleNavigateInput } from "./input/navigate";
import {
  detectDoubleClick,
  getTreeRenderedRows,
  type MouseClick,
  type MouseClickHistory,
  parseMouseClick,
  parseMouseScroll,
  resolveTreeDoubleClickAction,
  resolveTreeMouseTarget,
  resolveTreeViewportHeight,
  revealTreeItem,
  scrollTreeViewport,
} from "./mouse";
import {
  buildTreeItems,
  findOwningWorktreeIndex,
  resolveRecoveredSelectionIndex,
  resolveStatusBarProps,
  resolveTreeReturnMode,
  treeItemId,
} from "./tree-helpers";
import { Mode, type PendingAction, type PRInfo, pendingKey } from "./types";

export function App() {
  useTerminalMouse();
  const { exit } = useApp();
  const { columns: termCols, rows: termRows } = useWindowSize();
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

  const [selectedIndex, setSelectedIndex] = useState(0);
  const [treeScrollOffset, setTreeScrollOffset] = useState(0);
  const [openModalBase, setOpenModalBase] = useState<string | undefined>();
  const [openModalProfiles, setOpenModalProfiles] = useState<string[]>([]);
  const [openModalRepoProject, setOpenModalRepoProject] = useState("");
  const [openModalRepoPath, setOpenModalRepoPath] = useState("");
  const [openModalIdeDefaults, setOpenModalIdeDefaults] =
    useState<SessionIdeDefaults>({ baseNoIde: true, profileNoIde: {} });
  const [mode, setMode] = useState<Mode>(Mode.Navigate);
  const [expandedWorktreeKeys, setExpandedWorktreeKeys] = useState<Set<string>>(
    new Set(),
  );
  const [searchQuery, setSearchQuery] = useState("");
  const { actionError, showActionError, clearActionError } = useActionError();
  const [pendingActions, setPendingActions] = useState<
    Map<string, PendingAction>
  >(new Map());
  const confirmDownReturnModeRef = useRef<Mode>(Mode.Navigate);
  const confirmDownReturnSelectedIndexRef = useRef<number>(0);
  const confirmCloseReturnModeRef = useRef<Mode>(Mode.Navigate);
  const confirmCloseReturnSelectedIndexRef = useRef<number>(0);
  const upModalReturnModeRef = useRef<Mode>(Mode.Navigate);
  const upModalReturnSelectedIndexRef = useRef<number>(0);
  const searchReturnModeRef = useRef<Mode>(Mode.Navigate);
  const modalReturnModeRef = useRef<Mode>(Mode.Navigate);
  const lastMouseClickRef = useRef<MouseClickHistory | null>(null);

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

  const availableWorktreeKeys = useMemo(
    () =>
      new Set(
        repos.flatMap((repo) =>
          repo.worktrees.map((worktree) =>
            pendingKey(repo.project, worktree.branch),
          ),
        ),
      ),
    [repos],
  );

  useEffect(() => {
    setExpandedWorktreeKeys((previous) => {
      const next = new Set(
        [...previous].filter((key) => availableWorktreeKeys.has(key)),
      );
      return next.size === previous.size ? previous : next;
    });
  }, [availableWorktreeKeys]);

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
        prData,
        panes,
        jumpToPane,
      }),
    [filteredRepos, expandedWorktreeKeys, prData, panes, jumpToPane],
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
    repos: filteredRepos,
  });
  const selectedRepoError = statusBarProps.selectedProject
    ? githubErrors.get(statusBarProps.selectedProject)
    : undefined;
  const hasActionMessage = !!actionError || (!!tmuxError && !actionError);
  const treeFooterHeight =
    3 + (hasActionMessage ? 1 : 0) + (selectedRepoError ? 1 : 0);
  const modalVisible =
    mode.type === "OpenModal" ||
    mode.type === "UpModal" ||
    mode.type === "AddProjectModal";
  const treeViewportHeight = resolveTreeViewportHeight(
    termRows,
    treeFooterHeight,
    modalVisible,
  );
  const renderedTreeRows = useMemo(
    () =>
      getTreeRenderedRows({
        items: treeItems,
        repos: filteredRepos,
        pendingActions,
        expandedWorktreeKeys,
      }),
    [filteredRepos, pendingActions, treeItems, expandedWorktreeKeys],
  );
  const renderedTreeRowsSignature = renderedTreeRows
    .map((row) => row ?? "phantom")
    .join(",");
  const selectedTreeItemIdentity = treeItems[selectedIndex]
    ? treeItemId(treeItems[selectedIndex], filteredRepos)
    : null;
  const renderedTreeRowsRef = useRef(renderedTreeRows);
  renderedTreeRowsRef.current = renderedTreeRows;

  // biome-ignore lint/correctness/useExhaustiveDependencies: semantic triggers prevent refresh-only row-array changes from resetting manual scroll
  useEffect(() => {
    if (treeViewportHeight === 0) return;
    setTreeScrollOffset((currentOffset) =>
      revealTreeItem(
        renderedTreeRowsRef.current,
        selectedIndex,
        currentOffset,
        treeViewportHeight,
      ),
    );
  }, [
    renderedTreeRowsSignature,
    searchQuery,
    selectedIndex,
    selectedTreeItemIdentity,
    treeViewportHeight,
  ]);

  const refreshAll = useCallback(async () => {
    await Promise.all([refreshRegistry(), refreshSessions(), discoverClient()]);
  }, [refreshRegistry, refreshSessions, discoverClient]);

  useRefresh(refreshAll);

  const expandWorktree = useCallback((worktreeKey: string) => {
    setExpandedWorktreeKeys((previous) => {
      const next = new Set(previous);
      next.add(worktreeKey);
      return next;
    });
    setMode(Mode.Expanded(worktreeKey));
  }, []);

  const collapseWorktree = useCallback(
    (worktreeKey: string) => {
      const next = new Set(expandedWorktreeKeys);
      next.delete(worktreeKey);
      setExpandedWorktreeKeys(next);

      const remainingKey = next.values().next().value;
      setMode(
        typeof remainingKey === "string"
          ? Mode.Expanded(remainingKey)
          : Mode.Navigate,
      );
    },
    [expandedWorktreeKeys],
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
    setSelectedIndex,
    setMode,
    setPendingActions,
    showActionError,
    clearActionError,
    switchSession,
    detachClient,
    discoverClient,
    refreshSessions,
    refreshAll,
    confirmDownReturnModeRef,
    confirmDownReturnSelectedIndexRef,
    confirmCloseReturnModeRef,
    confirmCloseReturnSelectedIndexRef,
  });

  const modalActions = useModalActions({
    treeItems,
    filteredRepos,
    selectedIndex,
    mode,
    openModalRepoProject,
    openModalRepoPath,
    setMode,
    setSelectedIndex,
    setPendingActions,
    setOpenModalBase,
    setOpenModalProfiles,
    setOpenModalRepoProject,
    setOpenModalRepoPath,
    setOpenModalIdeDefaults,
    showActionError,
    clearActionError,
    switchSession,
    discoverClient,
    handleStartResult: sessionActions.handleStartResult,
    refreshAll,
    upModalReturnModeRef,
    upModalReturnSelectedIndexRef,
    modalReturnModeRef,
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
    setMode: setTreeInputMode,
    setSearchQuery,
    expandWorktree,
    navigateTree: sessionActions.navigateTree,
    prepareOpenModal: modalActions.prepareOpenModal,
    prepareUpModal: modalActions.prepareUpModal,
    prepareAddProjectModal: modalActions.prepareAddProjectModal,
    handleSpaceSwitch: sessionActions.handleSpaceSwitch,
    handleDownSelectedWorktree: sessionActions.handleDownSelectedWorktree,
    handleCloseSelectedWorktree: sessionActions.handleCloseSelectedWorktree,
    refreshRepo: (project: string) => void refreshGitHub(project),
  };

  const expCtx: ExpandedContext = {
    ...navCtx,
    panes,
    setSelectedIndex,
    zoomPane,
    killPane,
    refreshSessions,
    collapseWorktree,
  };

  const handleMouseClick = useCallback(
    (click: MouseClick) => {
      if (mode.type !== "Navigate" && mode.type !== "Expanded") {
        lastMouseClickRef.current = null;
        return;
      }

      // The tree begins after the title and spacer rows. SGR rows are 1-based.
      const visibleRow = click.row - 3;
      if (visibleRow < 0 || visibleRow >= treeViewportHeight) {
        lastMouseClickRef.current = null;
        return;
      }

      const targetIndex = resolveTreeMouseTarget({
        row: visibleRow,
        scrollOffset: treeScrollOffset,
        items: treeItems,
        repos: filteredRepos,
        pendingActions,
        expandedWorktreeKeys,
      });
      if (targetIndex === null) {
        lastMouseClickRef.current = null;
        return;
      }

      const target = treeItems[targetIndex];
      if (!target) return;
      setSelectedIndex(targetIndex);

      const targetId = treeItemId(target, filteredRepos);
      if (!targetId) {
        lastMouseClickRef.current = null;
        return;
      }
      const detection = detectDoubleClick(
        lastMouseClickRef.current,
        targetId,
        Date.now(),
      );
      lastMouseClickRef.current = detection.history;
      if (!detection.isDoubleClick) return;

      const action = resolveTreeDoubleClickAction(
        target,
        filteredRepos,
        expandedWorktreeKeys,
      );
      switch (action.type) {
        case "expand-worktree":
          expandWorktree(action.worktreeKey);
          break;
        case "collapse-worktree":
          collapseWorktree(action.worktreeKey);
          break;
        case "activate-detail":
          action.action();
          break;
      }
    },
    [
      collapseWorktree,
      expandWorktree,
      expandedWorktreeKeys,
      filteredRepos,
      mode.type,
      pendingActions,
      treeScrollOffset,
      treeItems,
      treeViewportHeight,
    ],
  );

  const handleMouseScroll = useCallback(
    (row: number, direction: -1 | 1) => {
      lastMouseClickRef.current = null;
      if (mode.type !== "Navigate" && mode.type !== "Expanded") return;

      const visibleRow = row - 3;
      if (visibleRow < 0 || visibleRow >= treeViewportHeight) return;

      setTreeScrollOffset((currentOffset) =>
        scrollTreeViewport(
          currentOffset,
          direction * 3,
          renderedTreeRows.length,
          treeViewportHeight,
        ),
      );
    },
    [mode.type, renderedTreeRows.length, treeViewportHeight],
  );

  function handleSearchInput(input: string, key: Key) {
    if (key.escape) {
      setMode(searchReturnModeRef.current);
      setSearchQuery("");
    } else if (key.backspace) {
      setSearchQuery((q) => q.slice(0, -1));
    } else if (key.return) {
      setMode(searchReturnModeRef.current);
    } else if (input && !key.ctrl && !key.meta) {
      setSearchQuery((q) => q + input);
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
      const { branch, worktreeKey, worktreePath, sessionName } = mode;
      void sessionActions.executeDown(
        sessionName,
        branch,
        worktreePath,
        worktreeKey,
      );
    }
  }

  useInput((input, key) => {
    const mouseScroll = parseMouseScroll(input);
    if (mouseScroll) {
      handleMouseScroll(mouseScroll.row, mouseScroll.direction);
      return;
    }

    const mouseClick = parseMouseClick(input);
    if (mouseClick) {
      handleMouseClick(mouseClick);
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
      mode.type !== "ConfirmCloseForce"
    ) {
      exit();
      return;
    }

    switch (mode.type) {
      case "Navigate":
        return handleNavigateInput(navCtx, input, key);
      case "Search":
        return handleSearchInput(input, key);
      case "OpenModal":
      case "UpModal":
      case "AddProjectModal":
        return;
      case "Expanded":
        return handleExpandedInput(expCtx, input, key);
      case "ConfirmKill":
        return handleConfirmKillInput(input, key);
      case "ConfirmDown":
        return handleConfirmDownInput(input, key);
      case "ConfirmClose":
      case "ConfirmCloseForce":
        return handleConfirmCloseInput(
          {
            mode,
            returnMode: confirmCloseReturnModeRef.current,
            returnSelectedIndex: confirmCloseReturnSelectedIndexRef.current,
            setMode,
            setSelectedIndex,
            executeClose: (...args) =>
              void sessionActions.executeClose(...args),
          },
          input,
          key,
        );
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

  return (
    <Box flexDirection="column" height={termRows} overflow="hidden">
      <Text bold>wct</Text>
      <Text> </Text>
      {treeViewportHeight > 0 ? (
        <Box
          flexDirection="column"
          height={treeViewportHeight}
          flexShrink={0}
          overflowY="hidden"
        >
          <TreeView
            repos={filteredRepos}
            sessions={sessions}
            selectedIndex={selectedIndex}
            items={treeItems}
            pendingActions={pendingActions}
            prData={prData}
            panes={panes}
            expandedWorktreeKeys={expandedWorktreeKeys}
            maxWidth={termCols}
            renderedRows={renderedTreeRows}
            scrollOffset={treeScrollOffset}
            viewportHeight={treeViewportHeight}
            refreshingProjects={refreshingProjects}
            errors={githubErrors}
          />
        </Box>
      ) : null}
      {mode.type === "OpenModal" ? (
        <OpenModal
          visible
          width={Math.min(termCols, 60)}
          defaultBase={openModalBase ?? ""}
          profileNames={openModalProfiles}
          repoProject={openModalRepoProject}
          repoPath={openModalRepoPath}
          ideDefaults={openModalIdeDefaults}
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
          ideDefaults={mode.ideDefaults}
          onSubmit={modalActions.handleUpSubmit}
          onCancel={() => {
            setSelectedIndex(upModalReturnSelectedIndexRef.current);
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
              {singleLineFooterText(tmuxError)}
            </Text>
          ) : null}
          {actionError ? (
            <Text color="red" wrap="truncate">
              {singleLineFooterText(actionError)}
            </Text>
          ) : null}
          <StatusBar
            {...statusBarProps}
            searchQuery={searchQuery}
            hasClient={tmuxClient !== null}
            repoError={selectedRepoError}
          />
        </Box>
      )}
    </Box>
  );
}

export async function startTui(): Promise<void> {
  const instance = render(<App />, { alternateScreen: true });
  await instance.waitUntilExit();
}
