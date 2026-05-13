import { Effect, Option } from "effect";
import { cdCommand } from "../commands/cd";
import { closeCommand } from "../commands/close";
import { downCommand } from "../commands/down";
import { initCommand } from "../commands/init";
import { listCommand } from "../commands/list";
import { openCommand, resolveOpenOptions } from "../commands/open";
import {
  projectsAddCommand,
  projectsListCommand,
  projectsRemoveCommand,
} from "../commands/projects";
import { switchCommand } from "../commands/switch";
import { tuiCommand } from "../commands/tui";
import { upCommand } from "../commands/up";
import { Argument, Command, Flag } from "../effect/cli";
import { JsonFlag } from "./json-flag";

const branchArgument = Argument.string("branch").pipe(
  Argument.withDescription("Branch name"),
);

const optionalBranchArgument = branchArgument.pipe(Argument.optional);

const branchesArgument = branchArgument.pipe(Argument.variadic({ min: 1 }));

function booleanFlag(name: string, description: string, alias?: string) {
  let flag = Flag.boolean(name).pipe(
    Flag.withDescription(description),
    Flag.withDefault(false),
  );

  if (alias) {
    flag = flag.pipe(Flag.withAlias(alias));
  }

  return flag;
}

function optionalStringFlag(
  name: string,
  description: string,
  alias?: string,
  metavar?: string,
) {
  let flag = Flag.string(name).pipe(
    Flag.withDescription(description),
    Flag.optional,
  );

  if (metavar) {
    flag = flag.pipe(Flag.withMetavar(metavar));
  }

  if (alias) {
    flag = flag.pipe(Flag.withAlias(alias));
  }

  return flag;
}

function optionToUndefined<A>(option: Option.Option<A>): A | undefined {
  return Option.isSome(option) ? option.value : undefined;
}

const cdCliCommand = Command.make(
  "cd",
  { branch: branchArgument },
  ({ branch }) => cdCommand(branch),
).pipe(Command.withDescription("Open a shell in a worktree directory"));

const closeCliCommand = Command.make(
  "close",
  {
    branches: branchesArgument,
    yes: booleanFlag("yes", "Skip confirmation prompt", "y"),
    force: booleanFlag("force", "Force removal even if worktree is dirty", "f"),
  },
  ({ branches, yes, force }) =>
    closeCommand({
      branches: [...branches],
      yes,
      force,
    }),
).pipe(Command.withDescription("Kill tmux session and remove worktree"));

const downCliCommand = Command.make(
  "down",
  {
    path: optionalStringFlag(
      "path",
      "Path to worktree directory",
      undefined,
      "path",
    ),
    branch: optionalStringFlag(
      "branch",
      "Branch name to resolve worktree from",
      "b",
      "NAME",
    ),
  },
  ({ path, branch }) =>
    downCommand({
      path: optionToUndefined(path),
      branch: optionToUndefined(branch),
    }),
).pipe(Command.withDescription("Kill tmux session for a worktree"));

const initCliCommand = Command.make("init", {}, () => initCommand()).pipe(
  Command.withDescription("Generate a starter .wct.yaml config file"),
);

const listCliCommand = Command.make(
  "list",
  {
    short: booleanFlag("short", "Print branch names only", "s"),
  },
  ({ short }) => listCommand({ short }),
).pipe(
  Command.withDescription("Show worktrees with tmux, changes, and sync status"),
);

const switchCliCommand = Command.make(
  "switch",
  { branch: branchArgument },
  ({ branch }) => switchCommand(branch),
).pipe(
  Command.withAlias("sw"),
  Command.withDescription("Switch to another worktree's tmux session"),
);

const upCliCommand = Command.make(
  "up",
  {
    ide: booleanFlag("ide", "Force opening IDE"),
    noIde: booleanFlag("no-ide", "Skip opening IDE"),
    noAttach: booleanFlag("no-attach", "Do not attach to tmux outside tmux"),
    path: optionalStringFlag(
      "path",
      "Path to worktree directory",
      undefined,
      "path",
    ),
    branch: optionalStringFlag(
      "branch",
      "Branch name to resolve worktree from",
      "b",
      "NAME",
    ),
    profile: optionalStringFlag(
      "profile",
      "Use a named config profile",
      "P",
      "NAME",
    ),
  },
  ({ ide, noIde, noAttach, path, branch, profile }) =>
    upCommand({
      ide,
      noIde,
      noAttach,
      path: optionToUndefined(path),
      branch: optionToUndefined(branch),
      profile: optionToUndefined(profile),
    }),
).pipe(
  Command.withDescription("Start tmux session and open IDE for a worktree"),
);

