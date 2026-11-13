import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import { JsonFlag } from "../cli/json-flag";
import { commandError } from "../errors";
import {
  makeRepositoryCoordinationService,
  repositoryMutationTarget,
} from "../services/repository-mutation";
import { canonicalSessionPath } from "../services/session-identity";
import { WorkspaceCoordinationService } from "../services/workspace-coordination";
import { WorktreeService } from "../services/worktree-service";
import { jsonSuccess } from "../utils/json-output";
import * as logger from "../utils/logger";

export interface OperationTargetOptions {
  branch: string;
  repo?: string;
}
export interface ReconcileOptions extends OperationTargetOptions {
  operation?: string;
  generation?: string;
  reason?: string;
  acknowledgeUncertainSideEffects: boolean;
}

function resolveOperationTarget(options: OperationTargetOptions) {
  return Effect.gen(function* () {
    const main = yield* WorktreeService.use((service) =>
      service.getMainRepoPath(options.repo),
    );
    if (!main)
      return yield* commandError(
        "not_git_repo",
        "Cannot resolve Main Repository; use --repo <path>",
      );
    const mainRepoPath = yield* canonicalSessionPath(main).pipe(
      Effect.mapError((error) =>
        commandError(
          "worktree_error",
          "Cannot canonicalize Main Repository",
          error,
        ),
      ),
    );
    return { mainRepoPath, branch: options.branch };
  });
}

export function inspectOperationCommand(
  options: OperationTargetOptions,
  repository = false,
) {
  return Effect.gen(function* () {
    const target = yield* repository
      ? repositoryMutationTarget(options.repo)
      : resolveOperationTarget(options);
    const coordination = yield* repository
      ? makeRepositoryCoordinationService()
      : WorkspaceCoordinationService;
    const status = yield* coordination.inspect(target);
    if (yield* JsonFlag) return yield* jsonSuccess({ target, ...status });
    yield* logger.info(
      `${repository ? "Repository mutation" : `Workspace '${target.branch}'`} in '${target.mainRepoPath}': ${status.status}`,
    );
    if (status.status !== "available" && status.reservation) {
      const owner = status.reservation;
      yield* logger.info(
        `Operation: ${owner.operationId}\nGeneration: ${owner.generation}\nPhase: ${owner.phase}\nOwner PID: ${owner.owner.pid}`,
      );
    }
    if (status.status === "outcome-unknown")
      yield* logger.info(
        `Inspect potentially surviving ${repository ? "Git mutations and partial config/worktree intent" : "setup/down work"}, then use wct operations ${repository ? "reconcile-repository" : "reconcile"} with --operation, --generation, --acknowledge-uncertain-side-effects and --reason. Reconciliation never replays commands.`,
      );
  });
}

export function reconcileOperationCommand(
  options: ReconcileOptions,
  repository = false,
) {
  return Effect.gen(function* () {
    if (
      !options.operation?.trim() ||
      !options.generation?.trim() ||
      !options.reason?.trim() ||
      !options.acknowledgeUncertainSideEffects
    )
      return yield* commandError(
        "invalid_options",
        "Reconciliation requires --operation, --generation, --acknowledge-uncertain-side-effects and a nonempty --reason after inspection",
      );
    const reason = options.reason;
    const target = yield* repository
      ? repositoryMutationTarget(options.repo)
      : resolveOperationTarget(options);
    const coordination = yield* repository
      ? makeRepositoryCoordinationService()
      : WorkspaceCoordinationService;
    const expectedOwnership = {
      operationId: options.operation,
      generation: options.generation,
    };
    yield* coordination.reconcile(target, {
      expectedOwnership,
      acknowledgeUncertainSideEffects: true,
      resolution: "release-after-inspection",
      requestId: randomUUID(),
      reason,
    });
    if (yield* JsonFlag)
      return yield* jsonSuccess({
        target,
        status: "reconciled",
        expectedOwnership,
      });
    yield* logger.success(
      `Reconciled operation ${expectedOwnership.operationId}, generation ${expectedOwnership.generation}; ${repository ? `Repository mutation custody in '${target.mainRepoPath}'` : `Workspace '${target.branch}'`} is available`,
    );
  });
}
