import { $ } from "bun";
import type { TmuxConfig } from "../config/schema";

export interface TmuxSession {
	name: string;
	attached: boolean;
	windows: number;
}

export async function listSessions(): Promise<TmuxSession[]> {
	try {
		const result =
			await $`tmux list-sessions -F "#{session_name}:#{session_attached}:#{session_windows}"`.quiet();
		const output = result.text().trim();

		if (!output) {
			return [];
		}

		return output.split("\n").map((line) => {
			const [name, attached, windows] = line.split(":");
			return {
				name,
				attached: attached === "1",
				windows: parseInt(windows, 10),
			};
		});
	} catch {
		return [];
	}
}

export async function sessionExists(name: string): Promise<boolean> {
	try {
		await $`tmux has-session -t ${name}`.quiet();
		return true;
	} catch {
		return false;
	}
}

export async function getSessionStatus(
	name: string,
): Promise<"attached" | "detached" | null> {
	const sessions = await listSessions();
	const session = sessions.find((s) => s.name === name);
	if (!session) {
		return null;
	}
	return session.attached ? "attached" : "detached";
}

export interface CreateSessionResult {
	success: boolean;
	sessionName: string;
	error?: string;
	alreadyExists?: boolean;
}

export async function createSession(
	name: string,
	workingDir: string,
	config?: TmuxConfig,
): Promise<CreateSessionResult> {
	if (await sessionExists(name)) {
		return {
			success: true,
			sessionName: name,
			alreadyExists: true,
		};
	}

	try {
		const layout = config?.layout ?? "panes";
		const split = config?.split ?? "horizontal";
		const panes = config?.panes ?? [{ name: "shell" }];

		await $`tmux new-session -d -s ${name} -c ${workingDir}`.quiet();

		if (panes.length > 0 && panes[0].command) {
			await $`tmux send-keys -t ${name} ${panes[0].command} Enter`.quiet();
		}

		if (layout === "panes") {
			for (let i = 1; i < panes.length; i++) {
				const pane = panes[i];
				const splitFlag = split === "horizontal" ? "-h" : "-v";

				await $`tmux split-window ${splitFlag} -t ${name} -c ${workingDir}`.quiet();

				if (pane.command) {
					await $`tmux send-keys -t ${name} ${pane.command} Enter`.quiet();
				}
			}

			await $`tmux select-layout -t ${name} tiled`.quiet();
		} else {
			for (let i = 1; i < panes.length; i++) {
				const pane = panes[i];

				await $`tmux new-window -t ${name} -n ${pane.name} -c ${workingDir}`.quiet();

				if (pane.command) {
					await $`tmux send-keys -t ${name}:${pane.name} ${pane.command} Enter`.quiet();
				}
			}

			await $`tmux select-window -t ${name}:0`.quiet();
		}

		return { success: true, sessionName: name };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { success: false, sessionName: name, error: message };
	}
}

export function formatSessionName(projectName: string, branch: string): string {
	const sanitizedBranch = branch.replace(/[^a-zA-Z0-9_-]/g, "-");
	return `${projectName}-${sanitizedBranch}`;
}
