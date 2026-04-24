import { Box, Text, useInput } from "ink";
import { useEffect, useMemo, useState } from "react";
import { WorktreeService } from "../../services/worktree-service";
import { useBlink } from "../hooks/useBlink";
import { tuiRuntime } from "../runtime";
import type { PRInfo } from "../types";
import { Modal } from "./Modal";
import { filterItems, type ListItem, ScrollableList } from "./ScrollableList";
import { resolveSessionOptionsSubmitState } from "./session-options";
import { SessionOptionsSection } from "./SessionOptionsSection";
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
  const [selectedProfileValue, setSelectedProfileValue] = useState<
    string | undefined
  >(undefined);
  const [prompt, setPrompt] = useState("");
  const [noIde, setNoIde] = useState(false);
  const [autoSwitch, setAutoSwitch] = useState(true);

  const fields = useMemo(() => {
    const f: NewBranchField[] = ["branch", "base"];
    if (profileNames.length > 0) f.push("profile");
    f.push("prompt", "noIde", "autoSwitch", "submit");
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
  onSubmit,
  onBack,
  width,
}: {
  prList: PRInfo[];
  profileNames: string[];
  onSubmit: (result: OpenModalResult) => void;
  onBack: () => void;
  width?: number;
}) {
  const [selectedPRIndex, setSelectedPRIndex] = useState(0);
  const [filterQuery, setFilterQuery] = useState("");
  const [selectedProfileValue, setSelectedProfileValue] = useState<
    string | undefined
  >(undefined);
  const [prompt, setPrompt] = useState("");
  const [noIde, setNoIde] = useState(false);
  const [autoSwitch, setAutoSwitch] = useState(true);

  const fields = useMemo(() => {
    const f: FromPRField[] = ["prList"];
    if (profileNames.length > 0) f.push("profile");
    f.push("prompt", "noIde", "autoSwitch", "submit");
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

  const filteredPRItems = useMemo(
    () => filterItems(prItems, filterQuery),
    [prItems, filterQuery],
  );

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
          setSelectedPRIndex((s) => Math.max(0, s - 1));
          return;
        }
        if (key.downArrow) {
          setSelectedPRIndex((s) =>
            Math.min(filteredPRItems.length - 1, s + 1),
          );
          return;
        }
        if (key.backspace || key.delete) {
          setFilterQuery((q) => q.slice(0, -1));
          setSelectedPRIndex(0);
          return;
        }
        if (input && !key.ctrl && !key.meta && !key.return) {
          setFilterQuery((q) => q + input);
          setSelectedPRIndex(0);
          return;
        }
      }
    },
    { isActive: true },
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
          items={prItems}
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
          submission.canSubmit && Boolean(filteredPRItems[selectedPRIndex])
        }
        onNoIdeToggle={() => setNoIde((prev) => !prev)}
        onAutoSwitchToggle={() => setAutoSwitch((prev) => !prev)}
        onSubmit={() => {
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
  | "prompt"
  | "noIde"
  | "autoSwitch"
  | "submit";

/** @internal */
export function ExistingBranchForm({
  repoPath,
  onSubmit,
  onBack,
  width,
}: {
  repoPath: string;
  onSubmit: (result: OpenModalResult) => void;
  onBack: () => void;
  width?: number;
}) {
  const [branches, setBranches] = useState<string[]>([]);
  const [selectedBranchIndex, setSelectedBranchIndex] = useState(0);
  const [filterQuery, setFilterQuery] = useState("");
  const [prompt, setPrompt] = useState("");
  const [noIde, setNoIde] = useState(false);
  const [autoSwitch, setAutoSwitch] = useState(true);

  const fields: ExistingBranchField[] = [
    "branchList",
    "prompt",
    "noIde",
    "autoSwitch",
    "submit",
  ];

  const submission = useMemo(
    () => resolveSessionOptionsSubmitState([], undefined),
    [],
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
        profileNames={[]}
        focusedField={
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
          if (!selectedBranch) return;
          onSubmit({
            branch: selectedBranch.value,
            prompt: prompt.trim() || undefined,
            existing: true,
            noIde,
            noAttach: !autoSwitch,
          });
        }}
        onProfileChange={() => {}}
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
}: OpenModalProps) {
  const [step, setStep] = useState<ModalStep>("selector");

  useEffect(() => {
    if (visible) setStep("selector");
  }, [visible]);

  if (!visible) return null;

  const titleMap: Record<ModalStep, string> = {
    selector: "Open Worktree",
    newBranch: "Open Worktree — New Branch",
    fromPR: "Open Worktree — From PR",
    existingBranch: "Open Worktree — Existing Branch",
  };
  const innerWidth = width === undefined ? undefined : Math.max(width - 2, 0);

  return (
    <Modal title={titleMap[step]} visible={visible} width={width}>
      {step === "selector" && (
        <ModeSelector
          onSelect={setStep}
          onCancel={onCancel}
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
          onSubmit={onSubmit}
          onBack={() => setStep("selector")}
          width={innerWidth}
        />
      )}
      {step === "existingBranch" && (
        <ExistingBranchForm
          repoPath={repoPath}
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
