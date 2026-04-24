import { Box, useInput } from "ink";
import { useEffect, useMemo, useState } from "react";
import { ScrollableList, filterItems } from "./ScrollableList";
import { SubmitButton, ToggleRow } from "./form-controls";
import { TitledBox } from "./TitledBox";
import {
  buildProfileItems,
  resolveSelectedProfileValue,
} from "./session-options";

export interface SessionOptionsSectionProps {
  profileNames: string[];
  focusedField: "profile" | "noIde" | "autoSwitch" | "submit" | null;
  noIde: boolean;
  autoSwitch: boolean;
  canSubmit: boolean;
  onNoIdeToggle: () => void;
  onAutoSwitchToggle: () => void;
  onSubmit: () => void;
  onProfileChange: (profile: string | undefined) => void;
  resetKey: string;
  width?: number;
}

export function SessionOptionsSection({
  profileNames,
  focusedField,
  noIde,
  autoSwitch,
  canSubmit,
  onNoIdeToggle,
  onAutoSwitchToggle,
  onSubmit,
  onProfileChange,
  resetKey,
  width,
}: SessionOptionsSectionProps) {
  const [profileQuery, setProfileQuery] = useState("");
  const [selectedProfileIndex, setSelectedProfileIndex] = useState(0);

  const profileItems = useMemo(
    () => buildProfileItems(profileNames),
    [profileNames],
  );
  const filteredProfiles = useMemo(
    () => filterItems(profileItems, profileQuery),
    [profileItems, profileQuery],
  );

  useEffect(() => {
    setProfileQuery("");
    setSelectedProfileIndex(0);
  }, [resetKey]);

  useEffect(() => {
    setSelectedProfileIndex((prev) =>
      filteredProfiles.length === 0
        ? 0
        : Math.min(prev, filteredProfiles.length - 1),
    );
  }, [filteredProfiles.length]);

  useEffect(() => {
    onProfileChange(
      resolveSelectedProfileValue(
        profileNames,
        filteredProfiles,
        selectedProfileIndex,
      ),
    );
  }, [profileNames, filteredProfiles, selectedProfileIndex, onProfileChange]);

  useInput(
    (input, key) => {
      if (key.upArrow) {
        setSelectedProfileIndex((prev) => Math.max(0, prev - 1));
        return;
      }
      if (key.downArrow) {
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
    { isActive: focusedField === "profile" },
  );

  return (
    <Box flexDirection="column">
      {profileNames.length > 0 ? (
        <TitledBox
          title={profileQuery ? `Profile filter: ${profileQuery}` : "Profile"}
          isFocused={focusedField === "profile"}
          width={width}
        >
          <ScrollableList
            items={profileItems}
            selectedIndex={selectedProfileIndex}
            filterQuery={profileQuery}
            isFocused={focusedField === "profile"}
            maxVisible={6}
          />
        </TitledBox>
      ) : null}
      <Box height={1} />
      <ToggleRow
        label="No IDE"
        checked={noIde}
        isFocused={focusedField === "noIde"}
        onToggle={onNoIdeToggle}
      />
      <ToggleRow
        label="Auto-switch"
        checked={autoSwitch}
        isFocused={focusedField === "autoSwitch"}
        onToggle={onAutoSwitchToggle}
      />
      <SubmitButton
        isFocused={focusedField === "submit"}
        disabled={!canSubmit}
        onSubmit={onSubmit}
      />
    </Box>
  );
}
