import { displayWidth } from "../utils/display-width";

export const SELECTED_ROW_BACKGROUND = "cyan" as const;
export const SELECTED_ROW_FOREGROUND = "#f2f2f2" as const;

export function selectedRowFill(
  isHighlighted: boolean,
  maxWidth: number,
  content: string,
): string {
  if (!isHighlighted) return "";
  return " ".repeat(Math.max(0, maxWidth - displayWidth(content)));
}
