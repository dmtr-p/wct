# Workspace Service Lifecycle Refactor

Status: ready-for-agent

## Problem Statement

`wct` manages a worktree lifecycle that spans git worktrees, tmux sessions, IDE launch, VS Code workspace state sync, file copy, setup commands, and derived `WCT_*` environment variables. Today that lifecycle is split across command modules and TUI actions. `open`, `up`, `down`, `close`, and the TUI each know different parts of the same sequencing, error policy, warning policy, and session naming rules.

This makes the lifecycle hard to change safely. Adding output modes, improving TUI progress, preserving JSON behavior, or changing close/down semantics requires touching multiple callers that should not need to understand the whole lifecycle.

Project registration also currently updates an existing registry row when the same repo path is registered again. Auto-registration from open flows should not rename an existing project; only an explicit project add with a name should force a rename.

## Solution

Introduce a deep `WorkspaceService` module that owns the lifecycle of a Workspace.

A Workspace means a managed worktree environment controlled by `wct`: a git worktree plus its lifecycle resources, including tmux session startup/shutdown, IDE launch, setup/copy side effects, VS Code workspace state sync, and the derived `WCT_*` environment. Workspace does not include project registry membership, PR cache state, or the TUI repo list.

From the user's perspective, existing behavior is preserved:

- `wct open` creates or reuses a worktree, syncs VS Code workspace state when configured, copies files, runs setup, starts tmux, opens the IDE, and can attach/switch afterward.
- `wct up` starts tmux and opens the IDE for an existing worktree; it does not run copy/setup.
- `wct down` kills the tmux session for an existing worktree. If the session is already absent, that is informational, not a warning or error.
- `wct close` kills the tmux session first, then removes the worktree. If the worktree is dirty, the caller receives a blocked result and can ask for force confirmation.
- PR opens are resolved by the Workspace lifecycle module, including GitHub CLI checks, PR branch resolution, fork remote setup, branch fetch, and local branch existence checks.
- Human output, JSON output, and TUI progress are handled by caller adapters, not by the Workspace module itself.

The command and TUI layers call `WorkspaceService` and focus on presentation, prompts, TUI mode transitions, project registration, JSON serialization, and tmux attach/client-switch policies.

## User Stories

