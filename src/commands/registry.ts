export interface CommandOption {
  name: string;
  short?: string;
  type: "boolean" | "string";
  placeholder?: string;
  description: string;
}

export interface CommandDef {
  name: string;
  description: string;
  args?: string;
  options?: CommandOption[];
}

export const COMMANDS: CommandDef[] = [
  {
    name: "open",
    description: "Create worktree, run setup, start tmux session, open IDE",
    args: "<branch>",
    options: [
      {
        name: "existing",
        short: "e",
        type: "boolean",
        description: "Use existing branch",
      },
      {
        name: "base",
        short: "b",
        type: "string",
        placeholder: "branch",
        description: "Base branch for new worktree (default: HEAD)",
      },
    ],
  },
  {
    name: "up",
    description: "Start tmux session and open IDE in current directory",
  },
  {
    name: "down",
    description: "Kill tmux session for current directory",
  },
  {
    name: "close",
    description: "Kill tmux session and remove worktree",
    args: "<branch>",
    options: [
      {
        name: "yes",
        short: "y",
        type: "boolean",
        description: "Skip confirmation prompt",
      },
      {
        name: "force",
        short: "f",
        type: "boolean",
        description: "Force removal even if worktree is dirty",
      },
    ],
  },
  {
    name: "list",
    description: "Show active worktrees with tmux session status",
  },
  {
    name: "init",
    description: "Generate a starter .wct.yaml config file",
  },
];
