export interface SetupCommand {
	name: string;
	command: string;
	optional?: boolean;
}

export interface TmuxPane {
	name: string;
	command?: string;
}

export interface TmuxConfig {
	layout?: "panes" | "windows";
	split?: "horizontal" | "vertical";
	panes?: TmuxPane[];
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
