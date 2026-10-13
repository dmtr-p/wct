// Approximate Ink's terminal column measurements without another dependency.
// Multi-code-point graphemes count as two columns, including combining marks.
// Rare clusters can differ from Ink; callers must also prevent soft wrapping.

const segmenter = new Intl.Segmenter();

function isFullwidthCodePoint(cp: number): boolean {
  return (
    cp >= 0x1100 &&
    (cp <= 0x115f || // Hangul Jamo
      cp === 0x2329 || // LEFT-POINTING ANGLE BRACKET
      cp === 0x232a || // RIGHT-POINTING ANGLE BRACKET
      // CJK Radicals Supplement .. Enclosed CJK Letters and Months
      (cp >= 0x2e80 && cp <= 0x3247 && cp !== 0x303f) ||
      (cp >= 0x3250 && cp <= 0x4dbf) || // Enclosed CJK .. CJK Ext A, Yijing
      (cp >= 0x4e00 && cp <= 0xa4c6) || // CJK Unified Ideographs .. Yi Radicals
      (cp >= 0xa960 && cp <= 0xa97c) || // Hangul Jamo Extended-A
      (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul Syllables
      (cp >= 0xf900 && cp <= 0xfaff) || // CJK Compatibility Ideographs
      (cp >= 0xfe10 && cp <= 0xfe19) || // Vertical Forms
      (cp >= 0xfe30 && cp <= 0xfe6b) || // CJK Compatibility Forms
      (cp >= 0xff01 && cp <= 0xff60) || // Fullwidth Forms
      (cp >= 0xffe0 && cp <= 0xffe6) || // Fullwidth Signs
      (cp >= 0x1b000 && cp <= 0x1b001) || // Kana Supplement
      (cp >= 0x1f200 && cp <= 0x1f251) || // Enclosed Ideographic Supplement
      (cp >= 0x20000 && cp <= 0x3fffd)) // CJK Extension B and beyond
  );
}

const EMOJI_PRESENTATION = /^\p{Emoji_Presentation}$/u;

function graphemeWidth(segment: string): number {
  // eslint-disable-next-line typescript/no-misused-spread -- segment is already a grapheme; count its code points for the width approximation
  const codePoints = [...segment];
  if (codePoints.length > 1) return 2;
  const cp = segment.codePointAt(0) ?? 0;
  if (cp <= 0x1f || (cp >= 0x7f && cp <= 0x9f)) return 0; // control chars
  if (isFullwidthCodePoint(cp) || EMOJI_PRESENTATION.test(segment)) return 2;
  return 1;
}

export function graphemeWidths(text: string): Array<[string, number]> {
  const result: Array<[string, number]> = [];
  for (const { segment } of segmenter.segment(text)) {
    result.push([segment, graphemeWidth(segment)]);
  }
  return result;
}

export function displayWidth(text: string): number {
  let width = 0;
  for (const { segment } of segmenter.segment(text)) {
    width += graphemeWidth(segment);
  }
  return width;
}
