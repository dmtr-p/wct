import {
  MERGE_METHODS,
  mergeEligibility,
  type MergeMethod,
  type MergeSnapshot,
  mergeSnapshotFingerprint,
} from "../services/pr-merge-service";
import type { PrFacts } from "../services/pr-model";
import type { PrMenuOption } from "./components/PrActionsModal";
import { candidatePrLabel } from "./pr-status";
import { Mode } from "./types";

interface WorkspaceTarget {
  repoPath: string;
  branch: string;
  candidates: PrFacts[];
  explicit: boolean;
}

export type PrActionTarget = WorkspaceTarget &
  (
    | { kind: "pr"; pr: PrFacts }
    | { kind: "candidate"; pr: PrFacts }
    | { kind: "group" }
  );
type AssociatedTarget = Extract<PrActionTarget, { kind: "pr" }>;

export type MergeCheck =
  | { status: "refreshing" }
  | { status: "ready"; snapshot: MergeSnapshot }
  | { status: "error"; reason: string };

interface DirectMerge {
  route: "direct";
  snapshot: MergeSnapshot;
  methods: MergeMethod[];
}
type MergeChoice =
  | { route: "direct"; snapshot: MergeSnapshot; method: MergeMethod }
  | { route: "queue"; snapshot: MergeSnapshot };

export type PrMenuState =
  | ({ screen: "actions"; notice?: string } & (
      | { target: AssociatedTarget; mergeCheck: MergeCheck }
      | { target: Exclude<PrActionTarget, AssociatedTarget> }
    ))
  | { screen: "choose"; target: PrActionTarget }
  | { screen: "methods"; target: AssociatedTarget; merge: DirectMerge }
  | ({ screen: "confirm"; target: AssociatedTarget } & MergeChoice)
  | { screen: "submitting"; target: AssociatedTarget };

export interface PrActionsDependencies {
  getMode: () => Mode;
  setMode: (mode: Mode) => void;
  showActionError: (message: string) => void;
  fetchSnapshot: (
    repoPath: string,
    baseRepository: string,
    number: number,
  ) => Promise<MergeSnapshot>;
  submitMerge: (
    repoPath: string,
    snapshot: MergeSnapshot,
    method?: MergeMethod,
  ) => Promise<"merged" | "queued">;
  refresh: (repoPath: string) => Promise<void>;
  refreshAfterCurrent: (repoPath: string) => Promise<void>;
  setExplicit: (repoPath: string, branch: string, pr: PrFacts) => Promise<void>;
  clearExplicit: (repoPath: string, branch: string) => Promise<void>;
  openInBrowser: (repoPath: string, pr: PrFacts) => void;
}

