import { Effect, Option } from "effect";
import {
  CliConfig,
  CliError,
  CliOutput,
  Command,
  GlobalFlag,
} from "effect/cli";
import {
  COMPLETION_PROFILES_FLAG,
  runCompletionProfiles,
} from "./cli/completion-profiles";
import {
  generateCompletionScript,
  getCustomCompletionShell,
} from "./cli/completions";
import { CompletionsFlag } from "./cli/completions-flag";
import { JsonFlag } from "./cli/json-flag";
import { rootCommand } from "./cli/root-command";
import { BunRuntime, provideBunServices } from "./effect/runtime";
import { provideWctServices } from "./effect/services";
import { runShutdownWorker } from "./effect/shutdown-worker";
import { commandError, toWctError } from "./errors";
import { SHUTDOWN_WORKER_FLAG } from "./services/shutdown-runner";
import { jsonError } from "./utils/json-output";

const { version: VERSION } = require("../package.json");
const args = process.argv.slice(2);
const customCompletionShell = getCustomCompletionShell(args);
const helpRequested = args.includes("--help") || args.includes("-h");
const jsonRequested = args.includes("--json");
const builtInActionRequested =
  args.includes("--version") || args.includes("--completions");
const cliConfigLayer = CliConfig.layer({
  builtIns: [
    GlobalFlag.Help,
    GlobalFlag.Version,
    CompletionsFlag,
    GlobalFlag.LogLevel,
  ],
});

function toJsonModeWctError(
  error: unknown,
): ReturnType<typeof toWctError> | null {
  if (!CliError.isCliError(error)) {
    return toWctError(error);
  }

  if (error instanceof CliError.UnknownSubcommand) {
    return commandError("unknown_command", error.message, error);
  }

  switch (error._tag) {
    case "UnrecognizedOption":
    case "DuplicateOption":
    case "MissingOption":
    case "MissingArgument":
    case "UnexpectedArgument":
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

const commandProgram = Command.run(rootCommand, {
  version: VERSION,
  renderErrors: !jsonRequested,
}).pipe(Effect.provide(cliConfigLayer));

const program = provideBunServices(
  provideWctServices(
    Effect.catch(commandProgram, (error) => {
      return Effect.gen(function* () {
        const jsonFlag = yield* Effect.serviceOption(JsonFlag);
        const json = Option.getOrElse(jsonFlag, () => false) || jsonRequested;

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
          // eslint-disable-next-line typescript/no-misused-spread -- defaultFormatter returns a plain object with own formatter functions
          ...CliOutput.defaultFormatter(),
          formatHelpDoc: () => "",
          formatErrors: () => "",
        }),
      ),
    )
  : program;

BunRuntime.runMain(
  args[0] === COMPLETION_PROFILES_FLAG
    ? provideBunServices(runCompletionProfiles(args[1] ?? ""))
    : args[0] === SHUTDOWN_WORKER_FLAG
      ? provideBunServices(provideWctServices(runShutdownWorker(args[1] ?? "")))
      : runnableProgram,
);
