import { describe, expect, test } from "bun:test";
import { formatSessionName } from "../src/services/tmux";

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

describe("tmux session parsing", () => {
	test("parses session list output", () => {
		const output = `main:0:3
myapp-feature-auth:1:2
myapp-fix-login:0:1`;

		const sessions = output.split("\n").map((line) => {
			const [name, attached, windows] = line.split(":");
			return {
				name,
				attached: attached === "1",
				windows: parseInt(windows, 10),
			};
		});

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
		const output = "";
		const sessions = output ? output.split("\n") : [];
		expect(sessions).toHaveLength(0);
	});
});
