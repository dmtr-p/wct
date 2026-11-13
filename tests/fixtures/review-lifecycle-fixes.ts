import { dlopen } from "bun:ffi";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Cause, Effect } from "effect";
import { type BunServices, runBunPromise } from "../../src/effect/runtime";
import { runShutdownWorker } from "../../src/effect/shutdown-worker";
import { commandError, type WctError } from "../../src/errors";
import { execProcess, type ProcessExitError } from "../../src/services/process";
import { withRepositoryMutation } from "../../src/services/repository-mutation";
import {
  CurrentWorkspaceLease,
  makeWorkspaceCoordinationService,
} from "../../src/services/workspace-coordination";
import { publishWorkspaceJournal } from "../../src/services/workspace-journal";
import { withTestServices } from "../helpers/services";

const mode = process.argv[2];
const args = JSON.parse(process.argv[3] ?? "{}") as {
  root: string;
  repo: string;
  directory: string;
  git: string;
};
const wait = (path: string) =>
  Effect.promise(async () => {
    while (existsSync(args.root) && !existsSync(path)) await Bun.sleep(10);
  });
const program: Effect.Effect<
  void,
  WctError | ProcessExitError | Cause.TimeoutError,
  BunServices.BunServices
> = mode?.startsWith("worker-")
  ? withTestServices(
      runShutdownWorker(args.directory, {
        publishOutcome: (path, content) =>
          Effect.gen(function* () {
            yield* Effect.try({
              try: () => publishWorkspaceJournal(path, content),
              catch: (error) =>
                commandError("unexpected_error", "fixture publication", error),
            });
            if (mode === "worker-publication-failure")
              return yield* commandError(
                "unexpected_error",
                "Required post-rename synchronization failed",
              );
            if (mode === "worker-finalization-failure")
              yield* Effect.addFinalizer(() =>
                Effect.die(new Error("Required custody finalization failed")),
              );
          }),
        ...(mode === "worker-lost-completed"
          ? { sendCompleted: () => {} }
          : {}),
      }),
    )
  : Effect.scoped(
      Effect.gen(function* () {
        if (mode === "writer") {
          // Deliberately surviving descendants are a supported adversarial fixture,
          // independent of whether Bun sets a parent-death signal on this platform.
          if (process.platform === "linux") {
            const native = dlopen("libc.so.6", {
              prctl: {
                args: ["int", "u64", "u64", "u64", "u64"],
                returns: "int",
              },
            });
            if (native.symbols.prctl(1, 0, 0, 0, 0) !== 0)
              throw new Error("Cannot clear fixture parent-death signal");
          }
          writeFileSync(join(args.root, "writer"), String(process.pid));
          yield* wait(join(args.root, "release"));
          if (existsSync(args.root))
            yield* execProcess(
              args.git,
              ["config", "--local", "review.orphan", "old-owner"],
              { cwd: args.repo },
            );
          return;
        }
        if (mode === "git-shim") {
          const child = Bun.spawn(
            [
              process.execPath,
              "run",
              import.meta.filename,
              "writer",
              JSON.stringify(args),
            ],
            { detached: true, stdio: ["ignore", "ignore", "ignore"] },
          );
          yield* Effect.promise(() => child.exited);
          return;
        }
        const service = yield* makeWorkspaceCoordinationService();
        const lease = yield* service.acquire({
          mainRepoPath: args.repo,
          branch: mode === "repository-holder" ? "holder" : "feature",
        });
        yield* withRepositoryMutation(
          args.repo,
          Effect.gen(function* () {
            writeFileSync(join(args.root, "acquired"), String(process.pid));
            if (mode === "repository-holder")
              return yield* wait(join(args.root, "release-holder"));
            if (mode === "repository-known-error") {
              yield* Effect.result(
                execProcess(
                  args.git,
                  ["config", "--local", "--get", "review.absent"],
                  { cwd: args.repo },
                ),
              );
              yield* execProcess(
                args.git,
                ["config", "--local", "review.known", "finished"],
                { cwd: args.repo },
              );
              return;
            }
            if (mode === "repository-partial") {
              yield* execProcess(
                args.git,
                ["config", "--local", "review.intent", "pending"],
                { cwd: args.repo },
              );
              writeFileSync(
                join(args.root, "partial"),
                "committed first command",
              );
              return yield* wait(join(args.root, "release"));
            }
            yield* execProcess(
              process.execPath,
              ["run", import.meta.filename, "git-shim", JSON.stringify(args)],
              { cwd: args.repo },
            );
          }),
        ).pipe(Effect.provideService(CurrentWorkspaceLease, lease));
      }),
    );
await runBunPromise(program).catch((error: unknown) => {
  process.stderr.write(String(error));
  process.exitCode = 1;
});
if (process.connected) process.disconnect?.();
