import { Data, Effect, Stream } from "effect";
import { ChildProcess } from "effect/process";
import { commandError } from "../errors";

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

function decodeOutput<E>(
  stream: Stream.Stream<Uint8Array, E>,
  maxBytes?: number,
): Effect.Effect<string, E | ProcessOutputLimitError> {
  let bounded: Stream.Stream<Uint8Array, E | ProcessOutputLimitError> = stream;
  if (maxBytes !== undefined) {
    let bytes = 0;
    bounded = Stream.mapEffect(stream, (chunk) => {
      bytes += chunk.byteLength;
      return bytes > maxBytes
        ? Effect.fail(new ProcessOutputLimitError())
        : Effect.succeed(chunk);
    });
  }
  return Stream.mkString(Stream.decodeText(bounded));
}

function makeCommand(
  command: string,
  args: ReadonlyArray<string>,
  options?: ProcessOptions,
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
  return Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* makeCommand(command, args, {
        ...options,
        stdin: options?.stdin ?? "pipe",
        stdout: options?.stdout ?? "pipe",
        stderr: options?.stderr ?? "pipe",
      });

      const [stdout, stderr, exitCode] = yield* Effect.all(
        [
          decodeOutput(handle.stdout, options?.maxOutputBytes),
          decodeOutput(handle.stderr, options?.maxOutputBytes),
          Effect.map(handle.exitCode, Number),
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
      error instanceof ProcessExitError
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
    (error): error is ProcessExitError => error instanceof ProcessExitError,
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
