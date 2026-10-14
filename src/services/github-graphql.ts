import { Effect } from "effect";
import { commandError } from "../errors";
import {
  execProcess,
  getProcessErrorMessage,
  ProcessExitError,
} from "./process";

interface GraphQlError {
  message?: string;
  path?: (string | number)[];
}
export interface GitHubGraphQlResponse {
  repository: Record<string, unknown>;
  errors: GraphQlError[];
  transportError: string | null;
}

function decode(
  stdout: string,
  transportError: string | null,
): GitHubGraphQlResponse {
  const response = JSON.parse(stdout) as {
    data?: { repository?: Record<string, unknown> };
    errors?: GraphQlError[];
  } | null;
  const repository = response?.data?.repository;
  if (
    !repository ||
    typeof repository !== "object" ||
    !Object.values(repository).some((value) => value !== null)
  )
    throw new Error(
      transportError ??
        response?.errors?.map((error) => error.message).join("; ") ??
        "Missing repository",
    );
  return { repository, errors: response?.errors ?? [], transportError };
}

/** gh may exit nonzero with useful partial data; retain stderr for failed aliases. */
export function queryGitHub(
  cwd: string,
  query: string,
  fields: Record<string, string> = {},
) {
  const args = [
    "api",
    "graphql",
    "-f",
    `query=${query}`,
    ...Object.entries(fields).flatMap(([name, value]) => [
      "-f",
      `${name}=${value}`,
    ]),
  ];
  return execProcess("gh", args, { cwd }).pipe(
    Effect.map((result) => ({
      stdout: result.stdout,
      transportError: null as string | null,
    })),
    Effect.catch((error) =>
      error instanceof ProcessExitError && error.stdout.trim()
        ? Effect.succeed({
            stdout: error.stdout,
            transportError: getProcessErrorMessage(error),
          })
        : Effect.fail(error),
    ),
    Effect.flatMap(({ stdout, transportError }) =>
      Effect.try({
        try: () => decode(stdout, transportError),
        catch: (error) =>
          commandError(
            "pr_error",
            `GitHub GraphQL: ${transportError ?? (error instanceof Error ? error.message : String(error))}`,
            error,
          ),
      }),
    ),
  );
}

export function graphQlAliasError(
  response: Pick<GitHubGraphQlResponse, "errors" | "transportError">,
  alias: string,
): string | null {
  const message = response.errors
    .filter(
      (error) =>
        !error.path?.length ||
        (error.path[0] === "repository" && error.path.length === 1) ||
        error.path.includes(alias),
    )
    .map((error) => error.message ?? "PR fetch failed")
    .join("; ");
  if (!message) return null;
  return response.transportError && !message.includes(response.transportError)
    ? `${message} (${response.transportError})`
    : message;
}
