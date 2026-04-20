// src/tui/hooks/useActionError.ts

import { useCallback, useEffect, useRef, useState } from "react";

export function useActionError() {
  const [actionError, setActionError] = useState<string | null>(null);
  const actionErrorTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );

  const clearActionError = useCallback(() => {
    if (actionErrorTimeoutRef.current) {
      clearTimeout(actionErrorTimeoutRef.current);
      actionErrorTimeoutRef.current = null;
    }
    setActionError(null);
  }, []);

  const showActionError = useCallback((message: string) => {
    if (actionErrorTimeoutRef.current) {
      clearTimeout(actionErrorTimeoutRef.current);
    }
    setActionError(message);
    actionErrorTimeoutRef.current = setTimeout(() => {
      actionErrorTimeoutRef.current = null;
      setActionError(null);
    }, 5000);
  }, []);

  useEffect(
    () => () => {
      if (actionErrorTimeoutRef.current) {
        clearTimeout(actionErrorTimeoutRef.current);
      }
    },
    [],
  );

  return { actionError, showActionError, clearActionError } as const;
}
