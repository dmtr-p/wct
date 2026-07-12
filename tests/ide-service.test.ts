import { describe, expect, test } from "vitest";
import { substituteEnvVars } from "../src/services/ide-service";
import type { WctEnv } from "../src/types/env";

describe("substituteEnvVars", () => {
  test("substitutes both WCT_WORK_DIR forms", () => {
    const env: WctEnv = {
      WCT_WORKTREE_DIR: "/repos/myapp-feature",
      WCT_WORK_DIR: "/repos/myapp-feature/apps/web",
      WCT_MAIN_DIR: "/repos/myapp",
      WCT_BRANCH: "feature",
      WCT_PROJECT: "myapp",
    };

    const bracedVariable = "${" + "WCT_WORK_DIR}";
    expect(substituteEnvVars(`tool $WCT_WORK_DIR ${bracedVariable}`, env)).toBe(
      "tool /repos/myapp-feature/apps/web /repos/myapp-feature/apps/web",
    );
  });
});
