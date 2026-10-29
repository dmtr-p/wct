import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { loadConfig, loadWorkspaceConfig } from "../src/config/loader";
import { runBunPromise } from "../src/effect/runtime";
import { liveSetupService } from "../src/services/setup-service";
import {
  type WorkspaceOpenOptions,
  type WorkspaceReporterEvent,
  WorkspaceService,
} from "../src/services/workspace-service";
import { liveWorktreeService } from "../src/services/worktree-service";
import { type IncludeRepo, makeIncludeRepo } from "./helpers/include-repo";
import { type ServiceOverrides, withTestServices } from "./helpers/services";

interface CopyScenario {
  name: string;
  project?: string;
  global?: string;
  include?: string;
  profile?: string;
  expected?: string;
}

const profileCopy = `profiles:
  selected:
    match: "feature/*"
    copy: [.profile.env]
`;

const scenarios: CopyScenario[] = [
  {
    name: "selected profile wins over project and include",
    project: `copy: [.project.env]\n${profileCopy}`,
    include: ".include.env\n",
    expected: ".profile.env",
  },
  {
    name: "selected profile wins over empty project list",
    project: `copy: []\n${profileCopy}`,
    include: ".include.env\n",
    expected: ".profile.env",
  },
  {
    name: "explicit profile wins without a branch match",
    project: profileCopy.replace("feature/*", "other/*"),
    profile: "selected",
    include: ".include.env\n",
    expected: ".profile.env",
  },
  {
    name: "global selected profile wins over include",
    global: `copy: [.global.env]\n${profileCopy}`,
    include: ".include.env\n",
    expected: ".profile.env",
  },
  {
    name: "project wins over include and global",
    project: "copy: [.project.env]\n",
    include: ".include.env\n",
    expected: ".project.env",
  },
  {
    name: "selected profile without copy preserves project copy",
    project:
      "copy: [.project.env]\nprofiles:\n  selected:\n    match: 'feature/*'\n    setup: []\n",
    include: ".include.env\n",
    expected: ".project.env",
  },
  {
    name: "include wins over global with missing project config",
    include: ".include.env\n",
    expected: ".include.env",
  },
  {
    name: "include wins when project omits copy",
    project: "setup: []\n",
    include: ".include.env\n",
    expected: ".include.env",
  },
  {
    name: "include wins over empty global list",
    global: "copy: []\n",
    include: ".include.env\n",
    expected: ".include.env",
  },
  {
    name: "selected profile without copy allows include",
    project: "profiles:\n  selected:\n    match: 'feature/*'\n    setup: []\n",
    include: ".include.env\n",
    expected: ".include.env",
  },
  {
    name: "unmatched profile allows include",
    project: profileCopy.replace("feature/*", "other/*"),
    include: ".include.env\n",
    expected: ".include.env",
  },
  {
    name: "disabled profile allows include",
    project: profileCopy,
    profile: "",
    include: ".include.env\n",
    expected: ".include.env",
  },
  {
    name: "missing include falls back to global",
    project: "setup: []\n",
    expected: ".global.env",
  },
  {
    name: "missing project and include fall back to global",
    expected: ".global.env",
  },
  {
    name: "unmatched profile falls back to global without include",
    project: profileCopy.replace("feature/*", "other/*"),
    expected: ".global.env",
  },
  {
    name: "project empty list disables all fallback",
    project: "copy: []\n",
    include: ".include.env\n",
  },
  {
    name: "profile empty list disables project and fallback",
    project: `copy: [.project.env]\n${profileCopy.replace("[.profile.env]", "[]")}`,
    include: ".include.env\n",
  },
  {
    name: "explicit profile empty list disables fallback",
    project: profileCopy
      .replace("[.profile.env]", "[]")
      .replace("feature/*", "other/*"),
    profile: "selected",
    include: ".include.env\n",
  },
  {
    name: "unmatched empty profile does not disable fallback",
    project: profileCopy
      .replace("[.profile.env]", "[]")
      .replace("feature/*", "other/*"),
    include: ".include.env\n",
    expected: ".include.env",
  },
  { name: "empty include disables global", include: "" },
  {
    name: "comments-only include disables global",
    include: "# Empty selection\n\n",
  },
  { name: "no-match include disables global", include: "*.missing\n" },
  {
    name: "empty global list disables copy without include",
    global: "copy: []\n",
  },
];

