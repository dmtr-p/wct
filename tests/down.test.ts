import { describe, expect, test } from "bun:test";
import { downCommand } from "../src/commands/down";
import { formatSessionName } from "../src/services/tmux";

describe("downCommand", () => {
	test("is exported as a function", () => {
		expect(typeof downCommand).toBe("function");
	});
});

describe("down session name derivation", () => {
	test("derives session name from directory basename", () => {
		const sessionName = formatSessionName("myapp-feature-auth");
		expect(sessionName).toBe("myapp-feature-auth");
	});

	test("sanitizes special characters in dirname", () => {
		const sessionName = formatSessionName("myapp.feature");
		expect(sessionName).toBe("myapp-feature");
	});
});
