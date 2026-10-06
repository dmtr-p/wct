# Context

## Glossary

### Workspace

A Workspace is a managed worktree environment controlled by `wct`: a Git
worktree plus its lifecycle resources, including tmux session startup and
shutdown, setup and copy side effects, and the derived `WCT_*` environment.
Its existence is determined by the managed worktree; missing or failed
optional lifecycle resources do not make it a Pending Workspace.

Workspace does not include project registry membership, PR cache state, or the
TUI repo list.

Managed means that `wct` operates on the worktree's lifecycle resources; it
does not require that `wct` created the worktree. The main worktree and
worktrees created outside `wct` can also be used as Workspaces.

### Worktree

A Worktree is a Git checkout belonging to a repository. It can be the main
worktree or a linked worktree, and can exist without a tmux session or Project
Registry membership. A Worktree is the checkout itself; a Workspace includes
the lifecycle resources managed around it.

### Main Repository

The Main Repository owns the main worktree and its linked worktrees. Its path
is the repository half of a Workspace Identity and is resolved independently
of which worktree an action starts from. It is distinct from the default
branch and from a PR's base or head GitHub repository.

### Workspace Operation

A Workspace Operation is an `open`, `up`, `down`, or `close` action. Open
creates or reuses a worktree, prepares its configured environment, and starts
its tmux session when configured. Start means `up`, which starts its tmux
session. Stop means `down`, which stops its tmux session while keeping the
worktree. Close stops the session and removes the worktree.

Use Start and Stop in user-facing action names, and `up` and `down` when
referring to the CLI commands. Stopping a session uses tmux's `kill-session`
operation; it does not suspend the processes in the session.

The JSON contract retains tmux's kill wording for compatibility: down reports
a stopped session as `status: "killed"`, and down and close expose an
`attempts.kill` field.

### Lifecycle Phase

A Lifecycle Phase is the current step of a Workspace Operation, such as
preparing, creating a worktree, copying files, running setup, starting or
stopping a tmux session, or removing a worktree. The TUI adds a validation
phase after the service operation settles to reconcile the displayed state
with a fresh repository scan.

### Lifecycle Progress Row

A Lifecycle Progress Row is the temporary TUI child row beneath a Workspace
that names the current Lifecycle Phase of a Workspace Operation. It
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

### Workspace Identity Key

A Workspace Identity Key encodes a Workspace Identity for keyed state such
as lifecycle progress, PR Associations, and identity-specific expansion. It
uses the main repository path and branch, never a Project Display Name or
registry ID.

### Worktree Display Key

A Worktree Display Key combines a Project Display Name and branch for TUI
expansion state. It is not a Workspace Identity Key: display names can collide
across repositories. It is also not specific to a Pending Workspace.

### PR Identity

A PR Identity is the base GitHub repository (owner/name) and PR number. A
branch name alone cannot identify a PR because branches can be reused and
multiple head repositories can use the same branch name.

### PR Association

A PR Association links a Workspace Identity to a PR Identity. It can be an
Automatic PR Association or an Explicit PR Association.

_Avoid_: PR binding

### Push Destination

A Push Destination is the GitHub repository (owner/name) and remote branch
that a plain `git push` would target for a local branch, as resolved from Git
configuration. It is distinct from the fetch remote or upstream alone and
from the local branch name. If the repository or branch cannot be resolved
unambiguously, the Push Destination is unknown.

### Automatic PR Association

An Automatic PR Association selects a PR using the branch's verified Push
Destination. An unknown destination or multiple matching open PRs leaves the
choice unresolved until the user chooses an Explicit PR Association.

### PR Candidate

A PR Candidate is a possible PR Association target discovered for a Workspace.
Without a known Push Destination, discovery uses PRs whose head branch name
matches the local branch as candidates rather than establishing an association.
Candidates can also remain available when a PR is already associated; their
presence alone does not imply an unresolved association.

### Explicit PR Association

An Explicit PR Association is a user's PR choice for a Workspace, or the PR
used when creating it with `wct open --pr`. It takes precedence over Automatic
PR Association until changed or cleared, including when that PR closes or merges.

### PR Status

PR Status is the TUI's summary of a PR's lifecycle, review, check, and merge
facts. A displayed `ready` status summarizes those facts; it does not establish
Merge Eligibility. Missing facts remain unknown. A stale marker indicates a
fetch error or incomplete check data, independently of the displayed status.

### Merge Eligibility

Merge Eligibility determines whether a PR can be submitted for a direct merge
or to a merge queue. It includes current PR facts and repository configuration,
including enabled merge methods and queue requirements. Submission re-fetches
the facts and configuration and requires the eligibility and routing facts to
match the confirmed snapshot.

### Project Registry

The Project Registry is the user's explicit list of repositories managed in the
TUI repo list. A repository becomes a registered project only through explicit
project registration.

### Registered Project

A Registered Project is a repository explicitly included in the Project
Registry. Registry membership is keyed by Main Repository path. Use repository
for the Git repository and Registered Project when registry membership matters.

### Project Display Name

A Project Display Name is a Registered Project's user-facing registry label.
It can be overridden at registration and need not be unique. It is not a
Workspace Identity and can differ from the Configured Project Name.

### Configured Project Name

The Configured Project Name is the resolved `project_name` configuration
value, defaulting to the repository directory name. It is used for naming new
worktree directories and their tmux sessions and for `WCT_PROJECT`. It supplies
the default Project Display Name at registration, but a registry name override
does not change the configuration.

### Explicit Project Registration

Explicit Project Registration is the user action that adds a repository to the
Project Registry. Opening, starting, initializing, or otherwise operating on a
Workspace does not imply project registration.

### Project Removal

Project Removal removes a repository's membership in the Project Registry.
The TUI also stops its worktree sessions before unregistering it; the CLI
`wct projects remove` only unregisters it. Both keep the repository and its
worktrees.

Removal clears repository-owned PR caches. Explicit PR Associations remain
tied to the surviving Workspace Identities.
Re-registering the same repository restores those explicit PR choices for its
surviving Workspaces.

_Avoid_: Delete Project

### Config Profile

A Config Profile is a named set of overrides for `work_dir`, `copy`, `setup`,
and `tmux`. Open and Start select a profile explicitly with `--profile` or use
the first profile whose branch glob matches. Sections absent from the profile
retain their base configuration.
