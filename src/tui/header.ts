export const ADD_PROJECT_BUTTON_LABEL = "[+Add]";
const AGENTS_VIEW_BUTTON_LABEL = "[Agents]";
const WORKTREES_VIEW_BUTTON_LABEL = "[Worktrees]";

/** Rendering and hit-testing share the labels that fit on one terminal row. */
export function getHeaderLayout(columns: number, agentsView: boolean) {
  const width = Math.max(0, columns);
  let title = "wct";
  let viewLabel = agentsView
    ? WORKTREES_VIEW_BUTTON_LABEL
    : AGENTS_VIEW_BUTTON_LABEL;
  let addLabel = ADD_PROJECT_BUTTON_LABEL;
  let gap = 1;
  const requiredWidth = () =>
    title.length + viewLabel.length + gap + addLabel.length;

  if (requiredWidth() > width) addLabel = "[+]";
  if (requiredWidth() > width) viewLabel = agentsView ? "[W]" : "[A]";
  if (requiredWidth() > width) title = "";
  if (requiredWidth() > width) {
    viewLabel = agentsView ? "W" : "A";
    addLabel = "+";
  }
  if (width < 3) gap = 0;
  if (width < 2) addLabel = "";
  if (width < 1) viewLabel = "";

  const addFirstColumn = width - addLabel.length + 1;
  const viewLastColumn = addFirstColumn - gap - 1;
  return {
    title,
    gap,
    controlsWidth: viewLabel.length + gap + addLabel.length,
    viewToggle: {
      label: viewLabel,
      firstColumn: viewLastColumn - viewLabel.length + 1,
      lastColumn: viewLastColumn,
    },
    addProject: {
      label: addLabel,
      firstColumn: addFirstColumn,
      lastColumn: width,
    },
  };
}
