import { Box, Text, useInput } from "ink";
import { useEffect, useMemo, useRef, useState } from "react";
import { WorktreeService } from "../../services/worktree-service";
import { useBlink } from "../hooks/useBlink";
import { useSessionOptionsState } from "../hooks/useSessionOptionsState";
import { tuiRuntime } from "../runtime";
import type { PRInfo } from "../types";
import { Modal } from "./Modal";
import { filterItems, type ListItem, ScrollableList } from "./ScrollableList";
import { SessionOptionsSection } from "./SessionOptionsSection";
import { resolveSessionOptionsSubmitState } from "./session-options";
import { TitledBox } from "./TitledBox";

export interface OpenModalResult {
  branch: string;
  base?: string;
  pr?: string;
  profile?: string;
  prompt?: string;
  existing: boolean;
  noIde: boolean;
  noAttach: boolean;
}

type ModalStep = "selector" | "newBranch" | "fromPR" | "existingBranch";

export interface OpenModalProps {
  visible: boolean;
  width?: number;
  onSubmit: (result: OpenModalResult) => void;
  onCancel: () => void;
  defaultBase: string;
  profileNames: string[];
  repoProject: string;
  repoPath: string;
  prList: PRInfo[];
  isRefreshing: boolean;
  onRefresh: (signal?: AbortSignal) => void;
}

// ─── Sub-components ───────────────────────────────────────────────

function ModeSelector({
  onSelect,
  onCancel,
  width,
}: {
  onSelect: (step: ModalStep) => void;
  onCancel: () => void;
  width?: number;
}) {
  const [selected, setSelected] = useState(0);
  const options: { label: string; step: ModalStep }[] = [
    { label: "New Branch", step: "newBranch" },
    { label: "Open from PR", step: "fromPR" },
    { label: "Existing Branch", step: "existingBranch" },
  ];

  useInput(
    (_input, key) => {
      if (key.upArrow) setSelected((s) => Math.max(0, s - 1));
      if (key.downArrow)
        setSelected((s) => Math.min(options.length - 1, s + 1));
      if (key.return) onSelect(options[selected]?.step ?? "newBranch");
      if (key.escape) onCancel();
    },
    { isActive: true },
  );

  return (
    <TitledBox title="Select mode" isFocused={true} width={width}>
      {options.map((opt, i) => {
        const isSel = i === selected;
        return (
          <Text key={opt.step} color={isSel ? "cyan" : "dim"} bold={isSel}>
            {isSel ? "▸ " : "  "}
            {opt.label}
          </Text>
        );
      })}
    </TitledBox>
  );
}

function BracketInput({
  label,
  value,
  isFocused,
  onChange,
  width,
}: {
  label: string;
  value: string;
  isFocused: boolean;
  onChange: (v: string) => void;
  width?: number;
}) {
  const cursorVisible = useBlink();
  const displayValue = value || (!isFocused || !cursorVisible ? " " : "");

  useInput(
    (input, key) => {
      if (!isFocused) return;
      if (key.backspace || key.delete) {
        onChange(value.slice(0, -1));
      } else if (input && !key.ctrl && !key.meta && !key.return) {
        onChange(value + input);
      }
    },
    { isActive: isFocused },
  );

  return (
    <TitledBox title={label} isFocused={isFocused} width={width}>
      <Text color={isFocused ? undefined : "dim"}>
        {displayValue}
        {isFocused ? (cursorVisible ? "▎" : " ") : ""}
      </Text>
    </TitledBox>
  );
}

function PromptArea({
  value,
  isFocused,
  onChange,
  width,
}: {
  value: string;
  isFocused: boolean;
  onChange: (v: string) => void;
  width?: number;
}) {
  const cursorVisible = useBlink();

  useInput(
    (input, key) => {
      if (!isFocused) return;
      if (key.backspace || key.delete) {
        onChange(value.slice(0, -1));
      } else if (key.return) {
        onChange(`${value}\n`);
      } else if (input && !key.ctrl && !key.meta) {
        onChange(value + input);
      }
    },
    { isActive: isFocused },
  );

  return (
    <TitledBox title="Prompt" isFocused={isFocused} width={width}>
      <Text color={isFocused ? undefined : "dim"}>
        {value || (isFocused ? "" : "optional")}
        {isFocused ? (cursorVisible ? "▎" : " ") : ""}
      </Text>
    </TitledBox>
  );
}

