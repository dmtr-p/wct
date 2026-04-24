import { Box, Text, useInput } from "ink";
import { useEffect, useMemo, useState } from "react";
import { Modal } from "./Modal";
import { SessionOptionsSection } from "./SessionOptionsSection";
import { resolveSessionOptionsSubmitState } from "./session-options";

export interface UpModalResult {
  profile?: string;
  noIde: boolean;
  autoSwitch: boolean;
}

export interface UpModalProps {
  visible: boolean;
  width?: number;
  profileNames: string[];
  onSubmit: (result: UpModalResult) => void;
  onCancel: () => void;
}

type UpModalField = "profile" | "noIde" | "autoSwitch" | "submit";

export function UpModal({
  visible,
  width,
  profileNames,
  onSubmit,
  onCancel,
}: UpModalProps) {
  const [focusIndex, setFocusIndex] = useState(0);
  const [selectedProfileValue, setSelectedProfileValue] = useState<
    string | undefined
  >(undefined);
  const [noIde, setNoIde] = useState(false);
  const [autoSwitch, setAutoSwitch] = useState(true);

  const fields = useMemo<UpModalField[]>(() => {
    const nextFields: UpModalField[] = [];
    if (profileNames.length > 0) nextFields.push("profile");
    nextFields.push("noIde", "autoSwitch", "submit");
    return nextFields;
  }, [profileNames.length]);

  const currentField = fields[focusIndex] ?? null;
  const submission = useMemo(
    () => resolveSessionOptionsSubmitState(profileNames, selectedProfileValue),
    [profileNames, selectedProfileValue],
  );

  useEffect(() => {
    if (!visible) return;
    setFocusIndex(0);
    setSelectedProfileValue(undefined);
    setNoIde(false);
    setAutoSwitch(true);
  }, [visible]);

  useInput(
    (_input, key) => {
      if (key.escape) {
        onCancel();
        return;
      }
      if (key.tab) {
        setFocusIndex(
          (prev) =>
            (prev + (key.shift ? -1 : 1) + fields.length) % fields.length,
        );
      }
    },
    { isActive: visible },
  );

  return (
    <Modal title="wct up" visible={visible} width={width}>
      <Box flexDirection="column">
        <Text dimColor>Start worktree session</Text>
        <Box height={1} />
        <SessionOptionsSection
          profileNames={profileNames}
          focusedField={currentField}
          noIde={noIde}
          autoSwitch={autoSwitch}
          canSubmit={submission.canSubmit}
          onNoIdeToggle={() => setNoIde((prev) => !prev)}
          onAutoSwitchToggle={() => setAutoSwitch((prev) => !prev)}
          onSubmit={() => {
            if (!submission.canSubmit) return;
            onSubmit({
              profile: submission.profile,
              noIde,
              autoSwitch,
            });
          }}
          onProfileChange={setSelectedProfileValue}
          resetKey={visible ? "visible" : "hidden"}
          width={width ? width - 2 : undefined}
        />
        <Box height={1} />
        <Text dimColor>{"tab:next  shift+tab:prev  esc:cancel"}</Text>
      </Box>
    </Modal>
  );
}
