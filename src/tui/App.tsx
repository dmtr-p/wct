// src/tui/App.tsx

import { Box, type Key, render, Text, useApp, useWindowSize } from "ink";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AddProjectModal } from "./components/AddProjectModal";
import { OpenModal } from "./components/OpenModal";
import { StatusBar, statusBarRowCount } from "./components/StatusBar";
import { TreeView } from "./components/TreeView";
import { UpModal } from "./components/UpModal";
import { useActionError } from "./hooks/useActionError";
import { useGitHub } from "./hooks/useGitHub";
import { useGuardedInput } from "./hooks/useGuardedInput";
import { useModalActions } from "./hooks/useModalActions";
import { useMouse } from "./hooks/useMouse";
import { useRefresh } from "./hooks/useRefresh";
import { useRegistry } from "./hooks/useRegistry";
import { useSessionActions } from "./hooks/useSessionActions";
import type { SessionIdeDefaults } from "./hooks/useSessionOptionsState";
import { useTmux } from "./hooks/useTmux";
import { handleConfirmCloseInput } from "./input/confirm-close";
import type { ExpandedContext } from "./input/expanded";
import { handleExpandedInput } from "./input/expanded";
import {
  HEADER_OFFSET,
  type MouseEvent,
  resolveMouseAction,
} from "./input/mouse";
import type { NavigateContext } from "./input/navigate";
import { handleNavigateInput } from "./input/navigate";
import {
  adjustIndexForDetailCollapse,
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
import { toSingleLine } from "./utils/truncate";

// Top chrome above the tree: the `wct` header line + a blank spacer line. Same
// 2 rows the mouse hit-test skips, so it is sourced from a single constant to
// keep windowing and hit-testing aligned.
const TOP_CHROME_ROWS = HEADER_OFFSET;

export function App() {
  const { exit } = useApp();
  const { columns: termCols, rows: termRows } = useWindowSize();
  const { disableMouse } = useMouse();
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
        maxWidth: termCols,
      }),
    [
      treeItems,
      filteredRepos,
      expandedRepos,
      expandedWorktreeKey,
      pendingActions,
      termCols,
    ],
  );

  // Bottom chrome: optional tmux/action error line (mutually exclusive, so at
  // most one row) + the StatusBar's rows — counted by statusBarRowCount, the
  // helper co-located with StatusBar's render branches so the budget cannot
  // drift from what it renders. Every chrome line renders with wrap="truncate"
  // AND is collapsed to a single line (toSingleLine), so each one is exactly
  // one terminal row at any width and for any message — otherwise the budget
  // would under-count, and the overflowing layout would misalign mouse
  // hit-testing.
  //
  // True modals (OpenModal/UpModal/AddProjectModal) replace the StatusBar but
  // budget the SAME virtual row count: viewportRows must not change when a
  // modal opens, or the clamp/keep-visible effects would rewrite a
  // wheel-scrolled offset the user expects back on cancel. The modal being
  // taller than the budgeted chrome is absorbed by the tree box's
  // overflowY="hidden" clipping (see the render below), which keeps the modal
  // fully on-screen without inflating the viewport.
  const bottomChromeRows =
    statusBarRowCount(mode, Boolean(repoError)) +
    (tmuxError || actionError ? 1 : 0);

  const viewportRows = Math.max(
    1,
    termRows - TOP_CHROME_ROWS - bottomChromeRows,
  );

  const effectiveScrollOffset = clampScrollOffset(
    scrollOffset,
    rows.length,
    viewportRows,
  );

  // Identity-based selection recovery: when the tree structure changes
  // (background refresh, async worktree add/remove), find the previously-
  // selected item by stable identity instead of blindly clamping by length.
  //
  // INVARIANT for prevSelectionIdRef: the recovery effect treats it as "the
  // selected item's identity as of the last commit" and normally rewrites it
  // exactly once per commit. Any handler that BOTH reshapes the tree AND
  // moves the selection to a different item in the same commit must pre-write
  // the ref with the NEW selection's identity before calling setSelectedIndex
  // (see selectAndExitExpanded in handleMouse): when the new index collides
  // with the current one, setSelectedIndex is a no-op, selectionChanged stays
  // false, and recovery would otherwise chase the OLD identity through the
  // reshaped tree and snap the cursor back. Handlers that only move the
  // selection (no reshape) or preserve the selected item's identity are safe
  // without it.
  const prevTreeRef = useRef(treeItems);
  const prevSelectionIdRef = useRef<string | null>(null);
  const prevSearchQueryRef = useRef(searchQuery);

  // selectionChanged distinguishes a deliberate selection change (e.g. a
  // mouse click) from a background refresh that only produced new object
  // references with the same selectedIndex. It's a const computed once
  // during render, from the ref's value as of the last commit — so every
  // effect below that closes over it this render sees the same, consistent
  // answer. The ref itself is written exactly once, in the trailing effect.
  const prevSelectedIndexRef = useRef(selectedIndex);
  const selectionChanged = selectedIndex !== prevSelectedIndexRef.current;

  // prevSelectionWasVisibleRef mirrors selectionChanged for PASSIVE layout
  // changes — ones that move the selection's visual row or the window without
  // touching selectedIndex: the viewport shrinking (an action/repo error line
  // appearing, the terminal resized shorter) or rows above the selection
  // reflowing (a PR title wrapping differently after a width change, a check
  // rollup arriving, phantom rows appearing). The clamp in the recovery
  // effect below can only ever DECREASE the offset, so without this signal a
  // selection sitting on a visible row could silently leave the window with
  // no path back until the next navigation key. Tracked as "was the selection
  // visible last commit" rather than one signal per cause so every passive
  // cause is covered, while a wheel-scrolled viewport whose selection was
  // already off-screen stays put.
  const selectionRowIndex = firstRowForItem(rows, selectedIndex);
  const selectionVisible =
    selectionRowIndex !== null &&
    selectionRowIndex >= effectiveScrollOffset &&
    selectionRowIndex < effectiveScrollOffset + viewportRows;
  const prevSelectionWasVisibleRef = useRef(selectionVisible);
  // Last commit's row/viewport values, so the keep-visible effect can tell a
  // REAL passive layout change apart from merely having re-run: its deps also
  // re-fire it on the falling edge of selectionChanged (true → false on the
  // commit after a deliberate change), where re-anchoring would undo a wheel
  // tick that just hid the still-"was visible" selection.
  const prevSelectionRowIndexRef = useRef(selectionRowIndex);
  const prevViewportRowsRef = useRef(viewportRows);

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
      // Reset the scroll explicitly: when the cursor was already at index 0
      // (e.g. after a wheel scroll), setSelectedIndex(0) is a no-op, so
      // `selectionChanged` stays false and the keep-visible effect below never
      // fires — leaving the first match scrolled off-screen without this.
      setScrollOffset(0);
      // Also suppress the keep-visible effect for THIS commit (this effect
      // runs first, so the write is seen by its read below): the stale
      // selectedIndex now indexes the FILTERED rows, so its visual row
      // "moves" spuriously and a still-visible old selection would hijack
      // the reset for one frame. The unconditional trailing write restores
      // the real visibility at the end of the commit.
      prevSelectionWasVisibleRef.current = false;
      return;
    }

    const item = treeItems[selectedIndex];
    prevSelectionIdRef.current = item ? treeItemId(item, filteredRepos) : null;

    // Skip identity recovery for a deliberate selection change (e.g. a mouse
    // click that also collapsed Expanded) — otherwise it sees the new
    // selection's identity mismatch the old one and "recovers" back to it.
    const recoveredIndex = resolveRecoveredSelectionIndex({
      prevTree,
      treeItems,
      prevSelectionId: prevId,
      selectedIndex,
      repos: filteredRepos,
      skipIdentityRecovery: selectionChanged,
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
    selectionChanged,
  ]);

  // Keyboard ↑/↓ (and mouse clicks) are viewport-aware: after a DELIBERATE
  // selection change, nudge the scroll offset minimally to keep the selection
  // on screen. A PASSIVE layout change (the row moved or the viewport
  // resized) that hid a previously-visible selection re-anchors too (see
  // prevSelectionWasVisibleRef above); since scrollToKeepVisible is a no-op
  // while the selection is still visible, that gate is exactly "re-anchor
  // only when the change hid it". Keyed on the selection's VISUAL row and the
  // viewport height — values, not the `rows` reference — so a background
  // refresh that only produces new object references (useRegistry always
  // calls setRepos, even when content is unchanged) cannot re-fire this and
  // snap a wheel-scrolled viewport back to the selection. NOT keyed on
  // scrollOffset, and uses a functional update, so it never fights a future
  // wheel scroll (slice 02).
  useEffect(() => {
    // All three refs are read BEFORE the trailing effects below rewrite them,
    // so they are last commit's values. A passive re-anchor requires the row
    // or viewport to have ACTUALLY changed — a run where neither did (the
    // falling edge of selectionChanged, with only the wheel's scrollOffset
    // different) must leave the viewport alone.
    const rowMoved = selectionRowIndex !== prevSelectionRowIndexRef.current;
    const viewportResized = viewportRows !== prevViewportRowsRef.current;
    const passiveLayoutChange =
      prevSelectionWasVisibleRef.current && (rowMoved || viewportResized);
    if (!selectionChanged && !passiveLayoutChange) return;
    if (selectionRowIndex === null) return;
    setScrollOffset((prev) =>
      scrollToKeepVisible(selectionRowIndex, prev, viewportRows),
    );
  }, [selectionRowIndex, viewportRows, selectionChanged]);

  // The trailing writes keeping the prev-* refs one commit behind for the
  // selectionChanged computation and the keep-visible effect above. The
  // visibility ref alone has a second writer (the searchQueryChanged branch
  // suppressing one commit) and so must be unconditionally rewritten here —
  // a keyed write would skip commits where visibility didn't change and
  // leave that suppression stuck.
  useEffect(() => {
    prevSelectedIndexRef.current = selectedIndex;
  }, [selectedIndex]);
  useEffect(() => {
    prevSelectionRowIndexRef.current = selectionRowIndex;
  }, [selectionRowIndex]);
  useEffect(() => {
    prevViewportRowsRef.current = viewportRows;
  }, [viewportRows]);
  useEffect(() => {
    prevSelectionWasVisibleRef.current = selectionVisible;
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

  function handleMouse(event: MouseEvent) {
    const action = resolveMouseAction(event, {
      mode,
      rows,
      effectiveScrollOffset,
      viewportRows,
      treeItems,
      repos: filteredRepos,
      expandedWorktreeKey,
    });
    switch (action.kind) {
      case "none":
        return;
      case "scroll":
        // Wheel scrolls the viewport only; the selection is untouched.
        setScrollOffset((prev) =>
          clampScrollOffset(prev + action.delta, rows.length, viewportRows),
        );
        return;
      case "select":
        setSelectedIndex(action.itemIndex);
        return;
      case "selectAndExitExpanded": {
        // Collapsing Expanded can remove the clicked item's detail rows (if
        // the previously-expanded worktree had a PR/tmux detail row), which
        // shifts every later item's index. Adjust the clicked itemIndex for
        // that collapse the same way the keyboard left-arrow/escape path does
        // (src/tui/input/expanded.ts) so the cursor lands on the row the user
        // actually clicked, not a stale post-collapse index.
        //
        // The adjusted index can equal the CURRENT selectedIndex (the clicked
        // row's post-collapse position collides with the cursor's pre-collapse
        // one, e.g. rows [A, PR detail, B(selected), C(clicked)]). Then
        // setSelectedIndex is a no-op, selectionChanged stays false, and the
        // identity-recovery effect would treat the collapse as a background
        // tree change and snap the cursor back to the old item. Pre-store the
        // clicked item's identity (stable across the collapse) so recovery
        // sees the clicked row as already-current and stays put.
        const clicked = treeItems[action.itemIndex];
        prevSelectionIdRef.current = clicked
          ? treeItemId(clicked, filteredRepos)
          : null;
        setMode(Mode.Navigate);
        setSelectedIndex(
          adjustIndexForDetailCollapse(treeItems, action.itemIndex),
        );
        return;
      }
    }
  }

  // useGuardedInput parses mouse events out of the string Ink already forwards
  // (no second stdin listener, ADR 0002) and swallows ANY SGR mouse sequence
  // in EVERY mode — including release/motion/extra-button sequences, and
  // multi-sequence strings from Ink's paste-fallback path (normal stdin
  // delivery is one sequence per event) — so no escape garble ever reaches
  // the handler below (or any other useGuardedInput handler, e.g. the modals'
  // text inputs). Actionable events arrive via onMouseEvent, in order.
  useGuardedInput(
    (input, key) => {
      // Ctrl+C exits from EVERY mode (parity with Ink's default), but through
      // the same disable-mouse-first sequence as `q`: startTui renders with
      // exitOnCtrlC: false precisely so Ctrl+C reaches this handler instead
      // of Ink's own \x03 shortcut, whose handleExit turns off raw mode
      // before React unmount — too late for the unmount-cleanup disable, so
      // mouse reports emitted in that window would echo as escape garbage on
      // the shell prompt after exit.
      if (key.ctrl && input === "c") {
        disableMouse();
        exit();
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
        // Disable mouse reporting BEFORE exit(): Ink's handleExit turns off raw
        // mode before React unmount, so the unmount-cleanup disable is too late.
        disableMouse();
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
      {/* Every sibling of the tree box is flexShrink={0}: when the content
          exceeds termRows, the tree box must be the ONLY thing Yoga shrinks —
          otherwise the header/spacer lines get squeezed to zero height and
          later rows paint over them. */}
      <Box flexDirection="column" flexShrink={0}>
        <Text bold>wct</Text>
        <Text> </Text>
      </Box>
      {/* overflowY="hidden" + flexShrink is what lets a true modal exceed the
          budgeted bottom-chrome rows: Yoga shrinks THIS box and the excess
          tree rows clip cleanly at its bottom edge, instead of the
          overflowing frame painting over the modal. The inner flexShrink={0}
          wrapper keeps the rows at their natural height so they overflow (and
          clip) rather than being squeezed into interleaved garbage. In the
          interactive layout the tree content equals the budget exactly, so
          nothing is ever clipped there. */}
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
            expandedRepos={expandedRepos}
            selectedIndex={selectedIndex}
            items={treeItems}
            rows={rows}
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
      </Box>
      {/* flexShrink={0} pins the bottom area (modal or status chrome) to its
          natural height so the tree box above is the only child Yoga shrinks. */}
      <Box flexDirection="column" flexShrink={0}>
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
              <Text color="yellow" wrap="truncate">
                {toSingleLine(tmuxError)}
              </Text>
            ) : null}
            {actionError ? (
              <Text color="red" wrap="truncate">
                {toSingleLine(actionError)}
              </Text>
            ) : null}
            <StatusBar
              {...statusBarProps}
              searchQuery={searchQuery}
              hasClient={tmuxClient !== null}
              repoError={repoError}
            />
          </Box>
        )}
      </Box>
    </Box>
  );
}

export async function startTui(): Promise<void> {
  // exitOnCtrlC stays OFF: the guarded input dispatcher in App owns Ctrl+C so
  // it can write MOUSE_DISABLE before Ink turns raw mode off (Ink's built-in
  // \x03 shortcut disables raw mode before React unmount, which would leak
  // mouse reports onto the shell — the same ordering bug the `q` path avoids).
  const instance = render(<App />, {
    alternateScreen: true,
    exitOnCtrlC: false,
  });
  await instance.waitUntilExit();
}
