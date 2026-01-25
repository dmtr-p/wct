export interface SetupCommand {
	name: string;
	command: string;
	optional?: boolean;
}

export interface TmuxPane {
	name?: string;
	command?: string;
}

export const VALID_LAYOUTS = [
	"even-horizontal",
	"even-vertical",
	"main-horizontal",
	"main-vertical",
	"tiled",
] as const;

export type TmuxLayout = (typeof VALID_LAYOUTS)[number];

export interface TmuxWindow {
	name: string;
	command?: string;
	split?: "horizontal" | "vertical";
	layout?: TmuxLayout;
	panes?: TmuxPane[];
}

export interface TmuxConfig {
	windows?: TmuxWindow[];
}

export interface IdeConfig {
	command: string;
}

export interface TabConfig {
	version?: number;
	worktree_dir?: string;
	project_name?: string;
	copy?: string[];
	setup?: SetupCommand[];
	ide?: IdeConfig;
	tmux?: TmuxConfig;
}

export interface ResolvedConfig extends TabConfig {
	worktree_dir: string;
	project_name: string;
}
