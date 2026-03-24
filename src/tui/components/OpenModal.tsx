import { Box, Text, useInput } from "ink";
import { useEffect, useMemo, useState } from "react";
import { useBlink } from "../hooks/useBlink";
import type { PRInfo } from "../types";
import { Modal } from "./Modal";
import { filterItems, type ListItem, ScrollableList } from "./ScrollableList";

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
  onSubmit: (result: OpenModalResult) => void;
  onCancel: () => void;
  defaultBase: string;
  profileNames: string[];
  repoProject: string;
  repoPath: string;
  prList: PRInfo[];
  onStepChange: (step: "selector" | "form" | "list") => void;
}

// ─── Sub-components ───────────────────────────────────────────────

function ModeSelector({
  onSelect,
  onCancel,
}: {
  onSelect: (step: ModalStep) => void;
  onCancel: () => void;
}) {
  const [selected, setSelected] = useState(0);
  const cursorVisible = useBlink();
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
      if (key.return) onSelect(options[selected].step);
      if (key.escape) onCancel();
    },
    { isActive: true },
  );

  return (
    <Box flexDirection="column">
      <Text dimColor>Open Worktree</Text>
      <Box height={1} />
      {options.map((opt, i) => {
        const isSel = i === selected;
        return (
          <Text key={opt.step} color={isSel ? "cyan" : "dim"}>
            {"["} {opt.label}
            {isSel && cursorVisible ? "▎" : " "}
            {"]"}
          </Text>
        );
      })}
    </Box>
  );
}

function BracketInput({
  label,
  value,
  isFocused,
  onChange,
}: {
  label: string;
  value: string;
  isFocused: boolean;
  onChange: (v: string) => void;
}) {
  const cursorVisible = useBlink();

  useInput(
    (input, key) => {
      if (!isFocused) return;
      if (key.backspace || key.delete) {
        onChange(value.slice(0, -1));
      } else if (input && !key.ctrl && !key.meta) {
        onChange(value + input);
      }
    },
    { isActive: isFocused },
  );

  return (
    <Box flexDirection="column">
      <Text color={isFocused ? "cyan" : "dim"} bold={isFocused}>
        {label}
      </Text>
      <Text color={isFocused ? "cyan" : "dim"}>
        {"[ "}
        <Text color={isFocused ? undefined : "dim"}>{value}</Text>
        {isFocused && cursorVisible ? "▎" : " "}
        {" ]"}
      </Text>
    </Box>
  );
}

function PromptArea({
  value,
  isFocused,
  onChange,
}: {
  value: string;
  isFocused: boolean;
  onChange: (v: string) => void;
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
    <Box flexDirection="column">
      <Text color={isFocused ? "cyan" : "dim"} bold={isFocused}>
        Prompt
      </Text>
      <Text dimColor>───────────────────────────────</Text>
      <Text color={isFocused ? undefined : "dim"}>
        {value || (isFocused ? "" : "optional")}
        {isFocused ? (cursorVisible ? "▎" : " ") : ""}
      </Text>
      <Text dimColor>───────────────────────────────</Text>
    </Box>
  );
}

function ToggleRow({
  label,
  checked,
  isFocused,
  onToggle,
}: {
  label: string;
  checked: boolean;
  isFocused: boolean;
  onToggle: () => void;
}) {
  useInput(
    (input) => {
      if (input === " ") onToggle();
    },
    { isActive: isFocused },
  );

  return (
    <Text color={isFocused ? "cyan" : "dim"}>
      {checked ? "[x]" : "[ ]"} {label}
    </Text>
  );
}

// ─── NewBranchForm ───────────────────────────────────────────────

type NewBranchField =
  | "branch"
  | "base"
  | "profile"
  | "prompt"
  | "noIde"
  | "noAttach";