// ─── NewBranchForm ───────────────────────────────────────────────

type NewBranchField =
  | "branch"
  | "base"
  | "profile"
  | "prompt"
  | "noIde"
  | "autoSwitch"
  | "submit";

/** @internal */
export function NewBranchForm({
  defaultBase,
  profileNames,
  onSubmit,
  onBack,
  width,
}: {
  defaultBase: string;
  profileNames: string[];
  onSubmit: (result: OpenModalResult) => void;
  onBack: () => void;
  width?: number;
}) {
  const [branch, setBranch] = useState("");
  const [base, setBase] = useState(defaultBase);
  const {
    selectedProfileValue,
    setSelectedProfileValue,
    noIde,
    setNoIde,
    autoSwitch,
    setAutoSwitch,
  } = useSessionOptionsState(profileNames);
  const [prompt, setPrompt] = useState("");

  const fields = useMemo(() => {
    const f: NewBranchField[] = ["branch", "base", "prompt"];
    if (profileNames.length > 0) f.push("profile");
    f.push("noIde", "autoSwitch", "submit");
    return f;
  }, [profileNames.length]);

  const [focusIndex, setFocusIndex] = useState(0);
  const currentField = fields[focusIndex];

  const submission = useMemo(
    () => resolveSessionOptionsSubmitState(profileNames, selectedProfileValue),
    [profileNames, selectedProfileValue],
  );

  const moveFocus = (delta: number) => {
    setFocusIndex((prev) => {
      const next = (prev + delta + fields.length) % fields.length;
      return next;
    });
  };

  useInput(
    (_input, key) => {
      if (key.escape) {
        onBack();
        return;
      }
      if (key.tab) {
        moveFocus(key.shift ? -1 : 1);
        return;
      }
    },
    { isActive: true },
  );

  return (
    <Box flexDirection="column" gap={0}>
      <Text dimColor>New Branch</Text>
      <Box height={1} />
      <BracketInput
        label="Branch"
        value={branch}
        isFocused={currentField === "branch"}
        onChange={setBranch}
        width={width}
      />
      <BracketInput
        label="Base"
        value={base}
        isFocused={currentField === "base"}
        onChange={setBase}
        width={width}
      />
      <PromptArea
        value={prompt}
        isFocused={currentField === "prompt"}
        onChange={setPrompt}
        width={width}
      />
      <SessionOptionsSection
        profileNames={profileNames}
        focusedField={
          currentField === "profile" ||
          currentField === "noIde" ||
          currentField === "autoSwitch" ||
          currentField === "submit"
            ? currentField
            : null
        }
        noIde={noIde}
        autoSwitch={autoSwitch}
        canSubmit={submission.canSubmit && branch.trim().length > 0}
        onNoIdeToggle={() => setNoIde((prev) => !prev)}
        onAutoSwitchToggle={() => setAutoSwitch((prev) => !prev)}
        onSubmit={() => {
          if (!branch.trim() || !submission.canSubmit) return;
          onSubmit({
            branch: branch.trim(),
            base: base.trim() || undefined,
            profile: submission.profile,
            prompt: prompt.trim() || undefined,
            existing: false,
            noIde,
            noAttach: !autoSwitch,
          });
        }}
        onProfileChange={setSelectedProfileValue}
        resetKey="new-branch"
        width={width}
      />
    </Box>
  );
}

// ─── FromPRForm ──────────────────────────────────────────────────

type FromPRField =
  | "prList"
  | "profile"
  | "prompt"
  | "noIde"
  | "autoSwitch"
  | "submit";

