# Context

## Glossary

### Workspace

A Workspace is a managed worktree environment controlled by `wct`: a git
worktree plus its lifecycle resources, including tmux session startup and
shutdown, setup and copy side effects, and the derived `WCT_*` environment.

Workspace does not include project registry membership, PR cache state, or the
TUI repo list.

### Project Registry

The Project Registry is the user's explicit list of repositories managed in the
TUI repo list. A repository becomes a registered project only through explicit
project registration.

### Explicit Project Registration

Explicit Project Registration is the user action that adds a repository to the
Project Registry. Opening, starting, initializing, or otherwise operating on a
Workspace does not imply project registration.
