import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

// We'll test the pure DB operations by setting HOME to a temp dir
describe("registry-service", () => {
  let tempDir: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    tempDir = join(tmpdir(), `wct-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    originalHome = process.env.HOME;
    process.env.HOME = tempDir;
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("register and list repos", async () => {
    const { liveRegistryService } = await import(
      "../../src/services/registry-service"
    );
    const { Effect } = await import("effect");

    const item = await Effect.runPromise(
      liveRegistryService.register("/tmp/fake-repo", "test-project"),
    );
    expect(item.repo_path).toBe("/tmp/fake-repo");
    expect(item.project).toBe("test-project");

    const repos = await Effect.runPromise(liveRegistryService.listRepos());
    expect(repos.length).toBeGreaterThanOrEqual(1);
    expect(repos.find((r) => r.repo_path === "/tmp/fake-repo")).toBeDefined();

    const removed = await Effect.runPromise(
      liveRegistryService.unregister("/tmp/fake-repo"),
    );
    expect(removed).toBe(true);
  });

  test("register is idempotent and updates project name", async () => {
    const { liveRegistryService } = await import(
      "../../src/services/registry-service"
    );
    const { Effect } = await import("effect");

    await Effect.runPromise(
      liveRegistryService.register("/tmp/idem-repo", "old-name"),
    );
    const updated = await Effect.runPromise(
      liveRegistryService.register("/tmp/idem-repo", "new-name"),
    );
    expect(updated.project).toBe("new-name");

    await Effect.runPromise(
      liveRegistryService.unregister("/tmp/idem-repo"),
    );
  });

  test("unregister returns false for unknown path", async () => {
    const { liveRegistryService } = await import(
      "../../src/services/registry-service"
    );
    const { Effect } = await import("effect");

    const removed = await Effect.runPromise(
      liveRegistryService.unregister("/tmp/does-not-exist"),
    );
    expect(removed).toBe(false);
  });
});
