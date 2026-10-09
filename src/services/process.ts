import { Effect, Stream } from "effect";
import { ChildProcess } from "effect/process";

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

export class ProcessOutputLimitError extends Error {
  constructor() {
    super("Process output limit exceeded");
    this.name = "ProcessOutputLimitError";
  }
}

export class ProcessExitError extends Error {
  override readonly cause?: unknown;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;

  constructor(params: {
    command: string;
    args: ReadonlyArray<string>;
    stdout: string;
    stderr: string;
    exitCode: number | null;
    cause?: unknown;
  }) {
    const message =
      params.stderr.trim() ||
      params.stdout.trim() ||
      (params.exitCode === null
        ? `Failed to run ${formatCommand(params.command, params.args)}`
        : `Command exited with code ${params.exitCode}: ${formatCommand(params.command, params.args)}`);

    super(message);
    this.name = "ProcessExitError";
    this.command = params.command;
    this.args = params.args;
    this.stdout = params.stdout;
    this.stderr = params.stderr;
    this.exitCode = params.exitCode;
    this.cause = params.cause;
  }
}

function formatCommand(command: string, args: ReadonlyArray<string>): string {
  return [command, ...args].join(" ");
}

function decodeOutput(
  stream: Stream.Stream<Uint8Array, unknown>,
  maxBytes?: number,
): Effect.Effect<string, unknown> {
  if (maxBytes !== undefined) {
    let bytes = 0;
    stream = Stream.mapEffect(stream, (chunk) => {
      bytes += chunk.byteLength;
      return bytes > maxBytes
        ? Effect.fail(new ProcessOutputLimitError())
        : Effect.succeed(chunk);
    });
  }
  return Stream.mkString(Stream.decodeText(stream));
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
  return Effect.catch(
    Effect.flatMap(collectOutput(command, args, options), (output) =>
      output.exitCode === 0
        ? Effect.succeed(output)
        : Effect.fail(
            new ProcessExitError({
              command,
              args,
              ...output,
            }),
          ),
    ),
    (error) =>
      error instanceof ProcessExitError
        ? Effect.fail(error)
        : Effect.fail(
            new ProcessExitError({
              command,
              args,
              stdout: "",
              stderr: "",
              exitCode: null,
              cause: error,
            }),
          ),
  );
}

export function runProcess(
  command: string,
  args: ReadonlyArray<string> = [],
  options?: ProcessOptions,
) {
  return Effect.catch(
    Effect.map(execProcess(command, args, options), (output) => ({
      ...output,
      success: true as const,
    })),
    (error) =>
      error instanceof ProcessExitError
        ? Effect.succeed({
            stdout: error.stdout,
            stderr: error.stderr,
            exitCode: error.exitCode ?? -1,
            success: false as const,
          })
        : Effect.fail(error),
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
  return Effect.tryPromise({
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

      const handle = Bun.spawn([command, ...args], {
        cwd: options?.cwd,
        env,
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      });

      return handle.exited;
    },
    catch: (error) =>
      error instanceof Error ? error : new Error(String(error)),
  });
}

export function getProcessErrorMessage(error: unknown): string {
  if (error instanceof ProcessExitError) {
    return error.stderr.trim() || error.stdout.trim() || error.message;
  }

  return error instanceof Error ? error.message : String(error);
}
