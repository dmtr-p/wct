// src/tui/App.tsx

import { basename } from "node:path";
import { Effect } from "effect";
import { Box, type Key, render, Text, useApp, useInput, useStdout } from "ink";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type StartWorktreeSessionResult,
  startWorktreeSession,
  stopWorktreeSession,
} from "../commands/worktree-session";
import { toWctError } from "../errors";
import { formatSessionName, TmuxService } from "../services/tmux";
import { WorktreeService } from "../services/worktree-service";
import { OpenModal, type OpenModalResult } from "./components/OpenModal";
import { StatusBar } from "./components/StatusBar";
import { TreeView } from "./components/TreeView";
import { UpModal, type UpModalResult } from "./components/UpModal";
import { useGitHub } from "./hooks/useGitHub";
import { useRefresh } from "./hooks/useRefresh";
import { useRegistry } from "./hooks/useRegistry";
import { useTmux } from "./hooks/useTmux";
import { tuiRuntime } from "./runtime";
import {
  buildTreeItems,
  findOwningWorktreeIndex,
  adjustIndexForDetailCollapse,
  resolveRecoveredSelectionIndex,
  resolveSelectedWorktreeIndex,
  resolveExpandedRightArrowAction,
  resolveSelectedPane,
  resolveStatusBarProps,
  treeItemId,
} from "./tree-helpers";
import {
  resolveSessionHandoff,
  resolveStartActionMessage,
} from "./session-utils";
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
  const [actionError, setActionError] = useState<string | null>(null);
  const [pendingActions, setPendingActions] = useState<
    Map<string, PendingAction>
  >(new Map());
  const confirmDownReturnModeRef = useRef<Mode>(Mode.Navigate);
  const confirmDownReturnSelectedIndexRef = useRef<number>(0);
  const confirmCloseReturnModeRef = useRef<Mode>(Mode.Navigate);
  const confirmCloseReturnSelectedIndexRef = useRef<number>(0);
  const upModalReturnModeRef = useRef<Mode>(Mode.Navigate);
  const upModalReturnSelectedIndexRef = useRef<number>(0);
  const actionErrorTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );

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

  const clearActionError = useCallback(() => {
    if (actionErrorTimeoutRef.current) {
      clearTimeout(actionErrorTimeoutRef.current);
      actionErrorTimeoutRef.current = null;
    }
    setActionError(null);
  }, []);

  const showActionError = useCallback((message: string) => {
    if (actionErrorTimeoutRef.current) {
      clearTimeout(actionErrorTimeoutRef.current);
    }
    setActionError(message);
    actionErrorTimeoutRef.current = setTimeout(() => {
      actionErrorTimeoutRef.current = null;
      setActionError(null);
    }, 5000);
  }, []);

  useEffect(
    () => () => {
      if (actionErrorTimeoutRef.current) {
        clearTimeout(actionErrorTimeoutRef.current);
      }
    },
    [],
  );

  const switchClientAwayFromSession = useCallback(
    async (sessionName: string) => {
      const [client, latestSessions] = await Promise.all([
        discoverClient(),
        refreshSessions(),
      ]);
      const handoff = resolveSessionHandoff({
        client,
        targetSession: sessionName,
        sessions: latestSessions,
      });

      if (handoff.type === "not-needed") {
        return true;
      }

      if (handoff.type === "blocked") {
        return false;
      }

      if (handoff.type === "detach") {
        return client.type === "single" ? detachClient(client.client) : false;
      }

      return client.type === "single"
        ? switchSession(handoff.sessionName, client.client)
        : false;
    },
    [detachClient, discoverClient, refreshSessions, switchSession],
  );

  const handleStartResult = useCallback(
    async (result: StartWorktreeSessionResult, autoSwitch: boolean) => {
      const actionMessage = resolveStartActionMessage(result);

      if (result.tmux.attempted && result.tmux.ok && autoSwitch) {
        const liveClient = await discoverClient();
        if (liveClient.type === "single") {
          const switched = await switchSession(
            result.sessionName,
            liveClient.client,
          );
          await refreshSessions();

          if (!switched) {
            showActionError(
              `Started session '${result.sessionName}', but failed to switch client`,
            );
          } else if (actionMessage) {
            showActionError(actionMessage);
          }
          return;
        }
      }

      await refreshAll();

      if (actionMessage) {
        showActionError(actionMessage);
      }
    },
    [
      discoverClient,
      refreshAll,
      refreshSessions,
      showActionError,
      switchSession,
    ],
  );

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

  function prepareUpModal() {
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

    const worktreeKey = pendingKey(repo.project, wt.branch);
    upModalReturnSelectedIndexRef.current = selectedIndex;
    upModalReturnModeRef.current =
      mode.type === "Expanded" ? Mode.Expanded(worktreeKey) : Mode.Navigate;
    setMode(Mode.UpModal(wt.path, worktreeKey, repo.profileNames));
  }

  function handleUpSubmit(result: UpModalResult) {
    if (mode.type !== "UpModal") return;

    const { worktreePath, worktreeKey } = mode;
    clearActionError();
    setSelectedIndex(upModalReturnSelectedIndexRef.current);
    setMode(upModalReturnModeRef.current);

    const branch = worktreeKey.split("/").slice(1).join("/");
    const project = worktreeKey.split("/")[0] ?? "unknown";
    setPendingActions((prev) =>
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
        await handleStartResult(startResult, result.autoSwitch);
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
      clearActionError();
      void switchSession(sessionName).then((switched) => {
        if (!switched) {
          showActionError(`Failed to switch to tmux session '${sessionName}'`);
        }
      });
    } else {
      const pendingActionKey = pendingKey(repo.project, wt.branch);
      clearActionError();
      setPendingActions((prev) =>
        new Map(prev).set(pendingActionKey, {
          type: "starting",
          branch: wt.branch,
          project: repo.project,
        }),
      );
      void (async () => {
        try {
          const startResult = await tuiRuntime.runPromise(
            startWorktreeSession({ path: wt.path }),
          );
          await handleStartResult(startResult, true);
        } catch (error) {
          showActionError(toWctError(error).message);
          await refreshAll();
        } finally {
          setPendingActions((prev) => {
            const next = new Map(prev);
            next.delete(pendingActionKey);
            return next;
          });
        }
      })();
    }
  }

  function handleCloseSelectedWorktree() {
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
    const worktreeKey = pendingKey(repo.project, wt.branch);
    confirmCloseReturnSelectedIndexRef.current = selectedIndex;
    confirmCloseReturnModeRef.current =
      mode.type === "Expanded" ? Mode.Expanded(worktreeKey) : Mode.Navigate;
    setMode(
      Mode.ConfirmClose(
        sessionName,
        wt.branch,
        wt.path,
        worktreeKey,
        repo.repoPath,
        repo.project,
        wt.changedFiles,
      ),
    );
  }

  async function executeClose(
    sessionName: string,
    branch: string,
    worktreePath: string,
    worktreeKey: string,
    repoPath: string,
    project: string,
    force: boolean,
  ) {
    clearActionError();

    const canProceed = await switchClientAwayFromSession(sessionName);
    if (!canProceed) {
      showActionError(
        "Cannot safely close the worktree because the active tmux client could not be moved away",
      );
      return;
    }

    setSelectedIndex(confirmCloseReturnSelectedIndexRef.current);
    setMode(confirmCloseReturnModeRef.current);

    setPendingActions((prev) =>
      new Map(prev).set(worktreeKey, {
        type: "closing",
        branch,
        project,
      }),
    );

    try {
      await tuiRuntime.runPromise(
        Effect.gen(function* () {
          const exists = yield* TmuxService.use((service) =>
            service.sessionExists(sessionName),
          );
          if (exists) {
            yield* TmuxService.use((service) =>
              service.killSession(sessionName),
            );
          }
        }),
      );

      const removeResult = await tuiRuntime.runPromise(
        WorktreeService.use((service) =>
          service.removeWorktree(worktreePath, force, repoPath),
        ),
      );

      if (removeResult._tag === "BlockedByChanges") {
        setPendingActions((prev) => {
          const next = new Map(prev);
          next.delete(worktreeKey);
          return next;
        });
        setMode(
          Mode.ConfirmCloseForce(
            sessionName,
            branch,
            worktreePath,
            worktreeKey,
            repoPath,
            project,
          ),
        );
        await refreshAll();
        return;
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
  }

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
      void executeClose(
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
      prepareOpenModal();
      return;
    }

    if (input === " " && tmuxClient) {
      handleSpaceSwitch();
      return;
    }

    if (input === "d" && tmuxClient) {
      handleDownSelectedWorktree();
      return;
    }

    if (input === "u") {
      prepareUpModal();
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

    if (input === " " && tmuxClient) {
      handleSpaceSwitch();
      return;
    }

    if (input === "o") {
      prepareOpenModal();
      return;
    }

    if (input === "d" && tmuxClient) {
      handleDownSelectedWorktree();
      return;
    }

    if (input === "u") {
      prepareUpModal();
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
      const { branch, worktreeKey, worktreePath, sessionName } = mode;
      clearActionError();

      void (async () => {
        const canProceed = await switchClientAwayFromSession(sessionName);
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
          onSubmit={handleOpen}
          onCancel={() => setMode(Mode.Navigate)}
        />
      ) : mode.type === "UpModal" ? (
        <UpModal
          visible
          width={Math.min(termCols, 60)}
          profileNames={mode.profileNames}
          onSubmit={handleUpSubmit}
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
