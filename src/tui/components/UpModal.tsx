import { Box, Text } from "ink";
import { useMemo } from "react";
import { useFieldFocus } from "../hooks/useFieldFocus";
import { useGuardedInput } from "../hooks/useGuardedInput";
import { useSessionOptionsState } from "../hooks/useSessionOptionsState";
import { isSubmitShortcut } from "./form-controls";
import { Modal } from "./Modal";
import { ModalShortcut } from "./ModalShortcut";
import { resolveSessionOptionsSubmitState } from "./session-options";
import { SessionOptionsSection } from "./SessionOptionsSection";

export interface UpModalResult {
  profile?: string;
  autoSwitch: boolean;
}

export interface UpModalProps {
  visible: boolean;
  width?: number;
  profileNames: string[];
  onSubmit: (result: UpModalResult) => void;
  onCancel: () => void;
}

type UpModalField = "profile" | "autoSwitch" | "submit";

export function UpModal({
  visible,
  width,
  profileNames,
  onSubmit,
  onCancel,
}: UpModalProps) {
  const {
    selectedProfileValue,
    setSelectedProfileValue,
    autoSwitch,
    setAutoSwitch,
  } = useSessionOptionsState(profileNames, visible);

  const fields = useMemo<UpModalField[]>(() => {
    const nextFields: UpModalField[] = [];
    if (profileNames.length > 0) nextFields.push("profile");
    nextFields.push("autoSwitch", "submit");
    return nextFields;
  }, [profileNames.length]);

  const { currentField, focusField, moveFocus } = useFieldFocus(
    fields,
    visible,
  );
  const submission = useMemo(
    () => resolveSessionOptionsSubmitState(profileNames, selectedProfileValue),
    [profileNames, selectedProfileValue],
  );

  const doSubmit = () => {
    if (!submission.canSubmit) return;
    onSubmit({
      profile: submission.profile,
      autoSwitch,
    });
  };

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
        moveFocus(key.shift ? -1 : 1);
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
          autoSwitch={autoSwitch}
          canSubmit={submission.canSubmit}
          onAutoSwitchToggle={() => setAutoSwitch((prev) => !prev)}
          onSubmit={doSubmit}
          onProfileChange={setSelectedProfileValue}
          onFocusField={focusField}
          resetKey={visible ? "visible" : "hidden"}
          width={width ? width - 2 : undefined}
        />
        <Box height={1} />
        <Box>
          <Text dimColor>{"tab:next  shift+tab:prev  "}</Text>
          <ModalShortcut label="esc:close" onClick={onCancel} />
        </Box>
      </Box>
    </Modal>
  );
}
