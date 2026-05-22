Status: done

# Introduce WorkspaceService for up and down

## Parent

.scratch/workspace-service/PRD.md

## What to build

Introduce the Workspace lifecycle module and prove it on the smaller `up` and `down` paths. The service should expose typed, JSON-safe results, warnings, attempts, and semantic reporter events while remaining output-format agnostic.

This slice migrates CLI `up` and `down` to the new service, including shared target resolution and current behavior preservation.

## Acceptance criteria

- [x] A Workspace lifecycle service exists with public `up` and `down` operations.
- [x] Workspace target resolution supports current directory, explicit path, and branch lookup.
- [x] Command-layer target-resolution helper is no longer needed by `up` and `down`.
- [x] `up` resolves an existing worktree, config, profile, IDE launch, env, and session name.
- [x] `up` starts tmux and opens IDE in parallel when both are configured.
- [x] `up` does not run copy or setup.
- [x] `up` treats an already-existing tmux session as a successful outcome.
- [x] `up` treats tmux and IDE launch failures as non-fatal typed warnings/failed attempts.
- [x] `down` kills an existing tmux session.
- [x] `down` treats an absent tmux session as informational success, not warning or failure.
- [x] `down` treats tmux kill failure as fatal.
- [x] Reporter events are typed, semantic, operation-tagged, JSON-safe, delivered in order, and best-effort.
- [x] CLI `up` and `down` use the service and keep human behavior materially compatible.
- [x] JSON output emits final results only, not reporter event history.
- [x] Tests cover `up`, `down`, reporter behavior, JSON-safe result shape, and target resolution.

## Blocked by

- .scratch/workspace-service/issues/01-define-workspace-and-registration-outcomes.md
