import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, test } from "vitest";
import packageJson from "../package.json";
import { completionCommands } from "../src/cli/command-metadata";
import { renderCompletionProfiles } from "../src/cli/completion-profiles";
import { generateCompletionScript } from "../src/cli/completions";
import { globalOptions } from "../src/cli/global-options";
import { rootCommand } from "../src/cli/root-command";

const VERSION = packageJson.version;

function runCliProcess(args: string[]) {
  return Bun.spawnSync(["bun", "run", "src/index.ts", ...args]);
}

function runBashCompletion(
  words: string[],
  cwd: string,
  env: Record<string, string | undefined> = {},
) {
  const tempDir = mkdtempSync(join(tmpdir(), "wct-bash-completion-"));
  const scriptPath = join(tempDir, "wct-completion.bash");
  const completionScript = generateCompletionScript("bash");

  writeFileSync(scriptPath, completionScript);

  try {
    return Bun.spawnSync(
      [
        "bash",
        "-c",
        [
          'source "$1"',
          "shift",
          'cd "$1"',
          "shift",
          `COMP_WORDS=(${words.map(quoteShell).join(" ")})`,
          `COMP_CWORD=${words.length - 1}`,
          "COMPREPLY=()",
          "_wct",
          `printf "%s\\n" "\${COMPREPLY[@]}"`,
        ].join("\n"),
        "bash",
        scriptPath,
        cwd,
      ],
      {
        env: {
          ...process.env,
          ...completionEnvironment(tempDir),
          ...env,
        },
      },
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function quoteShell(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function completionEnvironment(tempDir: string) {
  const bin = join(tempDir, "bin");
  const home = join(tempDir, "home");
  mkdirSync(bin, { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(
    join(bin, "wct"),
    `#!/bin/sh\nexec ${quoteShell(process.execPath)} ${quoteShell(resolve("src/index.ts"))} "$@"\n`,
    { mode: 0o755 },
  );
  return { PATH: `${bin}:${process.env.PATH}`, HOME: home };
}

function git(cwd: string, args: string[]) {
  const result = Bun.spawnSync(["git", ...args], { cwd });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
}

function profileFixture() {
  const dir = mkdtempSync(join(tmpdir(), "wct-profile-completion-"));
  const repo = join(dir, "repo");
  const nested = join(repo, "nested");
  const linked = join(dir, "linked");
  const env = completionEnvironment(dir);
  mkdirSync(nested, { recursive: true });
  git(repo, ["init", "-b", "main"]);
  git(repo, [
    "-c",
    "user.name=Completion Test",
    "-c",
    "user.email=completion@example.com",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--allow-empty",
    "-m",
    "fixture",
  ]);
  git(repo, ["worktree", "add", "-b", "linked", linked]);
  mkdirSync(join(linked, "nested"));
  return { dir, repo, nested, linked, env };
}

describe("Effect CLI root", () => {
  test("renders built-in help from the root command", () => {
    const result = runCliProcess(["--help"]);
    const output = result.stdout.toString();

    expect(result.exitCode).toBe(0);
    expect(output).toContain("GLOBAL FLAGS");
    expect(output).toContain("--completions <bash|zsh|fish>");
    expect(output).not.toContain("powershell");
    expect(output).not.toContain("pwsh");
    expect(output).toContain("projects");
    expect(output).toContain("switch, sw");
    expect(output).not.toContain("\n  register");
    expect(output).not.toContain("\n  unregister");
    expect(output).not.toContain("\n  completions");
  });

  test("renders built-in help for the short -h alias even when --json is present", () => {
    const result = runCliProcess(["--json", "-h"]);
    const output = result.stdout.toString();

    expect(result.exitCode).toBe(0);
    expect(result.stderr.toString()).toBe("");
    expect(output).toContain("GLOBAL FLAGS");
    expect(output).toContain("--json");
    expect(output).toContain("switch, sw");
  });

  test("renders built-in help for bare --json invocations", () => {
    const result = runCliProcess(["--json"]);
    const output = result.stdout.toString();

    expect(result.exitCode).toBe(0);
    expect(result.stderr.toString()).toBe("");
    expect(output).toContain("GLOBAL FLAGS");
    expect(output).toContain("--json");
    expect(output).toContain("switch, sw");
  });

  test("renders subcommand help for the short -h alias even when --json is present", () => {
    const result = runCliProcess(["open", "--json", "-h"]);
    const output = result.stdout.toString();

    expect(result.exitCode).toBe(0);
    expect(result.stderr.toString()).toBe("");
    expect(output).toContain("USAGE");
    expect(output).toContain("wct open");
    expect(output).toContain("--base");
    expect(output).toContain("--json");
  });

  test("renders built-in version output", () => {
    const result = runCliProcess(["--version"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString().trim()).toBe(`wct v${VERSION}`);
  });

  test("renders version output for the short -v flag", () => {
    const result = runCliProcess(["-v"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString().trim()).toBe(`wct v${VERSION}`);
  });

  test("renders custom fish completions with branch and worktree helpers", () => {
    const result = runCliProcess(["--completions", "fish"]);
    const output = result.stdout.toString();

    expect(result.exitCode).toBe(0);
    expect(output).toContain("function __wct_branches");
    expect(output).toContain("function __wct_worktree_branches");
    expect(output).toContain("git branch --format='%(refname:short)'");
    expect(output).toContain("git worktree list --porcelain");
    expect(output).toContain("-a 'projects'");
    expect(output).toContain(
      "__fish_seen_subcommand_from projects; and not __fish_seen_subcommand_from add remove list",
    );
    expect(output).toContain("-a 'add' -d 'Add a project to the registry'");
    expect(output).toContain(
      "-a 'remove' -d 'Remove a project from the registry'",
    );
    expect(output).toContain("-a 'list' -d 'List registered projects'");
    expect(output).toContain(
      "__fish_seen_subcommand_from projects; and __fish_seen_subcommand_from add' -a '(__fish_complete_directories)' -d 'Path to repo'",
    );
    expect(output).toContain(
      "__fish_seen_subcommand_from projects; and __fish_seen_subcommand_from remove' -a '(__fish_complete_directories)' -d 'Path to repo'",
    );
    expect(output).toContain(
      "__fish_seen_subcommand_from projects; and __fish_seen_subcommand_from add' -s n -l name -r -d 'Override project display name'",
    );
    expect(output).toContain("-a 'switch'");
    expect(output).not.toContain("-a 'register'");
    expect(output).not.toContain("-a 'unregister'");
    expect(output).not.toContain("-a 'completions'");
  });

  test("renders bash completions with command-specific options after a subcommand", () => {
    const result = runCliProcess(["--completions", "bash"]);
    const output = result.stdout.toString();

    expect(result.exitCode).toBe(0);
    expect(output).toContain("projects)");
    expect(output).toContain(
      "COMPREPLY=($(compgen -W 'add remove list' -- \"$cur\"))",
    );
    expect(output).toContain("add)");
    expect(output).toContain("remove)");
    expect(output).toContain("list)");
    expect(output).toContain("--name -n");
    expect(output).toContain("local cmd_index=1");
    expect(output).toContain("local subcmd_index=$((cmd_index + 1))");
    expect(output).toContain("while [[ $subcmd_index -lt $cword ]]");
    expect(output).toContain(
      "COMPREPLY=($(compgen -W '--help -h --version -v --completions --log-level --json --base -b --existing -e --no-attach --pr --profile -P' -- \"$cur\"))",
    );
  });

  test.each(["down", "close"])(
    "bash completes %s profile values",
    (command) => {
      const repoRoot = mkdtempSync(join(tmpdir(), "wct-shutdown-completion-"));
      git(repoRoot, ["init", "-b", "main"]);
      writeFileSync(
        join(repoRoot, ".wct.yaml"),
        "profiles:\n  cleanup:\n    down: []\n  minimal:\n    down: []\n",
      );
      try {
        for (const flag of ["--profile", "-P"]) {
          const result = runBashCompletion(
            ["wct", command, flag, ""],
            repoRoot,
          );
          expect(result.exitCode).toBe(0);
          expect(result.stdout.toString().trim().split("\n")).toEqual([
            "cleanup",
            "minimal",
          ]);
        }
      } finally {
        rmSync(repoRoot, { recursive: true, force: true });
      }
    },
  );

  test("bash completions do not offer directories for projects add --name or -n values", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "wct-bash-completion-repo-"));
    mkdirSync(join(repoRoot, "alpha"), { recursive: true });
    mkdirSync(join(repoRoot, "beta"), { recursive: true });

    try {
      const longFlagResult = runBashCompletion(
        ["wct", "projects", "add", "--name", ""],
        repoRoot,
      );
      const shortFlagResult = runBashCompletion(
        ["wct", "projects", "add", "-n", ""],
        repoRoot,
      );
      const positionalResult = runBashCompletion(
        ["wct", "projects", "add", ""],
        repoRoot,
      );

      expect(longFlagResult.exitCode).toBe(0);
      expect(shortFlagResult.exitCode).toBe(0);
      expect(positionalResult.exitCode).toBe(0);
      expect(longFlagResult.stdout.toString().trim()).toBe("");
      expect(shortFlagResult.stdout.toString().trim()).toBe("");
      expect(positionalResult.stdout.toString()).toContain("alpha");
      expect(positionalResult.stdout.toString()).toContain("beta");
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test("renders zsh completions that scan for nested subcommands after the group command", () => {
    const result = runCliProcess(["--completions", "zsh"]);
    const output = result.stdout.toString();

    expect(result.exitCode).toBe(0);
    expect(output).toContain("projects:Manage the project registry");
    expect(output).toContain("'add:Add a project to the registry'");
    expect(output).toContain("'remove:Remove a project from the registry'");
    expect(output).toContain("'list:List registered projects'");
    expect(output).toContain(
      "'(-n --name)'{-n,--name}'[Override project display name]:name:'",
    );
    expect(output).toContain('case "$command_word" in');
    expect(output).toContain("local subcmd_index=$((command_index + 1))");
    expect(output).toContain("while (( subcmd_index < CURRENT ))");
    expect(output).toContain('case "$subcmd" in');
  });

  test.each(["powershell", "pwsh", "sh"])(
    "rejects unsupported %s completions",
    (shell) => {
      for (const args of [
        ["--completions", shell],
        [`--completions=${shell}`],
      ]) {
        const result = runCliProcess(args);
        expect(result.exitCode).toBe(1);
        expect(result.stderr.toString()).toContain(shell);
        expect(result.stdout.toString()).not.toContain(
          "Register-ArgumentCompleter",
        );
        expect(result.stdout.toString()).not.toContain(
          "Static completion script for Bash",
        );
      }
    },
  );

  test("does not expose the legacy completions subcommand", async () => {
    const result = runCliProcess(["completions", "fish"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain(
      'Unknown subcommand "completions"',
    );
  });

  test("emits JSON for unknown subcommands when --json is present", () => {
    const result = runCliProcess(["--json", "nope"]);
    const stdout = result.stdout.toString();
    const stderr = result.stderr.toString();

    expect(result.exitCode).toBe(1);
    expect(stdout.trim()).toBe("");
    expect(() => JSON.parse(stderr)).not.toThrow();
    const parsed = JSON.parse(stderr);
    expect(parsed).toEqual(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({
          code: "unknown_command",
        }),
      }),
    );
    expect(parsed.error.message).toEqual(
      expect.stringContaining("Unknown subcommand"),
    );
    expect(parsed.error.message).toEqual(
      expect.stringContaining("Did you mean"),
    );
    expect(stderr).not.toContain("GLOBAL FLAGS");
    expect(stderr).not.toContain("Help requested");
  });

  test("emits JSON for the removed queue subcommand when --json is present", () => {
    const result = runCliProcess(["--json", "queue"]);
    const stdout = result.stdout.toString();
    const stderr = result.stderr.toString();

    expect(result.exitCode).toBe(1);
    expect(stdout.trim()).toBe("");
    expect(() => JSON.parse(stderr)).not.toThrow();
    const parsed = JSON.parse(stderr);
    expect(parsed).toEqual(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({
          code: "unknown_command",
        }),
      }),
    );
    expect(parsed.error.message).toEqual(
      expect.stringContaining("Unknown subcommand"),
    );
    expect(parsed.error.message).toEqual(expect.stringContaining("queue"));
    expect(stderr).not.toContain("GLOBAL FLAGS");
    expect(stderr).not.toContain("Help requested");
  });

  test("emits JSON for unrecognized flags when --json is present", () => {
    const result = runCliProcess(["--json", "open", "--bad-flag"]);
    const stdout = result.stdout.toString();
    const stderr = result.stderr.toString();

    expect(result.exitCode).toBe(1);
    expect(stdout.trim()).toBe("");
    expect(() => JSON.parse(stderr)).not.toThrow();
    const parsed = JSON.parse(stderr);
    expect(parsed).toEqual(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({
          code: "invalid_options",
        }),
      }),
    );
    expect(parsed.error.message).toEqual(
      expect.stringContaining("Unrecognized flag"),
    );
    expect(parsed.error.message).toEqual(expect.stringContaining("--bad-flag"));
    expect(stderr).not.toContain("GLOBAL FLAGS");
    expect(stderr).not.toContain("Help requested");
  });

  test("renders command validation failures without a stack trace", () => {
    const result = runCliProcess(["open"]);
    const stderr = result.stderr.toString();

    expect(result.exitCode).toBe(1);
    expect(stderr).toContain("Missing branch name");
    expect(stderr).not.toContain("WctCommandError");
    expect(stderr).not.toContain("at ");
  });
});

describe("shared command metadata", () => {
  test("native command names, aliases, and descriptions match completion metadata", () => {
    const nativeCommands = rootCommand.subcommands.flatMap(
      (group) => group.commands,
    );
    for (const definition of Object.values(completionCommands)) {
      const native = nativeCommands.find(
        (command) => command.name === definition.name,
      );
      expect(native?.description).toBe(definition.description);
      expect(native?.alias).toBe(definition.aliases?.[0]);
      expect(
        native?.subcommands
          .flatMap((group) => group.commands)
          .map((command) => ({
            name: command.name,
            description: command.description,
          })),
      ).toEqual(
        (definition.subcommands ?? []).map((command) => ({
          name: command.name,
          description: command.description,
        })),
      );
    }
  });

  test.each(
    Object.values(completionCommands).flatMap((command) => [
      { path: [command.name], definition: command },
      ...(command.subcommands ?? []).map((subcommand) => ({
        path: [command.name, subcommand.name],
        definition: subcommand,
      })),
    ]),
  )("native help uses shared parameters for $path", ({ path, definition }) => {
    const result = runCliProcess([...path, "--help"]);
    const output = result.stdout.toString();
    expect(result.exitCode).toBe(0);
    expect(output).toContain(definition.description);
    if (definition.args) expect(output).toContain(definition.args);
    for (const option of definition.options ?? []) {
      expect(output).toContain(`--${option.name}`);
      if (option.short) expect(output).toContain(`-${option.short}`);
      expect(output).toContain(option.description);
    }
  });

  test.each(["bash", "zsh", "fish"])(
    "%s offers supported global flags",
    (shell) => {
      const result = runCliProcess(["--completions", shell]);
      const output = result.stdout.toString();
      expect(result.exitCode).toBe(0);
      for (const option of globalOptions) {
        expect(output).toContain(
          shell === "fish" ? `-l ${option.name}` : `--${option.name}`,
        );
      }
      expect(output).not.toContain("powershell");
      expect(output).not.toContain("pwsh");
    },
  );

  test.each([
    "wct --",
    "wct open --",
    "wct projects add --",
    "wct --json open --",
  ])("bash offers --json in %s", (line) => {
    const tempDir = mkdtempSync(join(tmpdir(), "wct-global-completion-"));
    try {
      const result = runBashCompletion(line.split(" "), tempDir);
      expect(result.stdout.toString()).toContain("--json");
      expect(result.stderr.toString()).toBe("");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe("resolved profile completions", () => {
  test.each(
    (["repo", "nested", "linked", "linkedNested"] as const).flatMap(
      (directory) =>
        ["open", "up", "down", "close"].map((command) => ({
          directory,
          command,
        })),
    ),
  )(
    "uses Main Repository profiles for $command from $directory",
    ({ directory, command }) => {
      const fixture = profileFixture();
      writeFileSync(
        join(fixture.env.HOME, ".wct.yaml"),
        "profiles: {global: {}}\n",
      );
      writeFileSync(
        join(fixture.repo, ".wct.yaml"),
        'profiles: {"project profile": {}, "123: special": {}}\n',
      );
      writeFileSync(
        join(fixture.nested, ".wct.yaml"),
        "profiles: {wrong: {}}\n",
      );
      writeFileSync(
        join(fixture.linked, ".wct.yaml"),
        "profiles: {wrong: {}}\n",
      );
      const cwd =
        directory === "linkedNested"
          ? join(fixture.linked, "nested")
          : fixture[directory];
      try {
        for (const flag of ["--profile", "-P"]) {
          const result = runBashCompletion(
            ["wct", command, flag, ""],
            cwd,
            fixture.env,
          );
          expect(result.stdout.toString().trim().split("\n")).toEqual([
            "project\\ profile",
            "123:\\ special",
          ]);
          expect(result.stderr.toString()).toBe("");
        }
      } finally {
        rmSync(fixture.dir, { recursive: true, force: true });
      }
    },
  );

  test("falls back to global profiles, but project profiles replace the map even when empty", () => {
    const fixture = profileFixture();
    writeFileSync(
      join(fixture.env.HOME, ".wct.yaml"),
      "profiles: {global: {}}\n",
    );
    try {
      for (const [config, profiles] of [
        ["", ["global"]],
        ["worktree_dir: ..\n", ["global"]],
        ["profiles: {project: {}}\n", ["project"]],
        ["profiles: {}\n", []],
      ] as const) {
        writeFileSync(join(fixture.repo, ".wct.yaml"), config);
        const result = runBashCompletion(
          ["wct", "open", "--profile", ""],
          fixture.nested,
          fixture.env,
        );
        expect(result.stdout.toString().trim()).toBe(profiles.join("\n"));
        expect(result.stderr.toString()).toBe("");
      }
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test("preserves YAML names and prefix matching without evaluating shell text", () => {
    const fixture = profileFixture();
    const names = [
      "two words",
      "quote'and\"double",
      "back\\slash",
      "$(touch injected)",
      "semi;colon",
      "123: colon",
      "日本語",
      "line\nbreak",
      "tab\tname",
    ];
    writeFileSync(
      join(fixture.repo, ".wct.yaml"),
      `profiles: ${JSON.stringify(Object.fromEntries(names.map((name) => [name, {}])))}\n`,
    );
    mkdirSync(join(fixture.linked, "two words"));
    try {
      const result = runBashCompletion(
        ["wct", "open", "--profile", ""],
        fixture.nested,
        fixture.env,
      );
      const quoted = Bun.spawnSync([
        "bash",
        "-c",
        'printf "%q\n" "$@"',
        "bash",
        ...names,
      ]);
      expect(result.stdout.toString()).toBe(quoted.stdout.toString());
      expect(result.stderr.toString()).toBe("");
      expect(existsSync(join(fixture.nested, "injected"))).toBe(false);
      const prefixed = runBashCompletion(
        ["wct", "open", "-P", "two "],
        fixture.linked,
        fixture.env,
      );
      expect(prefixed.stdout.toString()).toBe("two\\ words\n");
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test("continues Bash completion after inserting an escaped common prefix", () => {
    const fixture = profileFixture();
    writeFileSync(
      join(fixture.repo, ".wct.yaml"),
      'profiles: {"dev^one": {}, "dev^two": {}}\n',
    );
    try {
      for (const [prefix, expected] of [
        ["dev", "dev\\^one\ndev\\^two\n"],
        ["dev\\^", "dev\\^one\ndev\\^two\n"],
        ["dev\\^o", "dev\\^one\n"],
      ] as const) {
        const result = runBashCompletion(
          ["wct", "open", "--profile", prefix],
          fixture.linked,
          fixture.env,
        );
        expect(result.exitCode).toBe(0);
        expect(result.stderr.toString()).toBe("");
        expect(result.stdout.toString()).toBe(expected);
      }
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test.each([
    ["two\\ ", "two words"],
    ['"two ', "two words"],
    ["'two ", "two words"],
    ["back\\\\", "back\\slash"],
    ['"back\\s', "back\\slash"],
    ["$'line\\n'", "line\nbreak"],
    ["$'tab\\t", "tab\tname"],
    ["\\$\\(touch\\ ", "$(touch injected)"],
    ["$(touch ", "$(touch injected)"],
  ])(
    "matches Bash shell-quoted prefix %s without evaluation",
    (prefix, name) => {
      const fixture = profileFixture();
      writeFileSync(
        join(fixture.repo, ".wct.yaml"),
        `profiles: ${JSON.stringify({ [name]: {} })}\n`,
      );
      try {
        const result = runBashCompletion(
          ["wct", "open", "-P", prefix],
          fixture.linked,
          fixture.env,
        );
        const quoted = Bun.spawnSync([
          "bash",
          "-c",
          'printf "%q\n" "$1"',
          "bash",
          name,
        ]);
        expect(result.exitCode).toBe(0);
        expect(result.stderr.toString()).toBe("");
        expect(result.stdout.toString()).toBe(quoted.stdout.toString());
        expect(existsSync(join(fixture.linked, "injected"))).toBe(false);
      } finally {
        rmSync(fixture.dir, { recursive: true, force: true });
      }
    },
  );

  test.each([
    undefined,
    "profiles: [",
    "profiles: []",
    "profiles: {broken: {tmux: false}}",
  ])("silently handles missing or invalid configuration: %s", (config) => {
    const fixture = profileFixture();
    if (config !== undefined)
      writeFileSync(join(fixture.repo, ".wct.yaml"), config);
    try {
      const result = Bun.spawnSync(
        [
          process.execPath,
          resolve("src/index.ts"),
          "--wct-completion-profiles",
          "bash",
        ],
        { cwd: fixture.nested, env: { ...process.env, ...fixture.env } },
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString()).toBe("");
      expect(result.stderr.toString()).toBe("");
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test("silently handles invocation outside a Git repository", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "wct-nonrepo-completion-"));
    try {
      const result = runBashCompletion(
        ["wct", "open", "--profile", ""],
        tempDir,
      );
      expect(result.stderr.toString()).toBe("");
      expect(result.stdout.toString().trim()).toBe("");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test.each(["zsh", "fish"])(
    "%s profile helpers preserve shell-sensitive names",
    (shell) => {
      if (!Bun.which(shell)) return;
      const fixture = profileFixture();
      const names = [
        "two words",
        "quote'and\"double",
        "back\\slash",
        "$(touch injected)",
        "semi;colon",
        "123: colon",
        "日本語",
        "line\nbreak",
        "tab\tname",
      ];
      const scriptPath = join(fixture.dir, `completion.${shell}`);
      writeFileSync(
        join(fixture.repo, ".wct.yaml"),
        `profiles: ${JSON.stringify(Object.fromEntries(names.map((name) => [name, {}])))}\n`,
      );
      writeFileSync(scriptPath, runCliProcess(["--completions", shell]).stdout);
      const command =
        shell === "zsh"
          ? `compdef() { :; }; compadd() { printf "%s\\0" "\${profiles[@]}"; }; source "$1"; _wct_profiles`
          : 'source $argv[1]; for profile in (__wct_profiles | string split0); printf "%s\\0" $profile; end';
      try {
        const result = Bun.spawnSync(
          [
            shell,
            ...(shell === "fish" ? ["--no-config"] : []),
            "-c",
            command,
            ...(shell === "zsh" ? [shell] : []),
            scriptPath,
          ],
          { cwd: fixture.linked, env: { ...process.env, ...fixture.env } },
        );
        expect(result.exitCode).toBe(0);
        expect(result.stderr.toString()).toBe("");
        expect(result.stdout.toString().split("\0").filter(Boolean)).toEqual(
          names,
        );
        expect(existsSync(join(fixture.linked, "injected"))).toBe(false);
      } finally {
        rmSync(fixture.dir, { recursive: true, force: true });
      }
    },
  );

  test("fish receives raw profile values to quote during insertion", () => {
    if (!Bun.which("fish")) return;
    const fixture = profileFixture();
    const scriptPath = join(fixture.dir, "completion.fish");
    writeFileSync(
      join(fixture.repo, ".wct.yaml"),
      'profiles: {"two words": {}, "semi;colon": {}}\n',
    );
    writeFileSync(scriptPath, runCliProcess(["--completions", "fish"]).stdout);
    try {
      const result = Bun.spawnSync(
        [
          "fish",
          "--no-config",
          "-c",
          'source $argv[1]; complete -C "wct open --profile "',
          scriptPath,
        ],
        { cwd: fixture.linked, env: { ...process.env, ...fixture.env } },
      );
      expect(result.exitCode).toBe(0);
      expect(result.stderr.toString()).toBe("");
      expect(result.stdout.toString().trimEnd().split("\n")).toEqual([
        "semi;colon\tUse a named config profile",
        "two words\tUse a named config profile",
      ]);
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test("unknown profile completion formats produce no output", () => {
    expect(renderCompletionProfiles(["profile"], "powershell")).toBe("");
  });
});
