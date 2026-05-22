Status: ready-for-agent

# Add WorkspaceService open lifecycle

## Parent

.scratch/workspace-service/PRD.md

## What to build

Move the branch and PR open lifecycle into Workspace. Opening a Workspace should create or reuse the worktree, optionally sync VS Code workspace state, copy configured files, run setup commands, and then start tmux and open the IDE in parallel.

Command-level behavior remains at the command seam: registration after successful open, attach/switch policy, human output, and JSON serialization.

## Acceptance criteria

- [ ] Workspace `open` accepts user-intent input including branch or PR, base, existing, cwd, IDE flags, profile, prompt, and optional reporter.
- [ ] Workspace `open` preserves current option validation ordering and materially preserves error codes/messages.
- [ ] Workspace `open` resolves PR inputs, including GitHub CLI availability, PR number/URL parsing, branch resolution, fork remote handling, fetch, and local branch existence.
- [ ] Workspace `open` creates or reuses the intended worktree.
- [ ] Path conflicts remain fatal.
- [ ] Worktree path and `WCT_PROJECT` continue to use the base loaded config, not profile overrides.
- [ ] `WCT_PROMPT` remains open-only.
- [ ] VS Code workspace state sync remains part of open and failures become typed warnings.
- [ ] Copy remains part of open and copy failure remains fatal.
- [ ] Setup remains part of open and setup failures remain non-fatal typed warnings.
- [ ] Copy/setup still run when the worktree already exists.
- [ ] Tmux and IDE start in parallel after prerequisite work is complete.
- [ ] Tmux and IDE failures remain non-fatal typed warnings/failed attempts.
- [ ] CLI open uses Workspace and registers the project only after successful workspace open.
- [ ] CLI open auto-registration does not rename existing registry rows.
- [ ] CLI open human output is materially compatible and avoids noise for already-registered auto-registration.
- [ ] CLI open JSON emits the final Workspace result plus registration status only.
- [ ] Tests cover branch open, PR open, validation ordering, already-existing worktree, path conflict, copy fatality, setup warnings, VS Code warnings, tmux/IDE non-fatal attempts, registration timing, and JSON output.

## Blocked by

- .scratch/workspace-service/issues/02-introduce-workspace-service-up-down.md

