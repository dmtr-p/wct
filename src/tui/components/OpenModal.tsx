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
      {options.map((opt, i) => {
        const isSel = i === selected;
        return (
          <Text key={opt.step} color={isSel ? "cyan" : "dim"} bold={isSel}>
            {isSel ? "▸ " : "  "}
            {opt.label}
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
    <Text color={isFocused ? "cyan" : "dim"} bold={isFocused}>
      {checked ? "[x]" : "[ ]"} {label}
    </Text>
  );
}

function SubmitButton({
  isFocused,
  onSubmit,
}: {
  isFocused: boolean;
  onSubmit: () => void;
}) {
  useInput(
    (input, key) => {
      if (key.return || input === " ") onSubmit();
    },
    { isActive: isFocused },
  );

  return (
    <Box marginTop={1}>
      <Text color={isFocused ? "cyan" : "dim"} bold={isFocused}>
        {isFocused ? "▸ " : "  "}Submit
      </Text>
    </Box>
  );
}

// ─── NewBranchForm ───────────────────────────────────────────────

type NewBranchField =
  | "branch"
  | "base"
  | "profile"
  | "prompt"
  | "noIde"
  | "noAttach"
  | "submit";

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
    f.push("prompt", "noIde", "noAttach", "submit");
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
    (_input, key) => {
      if (key.escape) {
        onBack();
        return;
      }
      if (key.tab) {
        moveFocus(key.shift ? -1 : 1);
        return;
      }
      // Up/down on toggle fields and submit
      if (
        (currentField === "noIde" ||
          currentField === "noAttach" ||
          currentField === "submit") &&
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
      <SubmitButton isFocused={currentField === "submit"} onSubmit={submit} />
    </Box>
  );
}

// ─── FromPRForm ──────────────────────────────────────────────────

type FromPRField =
  | "prList"
  | "profile"
  | "prompt"
  | "noIde"
  | "noAttach"
  | "submit";

function FromPRForm({
  prList,
  profileNames,
  onSubmit,
  onBack,
}: {
  prList: PRInfo[];
  profileNames: string[];
  onSubmit: (result: OpenModalResult) => void;
  onBack: () => void;
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
    f.push("prompt", "noIde", "noAttach", "submit");
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
      // Toggle and submit navigation
      if (
        (currentField === "noIde" ||
          currentField === "noAttach" ||
          currentField === "submit") &&
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
      <SubmitButton isFocused={currentField === "submit"} onSubmit={submit} />
    </Box>
  );
}

// ─── ExistingBranchForm ──────────────────────────────────────────

type ExistingBranchField =
  | "branchList"
  | "prompt"
  | "noIde"
  | "noAttach"
  | "submit";

function ExistingBranchForm({
  repoPath,
  onSubmit,
  onBack,
}: {
  repoPath: string;
  onSubmit: (result: OpenModalResult) => void;
  onBack: () => void;
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
    "submit",
  ];
  const [focusIndex, setFocusIndex] = useState(0);
  const currentField = fields[focusIndex];

  useEffect(() => {
    let cancelled = false;
    const proc = Bun.spawn(["git", "branch", "--format=%(refname:short)"], {
      cwd: repoPath,
      stdout: "pipe",
      stderr: "ignore",
    });
    new Response(proc.stdout).text().then((text) => {
      if (cancelled) return;
      setBranches(text.split("\n").filter(Boolean));
    });
    return () => {
      cancelled = true;
      proc.kill();
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
      // Toggle and submit navigation
      if (
        (currentField === "noIde" ||
          currentField === "noAttach" ||
          currentField === "submit") &&
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
      <SubmitButton isFocused={currentField === "submit"} onSubmit={submit} />
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

  return (
    <Modal title={titleMap[step]} visible={visible}>
      {step === "selector" && (
        <ModeSelector onSelect={setStep} onCancel={onCancel} />
      )}
      {step === "newBranch" && (
        <NewBranchForm
          defaultBase={defaultBase}
          profileNames={profileNames}
          onSubmit={onSubmit}
          onBack={() => setStep("selector")}
        />
      )}
      {step === "fromPR" && (
        <FromPRForm
          prList={prList}
          profileNames={profileNames}
          onSubmit={onSubmit}
          onBack={() => setStep("selector")}
        />
      )}
      {step === "existingBranch" && (
        <ExistingBranchForm
          repoPath={repoPath}
          onSubmit={onSubmit}
          onBack={() => setStep("selector")}
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
