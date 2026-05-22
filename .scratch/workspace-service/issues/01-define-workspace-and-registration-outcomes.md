Status: done

# Define Workspace and registry registration outcomes

## Parent

.scratch/workspace-service/PRD.md

## What to build

Define the Workspace domain term and update project registration so repeated automatic registration does not rename an existing project. Explicit project registration with a provided name can still force a rename.

This slice should make registration outcomes visible and stable: registering a new repo, skipping an already-registered repo, and updating a repo name are distinct outcomes.

## Acceptance criteria

- [x] A root domain glossary defines Workspace as a managed worktree environment and explicitly excludes project registry membership, PR cache state, and the TUI repo list.
- [x] Registering a new repo path returns a structured `registered` outcome.
- [x] Registering an existing repo path without force rename returns the existing row unchanged with an `already-registered` outcome.
- [x] Registering an existing repo path with force rename and a different explicit name updates the name and returns an `updated` outcome.
- [x] Registering an existing repo path with force rename and the same name returns `already-registered`.
- [x] `projects add` without a name preserves existing registrations.
- [x] `projects add --name` can update an existing registration name.
- [x] Human output for `projects add` distinguishes registered, already registered, and updated outcomes.
- [x] JSON output, where applicable, includes the structured registration outcome.
- [x] Registration tests cover new, already-registered, updated, and same-name force-rename cases.

## Blocked by

None - can start immediately
