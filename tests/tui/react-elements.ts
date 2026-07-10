import React from "react";

export function hasElementProp(
  node: React.ReactNode,
  prop: string,
  value: unknown,
): boolean {
  if (Array.isArray(node)) {
    return node.some((child) => hasElementProp(child, prop, value));
  }
  if (!React.isValidElement(node)) return false;

  const props = node.props as Record<string, unknown>;
  if (props[prop] === value) return true;
  return hasElementProp(props.children as React.ReactNode, prop, value);
}

export function elementText(node: React.ReactNode): string {
  if (Array.isArray(node)) return node.map(elementText).join("");
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (!React.isValidElement(node)) return "";
  const props = node.props as Record<string, unknown>;
  return elementText(props.children as React.ReactNode);
}
