import type { CommandDef } from "./registry";

export const commandDef: CommandDef = {
  name: "completions",
  description: "Output shell completion script",
  args: "<shell>",
};
