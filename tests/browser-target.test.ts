import { expect } from "vitest";
import { inspectLocalTarget } from "../src/browser/target";
import { sessionIdentity } from "../src/services/session-identity";
import type { TmuxSession } from "../src/services/tmux";
import { test } from "./helpers/temp-dir";

const target = {
  mainRepoPath: "/repo",
  worktreePath: "/repo/w",
  branch: "main",
  server: "server",
  sessionId: "$1",
};
const client = {
  tty: "tty",
  session: "fixture",
  server: "server",
  sessionId: "$1",
};
function sources(owner: TmuxSession["ownership"]) {
  const session: TmuxSession = {
    id: "$1",
    server: "server",
    name: "fixture",
    ownership: owner,
    attached: true,
    windows: 1,
  };
  return {
    initial: target,
    sessions: async () => [session],
    canonical: async (value: {
      mainRepoPath: string;
      worktreePath: string;
      branch: string;
    }) => value,
    worktrees: async () => [{ path: target.worktreePath, branch: "main" }],
    root: async () => target.worktreePath,
  };
}

test("preserves a known Workspace with identity-only ownership", async () => {
  const input = sources({ identity: sessionIdentity(target) });
  expect(await inspectLocalTarget(client, input)).toEqual(target);
});

test("preserves detached checkout conventions with the recorded session branch", async () => {
  const input = sources({
    mainRepoPath: target.mainRepoPath,
    worktreePath: target.worktreePath,
    branch: "main",
    identity: sessionIdentity(target),
  });
  input.initial = { ...target, branch: "" };
  input.worktrees = async () => [
    { path: target.worktreePath, branch: "(detached)" },
  ];
  expect(await inspectLocalTarget(client, input)).toEqual({
    ...target,
    branch: "",
  });
});

test("publishes native navigation with incomplete or unverified metadata without assigning a Workspace", async () => {
  for (const owner of [
    { branch: "label" },
    {
      mainRepoPath: target.mainRepoPath,
      worktreePath: target.worktreePath,
      branch: "main",
      identity: "invalid",
    },
  ]) {
    const input = sources(owner);
    input.initial = { ...target, sessionId: "$9" };
    expect(await inspectLocalTarget(client, input)).toEqual({
      server: "server",
      sessionId: "$1",
      sessionName: "fixture",
    });
  }
});

test("verified ownership cannot hide a missing checkout or changed branch behind a native fallback", async () => {
  const input = sources({
    mainRepoPath: target.mainRepoPath,
    worktreePath: target.worktreePath,
    branch: "main",
    identity: sessionIdentity(target),
  });
  input.worktrees = async () => [];
  await expect(inspectLocalTarget(client, input)).rejects.toThrow(
    "Workspace disappeared",
  );
  input.worktrees = async () => [
    { path: target.worktreePath, branch: "other" },
  ];
  await expect(inspectLocalTarget(client, input)).rejects.toThrow(
    "Workspace ownership changed",
  );
  input.worktrees = async () => [{ path: target.worktreePath, branch: "main" }];
  input.root = async () => {
    throw new Error("Missing checkout");
  };
  await expect(inspectLocalTarget(client, input)).rejects.toThrow(
    "Missing checkout",
  );
});