1. As a CLI user, I want `wct open <branch>` to keep creating a worktree and starting my environment, so that my existing workflow continues to work.
2. As a CLI user, I want `wct open --pr <number>` to resolve the PR branch and fork remote automatically, so that opening PR worktrees still feels like one operation.
3. As a CLI user, I want `wct open` to keep copying configured files, so that new worktrees contain the files I expect.
4. As a CLI user, I want `wct open` to keep running setup commands, so that new worktrees are ready to use.
5. As a CLI user, I want setup failures to remain warnings, so that a partially setup worktree is still available for manual repair.
6. As a CLI user, I want copy failures to remain fatal, so that I do not unknowingly work in a worktree missing required copied files.
7. As a CLI user, I want VS Code workspace state sync failures to remain warnings, so that editor state issues do not prevent worktree creation.
8. As a CLI user, I want tmux creation failures to remain non-fatal for open/up, so that IDE/worktree creation can still succeed.
9. As a CLI user, I want IDE launch failures to remain non-fatal for open/up, so that worktree creation is not blocked by editor issues.
10. As a CLI user, I want `wct up` to keep only starting tmux and opening the IDE, so that it does not rerun setup or copy files on existing worktrees.
11. As a CLI user, I want `wct down` to succeed when the tmux session is already absent, so that stopping an already-stopped workspace is harmless.
12. As a CLI user, I want `wct close` to kill the tmux session before removing the worktree, so that current close ordering is preserved.
13. As a CLI user, I want `wct close` to stop before removal if killing an existing tmux session fails, so that a live session is not left pointing at a removed worktree.
14. As a CLI user, I want dirty-worktree close handling to keep requiring an explicit force decision, so that uncommitted work is not removed accidentally.
15. As a CLI user, I want tmux session names to remain based on the worktree path basename, so that existing sessions and commands remain compatible.
16. As a CLI user, I want open/up to start tmux and IDE in parallel after prerequisite work is complete, so that environment startup is not slower than necessary.
17. As a CLI user, I want `--prompt` behavior on open to stay unchanged, so that `WCT_PROMPT` is still available only for open-created sessions.
18. As a CLI user, I want profile selection to keep affecting copy, setup, IDE, and tmux behavior, so that profiles behave as documented.
19. As a CLI user, I want profile selection not to alter worktree path or project-name derivation, so that current path naming behavior is preserved.
20. As a JSON CLI user, I want lifecycle commands to return final structured results only, so that progress events do not pollute machine-readable output.
21. As a JSON CLI user, I want warnings to be typed objects, so that automation does not depend on human prose.
22. As a JSON CLI user, I want non-fatal attempts to be represented as JSON-safe objects, so that tmux/IDE/setup outcomes can be inspected reliably.
23. As a TUI user, I want open/up/down/close actions to use the same lifecycle logic as CLI commands, so that behavior is consistent.
24. As a TUI user, I want copy/setup to remain part of the open operation, so that TUI open does not need to know lifecycle internals.
25. As a TUI user, I want absent tmux sessions during down to stop using the action-error lane, so that harmless no-ops are not presented as failures.
26. As a TUI user, I want close to keep moving/detaching active clients before lifecycle close runs, so that the TUI stays in control of interactive safety.
27. As a TUI user, I want progress to be representable through typed events, so that the UI can show meaningful pending state without parsing strings.
28. As a maintainer, I want lifecycle orchestration in one deep module, so that commands and TUI actions no longer duplicate sequencing logic.
29. As a maintainer, I want command modules to stop depending on lifecycle helper modules under `commands`, so that dependency direction is clearer.
30. As a maintainer, I want target resolution moved into the Workspace module, so that up/down/close can share path/branch/cwd behavior.
31. As a maintainer, I want the Workspace module to be output-format agnostic, so that human CLI, JSON CLI, TUI, and tests can use different adapters.
32. As a maintainer, I want reporter events to be typed and semantic, so that output adapters do formatting at the edge.
33. As a maintainer, I want reporter delivery to be best-effort, so that progress rendering failures do not break lifecycle operations.
34. As a maintainer, I want reporter events to be awaited in order, so that progress display follows lifecycle order.
35. As a maintainer, I want old lifecycle exports removed in the hard cutover, so that there are not two competing lifecycle interfaces.
36. As a maintainer, I want project auto-registration to stay outside Workspace, so that Workspace does not own registry membership.
37. As a maintainer, I want open command and TUI open action to auto-register after successful workspace open, so that current registry convenience remains.
38. As a maintainer, I want auto-registration to skip existing registry rows, so that opening a worktree does not rename an existing project.
39. As a maintainer, I want explicit project add with a name to be able to rename an existing registry row, so that user-directed registration still updates names.
40. As a maintainer, I want registry registration outcomes to be structured, so that commands and JSON output can distinguish registered, already registered, and updated.
41. As a maintainer, I want Workspace terminology documented, so that future architecture work does not confuse Workspace lifecycle with project registry or TUI repo discovery.

## Implementation Decisions

