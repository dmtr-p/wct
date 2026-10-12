import { Effect } from "effect";
import { loadConfig } from "../config/loader";
import { liveWorktreeService } from "../services/worktree-service";

export const COMPLETION_PROFILES_FLAG = "--wct-completion-profiles";

export const completionProfiles = Effect.gen(function* () {
  const mainRepo = yield* liveWorktreeService.getMainRepoPath();
  if (!mainRepo) return [];
  const config = yield* loadConfig(mainRepo);
  return Object.keys(config.profiles ?? {});
}).pipe(Effect.orElseSucceed(() => []));

export function renderCompletionProfiles(
  profiles: readonly string[],
  shell: string,
): string {
  switch (shell) {
    case "bash":
    case "zsh":
    case "fish":
      return profiles.length ? `${profiles.join("\n")}\n` : "";
    default:
      return "";
  }
}

export const runCompletionProfiles = (shell: string) =>
  completionProfiles.pipe(
    Effect.flatMap((profiles) =>
      Effect.sync(() => {
        process.stdout.write(renderCompletionProfiles(profiles, shell));
      }),
    ),
    Effect.ignoreCause,
  );
