import { describe, expect, test } from "vitest";
import { resolveProfile } from "../src/config/loader";
import type { ResolvedConfig } from "../src/config/schema";

function baseConfig(overrides?: Partial<ResolvedConfig>): ResolvedConfig {
  return {
    worktree_dir: "../worktrees",
    project_name: "test",
    setup: [{ name: "Install", command: "bun install" }],
    ide: { command: "code ." },
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
    expect(result.ide).toEqual(config.ide);
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
          ide: { command: "cursor ." },
        },
        broad: {
          match: "feature/*",
          ide: { command: "vim ." },
        },
      },
    });
    const { config: result, profileName } = resolveProfile(
      config,
      "feature/frontend-auth",
    );
    expect(result.ide).toEqual({ command: "cursor ." });
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
    expect(result.ide).toEqual({ command: "code ." });
    expect(result.setup).toEqual([{ name: "Install", command: "bun install" }]);
    expect(result.copy).toEqual([".env"]);
  });

  test("profile can replace all four sections", () => {
    const config = baseConfig({
      profiles: {
        full: {
          match: "full/*",
          setup: [{ name: "Build", command: "make" }],
          ide: { command: "vim ." },
          tmux: { windows: [{ name: "editor" }] },
          copy: [".gitignore"],
        },
      },
    });
    const { config: result } = resolveProfile(config, "full/test");
    expect(result.setup).toEqual([{ name: "Build", command: "make" }]);
    expect(result.ide).toEqual({ command: "vim ." });
    expect(result.tmux).toEqual({ windows: [{ name: "editor" }] });
    expect(result.copy).toEqual([".gitignore"]);
  });

  test("profile ide.open overrides base ide without discarding command", () => {
    const config = baseConfig({
      ide: {
        name: "vscode",
        command: "code $WCT_WORKTREE_DIR",
        fork_workspace: true,
      },
      profiles: {
        quiet: {
          ide: { open: false },
        },
      },
    });

    const { config: result } = resolveProfile(config, "any-branch", "quiet");

    expect(result.ide).toEqual({
      name: "vscode",
      command: "code $WCT_WORKTREE_DIR",
      fork_workspace: true,
      open: false,
    });
  });

  test("profile ide command overrides base command and inherits open flag", () => {
    const config = baseConfig({
      ide: {
        open: false,
        command: "code $WCT_WORKTREE_DIR",
      },
      profiles: {
        cursor: {
          ide: { command: "cursor $WCT_WORKTREE_DIR" },
        },
      },
    });

    const { config: result } = resolveProfile(config, "any-branch", "cursor");

    expect(result.ide).toEqual({
      open: false,
      command: "cursor $WCT_WORKTREE_DIR",
    });
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