- Add a `CONTEXT.md` glossary entry defining Workspace as a managed worktree environment. The definition must explicitly exclude project registry membership, PR cache state, and the TUI repo list.
- Do not rename the VS Code workspace module. VS Code also correctly uses the word workspace; the domain glossary disambiguates the two contexts.
- Add a `WorkspaceService` module under services. It owns lifecycle operations only: open, up, down, and close.
- `WorkspaceService` depends on existing low-level adapters for git worktrees, tmux, IDE launch, setup commands, VS Code workspace state sync, GitHub PR integration, config loading, and Bun platform services. It should not use logger, Console, JsonFlag, registry, PR cache, or TUI state.
- Public Workspace interface exposes lifecycle operations only. Internal helpers for resolving workspace context can exist, but should not become a public shallow interface.
- Move the target-resolution helper currently used by up/down into the Workspace module. Delete the command-layer helper after updating imports and tests.
- Keep config-derived worktree path calculation in the config loader. That path calculation remains based on the base loaded config's `worktree_dir` and `project_name`, not the resolved profile.
- `WorkspaceService.open` accepts user-intent input, including branch or PR, base, existing, cwd, ide/noIde, profile, prompt, and optional reporter.
- `WorkspaceService.open` owns PR input validation and resolution, including GitHub CLI installation checks, PR number/URL parsing, PR branch resolution, fork remote detection/addition, branch fetch, and local branch existence checks.
- Preserve current open validation ordering. Early validation covers ide/noIde conflict, PR conflicts, missing branch, invalid PR value, GitHub CLI availability, and PR resolution. The existing/base conflict and base branch existence checks remain later after repository/config/profile resolution.
- Preserve error codes and materially preserve error messages. This is a lifecycle consolidation, not a command semantics rewrite.
- `WorkspaceService.open` owns worktree creation or reuse, VS Code workspace state sync, file copy, setup commands, tmux creation, and IDE launch.
- `WorkspaceService.open` runs copy/setup when the worktree already exists, preserving current behavior.
- `WorkspaceService.open` attempts VS Code workspace state sync when current configuration says the IDE is VS Code and workspace forking is enabled. The VS Code adapter decides whether sync is skipped because target state already exists.
- `WorkspaceService.up` resolves an existing worktree, config, profile, IDE launch, env, and session name, then starts tmux and opens IDE. It does not run copy/setup.
- `WorkspaceService.down` resolves a worktree target and kills only the tmux session.
- `WorkspaceService.close` resolves a worktree target, kills the tmux session first, then removes the worktree.
- Workspace close is single-target. CLI close loops for multiple branch arguments and retains batching/prompt policy at the command layer.
- If close sees no tmux session, that is informational and removal continues.
- If close sees an existing tmux session and killing it fails, the Effect fails and worktree removal is not attempted.
- If close removal is blocked by changes, the structured result reports that state. The caller decides whether to ask for force and call close again with force.
- The TUI keeps active tmux client safety outside Workspace. TUI moves or detaches active clients before calling close/down.
- CLI prompts remain outside Workspace. CLI owns confirmation and attach behavior.
- Project registration remains outside Workspace. `openCommand` and TUI open call project registration after a successful workspace open and before CLI attach.
- Auto-registration from open flows must not rename an existing registry row.
- Registry registration gains `forceRename`. Existing path plus `forceRename !== true` returns the existing row unchanged. Existing path plus `forceRename === true` and a different provided name updates the project name. New paths insert normally.
- Registry registration returns a structured status: registered, already registered, or updated.
- Registry registration behavior should be implemented in the registry persistence interface, not only in the higher-level registration helper.
- Registry registration should perform select/insert/update logic atomically in a transaction.
- `projects add --name` passes `forceRename: true`. `projects add` without a name skips existing rows and preserves their name. Open auto-registration omits `forceRename` or passes false.
- Human open output mentions registration only when a project is newly registered. Already-registered stays silent.
- Project add output mentions registered, already registered, and updated statuses.
- JSON open output includes registration status when auto-registration was attempted.
- Workspace results are JSON-safe by construction. Do not embed raw Error objects in non-fatal result data.
- Use a JSON-safe error shape containing code and message for non-fatal attempts and warnings.
- Use structured operation attempts with attempted/ok/value/error and attempted false reasons for skipped steps.
- Use typed warnings, not warning strings. Setup failures, optional setup failures, VS Code sync failure, tmux start failure, and IDE open failure should be distinguishable.
- Setup required and optional failures remain non-fatal warnings. Copy failures remain fatal.
- Tmux and IDE failures during open/up remain non-fatal warnings. Down kill failure remains fatal. Close kill failure remains fatal when a session exists.
- Workspace reporter is optional and passed per operation.
- Reporter has one method that receives typed semantic events.
- Reporter events include operation identity: open, up, down, or close.
- Event names are generic with an operation field rather than operation-prefixed names.
- Reporter events are semantic and typed, not preformatted strings.
- Reporter events are JSON-safe and do not carry raw errors.
- Reporter delivery is awaited in lifecycle order, but reporter failures are swallowed.
- Workspace does not consume JsonFlag. Commands decide whether to pass a human reporter, TUI reporter, test reporter, or no reporter.
- JSON output includes final results only. It does not include reporter event history.
- Human CLI reporter formats typed events and typed warnings into prose at the edge.
- TUI reporter may initially be minimal, but TUI actions should stop suppressing workspace logging through a silent Console adapter for workspace operations.
- Tmux session naming remains based on the worktree path basename everywhere.
- `switch` and `cd` remain on worktree/tmux lookup behavior and do not move to Workspace.
- Keep `formatSessionName` in the tmux module.
- Delete the old command-layer lifecycle module after the hard cutover.

