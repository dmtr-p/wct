import { Effect } from "effect";
import { HooksService } from "../services/hooks-service";
import type { CommandDef } from "./command-def";

export const commandDef: CommandDef = {
  name: "hooks",
  description: "Output or install Claude Code hooks config",
  options: [
    {
      name: "install",
      type: "boolean",
      description: "Install hooks into .claude/settings.local.json",
    },
  ],
};

export interface HooksOptions {
  install?: boolean;
}

export function hooksCommand(options: HooksOptions) {
  return Effect.gen(function* () {
    if (!options.install) {
      const config = yield* HooksService.use((service) =>
        service.renderHooksConfig(),
      );
      yield* Effect.sync(() => {
        console.log(config);
        console.error(
          "\nAdd this to your .claude/settings.local.json, or run: wct hooks --install",
        );
      });
      return;
    }

    yield* HooksService.use((service) => service.installHooks(process.cwd()));
  });
}
