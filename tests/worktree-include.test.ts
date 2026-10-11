import { mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { runBunPromise } from "../src/effect/runtime";
import { copyFiles } from "../src/services/copy";
import { resolveWorktreeInclude } from "../src/services/worktree-include";
import { type IncludeRepo, makeIncludeRepo } from "./helpers/include-repo";

describe(".worktreeinclude resolver", () => {
  let fixture: IncludeRepo;
  beforeEach(async () => {
    fixture = await makeIncludeRepo();
  });
  afterEach(async () => {
    await fixture.cleanup();
  });

  const resolve = () => runBunPromise(resolveWorktreeInclude(fixture.repo));

  test("distinguishes missing, empty, comments-only, and no-match files", async () => {
    expect(await resolve()).toBeUndefined();
    for (const content of ["", "# A comment\n\n", "*.missing\n"]) {
      await fixture.write(".worktreeinclude", content);
      expect(await resolve()).toEqual([]);
    }
  });

  test("copies the .env, .env.local, and config/secrets.json example", async () => {
    const files = [".env", ".env.local", "config/secrets.json"];
    await fixture.write(
      ".gitignore",
      ".env\n.env.local\nconfig/secrets.json\n",
    );
    await fixture.write(
      ".worktreeinclude",
      "# Local configuration\n.env\n.env.local\nconfig/secrets.json\n",
    );
    for (const file of files) await fixture.write(file);
    expect((await resolve())?.sort()).toEqual(files.sort());
  });

  test("excludes tracked files even when ignored, nonignored files, symlinks, and Git metadata", async () => {
    await fixture.write(".gitignore", "*.txt\nlinks/\n.git/\n");
    await fixture.write(".worktreeinclude", "*\n");
    await fixture.write("ignored.txt");
    await fixture.write("not-ignored.json");
    await fixture.write(".git/info/secret.txt");
    await fixture.write("tracked.txt", "modified tracked file");
    await mkdir(join(fixture.repo, "links"));
    await symlink(
      join(fixture.repo, "ignored.txt"),
      join(fixture.repo, "links/file.txt"),
    );
    await symlink(
      join(fixture.repo, "missing"),
      join(fixture.repo, "links/broken.txt"),
    );
    await symlink(
      join(fixture.repo, ".git"),
      join(fixture.repo, "links/directory"),
    );
    expect(await resolve()).toEqual(["ignored.txt"]);
  });

  test("includes repository, nested, info/exclude, and global Git ignore rules", async () => {
    await fixture.write(".gitignore", ".env\n");
    await fixture.write("nested/.gitignore", "secret\n");
    await fixture.write(".git/info/exclude", "info-secret\n");
    await fixture.write("../global-ignore", "global-secret\n");
    await fixture.git(
      "config",
      "--global",
      "core.excludesFile",
      join(fixture.root, "global-ignore"),
    );
    const files = [".env", "nested/secret", "info-secret", "global-secret"];
    for (const file of files) await fixture.write(file);
    await fixture.write(".worktreeinclude", "*\n");
    expect((await resolve())?.sort()).toEqual(files.sort());
  });

  test("applies ordered negation and re-inclusion, deduplicating overlaps", async () => {
    await fixture.write(".gitignore", "*.json\n");
    for (const file of ["a.json", "b.json", "nested/a.json", "nested/b.json"])
      await fixture.write(file);
    await fixture.write(
      ".worktreeinclude",
      "*.json\n!b.json\n!nested/\nnested/a.json\na.json\n",
    );
    expect((await resolve())?.sort()).toEqual(["a.json", "nested/a.json"]);
    await fixture.write(".worktreeinclude", "*.json\n!*.json\n");
    expect(await resolve()).toEqual([]);
  });

  test("supports root anchoring, nested patterns, directory patterns, and dotfiles", async () => {
    await fixture.write(".gitignore", "*.env\n*.json\n.settings/\n");
    const selected = [
      "root.env",
      "nested/secret.json",
      "nested/deeper/secret.json",
      ".settings/.hidden",
      ".settings/sub/config",
    ];
    for (const file of [...selected, "nested/root.env", "outside/secret.json"])
      await fixture.write(file);
    await fixture.write(
      ".worktreeinclude",
      "/root.env\nnested/**/secret.json\n/.settings/\n",
    );
    expect((await resolve())?.sort()).toEqual(selected.sort());
  });

  test("supports escapes, CRLF, character classes, and unusual filenames without glob reinterpretation", async () => {
    await fixture.write(".gitignore", "*\n");
    const files = [
      "#secret",
      "!secret",
      "literal[1].env",
      "star*.env",
      "question?.env",
      "space name.env",
      "trailing ",
      "back\\slash.env",
      "tab\tname.env",
      "line\nbreak.env",
      "-dash.env",
      "é.env",
      "a1.env",
    ];
    for (const file of files) await fixture.write(file);
    await fixture.write(
      ".worktreeinclude",
      "\\#secret\r\n\\!secret\r\nliteral\\[1].env\nstar\\*.env\nquestion\\?.env\nspace name.env\ntrailing\\ \nback\\\\slash.env\ntab*name.env\nline*break.env\n-dash.env\né.env\na[0-9].env\n",
    );
    const resolved = await resolve();
    expect(resolved?.sort()).toEqual(files.sort());
    const target = join(fixture.root, "copy");
    const results = await runBunPromise(
      copyFiles(resolved ?? [], fixture.repo, target),
    );
    expect(results).toHaveLength(files.length);
    expect(results.every((result) => result.success)).toBe(true);
    for (const file of files)
      expect(await Bun.file(join(target, file)).text()).toBe(file);
  });

  test("restricts leading **/ inside wholly ignored directories, allowing explicit traversal", async () => {
    await fixture.write(
      ".gitignore",
      "vendor/\n.claude/\nouter/\nconfig.json\n",
    );
    const files = [
      "config.json",
      "normal/config.json",
      "vendor/config.json",
      "vendor/nested/config.json",
      ".claude/skills/one.md",
      "outer/.claude/skills/two.md",
    ];
    for (const file of files) await fixture.write(file);
    await fixture.write(".worktreeinclude", "**/config.json\n");
    expect((await resolve())?.sort()).toEqual([
      "config.json",
      "normal/config.json",
    ]);
    await fixture.write(".worktreeinclude", "vendor/**/config.json\n");
    expect((await resolve())?.sort()).toEqual([
      "vendor/config.json",
      "vendor/nested/config.json",
    ]);
    await fixture.write(
      ".worktreeinclude",
      "vendor/**/config.json\n!**/config.json\n",
    );
    expect((await resolve())?.sort()).toEqual([
      "vendor/config.json",
      "vendor/nested/config.json",
    ]);
    await fixture.write(".worktreeinclude", "**/.claude/skills/*.md\n");
    expect(await resolve()).toEqual([".claude/skills/one.md"]);
    // The first name is inside outer/, not in that ignored directory's path.
    await fixture.write(".worktreeinclude", "outer/**/.claude/skills/*.md\n");
    expect(await resolve()).toEqual(["outer/.claude/skills/two.md"]);
  });

  test("allows leading **/ when the ignored directory itself matches", async () => {
    await fixture.write(".gitignore", "cache/config.json/\n");
    await fixture.write("cache/config.json/secret");
    await fixture.write(".worktreeinclude", "**/config.json\n");
    expect(await resolve()).toEqual(["cache/config.json/secret"]);
  });

  test("fails clearly on unreadable include files and Git discovery failures", async () => {
    await mkdir(join(fixture.repo, ".worktreeinclude"));
    await expect(resolve()).rejects.toThrow("Failed to resolve");
    await fixture.write("../.worktreeinclude", ".env\n");
    await expect(
      runBunPromise(resolveWorktreeInclude(fixture.root)),
    ).rejects.toThrow("not a git repository");
  });
});
