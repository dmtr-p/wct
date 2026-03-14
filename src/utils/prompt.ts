import { Prompt } from "../effect/cli";

export function confirm(message: string) {
  return Prompt.run(
    Prompt.confirm({
      message,
      initial: false,
    }),
  );
}
