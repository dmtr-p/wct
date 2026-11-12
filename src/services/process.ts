import { Context, Data, Effect, Semaphore } from "effect";
import { ChildProcess } from "effect/process";
import { commandError, WctCommandError } from "../errors";
import { decodeText } from "./process-output";
import { CurrentWorkspaceLease } from "./workspace-coordination";

export const ObservationProcessBudget = Context.Reference<
  Semaphore.Semaphore | undefined
>("wct/ObservationProcessBudget", { defaultValue: () => undefined });

// Child processes inherit the full environment, independent of Config overrides.
export const processEnvironment = Effect.sync(() => ({ ...process.env }));

export interface ProcessOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  extendEnv?: boolean;
  shell?: boolean | string;
  stdin?: ChildProcess.CommandInput | ChildProcess.StdinConfig;
  stdout?: ChildProcess.CommandOutput | ChildProcess.StdoutConfig;
  stderr?: ChildProcess.CommandOutput | ChildProcess.StderrConfig;
  /** Fail while reading, rather than retaining an unbounded output buffer. */
  maxOutputBytes?: number;
}

export class ProcessOutputLimitError extends Data.TaggedError(
  "ProcessOutputLimitError",
) {
  override get message(): string {
    return "Process output limit exceeded";
  }
}

export class ProcessExitError extends Data.TaggedError("ProcessExitError")<{
  command: string;
  args: ReadonlyArray<string>;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  cause?: unknown;
}> {
  override get message(): string {
    return (
      this.stderr.trim() ||
      this.stdout.trim() ||
      (this.exitCode === null
        ? `Failed to run ${formatCommand(this.command, this.args)}`
        : `Command exited with code ${this.exitCode}: ${formatCommand(this.command, this.args)}`)
    );
  }
}

function formatCommand(command: string, args: ReadonlyArray<string>): string {
  return [command, ...args].join(" ");
}

function makeCommand(
  command: string,
  args: ReadonlyArray<string>,
  options?: ProcessOptions & { detached?: boolean },
) {
  const { maxOutputBytes: _limit, ...commandOptions } = options ?? {};
  return ChildProcess.make(command, [...args], {
    extendEnv: options?.extendEnv ?? true,
    ...commandOptions,
  });
}

function collectOutput(
  command: string,
  args: ReadonlyArray<string>,
  options?: ProcessOptions,
) {
  const collected = Effect.scoped(
    Effect.gen(function* () {
      const ownership = yield* CurrentWorkspaceLease;
      const handle = yield* makeCommand(command, args, {
        ...options,
        // Effect's default detached group cleanup kills intentional background
        // workloads even after a successful shell exit. Under custody, an
        // interrupted command retains a durable fence instead of claiming that
        // process-group cleanup proves descendant quiescence.
        ...(ownership ? { detached: false } : {}),
        stdin: options?.stdin ?? "pipe",
        stdout: options?.stdout ?? "pipe",
        stderr: options?.stderr ?? "pipe",
      });
      if (ownership) yield* ownership.childStarted(Number(handle.pid));

      const limit =
        options?.maxOutputBytes === undefined
          ? undefined
          : {
              maxBytes: options.maxOutputBytes,
              onLimit: () => new ProcessOutputLimitError(),
            };
      const [stdout, stderr, exitCode] = yield* Effect.all(
        [
          decodeText(handle.stdout, limit),
          decodeText(handle.stderr, limit),
          Effect.map(handle.exitCode, (exitCode) => Number(exitCode)),
        ],
        { concurrency: "unbounded" },
      );

      return {
        stdout,
        stderr,
        exitCode,
      };
    }),
  );
  return Effect.flatMap(CurrentWorkspaceLease, (ownership) => {
    const guarded = ownership
      ? ownership.command(command, collected)
      : collected;
    return Effect.flatMap(ObservationProcessBudget, (budget) =>
      budget ? budget.withPermits(1)(guarded) : guarded,
    );
  });
}

export function execProcess(
  command: string,
  args: ReadonlyArray<string> = [],
  options?: ProcessOptions,
) {
  return Effect.mapError(
    Effect.filterOrFail(
      collectOutput(command, args, options),
      (output) => output.exitCode === 0,
      (output) =>
        new ProcessExitError({
          command,
          args,
          ...output,
        }),
    ),
    (error) =>
      error instanceof ProcessExitError ||
      (error instanceof WctCommandError &&
        error.code === "workspace_coordination_error")
        ? error
        : new ProcessExitError({
            command,
            args,
            stdout: "",
            stderr: "",
            exitCode: null,
            cause: error,
          }),
  );
}

export function runProcess(
  command: string,
  args: ReadonlyArray<string> = [],
  options?: ProcessOptions,
) {
  return Effect.catchIf(
    Effect.map(execProcess(command, args, options), (output) => ({
      ...output,
      success: true as const,
    })),
    (error: ProcessExitError | WctCommandError): error is ProcessExitError =>
      error instanceof ProcessExitError,
    (error: ProcessExitError) =>
      Effect.succeed({
        stdout: error.stdout,
        stderr: error.stderr,
        exitCode: error.exitCode ?? -1,
        success: false as const,
      }),
  );
}

export function execShell(
  command: string,
  options?: Omit<ProcessOptions, "shell">,
) {
  return execProcess("sh", ["-c", command], options);
}

export function spawnInteractive(
  command: string,
  args: ReadonlyArray<string> = [],
  options?: Omit<ProcessOptions, "stdin" | "stdout" | "stderr">,
) {
  return Effect.acquireUseRelease(
    Effect.try({
      try: () => {
        const env =
          options?.env === undefined
            ? undefined
            : Object.fromEntries(
                Object.entries(
                  options.extendEnv === false
                    ? options.env
                    : { ...process.env, ...options.env },
                ).filter(
                  (entry): entry is [string, string] => entry[1] !== undefined,
                ),
              );

        return Bun.spawn([command, ...args], {
          cwd: options?.cwd,
          env,
          stdin: "inherit",
          stdout: "inherit",
          stderr: "inherit",
        });
      },
      catch: (error) =>
        commandError("unexpected_error", getProcessErrorMessage(error), error),
    }),
    (handle) =>
      Effect.tryPromise({
        try: () => handle.exited,
        catch: (error) =>
          commandError(
            "unexpected_error",
            getProcessErrorMessage(error),
            error,
          ),
      }),
    (handle) =>
      Effect.promise(async () => {
        if (handle.exitCode === null && handle.signalCode === null) {
          // Cancellation must also stop children that ignore SIGTERM.
          handle.kill("SIGKILL");
          await handle.exited;
        }
      }),
  );
}

export function getProcessErrorMessage(error: unknown): string {
  if (error instanceof ProcessExitError) {
    return error.stderr.trim() || error.stdout.trim() || error.message;
  }

  return error instanceof Error ? error.message : String(error);
}