/** @internal */
export function FromPRForm({
  prList,
  profileNames,
  isRefreshing,
  onRefresh,
  onSubmit,
  onBack,
  width,
}: {
  prList: PRInfo[];
  profileNames: string[];
  isRefreshing: boolean;
  onRefresh: () => void;
  onSubmit: (result: OpenModalResult) => void;
  onBack: () => void;
  width?: number;
}) {
  const [selectedPRIndex, setSelectedPRIndex] = useState(0);
  const [filterQuery, setFilterQuery] = useState("");
  const {
    selectedProfileValue,
    setSelectedProfileValue,
    noIde,
    setNoIde,
    autoSwitch,
    setAutoSwitch,
  } = useSessionOptionsState(profileNames);
  const [prompt, setPrompt] = useState("");

  const fields = useMemo(() => {
    const f: FromPRField[] = ["prList", "prompt"];
    if (profileNames.length > 0) f.push("profile");
    f.push("noIde", "autoSwitch", "submit");
    return f;
  }, [profileNames.length]);

  const [focusIndex, setFocusIndex] = useState(0);
  const currentField = fields[focusIndex];

  const prItems: ListItem[] = useMemo(
    () =>
      prList.map((pr) => ({
        label: `#${pr.number} ${pr.headRefName}`,
        value: String(pr.number),
        description: pr.title,
      })),
    [prList],
  );

  // Refresh row pinned at the bottom — non-selectable while refreshing
  const refreshItem: ListItem = {
    label: isRefreshing ? "↻ Loading..." : "↻ Refresh PRs",
    value: "__refresh__",
  };

  const filteredPRItems = useMemo(
    () => filterItems(prItems, filterQuery),
    [prItems, filterQuery],
  );

  // Total navigable items: filtered PRs + refresh row (always at bottom)
  const navigableCount = filteredPRItems.length + 1;
  const refreshRowIndex = filteredPRItems.length;
  const isRefreshRowSelectable = !isRefreshing;
  const isRefreshRowSelected = selectedPRIndex === refreshRowIndex;

  // When isRefreshing flips to true, move cursor off the Refresh row
  useEffect(() => {
    if (isRefreshing && selectedPRIndex === refreshRowIndex) {
      setSelectedPRIndex(Math.max(0, refreshRowIndex - 1));
    }
  }, [isRefreshing, selectedPRIndex, refreshRowIndex]);

  const submission = useMemo(
    () => resolveSessionOptionsSubmitState(profileNames, selectedProfileValue),
    [profileNames, selectedProfileValue],
  );

  const moveFocus = (delta: number) => {
    setFocusIndex((prev) => {
      const next = (prev + delta + fields.length) % fields.length;
      return next;
    });
  };

  useInput(
    (input, key) => {
      if (key.escape) {
        onBack();
        return;
      }
      if (key.tab) {
        moveFocus(key.shift ? -1 : 1);
        return;
      }
      // PR list navigation
      if (currentField === "prList") {
        if (key.upArrow) {
          setSelectedPRIndex((s) => {
            if (s === refreshRowIndex) return refreshRowIndex - 1;
            return Math.max(0, s - 1);
          });
          return;
        }
        if (key.downArrow) {
          setSelectedPRIndex((s) => {
            const max = isRefreshRowSelectable
              ? navigableCount - 1
              : Math.max(0, refreshRowIndex - 1);
            return Math.min(max, s + 1);
          });
          return;
        }
        if (key.return) {
          if (isRefreshRowSelected && isRefreshRowSelectable) {
            onRefresh();
          }
          return;
        }
        if (key.backspace || key.delete) {
          setFilterQuery((q) => q.slice(0, -1));
          setSelectedPRIndex(0);
          return;
        }
        if (input && !key.ctrl && !key.meta) {
          setFilterQuery((q) => q + input);
          setSelectedPRIndex(0);
          return;
        }
      }
    },
    { isActive: true },
  );

  // The display list shown in ScrollableList includes filtered PRs + refresh row.
  // isRefreshing is the real dep for refreshItem label — biome-ignore needed below.
  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshItem depends on isRefreshing, listed explicitly
  const displayItems: ListItem[] = useMemo(
    () => [...filteredPRItems, refreshItem],
    [filteredPRItems, isRefreshing],
  );

  return (
    <Box flexDirection="column" gap={0}>
      <Text dimColor>Open from PR</Text>
      <Box height={1} />
      <TitledBox
        title="Select PR"
        isFocused={currentField === "prList"}
        width={width}
      >
        <ScrollableList
          items={displayItems}
          selectedIndex={selectedPRIndex}
          filterQuery={filterQuery}
          maxVisible={8}
          isFocused={currentField === "prList"}
        />
      </TitledBox>
      <PromptArea
        value={prompt}
        isFocused={currentField === "prompt"}
        onChange={setPrompt}
        width={width}
      />
      <SessionOptionsSection
        profileNames={profileNames}
        focusedField={
          currentField === "profile" ||
          currentField === "noIde" ||
          currentField === "autoSwitch" ||
          currentField === "submit"
            ? currentField
            : null
        }
        noIde={noIde}
        autoSwitch={autoSwitch}
        canSubmit={
          submission.canSubmit &&
          !isRefreshRowSelected &&
          Boolean(filteredPRItems[selectedPRIndex])
        }
        onNoIdeToggle={() => setNoIde((prev) => !prev)}
        onAutoSwitchToggle={() => setAutoSwitch((prev) => !prev)}
        onSubmit={() => {
          if (isRefreshRowSelected) return;
          const selectedPR = filteredPRItems[selectedPRIndex];
          if (!selectedPR || !submission.canSubmit) return;
          const pr = prList.find((p) => String(p.number) === selectedPR.value);
          if (!pr) return;
          onSubmit({
            branch: pr.headRefName,
            pr: String(pr.number),
            profile: submission.profile,
            prompt: prompt.trim() || undefined,
            existing: false,
            noIde,
            noAttach: !autoSwitch,
          });
        }}
        onProfileChange={setSelectedProfileValue}
        resetKey="from-pr"
        width={width}
      />
    </Box>
  );
}

