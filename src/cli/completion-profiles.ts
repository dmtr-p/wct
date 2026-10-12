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
      // NUL records preserve whitespace and newlines in profile names.
      return profiles.map((profile) => `${profile}\0`).join("");
    case "zsh":
      // Zsh's (z)/(Q) decoding preserves names without evaluating shell text.
      return profiles
        .map((profile) => `'${profile.replaceAll("'", "'\\''")}'`)
        .join(" ");
    case "fish":
      return profiles.map((profile) => `${profile}\0`).join("");
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
