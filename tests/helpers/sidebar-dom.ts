export class SidebarElement {
  textContent = "";
  value = "";
  className = "";
  title = "";
  disabled = false;
  style = { width: "" };
  children: SidebarElement[] = [];
  attributes = new Map<string, string>();
  events = new Map<string, () => void>();
  onclick?: () => void;
  setAttribute(key: string, value: string) {
    this.attributes.set(key, value);
  }
  addEventListener(key: string, value: () => void) {
    this.events.set(key, value);
  }
  replaceChildren() {
    this.children = [];
  }
  append(child: SidebarElement) {
    this.children.push(child);
  }
  click() {
    if (!this.disabled) {
      this.onclick?.();
      this.events.get("click")?.();
    }
  }
  input(value: string) {
    this.value = value;
    this.events.get("input")?.();
  }
}
export function sidebarDocument() {
  const elements = new Map(
    [
      "workspace-tree",
      "sidebar-status",
      "workspace-filter",
      "local-host",
      "sidebar-width",
      "sidebar",
    ].map((id) => [id, new SidebarElement()]),
  );
  const get = (id: string) => {
    const element = elements.get(id);
    if (!element) throw new Error(`Missing ${id}`);
    return element;
  };
  return {
    get,
    getElementById: (id: string) => elements.get(id),
    createElement: () => new SidebarElement(),
    rows: () =>
      get("workspace-tree")
        .children.flatMap((section) => section.children)
        .filter((child) => child.className === "workspace"),
  };
}
