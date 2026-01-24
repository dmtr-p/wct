import { describe, expect, test } from "bun:test";
import {
	formatSessionName,
	getCurrentSession,
	parseSessionListOutput,
} from "../src/services/tmux";

describe("formatSessionName", () => {
	test("formats simple branch name", () => {
		const result = formatSessionName("myapp", "feature-auth");
		expect(result).toBe("myapp-feature-auth");
	});

	test("sanitizes branch with slashes", () => {
		const result = formatSessionName("myapp", "feature/auth");
		expect(result).toBe("myapp-feature-auth");
	});

	test("sanitizes branch with special characters", () => {
		const result = formatSessionName("myapp", "feature@auth#test");
		expect(result).toBe("myapp-feature-auth-test");
	});

	test("handles underscores and hyphens", () => {
		const result = formatSessionName("my_app", "feature_auth-test");
		expect(result).toBe("my_app-feature_auth-test");
	});
});

describe("parseSessionListOutput", () => {
	test("parses session list output", () => {
		const output = `main:0:3
myapp-feature-auth:1:2
myapp-fix-login:0:1`;

		const sessions = parseSessionListOutput(output);

		expect(sessions).toHaveLength(3);

		expect(sessions[0].name).toBe("main");
		expect(sessions[0].attached).toBe(false);
		expect(sessions[0].windows).toBe(3);

		expect(sessions[1].name).toBe("myapp-feature-auth");
		expect(sessions[1].attached).toBe(true);
		expect(sessions[1].windows).toBe(2);

		expect(sessions[2].name).toBe("myapp-fix-login");
		expect(sessions[2].attached).toBe(false);
		expect(sessions[2].windows).toBe(1);
	});

	test("handles empty session list", () => {
		const sessions = parseSessionListOutput("");
		expect(sessions).toHaveLength(0);
	});
});

describe("getCurrentSession", () => {
	test("returns null when TMUX env is not set", async () => {
		const originalTmux = process.env.TMUX;
		delete process.env.TMUX;

		const result = await getCurrentSession();
		expect(result).toBeNull();

		if (originalTmux !== undefined) {
			process.env.TMUX = originalTmux;
		}
	});
});
