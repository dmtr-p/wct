import type { CommandOption } from "../commands/command-def";

export const COMPLETION_SHELLS = ["bash", "zsh", "fish", "sh"] as const;
export const GLOBAL_LOG_LEVELS = [
  "all",
  "trace",
  "debug",
  "info",
  "warn",
  "warning",
  "error",
  "fatal",
  "none",
] as const;

export const jsonOption = {
  name: "json",
  type: "boolean",
  description: "Output results as JSON",
} as const satisfies CommandOption;

export const completionsOption = {
  name: "completions",
  type: "string",
  description: "Print shell completion script",
  values: COMPLETION_SHELLS,
} as const;

export const globalOptions: ReadonlyArray<
  CommandOption & { values?: readonly string[] }
> = [
  {
    name: "help",
    short: "h",
    type: "boolean",
    description: "Show help information",
  },
  {
    name: "version",
    short: "v",
    type: "boolean",
    description: "Show version information",
  },
  completionsOption,
  {
    name: "log-level",
    type: "string",
    description: "Sets the minimum log level",
    values: GLOBAL_LOG_LEVELS,
  },
  jsonOption,
];
