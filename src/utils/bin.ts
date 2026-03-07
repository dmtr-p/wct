export interface WctBinCommand {
  cmd: string;
  args: string[];
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function formatShellCommand(
  command: WctBinCommand,
  extraArgs: string[] = [],
): string {
  return [command.cmd, ...command.args, ...extraArgs].map(shellQuote).join(" ");
}

export function resolveWctBin(): WctBinCommand {
  try {
    const bin = Bun.which("wct");
    if (bin) return { cmd: bin, args: [] };
  } catch {
    // ignore
  }
  // Fallback: resolve relative to this source file
  const entry = new URL("../../src/index.ts", import.meta.url).pathname;
  return { cmd: "bun", args: ["run", entry] };
}
