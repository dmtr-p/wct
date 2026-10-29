import { vi } from "vitest";

vi.mock("../src/services/process", async () => {
  const actual = await vi.importActual<
    typeof import("../src/services/process")
  >("../src/services/process");
  const { Effect } = await import("effect");
  const blocked = () =>
    Effect.die(
      new Error(
        "Host tmux is disabled in tests; provide a fake service or an explicit fixture executable",
      ),
    );

  return {
    ...actual,
    execProcess: (...args: Parameters<typeof actual.execProcess>) =>
      args[0] === "tmux" ? blocked() : actual.execProcess(...args),
    runProcess: (...args: Parameters<typeof actual.runProcess>) =>
      args[0] === "tmux" ? blocked() : actual.runProcess(...args),
    spawnInteractive: (...args: Parameters<typeof actual.spawnInteractive>) =>
      args[0] === "tmux" ? blocked() : actual.spawnInteractive(...args),
  };
});
