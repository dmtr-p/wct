import { Effect } from "effect";
import { JsonFlag } from "../cli/json-flag";
import type { WctServices } from "../effect/services";
import type { WctError } from "../errors";
import { WorkspaceService } from "../services/workspace-service";
import { jsonSuccess } from "../utils/json-output";
import * as logger from "../utils/logger";
import { logTmuxResult, maybeAttachSession } from "./session";

export { upCommandDef as commandDef } from "../cli/command-metadata";

export interface UpOptions {
  noAttach?: boolean;
  profile?: string;
  path?: string;
  branch?: string;
}

export function upCommand(
  options?: UpOptions,
): Effect.Effect<void, WctError, WctServices | "effect/cli/GlobalFlag/json"> {
  return Effect.gen(function* () {
    const { noAttach, profile, path, branch } = options ?? {};
    const result = yield* WorkspaceService.use((service) =>
      service.up({ profile, path, branch }),
    );
    const json = yield* JsonFlag;

    if (json) {
      yield* jsonSuccess(result);
      return;
    }

    if (result.profileName) {
      yield* logger.info(`Using profile '${result.profileName}'`);
    }

    yield* logTmuxResult(result);

    if (result.attempts.tmux.attempted && result.attempts.tmux.ok) {
      yield* maybeAttachSession(result.sessionName, noAttach, result.env);
    }

    yield* logger.success(`Environment ready for '${result.branch}'`);
  });
}
