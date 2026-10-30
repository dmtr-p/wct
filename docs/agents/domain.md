# Domain Docs

Read `CONTEXT.md` at the repository root for domain vocabulary and the relevant
files in `docs/adr/` for engineering decisions.

## Documentation placement

- `README.md` owns user-facing usage and links to detailed behavior documents.
- `CONTEXT.md` owns shared domain vocabulary and invariants. Keep one glossary.
- `docs/<topic>.md` owns current behavior for its named subsystem. Agent
  identification, observation, and compatibility belong in
  [agent detection](../agent-detection.md); GitHub PR discovery, caching, and
  refresh coordination belong in [PR refresh](../pr-refresh.md). Workspace
  startup, copying, and shutdown belong in
  [Workspace Operations](../workspace-operations.md); repository and tmux
  polling belong in [TUI refresh](../tui-refresh.md).
- `docs/adr/` owns architectural decisions, constraints, and rationale. Routine
  behavior descriptions belong in topic documents.
- `docs/agents/` owns agent workflow and repository instructions.

Before editing documentation, find the document that owns the topic and check
its title and scope. Create a focused topic document when none exists, and link
it from the relevant README section or existing document so readers can find it.
Keep one authoritative description of each behavior; use links for cross-topic
relationships. Shared UI placement or a shared polling loop does not make
unrelated subsystems part of the same documentation topic.

## Domain vocabulary and decisions

Use the glossary's terms in code, documentation, issue titles, and proposals.
Avoid the synonyms explicitly listed under `_Avoid_`.

If a concept is missing, check whether an existing term covers it before adding
another. Document a distinct concept when its meaning is settled.

When a proposed change conflicts with an accepted ADR, identify the conflict
and explain why the decision needs to change.
