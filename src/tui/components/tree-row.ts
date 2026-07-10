import { displayWidth } from "../utils/truncate";

export const SELECTED_ROW_BACKGROUND = "cyan" as const;
export const SELECTED_ROW_FOREGROUND = "#f2f2f2" as const;

export function selectedRowFill(
  isSelected: boolean,
  maxWidth: number,
  content: string,
): string {
  if (!isSelected) return "";
  return " ".repeat(Math.max(0, maxWidth - displayWidth(content)));
}
