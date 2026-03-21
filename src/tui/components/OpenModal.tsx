import { Box, Text, useInput } from "ink";
import { useEffect, useMemo, useState } from "react";
import { Modal } from "./Modal";

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

interface Props {
  visible: boolean;
  defaultBase?: string;
  profileNames: string[];
  onSubmit: (opts: OpenModalResult) => void;
  onCancel: () => void;
}

type TextField = "branch" | "base" | "pr" | "profile";
type ToggleField = "existing" | "noIde" | "noAttach";
type FieldDef =
  | { kind: "text"; key: TextField; label: string; placeholder: string }
  | { kind: "toggle"; key: ToggleField; label: string }
  | { kind: "textarea"; key: "prompt"; label: string; placeholder: string }
  | { kind: "submit" };

function buildFields(hasProfiles: boolean): FieldDef[] {
  const fields: FieldDef[] = [
    {
      kind: "text",
      key: "branch",
      label: "Branch",
      placeholder: "feature/my-branch",
    },
    { kind: "text", key: "base", label: "Base", placeholder: "(optional)" },
    {
      kind: "text",
      key: "pr",
      label: "PR",
      placeholder: "(optional) number or URL",
    },
  ];
  if (hasProfiles) {
    fields.push({
      kind: "text",
      key: "profile",
      label: "Profile",
      placeholder: "(optional)",
    });
  }
  fields.push(
    {
      kind: "textarea",
      key: "prompt",
      label: "Prompt",
      placeholder: "(optional) multiline text",
    },
    { kind: "toggle", key: "existing", label: "Existing branch" },
    { kind: "toggle", key: "noIde", label: "No IDE" },
    { kind: "toggle", key: "noAttach", label: "No attach" },
    { kind: "submit" },
  );
  return fields;
}

const EMPTY_TEXT: Record<TextField, string> = {
  branch: "",
  base: "",
  pr: "",
  profile: "",
};

const EMPTY_TOGGLES: Record<ToggleField, boolean> = {
  existing: false,
  noIde: false,
  noAttach: false,
};

