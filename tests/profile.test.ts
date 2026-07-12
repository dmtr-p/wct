import { describe, expect, test } from "vitest";
import { resolveProfile } from "../src/config/loader";
import type { ResolvedConfig } from "../src/config/schema";

function baseConfig(overrides?: Partial<ResolvedConfig>): ResolvedConfig {
  return {
    worktree_dir: "../worktrees",
    project_name: "test",
    work_dir: ".",
    setup: [{ name: "Install", command: "bun install" }],
    tmux: { windows: [{ name: "main" }] },
    copy: [".env"],
    ...overrides,
  };
}

describe("resolveProfile", () => {
  test("returns base config when no profiles defined", () => {
    const config = baseConfig();
    const { config: result } = resolveProfile(config, "feature/auth");
    expect(result.tmux).toEqual(config.tmux);
  });

  test("returns no profileName when no profiles defined", () => {
    const config = baseConfig();
    const { profileName } = resolveProfile(config, "feature/auth");
    expect(profileName).toBeUndefined();
  });

  test("returns base config when no profile matches", () => {
    const config = baseConfig({
      profiles: {
        frontend: {
          match: "feature/frontend-*",
          tmux: { windows: [{ name: "dev" }] },
        },
      },
    });
    const { config: result } = resolveProfile(config, "feature/backend-auth");
    expect(result.tmux).toEqual(config.tmux);
  });

  test("profile overrides work_dir", () => {
    const config = baseConfig({
      work_dir: "apps/web",
      profiles: { api: { match: "api/*", work_dir: "apps/api" } },
    });
    const { config: result } = resolveProfile(config, "api/users");
    expect(result.work_dir).toBe("apps/api");
  });

  test("auto-matches profile by branch glob", () => {
    const config = baseConfig({
      profiles: {
        frontend: {
          match: "feature/frontend-*",
          tmux: { windows: [{ name: "dev" }] },
        },
      },
    });
    const { config: result, profileName } = resolveProfile(
      config,
      "feature/frontend-auth",
    );
    expect(result.tmux).toEqual({ windows: [{ name: "dev" }] });
    expect(profileName).toBe("frontend");
  });

  test("auto-matches with array of globs", () => {
    const config = baseConfig({
      profiles: {
        docs: {
          match: ["docs/*", "content/*"],
          tmux: { windows: [{ name: "edit" }] },
        },
      },
    });
    const { config: result, profileName } = resolveProfile(
      config,
      "content/new-page",
    );
    expect(result.tmux).toEqual({ windows: [{ name: "edit" }] });
    expect(profileName).toBe("docs");
  });

  test("first match wins when multiple profiles match", () => {
    const config = baseConfig({
      profiles: {
        specific: {
          match: "feature/frontend-auth",
          tmux: { windows: [{ name: "specific" }] },
        },
        broad: {
          match: "feature/*",
          tmux: { windows: [{ name: "broad" }] },
        },
      },
    });
    const { config: result, profileName } = resolveProfile(
      config,
      "feature/frontend-auth",
    );
    expect(result.tmux).toEqual({ windows: [{ name: "specific" }] });
    expect(profileName).toBe("specific");
  });

  test("explicit profile selection by name", () => {
    const config = baseConfig({
      profiles: {
        minimal: {
          tmux: { windows: [{ name: "shell" }] },
        },
      },
    });
    const { config: result, profileName } = resolveProfile(
      config,
      "any-branch",
      "minimal",
    );
    expect(result.tmux).toEqual({ windows: [{ name: "shell" }] });
    expect(profileName).toBe("minimal");
  });

  test("explicit profile errors on unknown name", () => {
    const config = baseConfig({
      profiles: {
        minimal: {
          tmux: { windows: [{ name: "shell" }] },
        },
      },
    });
    expect(() => resolveProfile(config, "any-branch", "nonexistent")).toThrow(
      /nonexistent/,
    );
  });

  test("profile replaces only sections it defines", () => {
    const config = baseConfig({
      profiles: {
        frontend: {
          match: "feature/frontend-*",
          tmux: { windows: [{ name: "dev" }] },
        },
      },
    });
    const { config: result } = resolveProfile(config, "feature/frontend-auth");
    expect(result.tmux).toEqual({ windows: [{ name: "dev" }] });
    expect(result.setup).toEqual([{ name: "Install", command: "bun install" }]);
    expect(result.copy).toEqual([".env"]);
  });

  test("profile can replace all configurable sections", () => {
    const config = baseConfig({
      profiles: {
        full: {
          match: "full/*",
          setup: [{ name: "Build", command: "make" }],
          tmux: { windows: [{ name: "editor" }] },
          copy: [".gitignore"],
        },
      },
    });
    const { config: result } = resolveProfile(config, "full/test");
    expect(result.setup).toEqual([{ name: "Build", command: "make" }]);
    expect(result.tmux).toEqual({ windows: [{ name: "editor" }] });
    expect(result.copy).toEqual([".gitignore"]);
  });

  test("empty string profile treated as no profile", () => {
    const config = baseConfig({
      profiles: {
        minimal: {
          tmux: { windows: [{ name: "shell" }] },
        },
      },
    });
    const { config: result } = resolveProfile(config, "main", "");
    expect(result.tmux).toEqual(config.tmux);
  });

  test("profile without match is skipped during auto-matching", () => {
    const config = baseConfig({
      profiles: {
        manual: {
          tmux: { windows: [{ name: "manual" }] },
        },
      },
    });
    const { config: result } = resolveProfile(config, "any-branch");
    expect(result.tmux).toEqual(config.tmux);
  });

  test("strips profiles key from returned config", () => {
    const config = baseConfig({
      profiles: {
        minimal: {
          match: "main",
          tmux: { windows: [{ name: "shell" }] },
        },
      },
    });
    const { config: result } = resolveProfile(config, "main");
    expect(result.profiles).toBeUndefined();
  });
});
