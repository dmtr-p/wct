import { Effect } from "effect";
import {
  generateCompletionScript,
  getCustomCompletionShell,
} from "./cli/completions";
import { rootCommand } from "./cli/root-command";
import { Command } from "./effect/cli";
import { BunRuntime, provideBunServices } from "./effect/runtime";
import { provideWctServices } from "./effect/services";
import { toWctError } from "./errors";

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
    Effect.catch(Command.run(rootCommand, { version: VERSION }), (error) =>
      Effect.sync(() => {
        process.stderr.write(`${toWctError(error).message}\n`);
        process.exitCode = 1;
      }),
    ),
  ),
);

BunRuntime.runMain(program as never);
