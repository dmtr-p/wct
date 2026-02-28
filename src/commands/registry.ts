import { commandDef as closeDef } from "./close";
import { commandDef as completionsDef } from "./completions-def";
import { commandDef as downDef } from "./down";
import { commandDef as initDef } from "./init";
import { commandDef as listDef } from "./list";
import { commandDef as openDef } from "./open";
import { commandDef as statusDef } from "./status";
import { commandDef as upDef } from "./up";

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
  completionType?: "branch" | "worktree";
}

export const COMMANDS: CommandDef[] = [
  closeDef,
  completionsDef,
  downDef,
  initDef,
  listDef,
  openDef,
  statusDef,
  upDef,
];
