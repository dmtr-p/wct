import { Effect } from "effect";
import {
  generateCompletionScript,
  getCustomCompletionShell,
} from "./cli/completions";
import { JsonFlag } from "./cli/json-flag";
import { rootCommand } from "./cli/root-command";
import { CliError, Command } from "./effect/cli";
import { BunRuntime, provideBunServices } from "./effect/runtime";
import { provideWctServices } from "./effect/services";
import { toWctError } from "./errors";
import { jsonError } from "./utils/json-output";

const { version: VERSION } = require("../package.json");
const args = process.argv.slice(2);
const customCompletionShell = getCustomCompletionShell(args);

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
      const wctError = toWctError(error);

      return Effect.gen(function* () {
        let json = false;

        try {
          json = yield* JsonFlag;
        } catch {
          // JsonFlag may not be in context if CLI parsing failed.
        }

        if (!json && !CliError.isCliError(error) && args.includes("--json")) {
          json = true;
        }

        if (json) {
          yield* jsonError(wctError.code, wctError.message);
        } else {
          process.stderr.write(`${wctError.message}\n`);
        }

        process.exitCode = 1;
      });
    }),
  ),
);

BunRuntime.runMain(program);
