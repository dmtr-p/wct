# TUI Modal Unification Design

## Goal

Make the TUI `open` and `up` modals behave consistently where they represent the same concepts, while keeping each modal's task-specific flow intact.

The main inconsistencies to remove are:

- `UpModal` uses a filtered profile picker, while `OpenModal` uses free-text profile input
- `UpModal` exposes positive `Auto-switch`, while `OpenModal` exposes negative `No attach`
- the option rows across the modals are implemented separately, so interaction can drift again

The target UX is the current `UpModal` control model:

- when profiles exist, users pick from a filtered list
- `(default)` is always available
- attach behavior is framed as positive `Auto-switch`
- `No IDE` stays as a shared toggle

## Current State

Today the two modals share visual primitives but not the option interaction model.

`src/tui/components/UpModal.tsx`:

- renders a filtered profile picker using `ScrollableList`
- prepends `(default)` to configured profiles
- submits `profile`, `noIde`, and `autoSwitch`
- owns a single ordered focus list for its fields

`src/tui/components/OpenModal.tsx`:

- has three separate subforms: new branch, from PR, existing branch
- uses free-text `Profile` inputs where profiles exist
- uses negative `No attach` toggles
- repeats option-row wiring in each subform

This creates two problems:

- users have to learn different controls for the same concepts depending on whether they press `o` or `u`
- future changes to profile and attach behavior need to be applied in multiple places and can drift again

## Chosen Approach

Extract a shared `SessionOptionsSection` and make both modals use it.

This is intentionally narrower than a generic form system:

- `OpenModal` keeps its three task-specific subforms
- `UpModal` stays a dedicated modal
- only the shared session-option area becomes reusable

That gives the codebase one place to define how profile selection, IDE launch, attach behavior, and submit affordance work, without forcing branch, PR, and prompt fields into an abstraction that does not buy much.

## Design

### Shared section

Add a reusable component in `src/tui/components` for the common session options area.

Responsibilities:

- render the profile picker when `profileNames.length > 0`
- prepend `(default)` ahead of configured profiles
- support typed filtering and arrow-key selection
- render `No IDE`
- render `Auto-switch`
- render the submit row
- expose whether submit is currently allowed

The section should operate on the same concepts for both modals:

- `profile?: string`
- `noIde: boolean`
- `autoSwitch: boolean`
- `canSubmit: boolean`

### Controlled focus ownership

To avoid keyboard conflicts, the parent form owns focus order.

That means:

- each modal or subform defines the ordered field list
- the parent computes `currentField`
- the shared section receives which of its fields are focused
- tab and shift-tab stay owned by the parent form

The shared section should not run an independent focus cycle. It can manage option-local state such as filter text and selected profile index, but only the currently focused field should react to input.

This is the main guardrail against the current risk area: embedded controls listening at the same time.

### Profile behavior

Profile selection becomes identical to `UpModal` wherever profiles are available.

Rules:

- `OpenModal` no longer accepts arbitrary profile text
- users can only select profiles defined in `.wct.yaml`
- `(default)` appears first and maps to `undefined` at submit time
- typing filters the profile list
- arrow keys move the selected entry
- if the filter leaves no matching profile, submit is disabled until a valid selection exists
- if there are no configured profiles, the profile control is omitted

This preserves the actual config boundary: profile names are not free-form user input.

### Attach behavior

Both modals should expose positive `Auto-switch`.

User-facing meaning:

- `Auto-switch = true`: after starting or opening a tmux session, try to switch the active tmux client when possible
- `Auto-switch = false`: do not attempt that handoff

Integration details:

- `UpModal` already submits `autoSwitch` and keeps that shape
- `OpenModal` keeps `OpenModalResult.noAttach` for compatibility with the existing action handler
- each `OpenModal` subform maps `autoSwitch` to `noAttach: !autoSwitch` when submitting

This keeps command-layer wiring stable while standardizing the TUI wording.

### `UpModal`

`UpModal` becomes a thin wrapper around the shared options section.

It should keep:

- modal shell
- title and description
- modal-open reset behavior
- submit callback shape

It should stop owning bespoke profile list construction and resolution logic. That logic should move into shared helpers used by the new section so `OpenModal` and `UpModal` resolve profile selection the same way.

### `OpenModal`

`OpenModal` keeps its current multi-step shape:

- selector
- new branch
- from PR
- existing branch

Only the option section becomes shared.

Expected field layouts:

- New branch: `branch`, `base`, `profile`, `prompt`, `No IDE`, `Auto-switch`, submit
- From PR: `prList`, `profile`, `prompt`, `No IDE`, `Auto-switch`, submit
- Existing branch: `branchList`, `prompt`, `No IDE`, `Auto-switch`, submit

The shared section supplies `profile`, `No IDE`, `Auto-switch`, and submit within those layouts. `prompt` stays before the toggles to match the current `OpenModal` mental flow. The important requirement is that profile, `No IDE`, `Auto-switch`, and submit behave the same way as `UpModal`.

### Data flow

Modal preparation does not need a new data source.

Existing flow remains:

- `prepareOpenModal(...)` passes `profileNames`
- `prepareUpModal(...)` passes `profileNames`
- the shared section derives its option list from those names

Submission flow:

- `UpModal` submits `profile`, `noIde`, and `autoSwitch`
- `OpenModal` subforms submit their task-specific values plus the same option values
- `OpenModal` converts `autoSwitch` into `noAttach` for `handleOpen(...)`

No command-layer or config-layer design changes are needed for this unification.

## Error Handling

This design does not introduce a new error model. The important behavior is invalid-state prevention in the UI.

The modal layer should prevent ambiguous or invalid submission by:

- hiding the profile field when no profiles exist
- disabling submit when a profile filter yields no valid selection
- mapping `(default)` to `undefined` instead of a synthetic profile name

Operational failures after submit continue to surface through the existing TUI action handlers and error banners.

## Testing And Verification

Add focused tests around the shared behavior rather than duplicating modal integration coverage everywhere.

Expected coverage:

- shared profile option construction includes `(default)` first
- filtering and selected-index resolution produce `undefined` for `(default)` and the selected configured profile otherwise
- submit is disabled when the filtered profile list is empty
- `OpenModal` submission maps `autoSwitch: false` to `noAttach: true`
- `OpenModal` submission never emits arbitrary profile text when profiles are configured
- `UpModal` still emits the same externally visible submission shape after the refactor

Project instructions say not to run tests or lint manually in-session; rely on repo hooks for formatting, linting, and tests.

## Risks

### Input focus conflicts

The main risk is overlapping keyboard handlers once the shared profile picker is embedded in `OpenModal` subforms.

Mitigation:

- keep one focus owner at the parent form level
- gate all field-specific input on `currentField`
- do not let the shared section own tab navigation
- reset profile filter text and selected profile index when the modal opens or step changes

### Over-abstraction

The second risk is turning this into a generic form engine.

Mitigation:

- share only the session options area
- keep branch, PR, base, and prompt fields local to their current forms
- keep result types stable at the modal boundary

### Behavioral drift during migration

The third risk is changing wording but not semantics, or semantics but not wiring.

Mitigation:

- preserve `UpModal` submission semantics
- explicitly map `autoSwitch` to `noAttach` in `OpenModal`
- cover the mapping in tests

## Non-Goals

- redesigning the overall `OpenModal` step structure
- introducing a schema-driven form renderer
- changing command-layer CLI flags or config schema
- changing how PR selection, branch selection, or prompt entry work beyond focus-safe integration with the shared section
