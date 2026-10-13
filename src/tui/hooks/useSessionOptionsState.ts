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
  /* eslint-disable react/exhaustive-deps -- profileKey tracks profileNames by content */
  useEffect(() => {
    if (!enabled) return;
    const nextSelectedProfileValue =
      getInitialSelectedProfileValue(profileNames);
    setSelectedProfileValue(nextSelectedProfileValue);
    setAutoSwitch(true);
  }, [profileKey, enabled]);
  /* eslint-enable react/exhaustive-deps */

  return {
    selectedProfileValue,
    setSelectedProfileValue,
    autoSwitch,
    setAutoSwitch,
  };
}
