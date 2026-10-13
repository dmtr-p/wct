import { useState } from "react";

export function useFieldFocus<Field extends string>(
  fields: readonly Field[],
  resetKey?: string | boolean,
) {
  const [state, setState] = useState(() => ({
    fields,
    currentField: fields[0] ?? null,
    resetKey,
  }));

  let currentField = state.currentField;
  const fieldsChanged =
    fields.length !== state.fields.length ||
    fields.some((field, index) => field !== state.fields[index]);

  if (resetKey !== state.resetKey) {
    currentField = fields[0] ?? null;
  } else if (currentField === null || !fields.includes(currentField)) {
    const previousIndex =
      currentField === null ? 0 : state.fields.indexOf(currentField);
    currentField =
      fields[Math.max(0, Math.min(previousIndex, fields.length - 1))] ?? null;
  }

  // Reconcile before children render so removed fields cannot keep input focus.
  if (fieldsChanged || resetKey !== state.resetKey) {
    setState({ fields, currentField, resetKey });
  }

  const focusField = (field: Field) => {
    if (!fields.includes(field)) return;
    setState((prev) => ({ ...prev, currentField: field }));
  };

  const moveFocus = (direction: -1 | 1) => {
    if (fields.length === 0) return;
    setState((prev) => {
      const index =
        prev.currentField === null ? -1 : fields.indexOf(prev.currentField);
      const nextIndex =
        index < 0
          ? direction === 1
            ? 0
            : fields.length - 1
          : (index + direction + fields.length) % fields.length;
      return { ...prev, currentField: fields[nextIndex] ?? null };
    });
  };

  return { currentField, focusField, moveFocus };
}
