// src/tui/App.tsx

import { Box, type Key, render, Text, useApp, useInput, useStdout } from "ink";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { stopWorktreeSession } from "../commands/worktree-session";
import { toWctError } from "../errors";
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
import { useTmux } from "./hooks/useTmux";
import { tuiRuntime } from "./runtime";
import {
  buildTreeItems,
  findOwningWorktreeIndex,
  adjustIndexForDetailCollapse,
  resolveRecoveredSelectionIndex,
  resolveExpandedRightArrowAction,
  resolveSelectedPane,
  resolveStatusBarProps,
  treeItemId,
} from "./tree-helpers";
import { Mode, type PendingAction, type PRInfo, pendingKey } from "./types";

export function App() {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const termCols = stdout?.columns ?? 80;
  const termRows = stdout?.rows ?? 24;
  const { repos, loading, refresh: refreshRegistry } = useRegistry();
  const { prData } = useGitHub(repos);
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
  const [openModalBase, setOpenModalBase] = useState<string | undefined>();
  const [openModalProfiles, setOpenModalProfiles] = useState<string[]>([]);
  const [openModalRepoProject, setOpenModalRepoProject] = useState("");
  const [openModalRepoPath, setOpenModalRepoPath] = useState("");
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
    prData,
    openModalRepoProject,
    openModalRepoPath,
    setMode,
    setSelectedIndex,
    setPendingActions,
    setOpenModalBase,
    setOpenModalProfiles,
    setOpenModalRepoProject,
    setOpenModalRepoPath,
    setOpenModalPRList,
    showActionError,
    clearActionError,
    handleStartResult: sessionActions.handleStartResult,
    refreshAll,
    upModalReturnModeRef,
    upModalReturnSelectedIndexRef,
  });

  function handleConfirmCloseInput(_input: string, key: Key) {
    if (mode.type !== "ConfirmClose" && mode.type !== "ConfirmCloseForce") {
      return;
    }

    if (key.escape) {
      setSelectedIndex(confirmCloseReturnSelectedIndexRef.current);
      setMode(confirmCloseReturnModeRef.current);
      return;
    }

    if (key.return) {
      if (mode.type === "ConfirmClose" && mode.changedFiles > 0) {
        setMode(
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

      const force = mode.type === "ConfirmCloseForce";
      void sessionActions.executeClose(
        mode.sessionName,
        mode.branch,
        mode.worktreePath,
        mode.worktreeKey,
        mode.repoPath,
        mode.project,
        force,
      );
    }
  }

  function handleNavigateInput(input: string, key: Key) {
    if (input === "/") {
      setMode(Mode.Search);
      setSearchQuery("");
      return;
    }

    if (input === "o") {
      modalActions.prepareOpenModal();
      return;
    }

    if (input === " " && tmuxClient) {
      sessionActions.handleSpaceSwitch();
      return;
    }

    if (input === "d" && tmuxClient) {
      sessionActions.handleDownSelectedWorktree();
      return;
    }

    if (input === "u") {
      modalActions.prepareUpModal();
      return;
    }

    if (key.upArrow) {
      sessionActions.navigateTree(-1);
      return;
    }

    if (key.downArrow) {
      sessionActions.navigateTree(1);
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
      sessionActions.handleCloseSelectedWorktree();
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
      sessionActions.navigateTree(-1);
      return;
    }

    if (key.downArrow) {
      sessionActions.navigateTree(1);
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

    if (input === " " && tmuxClient) {
      sessionActions.handleSpaceSwitch();
      return;
    }

    if (input === "o") {
      modalActions.prepareOpenModal();
      return;
    }

    if (input === "d" && tmuxClient) {
      sessionActions.handleDownSelectedWorktree();
      return;
    }

    if (input === "u") {
      modalActions.prepareUpModal();
      return;
    }

    if (input === "c") {
      sessionActions.handleCloseSelectedWorktree();
      return;
    }

    if (input === "/") {
      setMode(Mode.Search);
      setSearchQuery("");
      return;
    }

    if (input === "z" && tmuxClient) {
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

    if (input === "x" && tmuxClient) {
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
      clearActionError();

      void (async () => {
        const canProceed =
          await sessionActions.switchClientAwayFromSession(sessionName);
        if (!canProceed) {
          showActionError(
            "Cannot safely stop the tmux session because the active client could not be moved away",
          );
          return;
        }

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

        try {
          const result = await tuiRuntime.runPromise(
            stopWorktreeSession({ path: worktreePath }),
          );
          if (!result.existed) {
            showActionError(`No tmux session '${result.sessionName}' found`);
          }
          await refreshAll();
        } catch (error) {
          showActionError(toWctError(error).message);
          await refreshAll();
        } finally {
          setPendingActions((prev) => {
            const next = new Map(prev);
            next.delete(worktreeKey);
            return next;
          });
        }
      })();
    }
  }

  useInput((input, key) => {
    // Global keys (work in any mode)
    if (
      input === "q" &&
      mode.type !== "OpenModal" &&
      mode.type !== "UpModal" &&
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
        return handleNavigateInput(input, key);
      case "Search":
        return handleSearchInput(input, key);
      case "OpenModal":
        // Modal handles its own input
        return;
      case "UpModal":
        // Modal handles its own input
        return;
      case "Expanded":
        return handleExpandedInput(input, key);
      case "ConfirmKill":
        return handleConfirmKillInput(input, key);
      case "ConfirmDown":
        return handleConfirmDownInput(input, key);
      case "ConfirmClose":
      case "ConfirmCloseForce":
        return handleConfirmCloseInput(input, key);
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
          onSubmit={modalActions.handleOpen}
          onCancel={() => setMode(Mode.Navigate)}
        />
      ) : mode.type === "UpModal" ? (
        <UpModal
          visible
          width={Math.min(termCols, 60)}
          profileNames={mode.profileNames}
          onSubmit={modalActions.handleUpSubmit}
          onCancel={() => {
            setSelectedIndex(upModalReturnSelectedIndexRef.current);
            setMode(upModalReturnModeRef.current);
          }}
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
          />
        </Box>
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
