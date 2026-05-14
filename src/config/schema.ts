import { Schema } from "effect";

export const VALID_LAYOUTS = [
  "even-horizontal",
  "even-vertical",
  "main-horizontal",
  "main-vertical",
  "tiled",
] as const;

export const SetupCommandSchema = Schema.Struct({
  name: Schema.String,
  command: Schema.String,
  optional: Schema.optional(Schema.Boolean),
});

export const TmuxPaneSchema = Schema.Struct({
  name: Schema.optional(Schema.String),
  command: Schema.optional(Schema.String),
});

export const TmuxLayoutSchema = Schema.Literals(VALID_LAYOUTS);

export const TmuxWindowSchema = Schema.Struct({
  name: Schema.String,
  command: Schema.optional(Schema.String),
  split: Schema.optional(Schema.Literals(["horizontal", "vertical"] as const)),
  layout: Schema.optional(TmuxLayoutSchema),
  panes: Schema.optional(Schema.Array(TmuxPaneSchema)),
});

export const TmuxConfigSchema = Schema.Struct({
  windows: Schema.optional(Schema.Array(TmuxWindowSchema)),
});

export const IdeConfigSchema = Schema.Struct({
  open: Schema.optional(Schema.Boolean),
  name: Schema.optional(Schema.String),
  command: Schema.optional(Schema.String),
  fork_workspace: Schema.optional(Schema.Boolean),
});

export const ProfileSchema = Schema.Struct({
  match: Schema.optional(
    Schema.Union([Schema.String, Schema.Array(Schema.String)]),
  ),
  copy: Schema.optional(Schema.Array(Schema.String)),
  setup: Schema.optional(Schema.Array(SetupCommandSchema)),
  ide: Schema.optional(IdeConfigSchema),
  tmux: Schema.optional(TmuxConfigSchema),
});

export const WctConfigSchema = Schema.Struct({
  version: Schema.optional(Schema.Number),
  worktree_dir: Schema.optional(Schema.String),
  project_name: Schema.optional(Schema.String),
  copy: Schema.optional(Schema.Array(Schema.String)),
  setup: Schema.optional(Schema.Array(SetupCommandSchema)),
  ide: Schema.optional(IdeConfigSchema),
  tmux: Schema.optional(TmuxConfigSchema),
  profiles: Schema.optional(Schema.Record(Schema.String, ProfileSchema)),
});

export const ResolvedConfigSchema = Schema.Struct({
  version: Schema.optional(Schema.Number),
  worktree_dir: Schema.String,
  project_name: Schema.String,
  copy: Schema.optional(Schema.Array(Schema.String)),
  setup: Schema.optional(Schema.Array(SetupCommandSchema)),
  ide: Schema.optional(IdeConfigSchema),
  tmux: Schema.optional(TmuxConfigSchema),
  profiles: Schema.optional(Schema.Record(Schema.String, ProfileSchema)),
});

export type SetupCommand = typeof SetupCommandSchema.Type;
export type TmuxPane = typeof TmuxPaneSchema.Type;
export type TmuxLayout = (typeof VALID_LAYOUTS)[number];
export type TmuxWindow = typeof TmuxWindowSchema.Type;
export type TmuxConfig = typeof TmuxConfigSchema.Type;
export type IdeConfig = typeof IdeConfigSchema.Type;
export type Profile = typeof ProfileSchema.Type;
export type WctConfig = typeof WctConfigSchema.Type;
export type ResolvedConfig = typeof ResolvedConfigSchema.Type;
