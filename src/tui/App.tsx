// src/tui/App.tsx

import { basename } from "node:path";
import { Box, type Key, render, Text, useApp, useInput } from "ink";
import { useCallback, useEffect, useMemo, useState } from "react";
import { formatSessionName } from "../services/tmux";
import { OpenModal, type OpenModalResult } from "./components/OpenModal";
import { StatusBar } from "./components/StatusBar";
import { TreeView } from "./components/TreeView";
import { useQueue } from "./hooks/useQueue";
import { useRefresh } from "./hooks/useRefresh";
import { type RepoInfo, useRegistry } from "./hooks/useRegistry";
import { useTmux } from "./hooks/useTmux";
import { Mode, pendingKey, type TreeItem } from "./types";

function buildTreeItems(
  repos: RepoInfo[],
  expandedRepos: Set<string>,
): TreeItem[] {
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
      }
    }
  }
  return items;
}

export function App() {
  const { exit } = useApp();
  const { repos, loading, refresh: refreshRegistry } = useRegistry();
  const { items: queueItems, refresh: refreshQueue } = useQueue();
  const {
    client,
    sessions,
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
  const [mode, setMode] = useState<Mode>(Mode.Navigate);
  const [searchQuery, setSearchQuery] = useState("");

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

  const treeItems = useMemo(
    () => buildTreeItems(filteredRepos, expandedRepos),
    [filteredRepos, expandedRepos],
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

  const handleOpen = useCallback(async (opts: OpenModalResult) => {
    setMode(Mode.Navigate);
    const args = ["open", opts.branch];
    if (opts.base) args.push("--base", opts.base);
    if (opts.pr) args.push("--pr", opts.pr);
    if (opts.profile) args.push("--profile", opts.profile);
    if (opts.prompt) args.push("--prompt", opts.prompt);
    if (opts.existing) args.push("--existing");
    if (opts.noIde) args.push("--no-ide");
    if (opts.noAttach) args.push("--no-attach");

    const proc = Bun.spawn(["wct", ...args], {
      stdout: "ignore",
      stderr: "ignore",
    });
    await proc.exited;
  }, []);

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
    if (item?.type !== "worktree") return;
    const repo = filteredRepos[item.repoIndex];
    if (!repo) return;
    const wt = repo.worktrees[item.worktreeIndex];
    if (!wt) return;
    const sessionName = formatSessionName(basename(wt.path));
    const hasSession = sessions.some((s) => s.name === sessionName);
    if (hasSession) {
      switchSession(sessionName);
    } else {
      // Will be fleshed out in Task 3 with pending action tracking
      const proc = Bun.spawn(["wct", "up", "--no-attach"], {
        cwd: wt.path,
        stdio: ["ignore", "ignore", "ignore"],
      });
      proc.exited.then((code) => {
        if (code === 0) switchSession(sessionName);
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
      const selected = treeItems[selectedIndex];
      let base: string | undefined;
      let profiles: string[] = [];
      if (selected) {
        const repo = filteredRepos[selected.repoIndex];
        if (repo) {
          profiles = repo.profileNames;
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
      setMode(Mode.OpenModal);
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
      Bun.spawn(["wct", "close", currentWorktree.branch, "--yes"], {
        stdout: "ignore",
        stderr: "ignore",
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
      const selected = treeItems[selectedIndex];
      let base: string | undefined;
      let profiles: string[] = [];
      if (selected) {
        const repo = filteredRepos[selected.repoIndex];
        if (repo) {
          profiles = repo.profileNames;
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
      setMode(Mode.OpenModal);
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
      />
      <Text> </Text>
      <StatusBar mode={mode} searchQuery={searchQuery} />
      <OpenModal
        visible={mode.type === "OpenModal"}
        defaultBase={openModalBase}
        profileNames={openModalProfiles}
        onSubmit={handleOpen}
        onCancel={() => setMode(Mode.Navigate)}
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
