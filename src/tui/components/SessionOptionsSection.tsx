import { Box } from "ink";
import { useEffect, useMemo, useState } from "react";
import { useGuardedInput } from "../hooks/useGuardedInput";
import { SubmitButton, ToggleRow } from "./form-controls";
import { MouseClickable } from "./MouseClickable";
import { filterItems, ScrollableList } from "./ScrollableList";
import {
  buildProfileItems,
  clampSelectedProfileIndex,
  getNextSelectedProfileIndex,
  isFilterInputCharacter,
  resolveSelectedProfileValue,
} from "./session-options";
import { TitledBox } from "./TitledBox";

export interface SessionOptionsSectionProps {
  profileNames: string[];
  focusedField: "profile" | "autoSwitch" | "submit" | null;
  autoSwitch: boolean;
  canSubmit: boolean;
  onAutoSwitchToggle: () => void;
  onSubmit: () => void;
  onProfileChange: (profile: string | undefined) => void;
  onFocusField: (field: "profile" | "autoSwitch" | "submit") => void;
  resetKey: string;
  width?: number;
}

export function SessionOptionsSection({
  profileNames,
  focusedField,
  autoSwitch,
  canSubmit,
  onAutoSwitchToggle,
  onSubmit,
  onProfileChange,
  onFocusField,
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

  // biome-ignore lint/correctness/useExhaustiveDependencies: resetKey is an intentional reset trigger, not read in the body
  useEffect(() => {
    setProfileQuery("");
    setSelectedProfileIndex(0);
  }, [resetKey]);

  useEffect(() => {
    setSelectedProfileIndex((prev) =>
      clampSelectedProfileIndex(prev, filteredProfiles.length),
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

  useGuardedInput(
    (input, key) => {
      if (key.upArrow) {
        setSelectedProfileIndex((prev) =>
          getNextSelectedProfileIndex(prev, filteredProfiles.length, "up"),
        );
        return;
      }
      if (key.downArrow) {
        setSelectedProfileIndex((prev) =>
          getNextSelectedProfileIndex(prev, filteredProfiles.length, "down"),
        );
        return;
      }
      if (key.backspace) {
        setProfileQuery((prev) => prev.slice(0, -1));
        return;
      }
      if (isFilterInputCharacter(input, key)) {
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
          footer={
            filteredProfiles.length > 0
              ? `${selectedProfileIndex + 1} of ${filteredProfiles.length}`
              : "0 of 0"
          }
          isFocused={focusedField === "profile"}
          width={width}
        >
          <ScrollableList
            items={profileItems}
            selectedIndex={selectedProfileIndex}
            filterQuery={profileQuery}
            isFocused={focusedField === "profile"}
            maxVisible={5}
            onSelect={(index) => {
              onFocusField("profile");
              setSelectedProfileIndex(index);
            }}
          />
        </TitledBox>
      ) : null}
      <Box height={1} />
      <MouseClickable
        onClick={() => {
          onFocusField("autoSwitch");
          onAutoSwitchToggle();
        }}
      >
        {(isHovered) => (
          <ToggleRow
            label="Auto-switch"
            checked={autoSwitch}
            isFocused={focusedField === "autoSwitch"}
            onToggle={onAutoSwitchToggle}
            isHovered={isHovered}
          />
        )}
      </MouseClickable>
      <MouseClickable onClick={() => onFocusField("submit")}>
        <SubmitButton
          isFocused={focusedField === "submit"}
          disabled={!canSubmit}
          onSubmit={onSubmit}
        />
      </MouseClickable>
    </Box>
  );
}
