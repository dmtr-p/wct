// src/tui/App.tsx

import { basename } from "node:path";
import { Box, render, Text, useApp, useInput } from "ink";
import { useCallback, useEffect, useMemo, useState } from "react";
import { formatSessionName } from "../services/tmux";
import { OpenModal } from "./components/OpenModal";
import { StatusBar } from "./components/StatusBar";
import { type TreeItem, TreeView } from "./components/TreeView";
import { useQueue } from "./hooks/useQueue";
import { useRefresh } from "./hooks/useRefresh";
import { type RepoInfo, useRegistry } from "./hooks/useRegistry";
import { useTmux } from "./hooks/useTmux";

function buildTreeItems(
  repos: RepoInfo[],
  expandedRepos: Set<string>,
): TreeItem[] {
  const items: TreeItem[] = [];
  for (let ri = 0; ri < repos.length; ri++) {
    const repo = repos[ri]!;
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
    sessions,
    error: tmuxError,
    switchSession,
    jumpToPane,
    refreshSessions,
    discoverClient,
  } = useTmux();

  const [expandedRepos, setExpandedRepos] = useState<Set<string>>(new Set());
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [showOpenModal, setShowOpenModal] = useState(false);
  const [mode, setMode] = useState<"normal" | "search">("normal");
  const [searchQuery, setSearchQuery] = useState("");

  // Auto-expand all repos on first load
  useEffect(() => {
    if (repos.length > 0 && expandedRepos.size === 0) {
      setExpandedRepos(new Set(repos.map((r) => r.id)));
    }
  }, [repos, expandedRepos.size]);

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

  const handleOpen = useCallback(
    async (opts: {
      branch: string;
      base?: string;
      pr?: string;
      profile?: string;
    }) => {
      setShowOpenModal(false);
      const args = ["open", opts.branch];
      if (opts.base) args.push("--base", opts.base);
      if (opts.pr) args.push("--pr", opts.pr);
      if (opts.profile) args.push("--profile", opts.profile);

      const proc = Bun.spawn(["wct", ...args], {
        stdout: "ignore",
        stderr: "ignore",
      });
      await proc.exited;
    },
    [],
  );

  useInput(
    (input, key) => {
      if (showOpenModal) return;

      if (mode === "search") {
        if (key.escape) {
          setMode("normal");
          setSearchQuery("");
        } else if (key.backspace || key.delete) {
          setSearchQuery((q) => q.slice(0, -1));
        } else if (key.return) {
          setMode("normal");
        } else if (input && !key.ctrl && !key.meta) {
          setSearchQuery((q) => q + input);
        }
        return;
      }

      if (input === "q") {
        exit();
        return;
      }

      if (input === "/") {
        setMode("search");
        setSearchQuery("");
        return;
      }

      if (input === "o") {
        setShowOpenModal(true);
        return;
      }

      if (key.upArrow) {
        setSelectedIndex((i) => Math.max(0, i - 1));
        return;
      }

      if (key.downArrow) {
        setSelectedIndex((i) => Math.min(treeItems.length - 1, i + 1));
        return;
      }

      const currentItem = treeItems[selectedIndex];
      if (!currentItem) return;

      if (key.leftArrow && currentItem.type === "repo") {
        const repo = repos[currentItem.repoIndex]!;
        if (expandedRepos.has(repo.id)) {
          toggleExpanded(repo.id);
        }
        return;
      }

      if (key.rightArrow && currentItem.type === "repo") {
        const repo = repos[currentItem.repoIndex]!;
        if (!expandedRepos.has(repo.id)) {
          toggleExpanded(repo.id);
        }
        return;
      }

      if (key.return) {
        if (currentItem.type === "repo") {
          const repo = repos[currentItem.repoIndex]!;
          toggleExpanded(repo.id);
        } else if (currentItem.type === "worktree") {
          const repo = repos[currentItem.repoIndex]!;
          const wt = repo.worktrees[currentItem.worktreeIndex!]!;
          const sessionName = formatSessionName(basename(wt.path));
          switchSession(sessionName);
        }
        return;
      }

      if (input === "c" && currentItem.type === "worktree") {
        const repo = repos[currentItem.repoIndex]!;
        const wt = repo.worktrees[currentItem.worktreeIndex!]!;
        Bun.spawn(["wct", "close", wt.branch, "--yes"], {
          stdout: "ignore",
          stderr: "ignore",
        });
        return;
      }

      if (input === "j") {
        // Jump to first notification's pane
        if (queueItems.length > 0) {
          const item = queueItems[0]!;
          jumpToPane(item.session, item.pane);
        }
        return;
      }
    },
    { isActive: !showOpenModal },
  );

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
        visible={showOpenModal}
        onSubmit={handleOpen}
        onCancel={() => setShowOpenModal(false)}
      />
    </Box>
  );
}

export function startTui() {
  render(<App />);
}
