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

### PR Identity

A PR Identity is the base GitHub repository (owner/name) and PR number. A
branch name alone cannot identify a PR because branches can be reused and
multiple head repositories can use the same branch name.

### PR Association

A PR Association links a Workspace Identity to a PR Identity. Automatic
association uses the branch's verified push destination; an uncertain or
ambiguous destination remains a set of candidates until the user chooses.

### Explicit Association

An Explicit Association is a user's PR choice for a Workspace, or the PR used
when creating it with `wct open --pr`. It takes precedence over automatic
association until changed or cleared, including when that PR closes or merges.

### Project Registry

The Project Registry is the user's explicit list of repositories managed in the
TUI repo list. A repository becomes a registered project only through explicit
project registration.

### Explicit Project Registration

Explicit Project Registration is the user action that adds a repository to the
Project Registry. Opening, starting, initializing, or otherwise operating on a
Workspace does not imply project registration.
