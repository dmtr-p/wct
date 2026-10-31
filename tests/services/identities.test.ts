import { expect, expectTypeOf, test } from "vitest";
import {
  type PrIdentity,
  type RegistrationId,
  type WorkspaceIdentityKey,
  workspaceIdentityKey,
} from "../../src/services/identities";
import type { PrCacheServiceApi } from "../../src/services/pr-cache-service";
import type { LifecycleState } from "../../src/tui/lifecycle";

test("identity consumers require the matching brand", () => {
  type LifecycleKey = Parameters<LifecycleState["get"]>[0];
  type CacheRegistration = NonNullable<
    Parameters<PrCacheServiceApi["setDiscovery"]>[3]
  >;
  expectTypeOf<LifecycleKey>().toEqualTypeOf<WorkspaceIdentityKey>();
  expectTypeOf<CacheRegistration>().toEqualTypeOf<RegistrationId>();
  expectTypeOf<string>().not.toExtend<LifecycleKey>();
  expectTypeOf<string>().not.toExtend<CacheRegistration>();
  expectTypeOf<PrIdentity>().not.toExtend<LifecycleKey>();
  expectTypeOf<RegistrationId>().not.toExtend<LifecycleKey>();
  expectTypeOf<PrIdentity>().not.toExtend<CacheRegistration>();
  expectTypeOf<WorkspaceIdentityKey>().not.toExtend<CacheRegistration>();
});

test("Workspace encoding preserves component boundaries and empty branch prefixes", () => {
  const key = workspaceIdentityKey("/repos/a#b", "feature/c");
  expect(key).toBe("/repos/a#b\0feature/c");
  expect(key).not.toBe(workspaceIdentityKey("/repos/a", "b#feature/c"));
  expect(key).not.toBe(workspaceIdentityKey("/repos/a#b/feature", "c"));
  expect(workspaceIdentityKey("/repos/a#b", "")).toBe("/repos/a#b\0");
});
