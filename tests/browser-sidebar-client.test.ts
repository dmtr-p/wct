import { afterEach, expect, vi } from "vitest";
import { createSidebar, readCatalog } from "../src/browser/client/sidebar";
import { decode, LocalCatalog, policy } from "../src/browser/protocol";
import { sidebarDocument } from "./helpers/sidebar-dom";
import { test } from "./helpers/temp-dir";

afterEach(() => vi.unstubAllGlobals());
const target = {
  mainRepoPath: "/repo",
  worktreePath: "/repo",
  branch: "main",
  server: "server",
  sessionId: "$1",
};
const catalog = decode(LocalCatalog, {
  ref: {
    endpoint: "ephemeral",
    attachmentId: "11111111-1111-4111-8111-111111111111",
    generation: "22222222-2222-4222-8222-222222222222",
    server: "server",
  },
  streamId: "33333333-3333-4333-8333-333333333333",
  revision: 1,
  projects: [
    {
      mainRepoPath: "/repo",
      displayName: "Project",
      workspaces: [
        { branch: "main", worktreePath: "/repo", target },
        {
          branch: "other",
          worktreePath: "/repo/other",
          target: {
            ...target,
            branch: "other",
            worktreePath: "/repo/other",
            sessionId: "$2",
          },
        },
        { branch: "stopped", worktreePath: "/repo/stopped", target: null },
      ],
    },
  ],
});
function page() {
  const dom = sidebarDocument();
  vi.stubGlobal("document", dom);
  const sidebar = createSidebar();
  if (!sidebar) throw new Error("Missing sidebar");
  const select = vi.fn();
  sidebar.target(target);
  sidebar.snapshot(catalog);
  sidebar.connection(select);
  return { dom, sidebar, select };
}
test("two pages keep expansion, filtering, width and actual selection separate", () => {
  const one = page();
  const two = page();
  one.dom.get("workspace-filter").input("other");
  expect(one.dom.rows()).toHaveLength(1);
  expect(two.dom.rows()).toHaveLength(3);
  one.dom.rows()[0]?.click();
  expect(one.select).toHaveBeenCalledWith(
    catalog.projects[0]?.workspaces[1]?.target,
    1,
  );
  expect(two.select).not.toHaveBeenCalled();
  one.dom.get("sidebar-width").input("400");
  expect(one.dom.get("sidebar").style.width).toBe("400px");
  expect(two.dom.get("sidebar").style.width).toBe("");
  one.dom.get("workspace-tree").children[0]?.children[0]?.click();
  expect(one.dom.rows()).toHaveLength(0);
  expect(two.dom.rows()).toHaveLength(3);
  one.sidebar.connection(undefined);
  one.sidebar.connection(one.select);
  expect(one.dom.rows()).toHaveLength(0);
  two.sidebar.target({
    server: "server",
    sessionId: "$9",
    sessionName: "native-renamed",
  });
  expect(two.dom.get("sidebar-status").textContent).toContain("native-renamed");
  expect(
    two.dom
      .rows()
      .every((row) => row.attributes.get("aria-current") === "false"),
  ).toBe(true);
});
test("old row handlers and older catalogs cannot redirect a current selection", () => {
  const p = page();
  const old = p.dom.rows()[1];
  p.sidebar.snapshot({ ...catalog, revision: 2, projects: [] });
  old?.click();
  expect(p.select).not.toHaveBeenCalled();
  p.sidebar.snapshot(catalog);
  expect(p.dom.rows()).toHaveLength(0);
  p.sidebar.snapshot({ ...catalog, revision: 3 });
  expect(p.dom.rows()[2]?.disabled).toBe(true);
  const pending = p.dom.rows()[1];
  p.sidebar.connection(undefined);
  pending?.click();
  expect(p.select).not.toHaveBeenCalled();
  p.sidebar.unavailable();
  expect(p.dom.rows()).toHaveLength(0);
  p.sidebar.snapshot({ ...catalog, revision: 4 });
  expect(p.dom.get("sidebar-status").textContent).not.toContain("unavailable");
});
test("catalog reader bounds actual response bytes and strictly decodes references", async () => {
  expect(await readCatalog(Response.json(catalog))).toEqual(catalog);
  await expect(
    readCatalog(new Response("x".repeat(policy.catalogBytes + 1))),
  ).rejects.toThrow("bounds");
  await expect(
    readCatalog(Response.json({ ...catalog, command: "up" })),
  ).rejects.toThrow();
});
