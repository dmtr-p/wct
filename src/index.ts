import { Effect } from "effect";
import {
  generateCompletionScript,
  getCustomCompletionShell,
} from "./cli/completions";
import { JsonFlag } from "./cli/json-flag";
import { rootCommand } from "./cli/root-command";
import { CliError, CliOutput, Command } from "./effect/cli";
import { BunRuntime, provideBunServices } from "./effect/runtime";
import { provideWctServices } from "./effect/services";
import { commandError, toWctError } from "./errors";
import { jsonError } from "./utils/json-output";

const { version: VERSION } = require("../package.json");
const args = process.argv.slice(2);
const customCompletionShell = getCustomCompletionShell(args);
const helpRequested = args.includes("--help") || args.includes("-h");
const jsonRequested = args.includes("--json");
const builtInActionRequested =
  args.includes("--version") || args.includes("--completions");

function toJsonModeWctError(
  error: unknown,
): ReturnType<typeof toWctError> | null {
  if (!CliError.isCliError(error)) {
    return toWctError(error);
  }

  switch (error._tag) {
    case "UnknownSubcommand":
      return commandError("unknown_command", error.message, error);
    case "UnrecognizedOption":
    case "DuplicateOption":
    case "MissingOption":
    case "MissingArgument":
    case "InvalidValue":
      return commandError("invalid_options", error.message, error);
    case "UserError":
      return toWctError(error.cause);
    case "ShowHelp": {
      const firstError = error.errors[0];
      return firstError ? toJsonModeWctError(firstError) : null;
    }
  }
}

if (args.length === 1 && args[0] === "-v") {
  process.stdout.write(`wct v${VERSION}\n`);
  process.exit(0);
}

if (customCompletionShell) {
  process.stdout.write(`${generateCompletionScript(customCompletionShell)}\n`);
  process.exit(0);
}

const program = provideBunServices(
  provideWctServices(
    Effect.catch(Command.run(rootCommand, { version: VERSION }), (error) => {
      return Effect.gen(function* () {
        let json = false;

        try {
          json = yield* JsonFlag;
        } catch {
          // JsonFlag may not be in context if CLI parsing failed.
        }

        if (!json && args.includes("--json")) {
          json = true;
        }

        if (
          CliError.isCliError(error) &&
          error._tag === "ShowHelp" &&
          error.errors.length === 0
        ) {
          process.exitCode = 0;
          return;
        }

        const wctError = json ? toJsonModeWctError(error) : toWctError(error);

        if (json && wctError) {
          yield* jsonError(wctError.code, wctError.message);
        } else {
          process.stderr.write(`${toWctError(error).message}\n`);
        }

        process.exitCode = 1;
      });
    }),
  ),
);

const shouldSuppressCliOutputForJson =
  jsonRequested &&
  !helpRequested &&
  !builtInActionRequested &&
  args.some((arg) => arg !== "--json");

const runnableProgram = shouldSuppressCliOutputForJson
  ? program.pipe(
      Effect.provide(
        CliOutput.layer({
          ...CliOutput.defaultFormatter(),
          formatHelpDoc: () => "",
          formatErrors: () => "",
        }),
      ),
    )
  : program;

BunRuntime.runMain(runnableProgram);