// ─── ExistingBranchForm ──────────────────────────────────────────

type ExistingBranchField =
  | "branchList"
  | "profile"
  | "prompt"
  | "noIde"
  | "autoSwitch"
  | "submit";

/** @internal */
export function ExistingBranchForm({
  repoPath,
  profileNames,
  onSubmit,
  onBack,
  width,
}: {
  repoPath: string;
  profileNames: string[];
  onSubmit: (result: OpenModalResult) => void;
  onBack: () => void;
  width?: number;
}) {
  const [branches, setBranches] = useState<string[]>([]);
  const [selectedBranchIndex, setSelectedBranchIndex] = useState(0);
  const [filterQuery, setFilterQuery] = useState("");
  const {
    selectedProfileValue,
    setSelectedProfileValue,
    noIde,
    setNoIde,
    autoSwitch,
    setAutoSwitch,
  } = useSessionOptionsState(profileNames);
  const [prompt, setPrompt] = useState("");

  const fields = useMemo(() => {
    const nextFields: ExistingBranchField[] = ["branchList", "prompt"];
    if (profileNames.length > 0) nextFields.push("profile");
    nextFields.push("noIde", "autoSwitch", "submit");
    return nextFields;
  }, [profileNames.length]);

  const submission = useMemo(
    () => resolveSessionOptionsSubmitState(profileNames, selectedProfileValue),
    [profileNames, selectedProfileValue],
  );
  const [focusIndex, setFocusIndex] = useState(0);
  const currentField = fields[focusIndex];

  useEffect(() => {
    const controller = new AbortController();
    tuiRuntime
      .runPromise(
        WorktreeService.use((s) => s.listBranches(repoPath)),
        {
          signal: controller.signal,
        },
      )
      .then((result) => {
        setBranches(result);
      })
      .catch(() => {
        // Ignore branch listing errors
      });
    return () => {
      controller.abort();
    };
  }, [repoPath]);

  const branchItems: ListItem[] = useMemo(
    () => branches.map((b) => ({ label: b, value: b })),
    [branches],
  );

  const filteredBranchItems = useMemo(
    () => filterItems(branchItems, filterQuery),
    [branchItems, filterQuery],
  );

  const moveFocus = (delta: number) => {
    setFocusIndex((prev) => {
      const next = (prev + delta + fields.length) % fields.length;
      return next;
    });
  };

  useInput(
    (input, key) => {
      if (key.escape) {
        onBack();
        return;
      }
      if (key.tab) {
        moveFocus(key.shift ? -1 : 1);
        return;
      }
      // Branch list navigation
      if (currentField === "branchList") {
        if (key.upArrow) {
          setSelectedBranchIndex((s) => Math.max(0, s - 1));
          return;
        }
        if (key.downArrow) {
          setSelectedBranchIndex((s) =>
            Math.min(filteredBranchItems.length - 1, s + 1),
          );
          return;
        }
        if (key.backspace || key.delete) {
          setFilterQuery((q) => q.slice(0, -1));
          setSelectedBranchIndex(0);
          return;
        }
        if (input && !key.ctrl && !key.meta && !key.return) {
          setFilterQuery((q) => q + input);
          setSelectedBranchIndex(0);
          return;
        }
      }
    },
    { isActive: true },
  );

  return (
    <Box flexDirection="column" gap={0}>
      <Text dimColor>Existing Branch</Text>
      <Box height={1} />
      <TitledBox
        title="Select Branch"
        isFocused={currentField === "branchList"}
        width={width}
      >
        <ScrollableList
          items={branchItems}
          selectedIndex={selectedBranchIndex}
          filterQuery={filterQuery}
          maxVisible={10}
          isFocused={currentField === "branchList"}
        />
      </TitledBox>
      <PromptArea
        value={prompt}
        isFocused={currentField === "prompt"}
        onChange={setPrompt}
        width={width}
      />
      <SessionOptionsSection
        profileNames={profileNames}
        focusedField={
          currentField === "profile" ||
          currentField === "noIde" ||
          currentField === "autoSwitch" ||
          currentField === "submit"
            ? currentField
            : null
        }
        noIde={noIde}
        autoSwitch={autoSwitch}
        canSubmit={
          submission.canSubmit &&
          Boolean(filteredBranchItems[selectedBranchIndex])
        }
        onNoIdeToggle={() => setNoIde((prev) => !prev)}
        onAutoSwitchToggle={() => setAutoSwitch((prev) => !prev)}
        onSubmit={() => {
          const selectedBranch = filteredBranchItems[selectedBranchIndex];
          if (!selectedBranch || !submission.canSubmit) return;
          onSubmit({
            branch: selectedBranch.value,
            profile: submission.profile,
            prompt: prompt.trim() || undefined,
            existing: true,
            noIde,
            noAttach: !autoSwitch,
          });
        }}
        onProfileChange={setSelectedProfileValue}
        resetKey="existing-branch"
        width={width}
      />
    </Box>
  );
}

