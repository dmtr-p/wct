import type { ListItem } from "./ScrollableList";

export interface SessionOptionsSubmitState {
  canSubmit: boolean;
  profile?: string;
}

export interface FilterInputKey {
  ctrl: boolean;
  meta: boolean;
  return: boolean;
  tab?: boolean;
}

export function buildProfileItems(profileNames: string[]): ListItem[] {
  return [
    { label: "(default)", value: "" },
    ...profileNames.map((profileName) => ({
      label: profileName,
      value: profileName,
    })),
  ];
}

export function getInitialSelectedProfileValue(
  profileNames: string[],
): string | undefined {
  return profileNames.length > 0 ? "" : undefined;
}

export function isFilterInputCharacter(
  input: string,
  key: FilterInputKey,
): boolean {
  return Boolean(input) && !key.ctrl && !key.meta && !key.return && !key.tab;
}

export function resolveSelectedProfileValue(
  profileNames: string[],
  filteredProfiles: ListItem[],
  selectedProfileIndex: number,
): string | undefined {
  if (profileNames.length === 0) {
    return undefined;
  }

  return filteredProfiles[selectedProfileIndex]?.value;
}

export function resolveSessionOptionsSubmitState(
  profileNames: string[],
  selectedProfileValue: string | undefined,
): SessionOptionsSubmitState {
  if (profileNames.length === 0) {
    return { canSubmit: true, profile: undefined };
  }

  if (selectedProfileValue === undefined) {
    return { canSubmit: false, profile: undefined };
  }

  return {
    canSubmit: true,
    profile: selectedProfileValue || undefined,
  };
}
