// src/tui/App.tsx

import { basename } from "node:path";
import { Box, type Key, render, Text, useApp, useInput } from "ink";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { QueueItem } from "../services/queue-storage";
import { formatSessionName } from "../services/tmux";
import { OpenModal, type OpenModalResult } from "./components/OpenModal";
import { StatusBar } from "./components/StatusBar";
import { TreeView } from "./components/TreeView";
import { useGitHub } from "./hooks/useGitHub";
import { useQueue } from "./hooks/useQueue";
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
  queueItems: QueueItem[];
  prData: Map<string, PRInfo>;
  panes: Map<string, PaneInfo[]>;
  jumpToPane: (session: string, pane: string) => void;
}

function buildTreeItems({
  repos,
  expandedRepos,
  expandedWorktreeKey,
  queueItems,
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

        // Notifications for this worktree
        const wtNotifs = queueItems.filter(
          (q) => q.branch === wt.branch && q.project === repo.project,
        );
        if (wtNotifs.length > 0) {
          items.push({
            type: "detail",
            repoIndex: ri,
            worktreeIndex: wi,
            detailKind: "notification-header",
            label: `Notifications (${wtNotifs.length})`,
          });
          for (const notif of wtNotifs) {
            items.push({
              type: "detail",
              repoIndex: ri,
              worktreeIndex: wi,
              detailKind: "notification",
              label: notif.message,
              action: () => jumpToPane(notif.session, notif.pane),
            });
          }
        }

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
              label: `${pane.window}:${pane.index} ${pane.command}`,
              action: () =>
                jumpToPane(sessionName, `${pane.window}.${pane.index}`),
            });
          }
        }
      }
    }
  }
  return items;
}