const openCliCommand = Command.make(
  "open",
  {
    branch: optionalBranchArgument,
    base: optionalStringFlag(
      "base",
      "Base branch for new worktree",
      "b",
      "BRANCH",
    ),
    existing: booleanFlag("existing", "Use existing branch", "e"),
    ide: booleanFlag("ide", "Force opening IDE"),
    noIde: booleanFlag("no-ide", "Skip opening IDE"),
    noAttach: booleanFlag("no-attach", "Do not attach to tmux outside tmux"),
    pr: optionalStringFlag(
      "pr",
      "Open worktree from a GitHub PR",
      undefined,
      "NUMBER_OR_URL",
    ),
    prompt: optionalStringFlag(
      "prompt",
      "Set WCT_PROMPT env var in tmux session",
      "p",
      "TEXT",
    ),
    profile: optionalStringFlag(
      "profile",
      "Use a named config profile",
      "P",
      "NAME",
    ),
  },
  ({ branch, base, existing, ide, noIde, noAttach, pr, prompt, profile }) =>
    Effect.gen(function* () {
      const options = yield* resolveOpenOptions({
        branch: optionToUndefined(branch),
        base: optionToUndefined(base),
        existing,
        ide,
        noIde,
        pr: optionToUndefined(pr),
        prompt: optionToUndefined(prompt),
        profile: optionToUndefined(profile),
      });

      return yield* openCommand({ ...options, noAttach });
    }),
).pipe(
  Command.withDescription(
    "Create worktree, run setup, start tmux session, open IDE",
  ),
);

const projectsAddCliCommand = Command.make(
  "add",
  {
    path: Argument.string("path").pipe(
      Argument.withDescription("Path to repo"),
      Argument.optional,
    ),
    name: optionalStringFlag("name", "Override project name", "n", "NAME"),
  },
  ({ path, name }) =>
    projectsAddCommand({
      path: optionToUndefined(path),
      name: optionToUndefined(name),
    }),
).pipe(Command.withDescription("Add a project to the registry"));

const projectsRemoveCliCommand = Command.make(
  "remove",
  {
    path: Argument.string("path").pipe(
      Argument.withDescription("Path to repo"),
      Argument.optional,
    ),
  },
  ({ path }) => projectsRemoveCommand(optionToUndefined(path)),
).pipe(Command.withDescription("Remove a project from the registry"));

const projectsListCliCommand = Command.make("list", {}, () =>
  projectsListCommand(),
).pipe(Command.withDescription("List registered projects"));

const projectsCliCommand = Command.make("projects").pipe(
  Command.withDescription("Manage the project registry"),
  Command.withSubcommands([
    projectsAddCliCommand,
    projectsRemoveCliCommand,
    projectsListCliCommand,
  ]),
);

const tuiCliCommand = Command.make("tui", {}, () => tuiCommand()).pipe(
  Command.withDescription("Interactive TUI sidebar for managing worktrees"),
);

export const rootCommand = Command.make("wct").pipe(
  Command.withDescription("Git worktree workflow automation"),
  Command.withGlobalFlags([JsonFlag]),
  Command.withExamples([
    {
      command: "wct init",
      description: "Create a new .wct.yaml config file",
    },
    {
      command: "wct open feature-auth",
      description: "Create a worktree and launch the configured environment",
    },
    {
      command: "wct --completions fish",
      description: "Print Fish shell completions",
    },
  ]),
  Command.withSubcommands([
    cdCliCommand,
    closeCliCommand,
    downCliCommand,
    initCliCommand,
    listCliCommand,
    openCliCommand,
    projectsCliCommand,
    switchCliCommand,
    tuiCliCommand,
    upCliCommand,
  ]),
);
