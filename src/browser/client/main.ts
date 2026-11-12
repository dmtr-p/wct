/// <reference lib="dom" />
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";

const container = document.getElementById("terminal");
if (container) {
  const terminal = new Terminal({ disableStdin: true });
  const fit = new FitAddon();
  terminal.loadAddon(fit);
  terminal.open(container);
  fit.fit();
  terminal.writeln("wct browser terminal assets loaded.");
}
