import { basename, dirname, join, resolve } from "node:path";
import { Effect, FileSystem, type PlatformError } from "effect";
import { commandError } from "../errors";
import { workspaceIdentityKey } from "./identities";

export interface WorkspaceSessionTarget {
  mainRepoPath: string;
  branch: string;
  worktreePath: string;
}

export interface SessionOwnership {
  identity?: string;
  mainRepoPath?: string;
  branch?: string;
  worktreePath?: string;
}

export interface WorkspaceSession {
  name: string;
  id?: string;
  server?: string;
  ownership?: SessionOwnership;
}

export function formatSessionName(dirName: string): string {
  return dirName.replace(/[^a-zA-Z0-9_-]/g, "-");
}

export function sessionIdentity(target: WorkspaceSessionTarget): string {
  return Buffer.from(
    workspaceIdentityKey(target.mainRepoPath, target.branch),
  ).toString("base64");
}

export function workspaceSessionName(target: WorkspaceSessionTarget): string {
  const hash = new Bun.CryptoHasher("sha256")
    .update(workspaceIdentityKey(target.mainRepoPath, target.branch))
    .digest("hex")
    .slice(0, 10);
  return `${formatSessionName(basename(target.worktreePath))}-${hash}`;
}

// Deleted checkouts still have a Git registration. Resolve existing ancestors
// so their identity agrees with an earlier scan through a symlink alias.
export function canonicalSessionPath(
  path: string,
): Effect.Effect<string, PlatformError.PlatformError, FileSystem.FileSystem> {
  const absolute = resolve(path);
  return FileSystem.FileSystem.use((fs) => fs.realPath(absolute)).pipe(
    Effect.catchIf(
      (error) =>
        error.reason._tag === "NotFound" && dirname(absolute) !== absolute,
      () =>
        canonicalSessionPath(dirname(absolute)).pipe(
          Effect.map((parent) => join(parent, basename(absolute))),
        ),
    ),
  );
}

export function canonicalSessionTarget(target: WorkspaceSessionTarget) {
  return Effect.all({
    mainRepoPath: canonicalSessionPath(target.mainRepoPath),
    worktreePath: canonicalSessionPath(target.worktreePath),
    branch: Effect.succeed(target.branch === "(detached)" ? "" : target.branch),
  }).pipe(
    Effect.mapError((error) =>
      commandError(
        "tmux_error",
        "Cannot resolve Workspace session paths",
        error,
      ),
    ),
  );
}

export function workspaceSessionTarget(
  mainRepoPath: string,
  worktree: { path: string; branch: string },
): WorkspaceSessionTarget {
  return {
    mainRepoPath,
    worktreePath: worktree.path,
    branch: worktree.branch === "(detached)" ? "" : worktree.branch,
  };
}

export function ownsWorkspaceSession(
  session: WorkspaceSession,
  target: WorkspaceSessionTarget,
): boolean {
  const owner = session.ownership;
  if (!owner || !session.id || !session.server) return false;
  if (target.branch === "") {
    return (
      owner.mainRepoPath === target.mainRepoPath &&
      owner.worktreePath === target.worktreePath &&
      owner.branch !== undefined &&
      (owner.identity === undefined ||
        owner.identity === sessionIdentity({ ...target, branch: owner.branch }))
    );
  }
  if (owner.identity !== undefined)
    return owner.identity === sessionIdentity(target);
  return (
    owner.mainRepoPath === target.mainRepoPath &&
    owner.branch === target.branch &&
    owner.worktreePath === target.worktreePath
  );
}

export function selectWorkspaceSession<S extends WorkspaceSession>(
  sessions: readonly S[],
  target: WorkspaceSessionTarget,
):
  | { type: "owned"; session: S }
  | { type: "absent" }
  | { type: "conflict"; message: string } {
  const name = workspaceSessionName(target);
  const legacy = formatSessionName(basename(target.worktreePath));
  // Partial or corrupt metadata cannot prove that a legacy name is unrelated.
  const verifiedForeignLegacy = (session: S) => {
    const owner = session.ownership;
    return (
      owner?.mainRepoPath !== undefined &&
      owner.worktreePath !== undefined &&
      owner.branch !== undefined &&
      (owner.mainRepoPath !== target.mainRepoPath ||
        owner.worktreePath !== target.worktreePath) &&
      ownsWorkspaceSession(session, {
        mainRepoPath: owner.mainRepoPath,
        worktreePath: owner.worktreePath,
        branch: owner.branch,
      })
    );
  };
  const candidates = sessions.filter(
    (session) =>
      session.name === name ||
      (session.name === legacy && !verifiedForeignLegacy(session)) ||
      session.ownership?.identity === sessionIdentity(target) ||
      (target.branch === "" && ownsWorkspaceSession(session, target)),
  );
  const owned = candidates.filter((session) =>
    ownsWorkspaceSession(session, target),
  );
  // A foreign legacy name is common across repositories. Once a verified new
  // session exists, it does not interfere with that Workspace's operations.
  if (
    owned.length === 1 &&
    !candidates.some(
      (session) =>
        session.name === name && !ownsWorkspaceSession(session, target),
    )
  ) {
    const session = owned[0];
    if (session) return { type: "owned", session };
  }
  if (candidates.length)
    return {
      type: "conflict",
      message: `Cannot establish unique Workspace ownership for tmux session '${name}' (legacy '${legacy}'). Inspect the conflicting sessions and stop or rename them manually before retrying.`,
    };
  return { type: "absent" };
}

export function findWorkspaceSession<S extends WorkspaceSession>(
  sessions: readonly S[],
  target: WorkspaceSessionTarget,
): S | undefined {
  const result = selectWorkspaceSession(sessions, target);
  return result.type === "owned" ? result.session : undefined;
}
