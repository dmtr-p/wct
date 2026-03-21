import { Box, Text, useInput } from "ink";
import React, { useState } from "react";
import { Modal } from "./Modal";

interface Props {
  visible: boolean;
  onSubmit: (opts: {
    branch: string;
    base?: string;
    pr?: string;
    profile?: string;
  }) => void;
  onCancel: () => void;
}

type Field = "branch" | "base" | "pr" | "profile";

const FIELDS: { key: Field; label: string; placeholder: string }[] = [
  { key: "branch", label: "Branch", placeholder: "feature/my-branch" },
  { key: "base", label: "Base", placeholder: "(optional)" },
  { key: "pr", label: "PR", placeholder: "(optional) number or URL" },
  { key: "profile", label: "Profile", placeholder: "(optional)" },
];

const EMPTY_VALUES: Record<Field, string> = {
  branch: "",
  base: "",
  pr: "",
  profile: "",
};

export function OpenModal({ visible, onSubmit, onCancel }: Props) {
  const [values, setValues] = useState<Record<Field, string>>({
    ...EMPTY_VALUES,
  });
  const [focusIndex, setFocusIndex] = useState(0);

  useInput(
    (input, key) => {
      if (!visible) return;
      const currentField = FIELDS[focusIndex]!.key;

      if (key.escape) {
        onCancel();
        setValues({ ...EMPTY_VALUES });
        setFocusIndex(0);
        return;
      }

      if (key.backspace || key.delete) {
        setValues((prev) => ({
          ...prev,
          [currentField]: prev[currentField].slice(0, -1),
        }));
        return;
      }

      if (key.return) {
        if (focusIndex < FIELDS.length - 1) {
          setFocusIndex(focusIndex + 1);
        } else if (values.branch.trim()) {
          onSubmit({
            branch: values.branch.trim(),
            base: values.base.trim() || undefined,
            pr: values.pr.trim() || undefined,
            profile: values.profile.trim() || undefined,
          });
          setValues({ ...EMPTY_VALUES });
          setFocusIndex(0);
        }
        return;
      }

      if (key.tab) {
        setFocusIndex((focusIndex + 1) % FIELDS.length);
        return;
      }

      if (input && !key.ctrl && !key.meta) {
        setValues((prev) => ({
          ...prev,
          [currentField]: prev[currentField] + input,
        }));
      }
    },
    { isActive: visible },
  );

  return (
    <Modal title="Open Worktree" visible={visible}>
      {FIELDS.map((field, idx) => (
        <Box key={field.key}>
          <Text color={idx === focusIndex ? "cyan" : "gray"}>
            {field.label}:{" "}
          </Text>
          <Text>
            {values[field.key] || <Text dimColor>{field.placeholder}</Text>}
            {idx === focusIndex ? <Text color="cyan">|</Text> : null}
          </Text>
        </Box>
      ))}
      <Text dimColor>Tab: next field | Enter: submit | Esc: cancel</Text>
    </Modal>
  );
}
