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
import { StatusBar } from "./components/StatusBar";
import { TreeView } from "./components/TreeView";
import { UpModal } from "./components/UpModal";
import { useActionError } from "./hooks/useActionError";
import { useGitHub } from "./hooks/useGitHub";
import { useModalActions } from "./hooks/useModalActions";
import { useRefresh } from "./hooks/useRefresh";
import { useRegistry } from "./hooks/useRegistry";
import { useSessionActions } from "./hooks/useSessionActions";
import type { SessionIdeDefaults } from "./hooks/useSessionOptionsState";
import { useTmux } from "./hooks/useTmux";
import { handleConfirmCloseInput } from "./input/confirm-close";
import type { ExpandedContext } from "./input/expanded";
import { handleExpandedInput } from "./input/expanded";
import type { NavigateContext } from "./input/navigate";
import { handleNavigateInput } from "./input/navigate";
import {
  buildTreeItems,
  buildTreeRows,
  clampScrollOffset,
  findOwningWorktreeIndex,
  firstRowForItem,
  resolveRecoveredSelectionIndex,
  resolveStatusBarProps,
  scrollToKeepVisible,
  treeItemId,
} from "./tree-helpers";
import { Mode, type PendingAction, type PRInfo } from "./types";

/** Top chrome above the tree: the `wct` header line + a blank spacer line. */
const TOP_CHROME_ROWS = 2;

export function App() {
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

  const [expandedRepos, setExpandedRepos] = useState<Set<string>>(new Set());
  const [didInitialExpand, setDidInitialExpand] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [scrollOffset, setScrollOffset] = useState(0);
  const [openModalBase, setOpenModalBase] = useState<string | undefined>();
  const [openModalProfiles, setOpenModalProfiles] = useState<string[]>([]);
  const [openModalRepoProject, setOpenModalRepoProject] = useState("");
  const [openModalRepoPath, setOpenModalRepoPath] = useState("");
  const [openModalIdeDefaults, setOpenModalIdeDefaults] =
    useState<SessionIdeDefaults>({ baseNoIde: true, profileNoIde: {} });
  const [mode, setMode] = useState<Mode>(Mode.Navigate);
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
    (mode.type === "UpModal" &&
      upModalReturnModeRef.current.type === "Expanded") ||
    (mode.type === "ConfirmDown" &&
      confirmDownReturnModeRef.current.type === "Expanded") ||
    ((mode.type === "ConfirmClose" || mode.type === "ConfirmCloseForce") &&
      confirmCloseReturnModeRef.current.type === "Expanded")
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

  const statusBarProps = resolveStatusBarProps({
    mode,
    items: treeItems,
    selectedIndex,
    repos: filteredRepos,
  });

  const repoError = statusBarProps.selectedProject
    ? githubErrors.get(statusBarProps.selectedProject)
    : undefined;

  // The shared visual-row model drives both windowing here and the row-by-row
  // render in TreeView. Logical items are not 1:1 with terminal rows.
  const rows = useMemo(
    () =>
      buildTreeRows({
        items: treeItems,
        repos: filteredRepos,
        expandedRepos,
        expandedWorktreeKey,
        pendingActions,
      }),
    [
      treeItems,
      filteredRepos,
      expandedRepos,
      expandedWorktreeKey,
      pendingActions,
    ],
  );

  // The 3 true modals do not scroll the tree — rendering it in full keeps the
  // modal on-screen. The interactive layout (Navigate/Expanded/Search) windows
  // the tree under the StatusBar + optional error lines.
  const isTrueModal =
    mode.type === "OpenModal" ||
    mode.type === "UpModal" ||
    mode.type === "AddProjectModal";

  // Bottom chrome in the interactive layout: optional tmux/action error line
  // (mutually exclusive) + StatusBar (1 divider + optional repoError line + 2
  // hint lines). Search renders an extra query line in place of one hint, but
  // the line count stays at 3 either way. StatusBar only renders the repoError
  // line in its default Navigate/Expanded branch (Confirm/Search return early),
  // so only budget for it there.
  const bottomChromeRows = isTrueModal
    ? 0
    : 1 + // divider
      2 + // two hint lines (or query + hint in Search)
      (repoError && (mode.type === "Navigate" || mode.type === "Expanded")
        ? 1
        : 0) +
      ((tmuxError && !actionError) || actionError ? 1 : 0);

  const viewportRows = isTrueModal
    ? Math.max(1, rows.length)
    : Math.max(1, termRows - TOP_CHROME_ROWS - bottomChromeRows);

  const effectiveScrollOffset = clampScrollOffset(
    scrollOffset,
    rows.length,
    viewportRows,
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

    // Keep the scroll offset valid after a background refresh so it can't
    // desync from the selection (e.g. rows removed below the window).
    setScrollOffset((prev) =>
      clampScrollOffset(prev, rows.length, viewportRows),
    );
  }, [
    treeItems,
    selectedIndex,
    filteredRepos,
    searchQuery,
    rows,
    viewportRows,
  ]);

  // Keyboard ↑/↓ are viewport-aware: after a navigation moves selectedIndex,
  // nudge the scroll offset minimally to keep the selection on screen. Keyed on
  // [selectedIndex, rows, viewportRows] but NOT scrollOffset, and uses a
  // functional update so it never fights a future wheel scroll (slice 02).
  useEffect(() => {
    const rowIndex = firstRowForItem(rows, selectedIndex);
    if (rowIndex === null) return;
    setScrollOffset((prev) =>
      scrollToKeepVisible(rowIndex, prev, viewportRows),
    );
  }, [selectedIndex, rows, viewportRows]);

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
  });

  const navCtx: NavigateContext = {
    treeItems,
    filteredRepos,
    selectedIndex,
    expandedRepos,
    tmuxClient,
    setMode,
    setSearchQuery,
    navigateTree: sessionActions.navigateTree,
    toggleExpanded,
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
  };

  function handleSearchInput(input: string, key: Key) {
    if (key.escape) {
      setMode(Mode.Navigate);
      setSearchQuery("");
    } else if (key.backspace) {
      setSearchQuery((q) => q.slice(0, -1));
    } else if (key.return) {
      setMode(Mode.Navigate);
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
          refreshingProjects={refreshingProjects}
          errors={githubErrors}
          scrollOffset={effectiveScrollOffset}
          viewportRows={viewportRows}
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
          ideDefaults={openModalIdeDefaults}
          prList={openModalPRList}
          isRefreshing={refreshingProjects.has(openModalRepoProject)}
          onRefresh={openModalOnRefresh}
          onSubmit={modalActions.handleOpen}
          onCancel={() => setMode(Mode.Navigate)}
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
          onCancel={() => setMode(Mode.Navigate)}
        />
      ) : (
        <Box flexDirection="column">
          {tmuxError && !actionError ? (
            <Text color="yellow">{tmuxError}</Text>
          ) : null}
          {actionError ? <Text color="red">{actionError}</Text> : null}
          <StatusBar
            {...statusBarProps}
            searchQuery={searchQuery}
            hasClient={tmuxClient !== null}
            repoError={repoError}
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