## Testing Decisions

A good test for this refactor asserts external behavior at the new deep interface. Tests should verify lifecycle outcomes, warnings, attempts, fatal failures, and caller-visible command/TUI behavior without asserting incidental internal helper calls.

The Workspace module should receive focused tests for:

- open branch input validation and error ordering.
- open PR resolution behavior with GitHub adapter fakes.
- open worktree creation success and already-exists success.
- open path conflict fatal failure.
- open copy fatal failure.
- open setup failure as typed warning.
- open VS Code sync failure as typed warning.
- open tmux/IDE non-fatal attempts.
- open result shape for skipped copy/setup/tmux/IDE/VS Code steps.
- up starting tmux and IDE without running copy/setup.
- up preserving AlreadyExists tmux success.
- down killing an existing session.
- down absent session as informational success.
- down kill failure as fatal.
- close absent session followed by removal.
- close kill-first ordering.
- close kill failure preventing removal.
- close blocked-by-changes result after tmux kill.
- close force removal.
- reporter event ordering and best-effort failure swallowing.
- JSON-safe warning/attempt/error shapes.

Command tests should verify:

- open calls Workspace and performs registration after successful open.
- open does not register after fatal workspace failure.
- open JSON emits final result and registration status only.
- open human output uses reporter formatting and does not print already-registered auto-registration noise.
- up/down/close JSON emits final result only.
- down absent session is informational rather than a warning/error lane.
- close still loops over multiple branches and keeps prompt policy outside Workspace.

TUI tests should verify:

- TUI open calls Workspace and project registration, then refreshes.
- TUI up calls Workspace up and handles start result.
- TUI down uses Workspace down and does not show an action error for absent sessions.
- TUI close keeps active-client safety before Workspace close.
- TUI close handles blocked-by-changes by entering force-confirm mode.
- TUI actions clear pending state after success, warning, or failure.

Registry tests should verify:

- registering a new path returns registered.
- registering an existing path without forceRename returns already registered and preserves existing project name.
- registering an existing path with forceRename and a different name returns updated.
- registering an existing path with forceRename and the same name returns already registered.
- project add without name preserves existing registration.
- project add with explicit name can rename.
- registration select/insert/update behavior is transaction-safe enough for concurrent callers.

Prior art in the codebase includes service tests using fake service adapters, in-memory SQLite registry/cache tests, command behavior tests with overridden services, TUI hook/action tests, and parser/helper tests that assert behavior rather than private structure.

## Out of Scope

- Renaming VS Code workspace modules.
- Changing tmux session naming.
- Changing profile scope to affect worktree path or project-name derivation.
- Changing setup failure semantics from warning to fatal.
- Changing copy failure semantics from fatal to warning.
- Changing `up` to run copy/setup.
- Moving `switch` or `cd` into Workspace.
- Adding a general event bus or pub/sub system.
- Persisting reporter events.
- Adding progress event history to JSON output.
- Moving project registry, PR cache, or TUI repo-list ownership into Workspace.
- Adding a project rename command beyond explicit `projects add --name` force-rename behavior.
- Changing GitHub integration away from the `gh` CLI.

## Further Notes

- The hard cutover should avoid leaving two lifecycle interfaces alive. Once commands and TUI actions call Workspace, remove the old lifecycle module and update tests around the new service.
- This refactor intentionally deepens the lifecycle module while keeping low-level adapters focused. `WorktreeService`, `TmuxService`, `IdeService`, `SetupService`, `VSCodeWorkspaceService`, and `GitHubService` remain concrete adapters at their current seams.
- The registry behavior change is related but separate: it keeps automatic open-time registration from mutating project names while preserving explicit user-driven rename behavior.