// ─── Main OpenModal ──────────────────────────────────────────────

export function OpenModal({
  visible,
  width,
  onSubmit,
  onCancel,
  defaultBase,
  profileNames,
  repoProject: _repoProject,
  repoPath,
  prList,
  isRefreshing,
  onRefresh,
}: OpenModalProps) {
  const [step, setStep] = useState<ModalStep>("selector");

  useEffect(() => {
    if (visible) setStep("selector");
  }, [visible]);

  // One AbortController per modal mount — aborted on unmount or explicit cancel.
  const abortControllerRef = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    abortControllerRef.current = controller;
    // Auto-refresh on open so the PR list is fresh
    onRefresh(controller.signal);
    return () => {
      controller.abort();
      abortControllerRef.current = null;
    };
  }, [onRefresh]);

  const handleCancel = () => {
    abortControllerRef.current?.abort();
    onCancel();
  };

  if (!visible) return null;

  const updatingIndicator = isRefreshing ? " ↻ Updating…" : "";
  const titleMap: Record<ModalStep, string> = {
    selector: `Open Worktree${updatingIndicator}`,
    newBranch: `Open Worktree — New Branch${updatingIndicator}`,
    fromPR: `Open Worktree — From PR${updatingIndicator}`,
    existingBranch: `Open Worktree — Existing Branch${updatingIndicator}`,
  };
  const innerWidth = width === undefined ? undefined : Math.max(width - 2, 0);

  return (
    <Modal title={titleMap[step]} visible={visible} width={width}>
      {step === "selector" && (
        <ModeSelector
          onSelect={setStep}
          onCancel={handleCancel}
          width={innerWidth}
        />
      )}
      {step === "newBranch" && (
        <NewBranchForm
          defaultBase={defaultBase}
          profileNames={profileNames}
          onSubmit={onSubmit}
          onBack={() => setStep("selector")}
          width={innerWidth}
        />
      )}
      {step === "fromPR" && (
        <FromPRForm
          prList={prList}
          profileNames={profileNames}
          isRefreshing={isRefreshing}
          onRefresh={() => onRefresh(abortControllerRef.current?.signal)}
          onSubmit={onSubmit}
          onBack={() => setStep("selector")}
          width={innerWidth}
        />
      )}
      {step === "existingBranch" && (
        <ExistingBranchForm
          repoPath={repoPath}
          profileNames={profileNames}
          onSubmit={onSubmit}
          onBack={() => setStep("selector")}
          width={innerWidth}
        />
      )}
      <Box marginTop={1}>
        <Text dimColor>
          {step === "selector"
            ? "↑↓:select  enter:confirm  esc:cancel"
            : "tab:next  shift+tab:prev  esc:back"}
        </Text>
      </Box>
    </Modal>
  );
}
