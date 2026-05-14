import { type Dispatch, type SetStateAction, useEffect, useState } from "react";
import { getInitialSelectedProfileValue } from "../components/session-options";

export interface SessionOptionsState {
  selectedProfileValue: string | undefined;
  setSelectedProfileValue: Dispatch<SetStateAction<string | undefined>>;
  noIde: boolean;
  setNoIde: Dispatch<SetStateAction<boolean>>;
  autoSwitch: boolean;
  setAutoSwitch: Dispatch<SetStateAction<boolean>>;
}

export interface SessionIdeDefaults {
  baseNoIde: boolean;
  profileNoIde: Record<string, boolean>;
}

const DEFAULT_SESSION_IDE_DEFAULTS: SessionIdeDefaults = {
  baseNoIde: false,
  profileNoIde: {},
};

export function resolveNoIdeDefault(opts: {
  selectedProfileValue: string | undefined;
  baseNoIde: boolean;
  profileNoIde: Record<string, boolean>;
}): boolean {
  if (
    opts.selectedProfileValue &&
    opts.selectedProfileValue in opts.profileNoIde
  ) {
    return opts.profileNoIde[opts.selectedProfileValue] ?? opts.baseNoIde;
  }
  return opts.baseNoIde;
}

export function useSessionOptionsState(
  profileNames: string[],
  enabled = true,
  ideDefaults = DEFAULT_SESSION_IDE_DEFAULTS,
): SessionOptionsState {
  const initialProfile = getInitialSelectedProfileValue(profileNames);
  const [selectedProfileValue, setSelectedProfileValue] = useState<
    string | undefined
  >(() => initialProfile);
  const [noIde, setNoIde] = useState(() =>
    resolveNoIdeDefault({
      selectedProfileValue: initialProfile,
      baseNoIde: ideDefaults.baseNoIde,
      profileNoIde: ideDefaults.profileNoIde,
    }),
  );
  const [autoSwitch, setAutoSwitch] = useState(true);

  const profileKey = JSON.stringify(profileNames);
  const ideDefaultsKey = JSON.stringify(ideDefaults);
  // biome-ignore lint/correctness/useExhaustiveDependencies: profileKey is content-derived; default-only changes are handled below
  useEffect(() => {
    if (!enabled) return;
    const nextSelectedProfileValue =
      getInitialSelectedProfileValue(profileNames);
    setSelectedProfileValue(nextSelectedProfileValue);
    setNoIde(
      resolveNoIdeDefault({
        selectedProfileValue: nextSelectedProfileValue,
        baseNoIde: ideDefaults.baseNoIde,
        profileNoIde: ideDefaults.profileNoIde,
      }),
    );
    setAutoSwitch(true);
  }, [profileKey, enabled]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: ideDefaultsKey is a content-derived dependency key for ideDefaults
  useEffect(() => {
    if (!enabled) return;
    setNoIde(
      resolveNoIdeDefault({
        selectedProfileValue,
        baseNoIde: ideDefaults.baseNoIde,
        profileNoIde: ideDefaults.profileNoIde,
      }),
    );
  }, [selectedProfileValue, ideDefaultsKey, enabled]);

  return {
    selectedProfileValue,
    setSelectedProfileValue,
    noIde,
    setNoIde,
    autoSwitch,
    setAutoSwitch,
  };
}
