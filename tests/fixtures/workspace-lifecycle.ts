import type { EventEmitter } from "node:events";
import { Effect } from "effect";
import { runBunPromise } from "../../src/effect/runtime";
import type { WctError } from "../../src/errors";
import {
  type WorkspaceCloseResult,
  type WorkspaceDownResult,
  type WorkspaceOpenResult,
  WorkspaceService,
} from "../../src/services/workspace-service";
import {
  createLifecycleClaims,
  type LifecycleState,
  runLifecycleOperation,
} from "../../src/tui/lifecycle";
import { withTestServices } from "../helpers/services";

const args = JSON.parse(process.argv[2] ?? "{}") as {
  repo: string;
  path: string;
  branch: string;
  operation?: "down" | "close" | "retry" | "open";
  gap?: string;
  previous?: WorkspaceCloseResult;
};
const claims = createLifecycleClaims();
let state: LifecycleState = new Map();
const events: EventEmitter = process;
events.on("message", (message: unknown) => {
  if (message === "cancel") claims.cancelWait?.(args.repo, args.branch);
});
await runLifecycleOperation({
  claims,
  entry: {
    operation:
      args.operation === "open"
        ? "open"
        : args.operation === "close" || args.operation === "retry"
          ? "close"
          : "down",
    repoPath: args.repo,
    project: "fixture",
    branch: args.branch,
    phase: { _tag: "Preparing" },
  },
  setLifecycle: (update) => {
    state = typeof update === "function" ? update(state) : update;
    const entry = state.values().next().value;
    process.send?.({ _tag: "Phase", phase: entry?.phase._tag ?? "Idle" });
  },
  showActionError: (message) => process.send?.({ _tag: "Error", message }),
  refreshAll: async () => [],
  resultWarnings: (data) => {
    process.send?.({ _tag: "Result", data });
    return [];
  },
  run: (reporter) => {
    const wrapped = {
      ...reporter,
      event: (
        event: import("../../src/services/workspace-service").WorkspaceReporterEvent,
      ) =>
        reporter.event(event).pipe(
          Effect.andThen(
            event._tag === "SetupCommandCompleted" && args.gap
              ? Effect.promise(async () => {
                  process.send?.({ _tag: "Gap" });
                  while (!(await Bun.file(args.gap ?? "").exists()))
                    await Bun.sleep(10);
                })
              : Effect.void,
          ),
        ),
    };
    return runBunPromise(
      withTestServices(
        WorkspaceService.use(
          (
            service,
          ): Effect.Effect<
            WorkspaceCloseResult | WorkspaceDownResult | WorkspaceOpenResult,
            WctError
          > =>
            args.operation === "open"
              ? service.open({
                  branch: args.branch,
                  cwd: args.repo,
                  reporter: wrapped,
                })
              : args.operation === "retry" && args.previous
                ? service.retryCloseRemoval(args.previous, { reporter })
                : args.operation === "close"
                  ? service.close({ path: args.path, cwd: args.repo, reporter })
                  : service.down({ path: args.path, reporter }),
        ),
      ),
    );
  },
});
process.send?.({ _tag: "Finished", active: state.size });
process.disconnect?.();
