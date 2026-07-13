# Context

## Glossary

### Workspace

A Workspace is a managed worktree environment controlled by `wct`: a git
worktree plus its lifecycle resources, including tmux session startup and
shutdown, setup and copy side effects, and the derived `WCT_*` environment.
Its existence is determined by the managed worktree; missing or failed
optional lifecycle resources do not make it a Pending Workspace.

Workspace does not include project registry membership, PR cache state, or the
TUI repo list.

### Lifecycle Progress Row

A Lifecycle Progress Row is the temporary TUI child row beneath a Workspace
that names the current phase of an open, start, stop, or close operation. It
exists only while the operation is active and is removed when the operation
succeeds or fails.

_Avoid_: Progress line, status line

### Pending Workspace

A Pending Workspace is the temporary TUI representation of an intended
Workspace while its open operation is active and before it can be discovered
as a managed worktree environment. It is not interactive.

_Avoid_: Phantom worktree

### Workspace Identity

A Workspace Identity is the pair of a main repository path and branch name. It
also identifies the Pending Workspace before its managed worktree exists.

_Avoid_: Project and branch, registry ID and branch

### Project Registry

The Project Registry is the user's explicit list of repositories managed in the
TUI repo list. A repository becomes a registered project only through explicit
project registration.

### Explicit Project Registration

Explicit Project Registration is the user action that adds a repository to the
Project Registry. Opening, starting, initializing, or otherwise operating on a
Workspace does not imply project registration.
