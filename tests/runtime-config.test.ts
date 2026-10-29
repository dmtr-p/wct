import { Config, ConfigProvider, Effect } from "effect";
import { afterEach, describe, expect, test, vi } from "vitest";
import { loadRuntimeConfig } from "../src/effect/config";
import { WctCommandError } from "../src/errors";
import { processEnvironment } from "../src/services/process";

afterEach(() => vi.unstubAllEnvs());

describe("runtime configuration", () => {
  test("reads fresh environment values when the same effect runs again", async () => {
    const setting = loadRuntimeConfig(Config.String("WCT_TEST_CONFIG"));
    vi.stubEnv("WCT_TEST_CONFIG", "first");
    expect(await Effect.runPromise(setting)).toBe("first");
    vi.stubEnv("WCT_TEST_CONFIG", "second");
    expect(await Effect.runPromise(setting)).toBe("second");
  });

  test("uses defaults only for missing settings and retains empty strings", async () => {
    const setting = loadRuntimeConfig(
      Config.String("WCT_TEST_CONFIG").pipe(Config.withDefault("fallback")),
    );
    vi.stubEnv("WCT_TEST_CONFIG", undefined);
    expect(await Effect.runPromise(setting)).toBe("fallback");
    vi.stubEnv("WCT_TEST_CONFIG", "");
    expect(await Effect.runPromise(setting)).toBe("");
  });

  test("honors caller Config overrides without changing subprocess inheritance", async () => {
    vi.stubEnv("WCT_TEST_CONFIG", "inherited");
    const provider = ConfigProvider.fromUnknown({
      WCT_TEST_CONFIG: "override",
    });
    const setting = Effect.provideService(
      loadRuntimeConfig(Config.String("WCT_TEST_CONFIG")),
      ConfigProvider.ConfigProvider,
      provider,
    );
    expect(await Effect.runPromise(setting)).toBe("override");
    const environment = await Effect.runPromise(
      Effect.provideService(
        processEnvironment,
        ConfigProvider.ConfigProvider,
        provider,
      ),
    );
    expect(environment.WCT_TEST_CONFIG).toBe("inherited");
  });

  test("reports invalid configuration as a command error", async () => {
    const error = await Effect.runPromise(
      Effect.flip(
        loadRuntimeConfig(Config.Int("WCT_TEST_CONFIG")).pipe(
          Effect.provideService(
            ConfigProvider.ConfigProvider,
            ConfigProvider.fromUnknown({ WCT_TEST_CONFIG: "invalid" }),
          ),
        ),
      ),
    );
    expect(error).toBeInstanceOf(WctCommandError);
    expect(error.code).toBe("config_error");
    expect(error.cause).toBeDefined();
  });
});
