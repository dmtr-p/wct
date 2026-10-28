import { Argument, Command, Flag, type Param } from "effect/cli";
import type { CommandDef, CommandOption } from "../commands/command-def";

interface ParameterDefinition {
  readonly param: Param.Any;
  readonly option?: CommandOption;
  readonly argument?: string;
}

interface CommandDefinition {
  readonly name: string;
  readonly description: string;
  readonly aliases?: string[];
  readonly parameters: Record<string, ParameterDefinition>;
  readonly completionType?: CommandDef["completionType"];
  readonly subcommands?: CommandDefinition[];
}

function booleanOption(name: string, description: string, short?: string) {
  let param = Flag.Boolean(name).pipe(
    Flag.withoutNegation,
    Flag.withDescription(description),
    Flag.withDefault(false),
  );
  if (short) param = param.pipe(Flag.withAlias(short));
  return {
    param,
    option: { name, description, short, type: "boolean" as const },
  };
}

function stringOption(
  name: string,
  description: string,
  placeholder: string,
  short?: string,
  completionValues?: string,
) {
  let param = Flag.String(name).pipe(
    Flag.withDescription(description),
    Flag.withMetavar(placeholder),
    Flag.optional,
  );
  if (short) param = param.pipe(Flag.withAlias(short));
  return {
    param,
    option: {
      name,
      description,
      placeholder,
      short,
      completionValues,
      type: "string" as const,
    },
  };
}

function argument(name: string, description: string) {
  return {
    param: Argument.String(name).pipe(Argument.withDescription(description)),
    argument: `<${name}>`,
  };
}

function optionalArgument(name: string, description: string) {
  const required = argument(name, description);
  return {
    param: required.param.pipe(Argument.optional),
    argument: `[<${name}>]`,
  };
}

function variadicArgument(name: string, description: string) {
  const required = argument(name, description);
  return {
    param: required.param.pipe(Argument.variadic({ min: 1 })),
    argument: `<${name}...>`,
  };
}

const profile = stringOption(
  "profile",
  "Use a named config profile",
  "NAME",
  "P",
  "__wct_profiles",
);
const path = stringOption("path", "Path to worktree directory", "path");
const worktreeBranch = stringOption(
  "branch",
  "Branch name to resolve worktree from",
  "NAME",
  "b",
  "__wct_worktree_branches",
);
const noAttach = booleanOption(
  "no-attach",
  "Do not attach to tmux outside tmux",
);
const branch = argument("branch", "Branch name");
const projectPath = optionalArgument("path", "Path to repo");

export const projectDefinitions = {
  add: {
    name: "add",
    description: "Add a project to the registry",
    parameters: {
      path: projectPath,
      name: stringOption("name", "Override project display name", "NAME", "n"),
    },
    completionType: "path",
  },
  remove: {
    name: "remove",
    description: "Remove a project from the registry",
    parameters: { path: projectPath },
    completionType: "path",
  },
  list: {
    name: "list",
    description: "List registered projects",
    parameters: {},
  },
} satisfies Record<string, CommandDefinition>;

export const commandDefinitions = {
  cd: {
    name: "cd",
    description: "Open a shell in a worktree directory",
    parameters: { branch },
    completionType: "worktree",
  },
  close: {
    name: "close",
    description: "Stop tmux, run down scripts, and remove worktree",
    parameters: {
      branches: variadicArgument("branch", "Branch name"),
      profile,
      yes: booleanOption("yes", "Skip confirmation prompt", "y"),
      force: booleanOption(
        "force",
        "Force removal even if worktree is dirty",
        "f",
      ),
    },
    completionType: "worktree",
  },
  down: {
    name: "down",
    description: "Stop tmux session and run down scripts",
    parameters: { profile, path, branch: worktreeBranch },
  },
  init: {
    name: "init",
    description: "Generate a starter .wct.yaml config file",
    parameters: {},
  },
  list: {
    name: "list",
    description: "Show worktrees with tmux, changes, and sync status",
    parameters: {
      short: booleanOption("short", "Print branch names only", "s"),
    },
  },
  open: {
    name: "open",
    description: "Create worktree, run setup, and start configured environment",
    parameters: {
      branch: optionalArgument("branch", "Branch name"),
      base: stringOption(
        "base",
        "Base branch for new worktree (default: base_branch config or HEAD)",
        "BRANCH",
        "b",
      ),
      existing: booleanOption("existing", "Use existing branch", "e"),
      noAttach,
      pr: stringOption("pr", "Open worktree from a GitHub PR", "NUMBER_OR_URL"),
      profile,
    },
    completionType: "branch",
  },
  projects: {
    name: "projects",
    description: "Manage the project registry",
    parameters: {},
    subcommands: Object.values(projectDefinitions),
  },
  switch: {
    name: "switch",
    aliases: ["sw"],
    description: "Switch to another worktree's tmux session",
    parameters: { branch },
    completionType: "worktree",
  },
  tui: {
    name: "tui",
    description:
      "Interactive TUI sidebar for managing worktrees. Mouse on by default (wheel scrolls, click selects); set WCT_DISABLE_MOUSE=1 to disable.",
    parameters: {},
  },
  up: {
    name: "up",
    description: "Start configured environment for a worktree",
    parameters: { noAttach, path, branch: worktreeBranch, profile },
  },
} satisfies Record<string, CommandDefinition>;

export function commandConfig<D extends CommandDefinition>(definition: D) {
  return Object.fromEntries(
    Object.entries(definition.parameters).map(([key, value]) => [
      key,
      value.param,
    ]),
  ) as { [K in keyof D["parameters"]]: D["parameters"][K]["param"] };
}

export function commandMetadata(definition: CommandDefinition) {
  return <N extends string, I, CI, E, R>(
    command: Command.Command<N, I, CI, E, R>,
  ) => {
    const described = command.pipe(
      Command.withDescription(definition.description),
    );
    const alias = definition.aliases?.[0];
    return alias ? described.pipe(Command.withAlias(alias)) : described;
  };
}

function completionDefinition(definition: CommandDefinition): CommandDef {
  const parameters = Object.values(definition.parameters);
  return {
    name: definition.name,
    description: definition.description,
    aliases: definition.aliases,
    args:
      parameters
        .flatMap((parameter) =>
          parameter.argument ? [parameter.argument] : [],
        )
        .join(" ") || undefined,
    options: parameters.flatMap((parameter) =>
      parameter.option ? [parameter.option] : [],
    ),
    completionType: definition.completionType,
    subcommands: definition.subcommands?.map(completionDefinition),
  };
}

export const completionCommands = Object.fromEntries(
  Object.entries(commandDefinitions).map(([key, definition]) => [
    key,
    completionDefinition(definition),
  ]),
) as { [K in keyof typeof commandDefinitions]: CommandDef };

export const {
  cd: cdCommandDef,
  close: closeCommandDef,
  down: downCommandDef,
  init: initCommandDef,
  list: listCommandDef,
  open: openCommandDef,
  projects: projectsCommandDef,
  switch: switchCommandDef,
  tui: tuiCommandDef,
  up: upCommandDef,
} = completionCommands;