export function OpenModal({
  visible,
  defaultBase,
  profileNames,
  onSubmit,
  onCancel,
}: Props) {
  const fields = useMemo(
    () => buildFields(profileNames.length > 0),
    [profileNames.length],
  );

  const [textValues, setTextValues] = useState<Record<TextField, string>>({
    ...EMPTY_TEXT,
  });
  const [promptValue, setPromptValue] = useState("");
  const [toggleValues, setToggleValues] = useState<
    Record<ToggleField, boolean>
  >({
    ...EMPTY_TOGGLES,
  });
  const [focusIndex, setFocusIndex] = useState(0);

  // Set default base when modal opens
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on visibility change
  useEffect(() => {
    if (visible && defaultBase) {
      setTextValues((prev) => ({ ...prev, base: defaultBase }));
    }
  }, [visible]);

  const reset = () => {
    setTextValues({ ...EMPTY_TEXT });
    setPromptValue("");
    setToggleValues({ ...EMPTY_TOGGLES });
    setFocusIndex(0);
  };

  const submit = () => {
    if (!textValues.branch.trim()) return;
    onSubmit({
      branch: textValues.branch.trim(),
      base: textValues.base.trim() || undefined,
      pr: textValues.pr.trim() || undefined,
      profile: textValues.profile.trim() || undefined,
      prompt: promptValue.trim() || undefined,
      existing: toggleValues.existing,
      noIde: toggleValues.noIde,
      noAttach: toggleValues.noAttach,
    });
    reset();
  };

  const moveFocus = (delta: number) => {
    setFocusIndex((focusIndex + delta + fields.length) % fields.length);
  };

  useInput(
    (input, key) => {
      if (!visible) return;
      const currentField = fields[focusIndex];
      if (!currentField) return;

      if (key.escape) {
        onCancel();
        reset();
        return;
      }

      // Ctrl+S submits from any field
      if (input === "s" && key.ctrl) {
        submit();
        return;
      }

      // Submit button handling
      if (currentField.kind === "submit") {
        if (key.return || input === " ") {
          submit();
          return;
        }
        if (key.tab || key.downArrow) {
          moveFocus(1);
          return;
        }
        if (key.upArrow) {
          moveFocus(-1);
          return;
        }
        return;
      }

      // Toggle field handling
      if (currentField.kind === "toggle") {
        if (input === " ") {
          setToggleValues((prev) => ({
            ...prev,
            [currentField.key]: !prev[currentField.key],
          }));
          return;
        }
        if (key.return) {
          moveFocus(1);
          return;
        }
        if (key.tab || key.downArrow) {
          moveFocus(1);
          return;
        }
        if (key.upArrow) {
          moveFocus(-1);
          return;
        }
        return;
      }

      // Textarea field handling (prompt)
      if (currentField.kind === "textarea") {
        if (key.backspace || key.delete) {
          setPromptValue((prev) => prev.slice(0, -1));
          return;
        }
        // Enter adds newline in textarea
        if (key.return) {
          if (key.ctrl || key.meta) {
            // Ctrl+Enter submits from textarea
            submit();
          } else {
            setPromptValue((prev) => `${prev}\n`);
          }
          return;
        }
        if (key.tab) {
          moveFocus(1);
          return;
        }
        if (key.upArrow && key.ctrl) {
          moveFocus(-1);
          return;
        }
        if (input && !key.ctrl && !key.meta) {
          setPromptValue((prev) => prev + input);
        }
        return;
      }

      // Text field handling
      if (key.backspace || key.delete) {
        setTextValues((prev) => ({
          ...prev,
          [currentField.key]: prev[currentField.key].slice(0, -1),
        }));
        return;
      }

      if (key.return) {
        if (focusIndex < fields.length - 1) {
          moveFocus(1);
        } else {
          submit();
        }
        return;
      }

      if (key.tab || key.downArrow) {
        moveFocus(1);
        return;
      }

      if (key.upArrow) {
        moveFocus(-1);
        return;
      }

      if (input && !key.ctrl && !key.meta) {
        setTextValues((prev) => ({
          ...prev,
          [currentField.key]: prev[currentField.key] + input,
        }));
      }
    },
    { isActive: visible },
  );

  return (
    <Modal title="Open Worktree" visible={visible}>
      {fields.map((field, idx) => {
        const isFocused = idx === focusIndex;
        if (field.kind === "submit") {
          return (
            <Box key="submit" marginTop={1}>
              <Text
                bold={isFocused}
                color={isFocused ? "green" : "gray"}
                inverse={isFocused}
              >
                {" Open Worktree "}
              </Text>
            </Box>
          );
        }
        if (field.kind === "toggle") {
          const checked = toggleValues[field.key];
          return (
            <Box key={field.key}>
              <Text color={isFocused ? "cyan" : "gray"}>
                {checked ? "[x]" : "[ ]"} {field.label}
              </Text>
            </Box>
          );
        }
        if (field.kind === "textarea") {
          const lines = promptValue.split("\n");
          return (
            <Box key={field.key} flexDirection="column">
              <Text color={isFocused ? "cyan" : "gray"}>{field.label}:</Text>
              <Box marginLeft={2} flexDirection="column">
                {promptValue ? (
                  lines.map((line, li) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: stable line ordering
                    <Text key={li}>
                      {line}
                      {isFocused && li === lines.length - 1 ? (
                        <Text color="cyan">|</Text>
                      ) : null}
                    </Text>
                  ))
                ) : (
                  <Text>
                    <Text dimColor>{field.placeholder}</Text>
                    {isFocused ? <Text color="cyan">|</Text> : null}
                  </Text>
                )}
              </Box>
            </Box>
          );
        }
        const value = textValues[field.key];
        return (
          <Box key={field.key}>
            <Text color={isFocused ? "cyan" : "gray"}>{field.label}: </Text>
            <Text>
              {value || <Text dimColor>{field.placeholder}</Text>}
              {isFocused ? <Text color="cyan">|</Text> : null}
            </Text>
          </Box>
        );
      })}
      <Text dimColor>Tab/↑↓: navigate | Ctrl+S: submit | Esc: cancel</Text>
    </Modal>
  );
}
