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

export function useSessionOptionsState(
  profileNames: string[],
  enabled = true,
): SessionOptionsState {
  const [selectedProfileValue, setSelectedProfileValue] = useState<
    string | undefined
  >(() => getInitialSelectedProfileValue(profileNames));
  const [noIde, setNoIde] = useState(false);
  const [autoSwitch, setAutoSwitch] = useState(true);

  const profileKey = JSON.stringify(profileNames);
  // biome-ignore lint/correctness/useExhaustiveDependencies: profileKey is a content-derived stable identity for profileNames
  useEffect(() => {
    if (!enabled) return;
    setSelectedProfileValue(getInitialSelectedProfileValue(profileNames));
    setNoIde(false);
    setAutoSwitch(true);
  }, [profileKey, enabled]);

  return {
    selectedProfileValue,
    setSelectedProfileValue,
    noIde,
    setNoIde,
    autoSwitch,
    setAutoSwitch,
  };
}