describe("WorkspaceService .worktreeinclude", () => {
  let fixture: IncludeRepo;
  beforeEach(async () => {
    fixture = await makeIncludeRepo();
    await fixture.write(".gitignore", "*.env\n");
    for (const file of [
      ".global.env",
      ".project.env",
      ".profile.env",
      ".include.env",
    ])
      await fixture.write(file);
    await Bun.write(join(fixture.home, ".wct.yaml"), "copy: [.global.env]\n");
  });
  afterEach(async () => {
    await fixture.cleanup();
  });

  const open = (
    options: Partial<WorkspaceOpenOptions> = {},
    overrides: ServiceOverrides = {},
  ) =>
    runBunPromise(
      withTestServices(
        WorkspaceService.use((service) =>
          service.open({
            branch: "feature/copy",
            cwd: fixture.repo,
            ...options,
          }),
        ),
        overrides,
      ),
    );

  test.each(scenarios)("$name", async (scenario) => {
    if (scenario.project !== undefined)
      await fixture.write(".wct.yaml", scenario.project);
    if (scenario.global !== undefined)
      await Bun.write(join(fixture.home, ".wct.yaml"), scenario.global);
    if (scenario.include !== undefined)
      await fixture.write(".worktreeinclude", scenario.include);
    const result = await open({ profile: scenario.profile });
    expect(result.created).toBe(true);
    const copied = result.attempts.copy;
    if (scenario.expected) {
      expect(copied).toEqual({
        attempted: true,
        ok: true,
        value: [{ file: scenario.expected, success: true }],
      });
      expect(
        await Bun.file(join(result.worktreePath, scenario.expected)).text(),
      ).toBe(scenario.expected);
    } else {
      expect(copied.attempted).toBe(false);
    }
    for (const file of [
      ".global.env",
      ".project.env",
      ".profile.env",
      ".include.env",
    ]) {
      expect(await Bun.file(join(result.worktreePath, file)).exists()).toBe(
        file === scenario.expected,
      );
    }
  });

  test("retains project copy provenance without changing loadConfig results", async () => {
    for (const project of [
      undefined,
      "setup: []\n",
      "copy: []\n",
      "copy: [.project.env]\n",
    ]) {
      await rm(join(fixture.repo, ".wct.yaml"), { force: true });
      if (project !== undefined) await fixture.write(".wct.yaml", project);
      const loaded = await runBunPromise(loadWorkspaceConfig(fixture.repo));
      expect(loaded.projectDefinesCopy).toBe(
        project?.startsWith("copy:") ?? false,
      );
      expect(loaded.config).toEqual(
        await runBunPromise(loadConfig(fixture.repo)),
      );
    }
  });

  test("works without either YAML config", async () => {
    await rm(join(fixture.home, ".wct.yaml"));
    await fixture.write(".worktreeinclude", ".include.env\n");
    const result = await open();
    expect(result.attempts.copy).toMatchObject({
      attempted: true,
      ok: true,
      value: [{ file: ".include.env", success: true }],
    });
  });

  test("uses the main repository's root include when invoked from a linked worktree subdirectory", async () => {
    await fixture.git(
      "worktree",
      "add",
      "-b",
      "caller",
      join(fixture.root, "caller"),
    );
    const cwd = join(fixture.root, "caller", "nested");
    await mkdir(cwd);
    await Bun.write(
      join(fixture.root, "caller", ".worktreeinclude"),
      ".global.env\n",
    );
    await fixture.write(".worktreeinclude", ".include.env\n");
    const result = await open({ cwd });
    expect(result.mainRepoPath).toBe(fixture.repo);
    expect(result.attempts.copy).toMatchObject({
      attempted: true,
      value: [{ file: ".include.env" }],
    });
  });

  test("ignores nested include files", async () => {
    await fixture.write("nested/.worktreeinclude", ".include.env\n");
    const result = await open();
    expect(result.attempts.copy).toMatchObject({
      attempted: true,
      value: [{ file: ".global.env" }],
    });
  });

  test("empty include selections skip copy progress", async () => {
    await fixture.write(".worktreeinclude", "*.missing\n");
    const events: WorkspaceReporterEvent[] = [];
    const result = await open({
      reporter: {
        event: (event) =>
          Effect.sync(() => {
            events.push(event);
          }),
      },
    });
    expect(result.attempts.copy.attempted).toBe(false);
    expect(
      events.some(
        (event) =>
          event._tag === "PhaseStarted" && event.phase._tag === "CopyingFiles",
      ),
    ).toBe(false);
  });

  test.each(["project", "profile", "global"])(
    "%s YAML copying filters tracked and nonignored matches",
    async (source) => {
      await fixture.write(".gitignore", "*.env\ntracked.txt\n");
      await fixture.write("nonignored.json");
      const copy = "copy: ['*']\n";
      if (source === "project") await fixture.write(".wct.yaml", copy);
      if (source === "profile")
        await fixture.write(
          ".wct.yaml",
          "profiles:\n  selected:\n    match: 'feature/*'\n    copy: ['*']\n",
        );
      if (source === "global")
        await Bun.write(join(fixture.home, ".wct.yaml"), copy);
      const result = await open();
      const copied = result.attempts.copy;
      expect(copied).toMatchObject({ attempted: true, ok: true });
      if (!copied.attempted || !copied.ok)
        throw new Error("Expected copy to succeed");
      expect(copied.value.map((file) => file.file).sort()).toEqual([
        ".global.env",
        ".include.env",
        ".profile.env",
        ".project.env",
      ]);
      expect(
        await Bun.file(join(result.worktreePath, "tracked.txt")).text(),
      ).toBe("tracked.txt");
      expect(
        await Bun.file(join(result.worktreePath, "nonignored.json")).exists(),
      ).toBe(false);
    },
  );

  test("copies before real setup commands and reports copy progress", async () => {
    await fixture.write(".worktreeinclude", ".include.env\n");
    await fixture.write(
      ".wct.yaml",
      `setup:
  - name: Read copied file
    command: 'cat .include.env > setup-result'
`,
    );
    const events: WorkspaceReporterEvent[] = [];
    const result = await open({
      reporter: {
        event: (event) =>
          Effect.sync(() => {
            events.push(event);
          }),
      },
    });
    expect(
      await Bun.file(join(result.worktreePath, "setup-result")).text(),
    ).toBe(".include.env");
    expect(result.attempts.setup).toMatchObject({
      attempted: true,
      ok: true,
      value: [{ _tag: "Succeeded" }],
    });
    const copyDone = events.findIndex(
      (event) => event._tag === "AttemptCompleted" && event.attempt === "copy",
    );
    const setupStarted = events.findIndex(
      (event) => event._tag === "AttemptStarted" && event.attempt === "setup",
    );
    expect(copyDone).toBeGreaterThan(-1);
    expect(setupStarted).toBeGreaterThan(copyDone);
    expect(events).toContainEqual({
      operation: "open",
      _tag: "PhaseStarted",
      phase: { _tag: "CopyingFiles" },
    });
  });

  test("reopening and up skip include copying and preserve existing files", async () => {
    await Bun.write(join(fixture.home, ".wct.yaml"), "copy: []\n");
    await fixture.write(".worktreeinclude", ".include.env\n");
    const first = await open();
    await Bun.write(
      join(first.worktreePath, ".include.env"),
      "local worktree edit",
    );
    await fixture.write(".include.env", "changed main repository");
    // Reopening must not even try to read the include file.
    await rm(join(fixture.repo, ".worktreeinclude"));
    await mkdir(join(fixture.repo, ".worktreeinclude"));
    const reopened = await open();
    expect(reopened.created).toBe(false);
    expect(reopened.attempts.copy.attempted).toBe(false);
    await runBunPromise(
      withTestServices(
        WorkspaceService.use((service) =>
          service.up({ path: first.worktreePath }),
        ),
      ),
    );
    expect(
      await Bun.file(join(first.worktreePath, ".include.env")).text(),
    ).toBe("local worktree edit");
  });

  test("retries failed initial include resolution on the registered worktree", async () => {
    await Bun.write(join(fixture.home, ".wct.yaml"), "copy: []\n");
    await fixture.write(
      ".wct.yaml",
      "setup:\n  - name: Read copied file\n    command: 'cat .include.env > setup-result'\n",
    );
    await mkdir(join(fixture.repo, ".worktreeinclude"));
    await expect(open()).rejects.toThrow("Failed to resolve");
    const registered = await runBunPromise(
      liveWorktreeService.findWorktreeByBranch("feature/copy", fixture.repo),
    );
    expect(registered).not.toBeNull();
    if (!registered)
      throw new Error("Expected the failed worktree to remain registered");
    expect(await Bun.file(join(registered.path, "setup-result")).exists()).toBe(
      false,
    );

    await rm(join(fixture.repo, ".worktreeinclude"), { recursive: true });
    await fixture.write(".worktreeinclude", ".include.env\n");
    const recovered = await open();
    expect(recovered.created).toBe(false);
    expect(recovered.worktreePath).toBe(registered.path);
    expect(recovered.attempts.copy).toMatchObject({
      attempted: true,
      ok: true,
    });
    expect(await Bun.file(join(registered.path, "setup-result")).text()).toBe(
      ".include.env",
    );

    await fixture.write(".include.env", "changed after successful recovery");
    expect((await open()).attempts.copy.attempted).toBe(false);
    expect(await Bun.file(join(registered.path, ".include.env")).text()).toBe(
      ".include.env",
    );
  });

  test("successful YAML override clears failed initial include processing", async () => {
    await mkdir(join(fixture.repo, ".worktreeinclude"));
    await expect(open()).rejects.toThrow("Failed to resolve");
    await fixture.write(".wct.yaml", "copy: []\n");
    expect((await open()).attempts.copy.attempted).toBe(false);
    await fixture.write(".wct.yaml", "setup: []\n");
    await rm(join(fixture.repo, ".worktreeinclude"), { recursive: true });
    await fixture.write(".worktreeinclude", ".include.env\n");
    const reopened = await open();
    expect(
      await Bun.file(join(reopened.worktreePath, ".include.env")).exists(),
    ).toBe(false);
  });

  test.each(["project", "profile", "global"])(
    "reopening preserves %s YAML copying",
    async (source) => {
      if (source === "project")
        await fixture.write(".wct.yaml", "copy: [.project.env]\n");
      if (source === "profile") await fixture.write(".wct.yaml", profileCopy);
      const first = await open();
      const file = `.${source}.env`;
      await fixture.write(file, "updated yaml source");
      await mkdir(join(fixture.repo, ".worktreeinclude"));
      const reopened = await open();
      expect(reopened.created).toBe(false);
      expect(reopened.attempts.copy).toMatchObject({
        attempted: true,
        ok: true,
      });
      expect(await Bun.file(join(first.worktreePath, file)).text()).toBe(
        "updated yaml source",
      );
    },
  );

  test.each(["project", "profile"])(
    "explicit %s copy skips an unreadable include",
    async (source) => {
      await fixture.write(
        ".wct.yaml",
        source === "project"
          ? "copy: []\n"
          : profileCopy.replace("[.profile.env]", "[]"),
      );
      await mkdir(join(fixture.repo, ".worktreeinclude"));
      expect((await open()).attempts.copy.attempted).toBe(false);
    },
  );

  test("include read and discovery failures are fatal before setup", async () => {
    let setupRan = false;
    const overrides: ServiceOverrides = {
      setup: {
        ...liveSetupService,
        runSetupCommands: () =>
          Effect.sync(() => {
            setupRan = true;
            return [];
          }),
      },
    };
    await fixture.write(
      ".wct.yaml",
      "setup:\n  - name: setup\n    command: 'true'\n",
    );
    await mkdir(join(fixture.repo, ".worktreeinclude"));
    await expect(open({}, overrides)).rejects.toThrow("Failed to resolve");
    expect(setupRan).toBe(false);
    await rm(join(fixture.repo, ".worktreeinclude"), { recursive: true });
    await fixture.write(".worktreeinclude", ".include.env\n");
    overrides.worktree = {
      ...liveWorktreeService,
      createWorktree: () =>
        Effect.promise(async () => {
          await Bun.write(join(fixture.repo, ".git", "index"), "invalid index");
          return {
            _tag: "Created" as const,
            path: join(fixture.root, "target"),
          };
        }),
    };
    await expect(
      open({ branch: "discovery-fails" }, overrides),
    ).rejects.toThrow("Failed to resolve");
    expect(setupRan).toBe(false);
  });

  test("copy failures use existing fatal errors and file failure reporting", async () => {
    await fixture.git("switch", "--quiet", "-c", "collision");
    await rm(join(fixture.repo, ".include.env"));
    await fixture.write(".include.env/tracked.txt");
    await fixture.git("add", "--force", ".include.env/tracked.txt");
    await fixture.git("commit", "--quiet", "-m", "Tracked directory collision");
    await fixture.git("switch", "--quiet", "main");
    await fixture.write(".include.env");
    await fixture.write(".first.env", "first partial copy");
    await fixture.write(".worktreeinclude", ".first.env\n.include.env\n");
    await fixture.write(
      ".wct.yaml",
      "setup:\n  - name: setup\n    command: 'touch setup-ran'\n",
    );
    const events: WorkspaceReporterEvent[] = [];
    await expect(
      open({
        branch: "collision",
        existing: true,
        reporter: {
          event: (event) =>
            Effect.sync(() => {
              events.push(event);
            }),
        },
      }),
    ).rejects.toThrow("Failed to copy files: .include.env:");
    expect(events).toContainEqual(
      expect.objectContaining({
        _tag: "CopyEntryFailed",
        file: ".include.env",
        reason: "copy_failed",
      }),
    );
    expect(
      events.some(
        (event) => event._tag === "AttemptStarted" && event.attempt === "setup",
      ),
    ).toBe(false);
    const registered = await runBunPromise(
      liveWorktreeService.findWorktreeByBranch("collision", fixture.repo),
    );
    if (!registered)
      throw new Error("Expected the failed worktree to remain registered");
    expect(await Bun.file(join(registered.path, ".first.env")).text()).toBe(
      "first partial copy",
    );
    await rm(join(registered.path, ".include.env"), { recursive: true });
    await fixture.write(".first.env", "updated before retry");
    const recovered = await open({ branch: "collision", existing: true });
    expect(recovered.created).toBe(false);
    expect(recovered.attempts.copy).toMatchObject({
      attempted: true,
      ok: true,
    });
    expect(await Bun.file(join(registered.path, ".include.env")).text()).toBe(
      ".include.env",
    );
    expect(await Bun.file(join(registered.path, ".first.env")).text()).toBe(
      "updated before retry",
    );
    expect(await Bun.file(join(registered.path, "setup-ran")).exists()).toBe(
      true,
    );

    await fixture.write(".include.env", "updated after recovery");
    await open({ branch: "collision", existing: true });
    expect(await Bun.file(join(registered.path, ".include.env")).text()).toBe(
      ".include.env",
    );
  });
});