export function App() {
  const { exit } = useApp();
  const { repos, loading, refresh: refreshRegistry } = useRegistry();
  const { items: queueItems, refresh: refreshQueue } = useQueue();
  const { prData } = useGitHub(repos);
  const {
    client,
    sessions,
    panes,
    error: tmuxError,
    switchSession,
    jumpToPane,
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
  const [modalStep, setModalStep] = useState<"selector" | "form" | "list">(
    "selector",
  );
  const [pendingActions, setPendingActions] = useState<
    Map<string, PendingAction>
  >(new Map());

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
    mode.type === "Expanded" ? mode.worktreeKey : null;

  const treeItems = useMemo(
    () =>
      buildTreeItems({
        repos: filteredRepos,
        expandedRepos,
        expandedWorktreeKey,
        queueItems,
        prData,
        panes,
        jumpToPane,
      }),
    [
      filteredRepos,
      expandedRepos,
      expandedWorktreeKey,
      queueItems,
      prData,
      panes,
      jumpToPane,
    ],
  );

  const refreshAll = useCallback(async () => {
    await Promise.all([
      refreshRegistry(),
      refreshQueue(),
      refreshSessions(),
      discoverClient(),
    ]);
  }, [refreshRegistry, refreshQueue, refreshSessions, discoverClient]);

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

  /** Compute PR list for the currently-selected repo */
  const openModalPRList = useMemo(() => {
    const selected = treeItems[selectedIndex];
    if (!selected) return [];
    const repo = filteredRepos[selected.repoIndex];
    if (!repo) return [];
    const result: PRInfo[] = [];
    for (const [key, pr] of prData) {
      if (key.startsWith(`${repo.project}/`)) {
        result.push(pr);
      }
    }
    return result;
  }, [treeItems, selectedIndex, filteredRepos, prData]);

  /** Prepare and open the OpenModal with context from current selection */
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
      if (repo && selected.type === "worktree") {
        const worktreeIndex = selected.worktreeIndex;
        const wt =
          worktreeIndex === undefined
            ? undefined
            : repo.worktrees[worktreeIndex];
        if (wt) {
          base = wt.branch;
        }
      }
    }
    setOpenModalBase(base);
    setOpenModalProfiles(profiles);
    setOpenModalRepoProject(project);
    setOpenModalRepoPath(repoPath);
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

    // Determine project from current selection
    const selected = treeItems[selectedIndex];
    const repo = selected ? filteredRepos[selected.repoIndex] : undefined;
    const project = repo?.project ?? "unknown";

    const key = pendingKey(project, opts.branch);
    setPendingActions((prev) =>
      new Map(prev).set(key, {
        type: "opening",
        branch: opts.branch,
        project,
      }),
    );

    const proc = Bun.spawn(["wct", ...args], {
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

  /** Move selection up or down in the flat tree list */
  function navigateTree(direction: 1 | -1) {
    setSelectedIndex((prev) => {
      const next = prev + direction;
      if (next < 0 || next >= treeItems.length) return prev;
      return next;
    });
  }

  /** Switch to worktree's tmux session, creating one if needed */
  function handleSpaceSwitch() {
    const item = treeItems[selectedIndex];
    if (!item) return;

    // For pane/notification detail rows, jump directly to that pane
    if (
      item.type === "detail" &&
      (item.detailKind === "pane" || item.detailKind === "notification") &&
      item.action
    ) {
      item.action();
      return;
    }

    // For other detail rows, resolve the parent worktree
    const resolvedItem =
      item.type === "detail"
        ? {
            type: "worktree" as const,
            repoIndex: item.repoIndex,
            worktreeIndex: item.worktreeIndex,
          }
        : item;
    if (resolvedItem.type !== "worktree") return;
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
      const key = pendingKey(repo.project, wt.branch);
      setPendingActions((prev) =>
        new Map(prev).set(key, {
          type: "starting",
          branch: wt.branch,
          project: repo.project,
        }),
      );
      const proc = Bun.spawn(["wct", "up", "--no-attach"], {
        cwd: wt.path,
        stdio: ["ignore", "ignore", "ignore"],
      });
      proc.exited.then((code) => {
        if (code === 0) {
          switchSession(sessionName);
        }
        setPendingActions((prev) => {
          const next = new Map(prev);
          next.delete(key);
          return next;
        });
      });
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

    if (input === " ") {
      handleSpaceSwitch();
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

    if (key.return) {
      if (currentItem.type === "repo") {
        toggleExpanded(currentRepo.id);
      }
      return;
    }

    if (input === "c" && currentItem.type === "worktree" && currentWorktree) {
      const closingSession = formatSessionName(basename(currentWorktree.path));
      if (client && client.session === closingSession) {
        const other = sessions.find((s) => s.name !== closingSession);
        if (other) {
          switchSession(other.name);
        }
      }

      const key = pendingKey(currentRepo.project, currentWorktree.branch);
      setPendingActions((prev) =>
        new Map(prev).set(key, {
          type: "closing",
          branch: currentWorktree.branch,
          project: currentRepo.project,
        }),
      );

      const proc = Bun.spawn(
        ["wct", "close", currentWorktree.branch, "--yes"],
        {
          stdout: "ignore",
          stderr: "ignore",
        },
      );
      proc.exited.then(() => {
        refreshAll().then(() => {
          setPendingActions((prev) => {
            const next = new Map(prev);
            next.delete(key);
            return next;
          });
        });
      });
      return;
    }

    if (input === "j") {
      const [item] = queueItems;
      if (item) {
        jumpToPane(item.session, item.pane);
      }
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
      // Move selection back to the parent worktree before collapsing,
      // so selectedIndex doesn't point past the end of the new tree.
      const current = treeItems[selectedIndex];
      if (current && current.type === "detail") {
        // Find the worktree item that owns this detail
        for (let i = selectedIndex - 1; i >= 0; i--) {
          const candidate = treeItems[i];
          if (candidate?.type === "worktree") {
            setSelectedIndex(i);
            break;
          }
        }
      }
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

    if (input === " ") {
      handleSpaceSwitch();
      return;
    }

    if (input === "o") {
      prepareOpenModal();
      return;
    }

    if (key.return) {
      const item = treeItems[selectedIndex];
      if (item?.type === "detail" && item.action) {
        item.action();
      }
      return;
    }

    if (input === "/") {
      setMode(Mode.Search);
      setSearchQuery("");
      return;
    }
  }

  useInput((input, key) => {
    // Global keys (work in any mode)
    if (input === "q" && mode.type !== "OpenModal" && mode.type !== "Search") {
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
    <Box flexDirection="column">
      <Text bold>wct</Text>
      <Text> </Text>
      <TreeView
        repos={filteredRepos}
        sessions={sessions}
        queueItems={queueItems}
        expandedRepos={expandedRepos}
        selectedIndex={selectedIndex}
        items={treeItems}
        pendingActions={pendingActions}
        prData={prData}
        panes={panes}
        expandedWorktreeKey={expandedWorktreeKey}
      />
      <Text> </Text>
      <StatusBar mode={mode} searchQuery={searchQuery} modalStep={modalStep} />
      <OpenModal
        visible={mode.type === "OpenModal"}
        defaultBase={openModalBase ?? ""}
        profileNames={openModalProfiles}
        repoProject={openModalRepoProject}
        repoPath={openModalRepoPath}
        prList={openModalPRList}
        onSubmit={handleOpen}
        onCancel={() => setMode(Mode.Navigate)}
        onStepChange={setModalStep}
      />
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
