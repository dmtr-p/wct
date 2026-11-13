import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    {
      name: "embedded-browser-manifest",
      enforce: "pre",
      load(id) {
        // Vite does not implement Bun's text import attribute. Keep endpoint
        // regressions on the actual manifest; compiled tests use Bun's loader.
        if (id === resolve("src/browser/built.browser-assets"))
          return `export default ${JSON.stringify(readFileSync(id, "utf8"))};`;
        return undefined;
      },
    },
  ],
  test: {
    pool: "forks",
    setupFiles: ["./tests/setup.ts"],
  },
});
