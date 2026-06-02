# Context

## Glossary

### Workspace

A Workspace is a managed worktree environment controlled by `wct`: a git
worktree plus its lifecycle resources, including tmux session startup and
shutdown, IDE launch, setup and copy side effects, VS Code workspace state sync,
and the derived `WCT_*` environment.

Workspace does not include project registry membership, PR cache state, or the
TUI repo list.