function NewBranchForm({
  defaultBase,
  profileNames,
  onSubmit,
  onBack,
}: {
  defaultBase: string;
  profileNames: string[];
  onSubmit: (result: OpenModalResult) => void;
  onBack: () => void;
}) {
  const [branch, setBranch] = useState("");
  const [base, setBase] = useState(defaultBase);
  const [profile, setProfile] = useState("");
  const [prompt, setPrompt] = useState("");
  const [noIde, setNoIde] = useState(false);
  const [noAttach, setNoAttach] = useState(false);

  const fields = useMemo(() => {
    const f: NewBranchField[] = ["branch", "base"];
    if (profileNames.length > 0) f.push("profile");
    f.push("prompt", "noIde", "noAttach");
    return f;
  }, [profileNames.length]);

  const [focusIndex, setFocusIndex] = useState(0);
  const currentField = fields[focusIndex];

  const moveFocus = (delta: number) => {
    setFocusIndex((prev) => {
      const next = (prev + delta + fields.length) % fields.length;
      return next;
    });
  };

  const submit = () => {
    if (!branch.trim()) return;
    onSubmit({
      branch: branch.trim(),
      base: base.trim() || undefined,
      profile: profile.trim() || undefined,
      prompt: prompt.trim() || undefined,
      existing: false,
      noIde,
      noAttach,
    });
  };

  useInput(
    (input, key) => {
      if (key.escape) {
        onBack();
        return;
      }
      if (input === "s" && key.ctrl) {
        submit();
        return;
      }
      if (key.tab) {
        moveFocus(key.shift ? -1 : 1);
        return;
      }
      // Up/down on toggle fields
      if (
        (currentField === "noIde" || currentField === "noAttach") &&
        (key.upArrow || key.downArrow)
      ) {
        moveFocus(key.upArrow ? -1 : 1);
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
      />
      <BracketInput
        label="Base"
        value={base}
        isFocused={currentField === "base"}
        onChange={setBase}
      />
      {profileNames.length > 0 && (
        <BracketInput
          label="Profile"
          value={profile}
          isFocused={currentField === "profile"}
          onChange={setProfile}
        />
      )}
      <PromptArea
        value={prompt}
        isFocused={currentField === "prompt"}
        onChange={setPrompt}
      />
      <ToggleRow
        label="No IDE"
        checked={noIde}
        isFocused={currentField === "noIde"}
        onToggle={() => setNoIde((v) => !v)}
      />
      <ToggleRow
        label="No attach"
        checked={noAttach}
        isFocused={currentField === "noAttach"}
        onToggle={() => setNoAttach((v) => !v)}
      />
    </Box>
  );
}

// ─── FromPRForm ──────────────────────────────────────────────────

type FromPRField = "prList" | "profile" | "prompt" | "noIde" | "noAttach";

function FromPRForm({
  prList,
  profileNames,
  onSubmit,
  onBack,
  onStepChange,
}: {
  prList: PRInfo[];
  profileNames: string[];
  onSubmit: (result: OpenModalResult) => void;
  onBack: () => void;
  onStepChange: (step: "selector" | "form" | "list") => void;
}) {
  const [selectedPRIndex, setSelectedPRIndex] = useState(0);
  const [filterQuery, setFilterQuery] = useState("");
  const [profile, setProfile] = useState("");
  const [prompt, setPrompt] = useState("");
  const [noIde, setNoIde] = useState(false);
  const [noAttach, setNoAttach] = useState(false);

  const fields = useMemo(() => {
    const f: FromPRField[] = ["prList"];
    if (profileNames.length > 0) f.push("profile");
    f.push("prompt", "noIde", "noAttach");
    return f;
  }, [profileNames.length]);

  const [focusIndex, setFocusIndex] = useState(0);
  const currentField = fields[focusIndex];

  // Notify parent about step change
  useEffect(() => {
    onStepChange(currentField === "prList" ? "list" : "form");
  }, [currentField, onStepChange]);

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

  const moveFocus = (delta: number) => {
    setFocusIndex((prev) => {
      const next = (prev + delta + fields.length) % fields.length;
      return next;
    });
  };

  const submit = () => {
    const selectedPR = filteredPRItems[selectedPRIndex];
    if (!selectedPR) return;
    const pr = prList.find((p) => String(p.number) === selectedPR.value);
    if (!pr) return;
    onSubmit({
      branch: pr.headRefName,
      pr: String(pr.number),
      profile: profile.trim() || undefined,
      prompt: prompt.trim() || undefined,
      existing: false,
      noIde,
      noAttach,
    });
  };

  useInput(
    (input, key) => {
      if (key.escape) {
        onBack();
        return;
      }
      if (input === "s" && key.ctrl) {
        submit();
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
          return;
        }
        if (input && !key.ctrl && !key.meta && !key.return) {
          setFilterQuery((q) => q + input);
          return;
        }
      }
      // Toggle navigation
      if (
        (currentField === "noIde" || currentField === "noAttach") &&
        (key.upArrow || key.downArrow)
      ) {
        moveFocus(key.upArrow ? -1 : 1);
        return;
      }
    },
    { isActive: true },
  );

  return (
    <Box flexDirection="column" gap={0}>
      <Text dimColor>Open from PR</Text>
      <Box height={1} />
      <Text
        color={currentField === "prList" ? "cyan" : "dim"}
        bold={currentField === "prList"}
      >
        Select PR
      </Text>
      <ScrollableList
        items={prItems}
        selectedIndex={selectedPRIndex}
        filterQuery={filterQuery}
        maxVisible={8}
        isFocused={currentField === "prList"}
      />
      {profileNames.length > 0 && (
        <BracketInput
          label="Profile"
          value={profile}
          isFocused={currentField === "profile"}
          onChange={setProfile}
        />
      )}
      <PromptArea
        value={prompt}
        isFocused={currentField === "prompt"}
        onChange={setPrompt}
      />
      <ToggleRow
        label="No IDE"
        checked={noIde}
        isFocused={currentField === "noIde"}
        onToggle={() => setNoIde((v) => !v)}
      />
      <ToggleRow
        label="No attach"
        checked={noAttach}
        isFocused={currentField === "noAttach"}
        onToggle={() => setNoAttach((v) => !v)}
      />
    </Box>
  );
}

// ─── ExistingBranchForm ──────────────────────────────────────────

type ExistingBranchField = "branchList" | "prompt" | "noIde" | "noAttach";

function ExistingBranchForm({
  repoPath,
  onSubmit,
  onBack,
  onStepChange,
}: {
  repoPath: string;
  onSubmit: (result: OpenModalResult) => void;
  onBack: () => void;
  onStepChange: (step: "selector" | "form" | "list") => void;
}) {
  const [branches, setBranches] = useState<string[]>([]);
  const [selectedBranchIndex, setSelectedBranchIndex] = useState(0);
  const [filterQuery, setFilterQuery] = useState("");
  const [prompt, setPrompt] = useState("");
  const [noIde, setNoIde] = useState(false);
  const [noAttach, setNoAttach] = useState(false);

  const fields: ExistingBranchField[] = [
    "branchList",
    "prompt",
    "noIde",
    "noAttach",
  ];
  const [focusIndex, setFocusIndex] = useState(0);
  const currentField = fields[focusIndex];

  // Notify parent about step change
  useEffect(() => {
    onStepChange(currentField === "branchList" ? "list" : "form");
  }, [currentField, onStepChange]);

  // Fetch branches on mount
  useEffect(() => {
    const proc = Bun.spawn(
      ["git", "branch", "-r", "--format=%(refname:short)"],
      { cwd: repoPath, stdout: "pipe", stderr: "ignore" },
    );
    new Response(proc.stdout).text().then((text) => {
      setBranches(
        text
          .split("\n")
          .filter(Boolean)
          .map((b) => b.replace(/^origin\//, ""))
          .filter((b) => b !== "HEAD"),
      );
    });
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

  const submit = () => {
    const selectedBranch = filteredBranchItems[selectedBranchIndex];
    if (!selectedBranch) return;
    onSubmit({
      branch: selectedBranch.value,
      prompt: prompt.trim() || undefined,
      existing: true,
      noIde,
      noAttach,
    });
  };

  useInput(
    (input, key) => {
      if (key.escape) {
        onBack();
        return;
      }
      if (input === "s" && key.ctrl) {
        submit();
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
          return;
        }
        if (input && !key.ctrl && !key.meta && !key.return) {
          setFilterQuery((q) => q + input);
          return;
        }
      }
      // Toggle navigation
      if (
        (currentField === "noIde" || currentField === "noAttach") &&
        (key.upArrow || key.downArrow)
      ) {
        moveFocus(key.upArrow ? -1 : 1);
        return;
      }
    },
    { isActive: true },
  );

  return (
    <Box flexDirection="column" gap={0}>
      <Text dimColor>Existing Branch</Text>
      <Box height={1} />
      <Text
        color={currentField === "branchList" ? "cyan" : "dim"}
        bold={currentField === "branchList"}
      >
        Select Branch
      </Text>
      <ScrollableList
        items={branchItems}
        selectedIndex={selectedBranchIndex}
        filterQuery={filterQuery}
        maxVisible={10}
        isFocused={currentField === "branchList"}
      />
      <PromptArea
        value={prompt}
        isFocused={currentField === "prompt"}
        onChange={setPrompt}
      />
      <ToggleRow
        label="No IDE"
        checked={noIde}
        isFocused={currentField === "noIde"}
        onToggle={() => setNoIde((v) => !v)}
      />
      <ToggleRow
        label="No attach"
        checked={noAttach}
        isFocused={currentField === "noAttach"}
        onToggle={() => setNoAttach((v) => !v)}
      />
    </Box>
  );
}

// ─── Main OpenModal ──────────────────────────────────────────────

export function OpenModal({
  visible,
  onSubmit,
  onCancel,
  defaultBase,
  profileNames,
  repoProject: _repoProject,
  repoPath,
  prList,
  onStepChange,
}: OpenModalProps) {
  const [step, setStep] = useState<ModalStep>("selector");

  // Reset to selector when modal opens
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on visibility change
  useEffect(() => {
    if (visible) {
      setStep("selector");
      onStepChange("selector");
    }
  }, [visible]);

  if (!visible) return null;

  const handleBack = () => {
    setStep("selector");
    onStepChange("selector");
  };

  const handleSelectStep = (nextStep: ModalStep) => {
    setStep(nextStep);
    onStepChange(nextStep === "selector" ? "selector" : "form");
  };

  const titleMap: Record<ModalStep, string> = {
    selector: "Open Worktree",
    newBranch: "Open Worktree — New Branch",
    fromPR: "Open Worktree — From PR",
    existingBranch: "Open Worktree — Existing Branch",
  };

  return (
    <Modal title={titleMap[step]} visible={visible}>
      {step === "selector" && (
        <ModeSelector onSelect={handleSelectStep} onCancel={onCancel} />
      )}
      {step === "newBranch" && (
        <NewBranchForm
          defaultBase={defaultBase}
          profileNames={profileNames}
          onSubmit={onSubmit}
          onBack={handleBack}
        />
      )}
      {step === "fromPR" && (
        <FromPRForm
          prList={prList}
          profileNames={profileNames}
          onSubmit={onSubmit}
          onBack={handleBack}
          onStepChange={onStepChange}
        />
      )}
      {step === "existingBranch" && (
        <ExistingBranchForm
          repoPath={repoPath}
          onSubmit={onSubmit}
          onBack={handleBack}
          onStepChange={onStepChange}
        />
      )}
      <Box marginTop={1}>
        <Text dimColor>
          {step === "selector"
            ? "↑↓:select  enter:confirm  esc:cancel"
            : "tab:next  shift+tab:prev  ctrl+s:submit  esc:back"}
        </Text>
      </Box>
    </Modal>
  );
}
