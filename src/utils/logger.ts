const colors = {
	red: Bun.color("red", "ansi") ?? "",
	green: Bun.color("green", "ansi") ?? "",
	yellow: Bun.color("yellow", "ansi") ?? "",
	blue: Bun.color("blue", "ansi") ?? "",
	cyan: Bun.color("cyan", "ansi") ?? "",
	gray: Bun.color("gray", "ansi") ?? "",
	reset: "\x1b[0m",
	bold: "\x1b[1m",
};

export function info(message: string): void {
	console.log(`${colors.blue}info${colors.reset} ${message}`);
}

export function success(message: string): void {
	console.log(`${colors.green}done${colors.reset} ${message}`);
}

export function warn(message: string): void {
	console.log(`${colors.yellow}warn${colors.reset} ${message}`);
}

export function error(message: string): void {
	console.error(`${colors.red}error${colors.reset} ${message}`);
}

export function step(current: number, total: number, message: string): void {
	const prefix = `${colors.cyan}[${current}/${total}]${colors.reset}`;
	console.log(`${prefix} ${message}`);
}

export function dim(message: string): string {
	return `${colors.gray}${message}${colors.reset}`;
}

export function bold(message: string): string {
	return `${colors.bold}${message}${colors.reset}`;
}
