import { Prompt } from "../effect/cli";

export function confirm(message: string) {
  return Prompt.run(
    Prompt.Confirm({
      message,
      initial: false,
    }),
  );
}
