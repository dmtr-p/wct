import { Box, Text, useInput } from "ink";
import { useEffect, useMemo, useState } from "react";
import { SubmitButton, ToggleRow } from "./form-controls";
import { Modal } from "./Modal";
import { filterItems, type ListItem, ScrollableList } from "./ScrollableList";
import { TitledBox } from "./TitledBox";

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
  const [profileQuery, setProfileQuery] = useState("");
  const [selectedProfileIndex, setSelectedProfileIndex] = useState(0);
  const [focusIndex, setFocusIndex] = useState(0);
  const [noIde, setNoIde] = useState(false);
  const [autoSwitch, setAutoSwitch] = useState(true);

  const profileItems = useMemo<ListItem[]>(
    () => [
      {
        label: "(default)",
        value: "",
      },
      ...profileNames.map((profileName) => ({
        label: profileName,
        value: profileName,
      })),
    ],
    [profileNames],
  );
  const filteredProfiles = useMemo(
    () => filterItems(profileItems, profileQuery),
    [profileItems, profileQuery],
  );
  const fields = useMemo<UpModalField[]>(() => {
    const nextFields: UpModalField[] = [];
    if (profileNames.length > 0) {
      nextFields.push("profile");
    }
    nextFields.push("noIde", "autoSwitch", "submit");
    return nextFields;
  }, [profileNames.length]);
  const currentField = fields[focusIndex];

  useEffect(() => {
    if (!visible) {
      return;
    }

    setProfileQuery("");
    setSelectedProfileIndex(0);
    setFocusIndex(0);
    setNoIde(false);
    setAutoSwitch(true);
  }, [visible]);

  useEffect(() => {
    setSelectedProfileIndex((prev) => {
      if (filteredProfiles.length === 0) {
        return 0;
      }
      return Math.min(prev, filteredProfiles.length - 1);
    });
  }, [filteredProfiles.length]);

  const moveFocus = (delta: number) => {
    setFocusIndex((prev) => (prev + delta + fields.length) % fields.length);
  };

  const submit = () => {
    const selectedProfile =
      profileNames.length > 0
        ? filteredProfiles[selectedProfileIndex]?.value
        : undefined;
    onSubmit({
      profile: selectedProfile || undefined,
      noIde,
      autoSwitch,
    });
  };

  useInput(
    (input, key) => {
      if (key.escape) {
        onCancel();
        return;
      }

      if (key.tab) {
        moveFocus(key.shift ? -1 : 1);
        return;
      }

      if (currentField !== "profile") {
        return;
      }

      if (key.upArrow) {
        setSelectedProfileIndex((prev) => Math.max(0, prev - 1));
        return;
      }

      if (key.downArrow) {
        if (filteredProfiles.length === 0) {
          return;
        }
        setSelectedProfileIndex((prev) =>
          Math.min(filteredProfiles.length - 1, prev + 1),
        );
        return;
      }

      if (key.backspace || key.delete) {
        setProfileQuery((prev) => prev.slice(0, -1));
        return;
      }

      if (input && !key.ctrl && !key.meta && !key.return) {
        setProfileQuery((prev) => prev + input);
      }
    },
    { isActive: visible },
  );

  return (
    <Modal title="wct up" visible={visible} width={width}>
      <Box flexDirection="column">
        <Text dimColor>Start worktree session</Text>
        <Box height={1} />
        {profileNames.length > 0 ? (
          <TitledBox
            title={profileQuery ? `Profile filter: ${profileQuery}` : "Profile"}
            isFocused={currentField === "profile"}
            width={width ? width - 2 : undefined}
          >
            <ScrollableList
              items={profileItems}
              selectedIndex={selectedProfileIndex}
              filterQuery={profileQuery}
              isFocused={currentField === "profile"}
              maxVisible={6}
            />
          </TitledBox>
        ) : (
          <Text dimColor>No profiles configured</Text>
        )}
        <Box height={1} />
        <ToggleRow
          label="No IDE"
          checked={noIde}
          isFocused={currentField === "noIde"}
          onToggle={() => setNoIde((prev) => !prev)}
        />
        <ToggleRow
          label="Auto-switch"
          checked={autoSwitch}
          isFocused={currentField === "autoSwitch"}
          onToggle={() => setAutoSwitch((prev) => !prev)}
        />
        <SubmitButton isFocused={currentField === "submit"} onSubmit={submit} />
        <Box height={1} />
        <Text dimColor>tab:next  shift+tab:prev  esc:cancel</Text>
      </Box>
    </Modal>
  );
}
