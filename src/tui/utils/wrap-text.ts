import { displayWidth, graphemeWidths } from "./display-width";

export function wrapText(text: string, width: number): string[] {
  if (width <= 0) return [text];
  const lines: string[] = [];
  let current = "";
  let currentWidth = 0;

  for (const word of text.split(" ")) {
    let nextWord = word;
    let wordWidth = displayWidth(word);
    if (wordWidth > width) {
      if (current !== "") {
        lines.push(current);
        current = "";
        currentWidth = 0;
      }
      let piece = "";
      let pieceWidth = 0;
      for (const [grapheme, graphemeWidth] of graphemeWidths(word)) {
        if (piece !== "" && pieceWidth + graphemeWidth > width) {
          lines.push(piece);
          piece = "";
          pieceWidth = 0;
        }
        piece += grapheme;
        pieceWidth += graphemeWidth;
      }
      nextWord = piece;
      wordWidth = pieceWidth;
    }

    if (current === "") {
      current = nextWord;
      currentWidth = wordWidth;
    } else if (currentWidth + 1 + wordWidth <= width) {
      current += ` ${nextWord}`;
      currentWidth += 1 + wordWidth;
    } else {
      lines.push(current);
      current = nextWord;
      currentWidth = wordWidth;
    }
  }

  lines.push(current);
  return lines;
}
