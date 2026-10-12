import { Option } from "effect";
import { Command } from "effect/cli";
import { cdCommand } from "../commands/cd";
import { closeCommand } from "../commands/close";
import { downCommand } from "../commands/down";
import { initCommand } from "../commands/init";
import { listCommand } from "../commands/list";
import { openCommand } from "../commands/open";
import {
  projectsAddCommand,
  projectsListCommand,
  projectsRemoveCommand,
} from "../commands/projects";
import { switchCommand } from "../commands/switch";
import { tuiCommand } from "../commands/tui";
import { upCommand } from "../commands/up";
import {
  commandConfig,
  commandMetadata,
  commandDefinitions as defs,
  projectDefinitions,
} from "./command-metadata";
import { JsonFlag } from "./json-flag";

function optionToUndefined<A>(option: Option.Option<A>): A | undefined {
  return Option.isSome(option) ? option.value : undefined;
}

const cdCliCommand = Command.make(
  defs.cd.name,
  commandConfig(defs.cd),
  ({ branch }) => cdCommand(branch),
).pipe(commandMetadata(defs.cd));

const closeCliCommand = Command.make(
  defs.close.name,
  commandConfig(defs.close),
  ({ branches, yes, force, profile }) =>
    closeCommand({
      branches: [...branches],
      profile: optionToUndefined(profile),
      yes,
      force,
    }),
).pipe(commandMetadata(defs.close));

const downCliCommand = Command.make(
  defs.down.name,
  commandConfig(defs.down),
  ({ path, branch, profile }) =>
    downCommand({
      profile: optionToUndefined(profile),
      path: optionToUndefined(path),
      branch: optionToUndefined(branch),
    }),
).pipe(commandMetadata(defs.down));

const initCliCommand = Command.make(
  defs.init.name,
  commandConfig(defs.init),
  () => initCommand,
).pipe(commandMetadata(defs.init));

const listCliCommand = Command.make(
  defs.list.name,
  commandConfig(defs.list),
  ({ short }) => listCommand({ short }),
).pipe(commandMetadata(defs.list));

const switchCliCommand = Command.make(
  defs.switch.name,
  commandConfig(defs.switch),
  ({ branch }) => switchCommand(branch),
).pipe(commandMetadata(defs.switch));

const upCliCommand = Command.make(
  defs.up.name,
  commandConfig(defs.up),
  ({ noAttach, path, branch, profile }) =>
    upCommand({
      noAttach,
      path: optionToUndefined(path),
      branch: optionToUndefined(branch),
      profile: optionToUndefined(profile),
    }),
).pipe(commandMetadata(defs.up));

const openCliCommand = Command.make(
  defs.open.name,
  commandConfig(defs.open),
  ({ branch, base, existing, noAttach, pr, profile }) =>
    openCommand({
      branch: optionToUndefined(branch),
      base: optionToUndefined(base),
      existing,
      noAttach,
      pr: optionToUndefined(pr),
      profile: optionToUndefined(profile),
    }),
).pipe(commandMetadata(defs.open));

const projectsAddCliCommand = Command.make(
  projectDefinitions.add.name,
  commandConfig(projectDefinitions.add),
  ({ path, name }) =>
    projectsAddCommand({
      path: optionToUndefined(path),
      name: optionToUndefined(name),
    }),
).pipe(commandMetadata(projectDefinitions.add));

const projectsRemoveCliCommand = Command.make(
  projectDefinitions.remove.name,
  commandConfig(projectDefinitions.remove),
  ({ path }) => projectsRemoveCommand(optionToUndefined(path)),
).pipe(commandMetadata(projectDefinitions.remove));

const projectsListCliCommand = Command.make(
  projectDefinitions.list.name,
  commandConfig(projectDefinitions.list),
  () => projectsListCommand,
).pipe(commandMetadata(projectDefinitions.list));

const projectsCliCommand = Command.make(defs.projects.name).pipe(
  commandMetadata(defs.projects),
  Command.withSubcommands([
    projectsAddCliCommand,
    projectsRemoveCliCommand,
    projectsListCliCommand,
  ]),
);

const tuiCliCommand = Command.make(
  defs.tui.name,
  commandConfig(defs.tui),
  () => tuiCommand,
).pipe(commandMetadata(defs.tui));

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
