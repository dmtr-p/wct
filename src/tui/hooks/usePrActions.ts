import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  fetchMergeSnapshot,
  submitPrMerge,
} from "../../services/pr-merge-service";
import {
  createPrActionsController,
  type PrActionsDependencies,
  prMenuOptions,
  prMenuTitle,
} from "../pr-actions";
import { tuiRuntime } from "../runtime";
import { openPrInBrowser } from "../tree-helpers";
import type { Mode } from "../types";

type PrActionsHookDependencies = Pick<
  PrActionsDependencies,
  | "setMode"
  | "showActionError"
  | "refresh"
  | "refreshAfterCurrent"
  | "setExplicit"
  | "clearExplicit"
> & { mode: Mode };

export function usePrActions(deps: PrActionsHookDependencies) {
  const current = useRef(deps);
  current.current = deps;
  const [controller] = useState(() =>
    createPrActionsController({
      getMode: () => current.current.mode,
      setMode: (mode) => current.current.setMode(mode),
      showActionError: (message) => current.current.showActionError(message),
      refresh: (path) => current.current.refresh(path),
      refreshAfterCurrent: (path) => current.current.refreshAfterCurrent(path),
      setExplicit: (path, branch, pr) =>
        current.current.setExplicit(path, branch, pr),
      clearExplicit: (path, branch) =>
        current.current.clearExplicit(path, branch),
      fetchSnapshot: (path, base, number) =>
        tuiRuntime.runPromise(fetchMergeSnapshot(path, base, number)),
      submitMerge: (path, snapshot, method) =>
        tuiRuntime.runPromise(submitPrMerge(path, snapshot, method)),
      openInBrowser: (path, pr) => openPrInBrowser(path, pr.number, pr.url),
    }),
  );
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
  );
  useEffect(() => controller.invalidate, [controller]);
  return {
    ...state,
    options: prMenuOptions(state.menu),
    title: prMenuTitle(state.menu),
    open: controller.open,
    choose: controller.choose,
    close: controller.close,
  };
}