interface PrActionsState {
  menu: PrMenuState | null;
  outcome: string | null;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function prMenuTitle(menu: PrMenuState | null): string {
  switch (menu?.screen) {
    case "choose":
      return "Choose PR";
    case "methods":
      return "Merge method";
    case "confirm":
      return menu.route === "queue"
        ? "Confirm queue submission"
        : "Confirm merge";
    case undefined:
    case "actions":
    case "submitting":
      return "PR actions";
  }
}

export function prMenuOptions(menu: PrMenuState | null): PrMenuOption[] {
  if (!menu) return [];
  const { target } = menu;
  switch (menu.screen) {
    case "choose":
      return target.candidates.map((candidate) => ({
        id: `use:${candidate.number}`,
        label: candidatePrLabel(candidate),
      }));
    case "submitting":
      return [{ id: "submitting", label: "Submitting…", disabled: true }];
    case "methods":
      return menu.merge.methods.map((method) => ({
        id: `method:${method}`,
        label: `${MERGE_METHODS[method].label} — ${MERGE_METHODS[method].explanation}`,
      }));
    case "confirm": {
      const { pr } = menu.snapshot;
      return [
        { id: "summary", label: `#${pr.number} ${pr.title}`, disabled: true },
        {
          id: "target",
          label: `${pr.headRefName} → ${pr.baseRefName ?? "unknown target"}`,
          disabled: true,
        },
        {
          id: "method",
          label:
            menu.route === "queue"
              ? "Repository merge queue controls the method"
              : `Method: ${MERGE_METHODS[menu.method].label}`,
          disabled: true,
        },
        {
          id: "confirm",
          label:
            menu.route === "queue"
              ? "Confirm: Add to merge queue"
              : "Confirm: Merge now",
        },
        { id: "cancel", label: "Cancel" },
      ];
    }
    case "actions": {
      const options: PrMenuOption[] = [
        ...(target.kind === "group" || target.explicit
          ? [
              {
                id: "choose",
                label: target.explicit ? "Change PR…" : "Choose PR…",
              },
            ]
          : []),
        ...(target.kind === "candidate"
          ? [
              {
                id: "use",
                label: `Use #${target.pr.number} for this Workspace`,
              },
            ]
          : []),
        ...(target.kind !== "group"
          ? [{ id: "open", label: "Open in GitHub" }]
          : []),
        { id: "refresh", label: "Refresh" },
        ...(target.explicit
          ? [{ id: "clear", label: "Clear association" }]
          : []),
      ];
      if ("mergeCheck" in menu) {
        const check = menu.mergeCheck;
        switch (check.status) {
          case "refreshing":
            options.push({
              id: "refreshing",
              label: "refreshing…",
              disabled: true,
            });
            break;
          case "error":
            options.push({
              id: "unavailable",
              label: `Merge unavailable: ${check.reason}`,
              disabled: true,
            });
            break;
          case "ready": {
            const eligibility = mergeEligibility(check.snapshot);
            if (eligibility.route === "direct")
              options.push({ id: "merge", label: "Merge…" });
            else if (eligibility.route === "queue")
              options.push({ id: "queue", label: "Add to merge queue…" });
            else if (eligibility.route === "unavailable")
              options.push({
                id: "unavailable",
                label: `Merge unavailable: ${eligibility.reason}`,
                disabled: true,
              });
            break;
          }
        }
      }
      if (menu.notice)
        options.push({ id: "notice", label: menu.notice, disabled: true });
      return options;
    }
  }
}

export function createPrActionsController(deps: PrActionsDependencies) {
  let state: PrActionsState = { menu: null, outcome: null };
  let returnMode = Mode.Navigate;
  let request = 0;
  const listeners = new Set<() => void>();
  const update = (next: PrActionsState) => {
    state = next;
    for (const listener of listeners) listener();
  };
  const setMenu = (menu: PrMenuState | null) => update({ ...state, menu });
  const invalidate = () => {
    request++;
  };
  const close = () => {
    if (!state.menu || state.menu.screen === "submitting") return;
    invalidate();
    setMenu(null);
    deps.setMode(returnMode);
  };

  const loadSnapshot = async (target: AssociatedTarget, token: number) => {
    try {
      const snapshot = await deps.fetchSnapshot(
        target.repoPath,
        target.pr.baseRepository,
        target.pr.number,
      );
      if (request !== token || state.menu?.screen !== "actions") return;
      setMenu({
        screen: "actions",
        target,
        mergeCheck: { status: "ready", snapshot },
      });
    } catch (error) {
      if (request !== token || state.menu?.screen !== "actions") return;
      setMenu({
        screen: "actions",
        target,
        mergeCheck: { status: "error", reason: errorMessage(error) },
      });
    }
  };

  const prepareConfirmation = async (
    target: AssociatedTarget,
    choice: MergeChoice,
  ) => {
    const token = ++request;
    setMenu({
      screen: "actions",
      target,
      mergeCheck: { status: "refreshing" },
    });
    try {
      const fresh = await deps.fetchSnapshot(
        target.repoPath,
        choice.snapshot.pr.baseRepository,
        choice.snapshot.pr.number,
      );
      if (request !== token) return;
      const eligibility = mergeEligibility(fresh);
      const changed =
        mergeSnapshotFingerprint(fresh) !==
          mergeSnapshotFingerprint(choice.snapshot) ||
        eligibility.route !== choice.route ||
        (choice.route === "direct" &&
          eligibility.route === "direct" &&
          !eligibility.methods.includes(choice.method));
      if (changed) {
        setMenu({
          screen: "actions",
          target,
          mergeCheck: { status: "ready", snapshot: fresh },
          notice: "PR eligibility or routing changed; choose the action again",
        });
        void deps.refreshAfterCurrent(target.repoPath);
      } else {
        setMenu({ screen: "confirm", target, ...choice, snapshot: fresh });
      }
    } catch (error) {
      if (request !== token) return;
      setMenu({
        screen: "actions",
        target,
        mergeCheck: { status: "error", reason: errorMessage(error) },
      });
    }
  };

  const submit = async (menu: Extract<PrMenuState, { screen: "confirm" }>) => {
    const token = ++request;
    // Publish synchronously so input arriving before React renders cannot resubmit or dismiss.
    setMenu({ screen: "submitting", target: menu.target });
    try {
      const result = await deps.submitMerge(
        menu.target.repoPath,
        menu.snapshot,
        menu.route === "direct" ? menu.method : undefined,
      );
      if (request === token)
        update({
          menu: null,
          outcome: `PR #${menu.snapshot.pr.number} ${result}`,
        });
    } catch (error) {
      if (request === token) {
        setMenu(null);
        deps.showActionError(errorMessage(error));
      }
    } finally {
      if (request === token) {
        invalidate();
        deps.setMode(returnMode);
      }
      void deps.refreshAfterCurrent(menu.target.repoPath);
    }
  };

  return {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    invalidate,
    close,
    open: (target: PrActionTarget) => {
      if (state.menu?.screen === "submitting") return;
      if (!state.menu) returnMode = deps.getMode();
      const token = ++request;
      const menu: PrMenuState =
        target.kind === "pr"
          ? { screen: "actions", target, mergeCheck: { status: "refreshing" } }
          : { screen: "actions", target };
      update({ menu, outcome: null });
      deps.setMode(Mode.PrMenu);
      if (target.kind === "pr") void loadSnapshot(target, token);
    },
    choose: (id: string) => {
      const menu = state.menu;
      if (!menu || menu.screen === "submitting") return;
      if (id === "cancel") {
        close();
        return;
      }
      if (
        !prMenuOptions(menu).some(
          (option) => option.id === id && !option.disabled,
        )
      )
        return;
      const { target } = menu;
      if (menu.screen === "confirm") {
        void submit(menu);
        return;
      }
      if (menu.screen === "methods") {
        const method = menu.merge.methods.find(
          (method) => `method:${method}` === id,
        );
        if (method)
          void prepareConfirmation(menu.target, {
            route: "direct",
            snapshot: menu.merge.snapshot,
            method,
          });
        return;
      }
      if (
        menu.screen === "actions" &&
        "mergeCheck" in menu &&
        menu.mergeCheck.status === "ready"
      ) {
        const snapshot = menu.mergeCheck.snapshot;
        const eligibility = mergeEligibility(snapshot);
        if (id === "merge" && eligibility.route === "direct") {
          const [method] = eligibility.methods;
          if (method && eligibility.methods.length === 1)
            void prepareConfirmation(menu.target, {
              route: "direct",
              snapshot,
              method,
            });
          else
            setMenu({
              screen: "methods",
              target: menu.target,
              merge: {
                route: "direct",
                snapshot,
                methods: eligibility.methods,
              },
            });
          return;
        }
        if (id === "queue" && eligibility.route === "queue") {
          void prepareConfirmation(menu.target, { route: "queue", snapshot });
          return;
        }
      }
      if (id === "choose") {
        invalidate();
        setMenu({ screen: "choose", target });
      } else if (id === "open" && target.kind !== "group") {
        deps.openInBrowser(target.repoPath, target.pr);
        close();
      } else if (id === "refresh") {
        void deps.refresh(target.repoPath);
        close();
      } else if (id === "clear") {
        void deps
          .clearExplicit(target.repoPath, target.branch)
          .catch((error) => deps.showActionError(String(error)));
        close();
      } else {
        const selected =
          id === "use" && target.kind === "candidate"
            ? target.pr
            : target.candidates.find((pr) => `use:${pr.number}` === id);
        if (selected) {
          void deps
            .setExplicit(target.repoPath, target.branch, selected)
            .catch((error) => deps.showActionError(String(error)));
          close();
        }
      }
    },
  };
}
