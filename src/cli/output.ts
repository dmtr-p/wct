import { Console, Effect } from "effect";
import { CliOutput } from "effect/cli";

export function installCliOutputHandlers() {
  for (const [stream, exitCode] of [
    [process.stdout, 0],
    [process.stderr, 1],
  ] as const) {
    stream.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE") throw error;
      // A downstream reader can exit before the CLI finishes writing.
      process.exit(exitCode);
    });
  }
}

export function provideCliOutput<A, E, R>(
  program: Effect.Effect<A, E, R>,
  { suppressHelp }: { suppressHelp: boolean },
) {
  return Console.consoleWith((output) => {
    // Bun can color console.error strings independently of the CLI formatter.
    // Write formatted text directly so its color policy also governs the bytes.
    const withConsole = program.pipe(
      Effect.provideService(
        Console.Console,
        Object.assign(Object.create(output) as Console.Console, {
          log: (...messages: ReadonlyArray<unknown>) => {
            if (messages.length === 1 && typeof messages[0] === "string") {
              if (suppressHelp && messages[0] === "") return;
              process.stdout.write(`${messages[0]}\n`);
            } else {
              output.log(...messages);
            }
          },
          error: (...messages: ReadonlyArray<unknown>) => {
            if (messages.length === 1 && typeof messages[0] === "string") {
              process.stderr.write(`${messages[0]}\n`);
            } else {
              output.error(...messages);
            }
          },
        }),
      ),
    );

    return suppressHelp
      ? withConsole.pipe(
          Effect.provide(
            CliOutput.layer({
              // eslint-disable-next-line typescript/no-misused-spread -- defaultFormatter returns a plain object with own formatter functions
              ...CliOutput.defaultFormatter({ colors: false }),
              formatHelpDoc: () => "",
              formatErrors: () => "",
            }),
          ),
        )
      : withConsole;
  });
}
