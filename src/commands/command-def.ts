export interface CommandOption {
  name: string;
  short?: string;
  type: "boolean" | "string";
  placeholder?: string;
  description: string;
  completionValues?: string;
}

export interface CommandDef {
  name: string;
  aliases?: string[];
  description: string;
  args?: string;
  options?: CommandOption[];
  completionType?: "branch" | "worktree";
  subcommands?: CommandDef[];
}
