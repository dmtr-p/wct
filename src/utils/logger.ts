import {
  ConfigProvider,
  Console,
  Context,
  Effect,
  Option,
  Stdio,
} from "effect";
import { TerminalCapabilities } from "effect/cli";
import { JsonFlag } from "../cli/json-flag";

const colors = {
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
  reset: "\x1b[0m",
  bold: "\x1b[1m",
};

function colorsEnabled(stream: "stdout" | "stderr") {
  return Effect.gen(function* () {
    const json = yield* Effect.serviceOption(JsonFlag);
    if (Option.getOrElse(json, () => false)) {
      return false;
    }
    const stdio = yield* Stdio.Stdio;
    const context = yield* Effect.context<never>();
    // Both capability and config references cache their defaults. Retain an
    // explicit provider, otherwise read the environment for this execution.
    const provider =
      Context.getOrUndefined(context, ConfigProvider.ConfigProvider) ??
      ConfigProvider.fromEnv();
    // The capability layer detects color from stdout. Substitute the target
    // stream so redirected stdout does not disable terminal stderr styling.
    return yield* Effect.map(
      TerminalCapabilities.TerminalCapabilities,
      (capabilities) => capabilities.canColor,
    ).pipe(
      Effect.provide(TerminalCapabilities.layer),
      Effect.provideService(ConfigProvider.ConfigProvider, provider),
      Effect.provideService(
        Stdio.Stdio,
        stream === "stdout"
          ? stdio
          : {
              ...stdio,
              stdoutIsTerminal: stdio.stderrIsTerminal,
            },
      ),
    );
  });
}

function style(message: string, color: string, enabled: boolean): string {
  return enabled ? `${color}${message}${colors.reset}` : message;
}

export const stdoutStyles = Effect.map(colorsEnabled("stdout"), (enabled) => ({
  bold: (message: string) => style(message, colors.bold, enabled),
  green: (message: string) => style(message, colors.green, enabled),
}));

function log(
  label: string,
  color: string,
  message: string,
  stream: "stdout" | "stderr" = "stdout",
) {
  return Effect.flatMap(colorsEnabled(stream), (enabled) => {
    const line = `${style(label, color, enabled)} ${message}`;
    return stream === "stdout" ? Console.log(line) : Console.error(line);
  });
}

export function info(message: string) {
  return log("info", colors.blue, message);
}

export function success(message: string) {
  return log("done", colors.green, message);
}

export function warn(message: string) {
  return log("warn", colors.yellow, message);
}

export function error(message: string) {
  return log("error", colors.red, message, "stderr");
}

export function step(current: number, total: number, message: string) {
  return log(`[${current}/${total}]`, colors.cyan, message);
}
