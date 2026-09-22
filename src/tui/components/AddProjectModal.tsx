import * as path from "node:path";
import { Effect, FileSystem } from "effect";
import { Box, Text } from "ink";
import { useCallback, useEffect, useState } from "react";
import { useCursorBlink } from "../hooks/useCursorBlink";
import { useGuardedInput } from "../hooks/useGuardedInput";
import { useTextEditing } from "../hooks/useTextEditing";
import { runTuiSilentPromise } from "../runtime";
import { EditableText } from "./EditableText";
import { isSubmitShortcut, SubmitButton } from "./form-controls";
import { Modal } from "./Modal";
import { ModalShortcut } from "./ModalShortcut";
import { MouseClickable } from "./MouseClickable";
import { expandTilde, PathInput } from "./PathInput";
import { TitledBox } from "./TitledBox";

export interface AddProjectModalResult {
  path: string;
  name: string;
  nameManuallyEdited: boolean;
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
  const [focusIndex, setFocusIndex] = useState(0);
  const [pathValue, setPathValue] = useState("~/");
  const [nameValue, setNameValue] = useState("");
  const [isGitRepo, setIsGitRepo] = useState(false);
  const [nameAutoFilled, setNameAutoFilled] = useState(false);

  const currentField = FIELDS[focusIndex] ?? "path";
  const nameFocused = currentField === "name";
  const nameEditing = useTextEditing(
    nameValue,
    (next) => {
      setNameValue(next);
      setNameAutoFilled(false);
    },
    nameFocused,
  );
  const cursorVisible = useCursorBlink(
    nameValue,
    nameEditing.cursor,
    nameFocused,
  );

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
    if (!expanded) {
      setIsGitRepo(false);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const gitPath = expanded.endsWith("/")
          ? `${expanded}.git`
          : `${expanded}/.git`;
        const exists = await runTuiSilentPromise(
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            return yield* fs.exists(gitPath);
          }),
        );
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
    const manuallyEdited = nameValue !== "" && !nameAutoFilled;
    onSubmit({ path: expanded, name, nameManuallyEdited: manuallyEdited });
  }, [isGitRepo, pathValue, nameValue, nameAutoFilled, onSubmit]);

  useGuardedInput(
    (_input, key) => {
      if (key.escape) {
        onCancel();
        return;
      }
      if (isSubmitShortcut(key)) {
        handleSubmit();
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
      if (key.return && !key.ctrl && currentField === "path") {
        autoFillName();
        setFocusIndex(1); // advance to name
        return;
      }
      if (key.return && !key.ctrl && currentField === "name") {
        setFocusIndex(2); // advance to submit
        return;
      }
    },
    { isActive: visible },
  );

  // Name field input handling
  useGuardedInput(
    (input, key) => {
      nameEditing.handleInput(input, key);
    },
    { isActive: visible && currentField === "name" },
  );

  const innerWidth = width === undefined ? undefined : Math.max(width - 2, 0);

  return (
    <Modal title="Add Project" visible={visible} width={width}>
      <Box flexDirection="column">
        <Text dimColor>Register a git repository</Text>
        <Box height={1} />
        <PathInput
          value={pathValue}
          onChange={(v) => {
            setPathValue(v);
          }}
          isFocused={currentField === "path"}
          isGitRepo={isGitRepo}
          width={innerWidth}
          onFocus={() => setFocusIndex(0)}
        />
        <MouseClickable
          onClick={() => {
            autoFillName();
            setFocusIndex(1);
          }}
        >
          {(isHovered) => (
            <TitledBox
              title="Name"
              isFocused={nameFocused}
              isHovered={isHovered}
              width={innerWidth}
            >
              <EditableText
                value={nameValue}
                cursor={nameEditing.cursor}
                isFocused={nameFocused}
                cursorVisible={cursorVisible}
                dimColor={!nameFocused}
              />
            </TitledBox>
          )}
        </MouseClickable>
        <SubmitButton
          isFocused={currentField === "submit"}
          disabled={!isGitRepo}
          onSubmit={handleSubmit}
        />
        <Box marginTop={1}>
          <Text dimColor>
            {"tab:next  shift+tab:prev  →:complete  enter:confirm  "}
          </Text>
          <ModalShortcut label="esc:close" onClick={onCancel} />
        </Box>
      </Box>
    </Modal>
  );
}
