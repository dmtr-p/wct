// src/tui/App.tsx

import { basename } from "node:path";
import { Box, type Key, render, Text, useApp, useInput, useStdout } from "ink";
import { useCallback, useEffect, useMemo, useState } from "react";
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

function buildTreeItems({
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
              action: () => jumpToPane(pane.paneId),
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

    if (input === "c" && currentItem.type === "worktree" && currentWorktree) {
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

      const proc = Bun.spawn(
        ["wct", "close", currentWorktree.branch, "--yes"],
        {
          cwd: currentRepo.repoPath,
          stdout: "ignore",
          stderr: "ignore",
        },
      );
      proc.exited.then(() => {
        refreshAll().then(() => {
          setPendingActions((prev) => {
            const next = new Map(prev);
            next.delete(pendingActionKey);
            return next;
          });
        });
      });
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
      // Move selection back to parent worktree so selectedIndex
      // doesn't point past the end after detail rows are removed.
      const current = treeItems[selectedIndex];
      if (current && current.type === "detail") {
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

    if (key.rightArrow) {
      const current = treeItems[selectedIndex];
      if (current?.type === "worktree") {
        const repo = filteredRepos[current.repoIndex];
        const wt = repo?.worktrees[current.worktreeIndex];
        if (repo && wt) {
          setMode(Mode.Expanded(pendingKey(repo.project, wt.branch)));
        }
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
          defaultBase={openModalBase ?? ""}
          profileNames={openModalProfiles}
          repoProject={openModalRepoProject}
          repoPath={openModalRepoPath}
          prList={openModalPRList}
          onSubmit={handleOpen}
          onCancel={() => setMode(Mode.Navigate)}
        />
      ) : (
        <StatusBar mode={mode} searchQuery={searchQuery} />
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
