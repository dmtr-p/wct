import { useCallback, useLayoutEffect, useRef, useState } from "react";
import {
  effectiveTreeScrollOffset,
  initialTreeNavigationState,
  type TreeNavigationIntent,
  type TreeNavigationSnapshot,
  transitionTreeNavigation,
} from "../tree-navigation";

/** The getter closes over the committed layout, including the footer height
 * derived from the selected item. It is read when an input is dispatched and
 * once after each commit, never while the tree is still being built. */
export function useTreeNavigation(getSnapshot: () => TreeNavigationSnapshot) {
  const [state, setState] = useState(initialTreeNavigationState);
  const snapshotRef = useRef(getSnapshot);
  snapshotRef.current = getSnapshot;

  const dispatch = useCallback((intent: TreeNavigationIntent) => {
    const snapshot = snapshotRef.current();
    setState((previous) =>
      transitionTreeNavigation(previous, snapshot, intent),
    );
  }, []);

  useLayoutEffect(() => {
    dispatch({ type: "reconcile" });
  });

  return {
    selectedIndex: state.selectedIndex,
    effectiveScrollOffset: (snapshot: TreeNavigationSnapshot) =>
      effectiveTreeScrollOffset(state, snapshot),
    dispatch,
  };
}
