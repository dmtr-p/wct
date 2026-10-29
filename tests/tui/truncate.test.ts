import { it } from "@effect/vitest";
import { Arbitrary, Schema } from "effect";
import { describe, expect, test } from "vitest";
import { displayWidth } from "../../src/tui/utils/display-width";
import {
  toSingleLine,
  truncateBranch,
  truncateWithPrefix,
} from "../../src/tui/utils/truncate";

const unicodeText = Arbitrary.array(
  Arbitrary.schema(
    Schema.Literals([
      "a",
      "Z",
      "0",
      "/",
      " ",
      "日",
      "界",
      "é",
      "e\u0301",
      "\u0301",
      "👨‍👩‍👧‍👦",
      "🇺🇦",
      "👍🏽",
      "…",
      "\u200d",
      "\ufe0f",
      "\u0000",
    ]),
  ),
  { maxLength: 32 },
).pipe(Arbitrary.map((parts) => parts.join("")));
const columnBudget = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: 64 }),
);
const segmenter = new Intl.Segmenter();

function expectCompleteTruncation(
  text: string,
  output: string,
  available: number,
) {
  expect(displayWidth(output)).toBeLessThanOrEqual(available);
  if (output === text || output === "") return;
  const original = Array.from(
    segmenter.segment(text),
    ({ segment }) => segment,
  );
  const truncated = Array.from(
    segmenter.segment(output),
    ({ segment }) => segment,
  );
  expect(truncated.at(-1)).toBe("…");
  expect(truncated.slice(0, -1)).toEqual(
    original.slice(0, truncated.length - 1),
  );
}

describe("truncateBranch", () => {
  it.prop(
    "respects column budgets and complete Unicode graphemes",
    {
      text: unicodeText,
      available: columnBudget,
    },
    ({ text, available }) => {
      expectCompleteTruncation(
        text,
        truncateBranch(text, available),
        available,
      );
      if (displayWidth(text) <= available)
        expect(truncateBranch(text, available)).toBe(text);
    },
    { arbitrary: { runs: 100, maxShrinks: 200 } },
  );

  test("returns text unchanged when it fits", () => {
    expect(truncateBranch("feat/auth", 20)).toBe("feat/auth");
  });

  test("returns text unchanged at exact limit", () => {
    expect(truncateBranch("feat/auth", 9)).toBe("feat/auth");
  });

  test("truncates with ellipsis when too long", () => {
    expect(truncateBranch("feature/very-long-branch-name", 15)).toBe(
      "feature/very-l…",
    );
  });

  test("uses one ellipsis glyph in the available budget", () => {
    expect(truncateBranch("feature/branch", 3)).toBe("fe…");
  });

  test("handles available less than the text length", () => {
    expect(truncateBranch("feature/branch", 2)).toBe("f…");
    expect(truncateBranch("feature/branch", 1)).toBe("…");
  });

  test("returns empty string when available is 0", () => {
    expect(truncateBranch("feature/branch", 0)).toBe("");
  });

  test("budgets CJK glyphs at two display columns each", () => {
    expect(truncateBranch("日本語ブランチ", 9)).toBe("日本語ブ…");
    expect(truncateBranch("日本語ブランチ", 14)).toBe("日本語ブランチ");
  });

  test("never splits an emoji ZWJ sequence when truncating", () => {
    const family = "👨‍👩‍👧‍👦";
    expect(truncateBranch(family.repeat(3), 5)).toBe(`${family.repeat(2)}…`);
  });
});

describe("truncateWithPrefix", () => {
  it.prop(
    "keeps pane prefixes and Unicode text within the column budget",
    {
      paneIndex: Schema.Int.check(
        Schema.isBetween({ minimum: 0, maximum: 99 }),
      ),
      text: unicodeText,
      available: columnBudget,
    },
    ({ paneIndex, text, available }) => {
      const prefix = `${paneIndex}:0 `;
      const output = truncateWithPrefix(prefix, text, available);
      expectCompleteTruncation(prefix + text, output, available);
      if (available > displayWidth(prefix) + 1)
        expect(output.startsWith(prefix)).toBe(true);
    },
    { arbitrary: { runs: 100, maxShrinks: 200 } },
  );

  test("returns prefix+rest when both fit", () => {
    expect(truncateWithPrefix("1:0 ", "vim", 20)).toBe("1:0 vim");
  });

  test("returns prefix+rest at exact limit", () => {
    expect(truncateWithPrefix("1:0 ", "vim", 7)).toBe("1:0 vim");
  });

  test("preserves prefix and truncates rest when too long", () => {
    expect(truncateWithPrefix("1:0 ", "bun run dev --watch", 15)).toBe(
      "1:0 bun run de…",
    );
  });

  test("preserves prefix when available is wider than prefix plus ellipsis", () => {
    expect(truncateWithPrefix("1:0 ", "vim this is long", 7)).toBe("1:0 vi…");
  });

  test("truncates when the prefix consumes the available columns", () => {
    expect(truncateWithPrefix("1:0 ", "vim this is long", 5)).toBe("1:0 …");
  });

  test("handles empty rest", () => {
    expect(truncateWithPrefix("1:0 ", "", 10)).toBe("1:0 ");
    expect(truncateWithPrefix("1:0 ", "", 4)).toBe("1:0 ");
  });

  test("measures the rest by display width", () => {
    expect(truncateWithPrefix("1:0 ", "🎉🎉🎉", 8)).toBe("1:0 🎉…");
  });

  test("preserves a grapheme spanning the prefix boundary", () => {
    expect(truncateWithPrefix("1:0 ", "\u0301\u0301abc", 6)).toBe(
      "1:0 \u0301\u0301…",
    );
  });
});

describe("toSingleLine", () => {
  test("returns a single-line string unchanged", () => {
    expect(toSingleLine("fatal: not a git repository")).toBe(
      "fatal: not a git repository",
    );
  });

  test("collapses git-style multi-line stderr onto one line", () => {
    expect(toSingleLine("fatal: something went wrong\nhint: try again")).toBe(
      "fatal: something went wrong hint: try again",
    );
  });

  test("squashes CRLF, indentation after the break, and trailing newlines", () => {
    expect(toSingleLine("error: HTTP 502\r\n   advice: retry later\n")).toBe(
      "error: HTTP 502 advice: retry later",
    );
    expect(toSingleLine("a\n\n\nb")).toBe("a b");
  });

  test("collapses standalone carriage returns", () => {
    expect(toSingleLine("first\r    second")).toBe("first second");
  });
});
