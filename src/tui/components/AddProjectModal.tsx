import * as path from "node:path";
import { Box, Text, useInput } from "ink";
import { useCallback, useEffect, useState } from "react";
import { pathExists } from "../../services/filesystem";
import { useBlink } from "../hooks/useBlink";
import { runTuiSilentPromise } from "../runtime";
import { SubmitButton } from "./form-controls";
import { Modal } from "./Modal";
import { expandTilde, PathInput } from "./PathInput";
import { TitledBox } from "./TitledBox";

export interface AddProjectModalResult {
  path: string;
  name: string;
}

export interface AddProjectModalProps {
  visible: boolean;
  width?: number;
  onSubmit: (result: AddProjectModalResult) => void;
  onCancel: () => void;
}

type AddProjectField = "path" | "name" | "submit";
const FIELDS: AddProjectField[] = ["path", "name", "submit"];

export function AddProjectModal({
  visible,
  width,
  onSubmit,
  onCancel,
}: AddProjectModalProps) {
  const cursorVisible = useBlink();
  const [focusIndex, setFocusIndex] = useState(0);
  const [pathValue, setPathValue] = useState("~/");
  const [nameValue, setNameValue] = useState("");
  const [isGitRepo, setIsGitRepo] = useState(false);
  const [nameAutoFilled, setNameAutoFilled] = useState(false);

  const currentField = FIELDS[focusIndex] ?? "path";

  // Reset state when modal visibility changes
  useEffect(() => {
    if (visible) {
      setFocusIndex(0);
      setPathValue("~/");
      setNameValue("");
      setIsGitRepo(false);
      setNameAutoFilled(false);
    }
  }, [visible]);

  // Check if path is a git repo
  useEffect(() => {
    const expanded = expandTilde(pathValue);
    if (!expanded || expanded.length < 2) {
      setIsGitRepo(false);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const gitPath = expanded.endsWith("/")
          ? `${expanded}.git`
          : `${expanded}/.git`;
        const exists = await runTuiSilentPromise(pathExists(gitPath));
        if (!cancelled) setIsGitRepo(exists);
      } catch {
        if (!cancelled) setIsGitRepo(false);
      }
    }, 100);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [pathValue]);

  // Auto-fill name when leaving path field
  const autoFillName = useCallback(() => {
    if (nameValue === "" || nameAutoFilled) {
      const expanded = expandTilde(pathValue);
      const basename = path.basename(expanded.replace(/\/+$/, ""));
      if (basename) {
        setNameValue(basename);
        setNameAutoFilled(true);
      }
    }
  }, [pathValue, nameValue, nameAutoFilled]);

  const handleSubmit = useCallback(() => {
    if (!isGitRepo) return;
    const expanded = expandTilde(pathValue).replace(/\/+$/, "");
    const name = nameValue || path.basename(expanded);
    onSubmit({ path: expanded, name });
  }, [isGitRepo, pathValue, nameValue, onSubmit]);

  useInput(
    (_input, key) => {
      if (key.escape) {
        onCancel();
        return;
      }
      if (key.tab) {
        // When leaving path field, auto-fill name
        if (currentField === "path") autoFillName();
        setFocusIndex(
          (prev) =>
            (prev + (key.shift ? -1 : 1) + FIELDS.length) % FIELDS.length,
        );
        return;
      }
      if (key.return && currentField === "path") {
        autoFillName();
        setFocusIndex(1); // advance to name
        return;
      }
      if (key.return && currentField === "name") {
        setFocusIndex(2); // advance to submit
        return;
      }
    },
    { isActive: visible },
  );

  // Name field input handling
  useInput(
    (input, key) => {
      if (key.backspace || key.delete) {
        setNameValue((prev) => prev.slice(0, -1));
        setNameAutoFilled(false);
        return;
      }
      if (
        input &&
        !key.ctrl &&
        !key.meta &&
        !key.escape &&
        !key.return &&
        !key.tab
      ) {
        setNameValue((prev) => prev + input);
        setNameAutoFilled(false);
      }
    },
    { isActive: visible && currentField === "name" },
  );

  const innerWidth = width === undefined ? undefined : Math.max(width - 2, 0);
  const nameFocused = currentField === "name";
  const nameDisplay = nameValue || (!nameFocused || !cursorVisible ? " " : "");

  return (
    <Modal title="Add Project" visible={visible} width={width}>
      <Box flexDirection="column">
        <Text dimColor>Register a git repository</Text>
        <Box height={1} />
        <PathInput
          value={pathValue}
          onChange={(v) => {
            setPathValue(v);
            setNameAutoFilled(false);
          }}
          isFocused={currentField === "path"}
          isGitRepo={isGitRepo}
          width={innerWidth}
        />
        <TitledBox title="Name" isFocused={nameFocused} width={innerWidth}>
          <Text color={nameFocused ? undefined : "dim"}>
            {nameDisplay}
            {nameFocused ? (cursorVisible ? "▎" : " ") : ""}
          </Text>
        </TitledBox>
        <SubmitButton
          isFocused={currentField === "submit"}
          disabled={!isGitRepo}
          onSubmit={handleSubmit}
        />
        <Box marginTop={1}>
          <Text dimColor>
            {"tab:next  shift+tab:prev  →:complete  enter:confirm  esc:cancel"}
          </Text>
        </Box>
      </Box>
    </Modal>
  );
}
