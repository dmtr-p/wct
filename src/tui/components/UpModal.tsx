import { Box, Text } from "ink";
import { useEffect, useMemo, useState } from "react";
import { useGuardedInput } from "../hooks/useGuardedInput";
import {
  type SessionIdeDefaults,
  useSessionOptionsState,
} from "../hooks/useSessionOptionsState";
import { isSubmitShortcut } from "./form-controls";
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
  ideDefaults?: SessionIdeDefaults;
  onSubmit: (result: UpModalResult) => void;
  onCancel: () => void;
}

type UpModalField = "profile" | "noIde" | "autoSwitch" | "submit";

function clampFocusIndex(index: number, fields: readonly UpModalField[]) {
  if (fields.length === 0) return 0;
  return Math.max(0, Math.min(index, fields.length - 1));
}

export function UpModal({
  visible,
  width,
  profileNames,
  ideDefaults,
  onSubmit,
  onCancel,
}: UpModalProps) {
  const [focusIndex, setFocusIndex] = useState(0);
  const {
    selectedProfileValue,
    setSelectedProfileValue,
    noIde,
    setNoIde,
    autoSwitch,
    setAutoSwitch,
  } = useSessionOptionsState(profileNames, visible, ideDefaults);

  const fields = useMemo<UpModalField[]>(() => {
    const nextFields: UpModalField[] = [];
    if (profileNames.length > 0) nextFields.push("profile");
    nextFields.push("noIde", "autoSwitch", "submit");
    return nextFields;
  }, [profileNames.length]);

  const clampedFocusIndex = clampFocusIndex(focusIndex, fields);
  const currentField = fields[clampedFocusIndex] ?? null;
  const submission = useMemo(
    () => resolveSessionOptionsSubmitState(profileNames, selectedProfileValue),
    [profileNames, selectedProfileValue],
  );

  const doSubmit = () => {
    if (!submission.canSubmit) return;
    onSubmit({
      profile: submission.profile,
      noIde,
      autoSwitch,
    });
  };

  useEffect(() => {
    setFocusIndex((prev) => clampFocusIndex(prev, fields));
  }, [fields]);

  useEffect(() => {
    if (visible) setFocusIndex(0);
  }, [visible]);

  useGuardedInput(
    (_input, key) => {
      if (key.escape) {
        onCancel();
        return;
      }
      if (isSubmitShortcut(key)) {
        doSubmit();
        return;
      }
      if (key.tab) {
        setFocusIndex(
          (prev) =>
            (clampFocusIndex(prev, fields) +
              (key.shift ? -1 : 1) +
              fields.length) %
            fields.length,
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
          onSubmit={doSubmit}
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
