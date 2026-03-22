// src/tui/App.tsx

import { basename } from "node:path";
import { Box, render, Text, useApp, useInput } from "ink";
import { useCallback, useEffect, useMemo, useState } from "react";
import { formatSessionName } from "../services/tmux";
import { OpenModal, type OpenModalResult } from "./components/OpenModal";
import { StatusBar } from "./components/StatusBar";
import { TreeView } from "./components/TreeView";
import { useQueue } from "./hooks/useQueue";
import { useRefresh } from "./hooks/useRefresh";
import { type RepoInfo, useRegistry } from "./hooks/useRegistry";
import { useTmux } from "./hooks/useTmux";
import type { TreeItem } from "./types";

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
  const [showOpenModal, setShowOpenModal] = useState(false);
  const [openModalBase, setOpenModalBase] = useState<string | undefined>();
  const [openModalProfiles, setOpenModalProfiles] = useState<string[]>([]);
  const [mode, setMode] = useState<"normal" | "search">("normal");
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
    setShowOpenModal(false);
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
        // Determine default base from selected item
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

      const currentRepo = filteredRepos[currentItem.repoIndex];
      if (!currentRepo) return;

      const currentWorktree =
        currentItem.type === "worktree" &&
        currentItem.worktreeIndex !== undefined
          ? currentRepo.worktrees[currentItem.worktreeIndex]
          : undefined;

      if (key.leftArrow && currentItem.type === "repo") {
        if (expandedRepos.has(currentRepo.id)) {
          toggleExpanded(currentRepo.id);
        }
        return;
      }

      if (key.rightArrow && currentItem.type === "repo") {
        if (!expandedRepos.has(currentRepo.id)) {
          toggleExpanded(currentRepo.id);
        }
        return;
      }

      if (key.return) {
        if (currentItem.type === "repo") {
          toggleExpanded(currentRepo.id);
        } else if (currentWorktree) {
          const sessionName = formatSessionName(basename(currentWorktree.path));
          const hasSession = sessions.some((s) => s.name === sessionName);
          if (hasSession) {
            switchSession(sessionName);
          } else {
            Bun.spawn(["wct", "up"], {
              cwd: currentWorktree.path,
              stdout: "ignore",
              stderr: "ignore",
            });
          }
        }
        return;
      }

      if (input === "c" && currentItem.type === "worktree" && currentWorktree) {
        const closingSession = formatSessionName(
          basename(currentWorktree.path),
        );
        // If closing the active session, switch to another one first
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
        // Jump to first notification's pane
        const [item] = queueItems;
        if (item) {
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
        defaultBase={openModalBase}
        profileNames={openModalProfiles}
        onSubmit={handleOpen}
        onCancel={() => setShowOpenModal(false)}
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
