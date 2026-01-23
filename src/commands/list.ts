import { loadConfig } from "../config/loader";
import { formatSessionName, listSessions } from "../services/tmux";
import { listWorktrees } from "../services/worktree";
import * as logger from "../utils/logger";

interface WorktreeRow {
	branch: string;
	path: string;
	sessionName: string;
	status: string;
}

export async function listCommand(): Promise<void> {
	const cwd = process.cwd();
	const { config } = await loadConfig(cwd);
	const projectName =
		config?.project_name ?? cwd.split("/").filter(Boolean).pop() ?? "project";

	const worktrees = await listWorktrees();
	const sessions = await listSessions();

	if (worktrees.length === 0) {
		logger.info("No worktrees found");
		return;
	}

	const rows: WorktreeRow[] = [];

	for (const wt of worktrees) {
		if (wt.isBare) continue;

		const branch = wt.branch || "(unknown)";
		const sessionName = formatSessionName(projectName, branch);
		const session = sessions.find((s) => s.name === sessionName);

		rows.push({
			branch,
			path: wt.path,
			sessionName: session ? sessionName : "-",
			status: session ? (session.attached ? "attached" : "detached") : "-",
		});
	}

	const headers = ["BRANCH", "WORKTREE", "TMUX SESSION", "STATUS"];
	const colWidths = [
		Math.max(headers[0].length, ...rows.map((r) => r.branch.length)),
		Math.max(headers[1].length, ...rows.map((r) => r.path.length)),
		Math.max(headers[2].length, ...rows.map((r) => r.sessionName.length)),
		Math.max(headers[3].length, ...rows.map((r) => r.status.length)),
	];

	const headerLine = headers.map((h, i) => h.padEnd(colWidths[i])).join("  ");
	console.log(logger.bold(headerLine));

	for (const row of rows) {
		const line = [
			row.branch.padEnd(colWidths[0]),
			row.path.padEnd(colWidths[1]),
			row.sessionName.padEnd(colWidths[2]),
			row.status.padEnd(colWidths[3]),
		].join("  ");
		console.log(line);
	}
}
