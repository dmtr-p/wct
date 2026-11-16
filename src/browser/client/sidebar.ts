/// <reference lib="dom" />
import {
  decode,
  LocalCatalog,
  type LocalTarget,
  policy,
  sameLocalTarget,
  type WorkspaceTarget,
} from "../protocol";

/** Presentation state belongs to this page, including across fresh attachments. */
export function createSidebar() {
  const tree = document.getElementById("workspace-tree");
  const status = document.getElementById("sidebar-status");
  const filter = document.getElementById(
    "workspace-filter",
  ) as HTMLInputElement | null;
  const host = document.getElementById(
    "local-host",
  ) as HTMLButtonElement | null;
  const width = document.getElementById(
    "sidebar-width",
  ) as HTMLInputElement | null;
  const sidebar = document.getElementById("sidebar");
  if (!tree?.replaceChildren || !filter?.addEventListener) return undefined;
  let snapshot: LocalCatalog | undefined;
  let target: LocalTarget | undefined;
  let select: ((target: WorkspaceTarget, revision: number) => void) | undefined;
  let view = 0;
  let collapsed = false;
  const expanded = new Map<string, boolean>();
  function render() {
    const current = ++view;
    tree?.replaceChildren();
    if (host) {
      host.setAttribute("aria-expanded", String(!collapsed));
      host.textContent = `${collapsed ? "▸" : "▾"} Local host · this machine`;
    }
    if (collapsed || !snapshot) return;
    const observed = snapshot;
    const query = (filter?.value ?? "").trim().toLocaleLowerCase();
    for (const project of observed.projects) {
      const matches = project.workspaces.filter((workspace) =>
        `${project.displayName} ${project.mainRepoPath} ${workspace.branch} ${workspace.worktreePath}`
          .toLocaleLowerCase()
          .includes(query),
      );
      if (query && !matches.length) continue;
      const section = document.createElement("section");
      const button = document.createElement("button");
      button.className = "project";
      const open = expanded.get(project.mainRepoPath) ?? true;
      button.textContent = `${open ? "▾" : "▸"} ${project.displayName}`;
      button.title = project.mainRepoPath;
      button.setAttribute("aria-expanded", String(open));
      button.onclick = () => {
        if (current !== view) return;
        expanded.set(project.mainRepoPath, !open);
        render();
      };
      section.append(button);
      if (project.error) {
        const error = document.createElement("p");
        error.textContent = "Repository unavailable";
        section.append(error);
      }
      if (open)
        for (const workspace of matches) {
          const row = document.createElement("button");
          const selected =
            !!workspace.target &&
            !!target &&
            sameLocalTarget(workspace.target, target);
          row.className = "workspace";
          row.textContent = `${workspace.branch || "(detached)"}${workspace.target ? "" : " · no session"}`;
          row.title = workspace.worktreePath;
          row.disabled =
            !select ||
            !workspace.target ||
            workspace.target.server !== target?.server;
          row.setAttribute("aria-current", String(selected));
          row.onclick = () => {
            if (
              current !== view ||
              snapshot !== observed ||
              row.disabled ||
              !workspace.target
            )
              return;
            select?.(workspace.target, observed.revision);
          };
          section.append(row);
        }
      tree?.append(section);
    }
    // Removed registry entries must not accumulate expansion state indefinitely.
    for (const key of expanded.keys())
      if (!observed.projects.some((project) => project.mainRepoPath === key))
        expanded.delete(key);
  }
  filter.addEventListener("input", render);
  host?.addEventListener("click", () => {
    collapsed = !collapsed;
    render();
  });
  width?.addEventListener("input", () => {
    const pixels = Number(width.value);
    if (sidebar && Number.isFinite(pixels))
      sidebar.style.width = `${Math.max(180, Math.min(480, pixels))}px`;
  });
  return {
    connection(next: typeof select) {
      select = next;
      render();
    },
    target(next: LocalTarget) {
      target = next;
      if (status)
        status.textContent =
          "sessionName" in next
            ? `Native session · ${next.sessionName} (outside Workspace selection)`
            : "Existing Workspaces · sessions shared with native tmux";
      render();
    },
    unavailable() {
      snapshot = undefined;
      if (status) status.textContent = "Workspace list unavailable; retrying.";
      render();
    },
    snapshot(next: LocalCatalog) {
      if (
        snapshot &&
        next.ref.endpoint === snapshot.ref.endpoint &&
        next.revision < snapshot.revision
      )
        return;
      snapshot = next;
      if (status && target)
        status.textContent =
          "sessionName" in target
            ? `Native session · ${target.sessionName} (outside Workspace selection)`
            : "Existing Workspaces · sessions shared with native tmux";
      render();
    },
  };
}

export async function readCatalog(response: Response) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Missing sidebar response");
  const bytes = new Uint8Array(policy.catalogBytes);
  let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value.length > bytes.length - length)
        throw new Error("Sidebar response exceeds bounds");
      bytes.set(value, length);
      length += value.length;
    }
    return decode(
      LocalCatalog,
      JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(
          bytes.subarray(0, length),
        ),
      ),
    );
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
