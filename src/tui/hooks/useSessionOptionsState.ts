import { type Dispatch, type SetStateAction, useEffect, useState } from "react";
import { getInitialSelectedProfileValue } from "../components/session-options";

export interface SessionOptionsState {
  selectedProfileValue: string | undefined;
  setSelectedProfileValue: Dispatch<SetStateAction<string | undefined>>;
  autoSwitch: boolean;
  setAutoSwitch: Dispatch<SetStateAction<boolean>>;
}

export function useSessionOptionsState(
  profileNames: string[],
  enabled = true,
): SessionOptionsState {
  const initialProfile = getInitialSelectedProfileValue(profileNames);
  const [selectedProfileValue, setSelectedProfileValue] = useState<
    string | undefined
  >(() => initialProfile);
  const [autoSwitch, setAutoSwitch] = useState(true);

  const profileKey = JSON.stringify(profileNames);
  // biome-ignore lint/correctness/useExhaustiveDependencies: profileKey is content-derived; default-only changes are handled below
  useEffect(() => {
    if (!enabled) return;
    const nextSelectedProfileValue =
      getInitialSelectedProfileValue(profileNames);
    setSelectedProfileValue(nextSelectedProfileValue);
    setAutoSwitch(true);
  }, [profileKey, enabled]);

  return {
    selectedProfileValue,
    setSelectedProfileValue,
    autoSwitch,
    setAutoSwitch,
  };
}
