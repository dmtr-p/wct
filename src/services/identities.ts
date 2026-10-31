import { Brand } from "effect";

export type WorkspaceIdentityKey = string & Brand.Brand<"WorkspaceIdentityKey">;
export type PrIdentity = string & Brand.Brand<"PrIdentity">;
export type RegistrationId = string & Brand.Brand<"RegistrationId">;

const WorkspaceIdentityKey = Brand.nominal<WorkspaceIdentityKey>();
const PrIdentity = Brand.nominal<PrIdentity>();

/** Brand an existing ID only at trusted registration creation/hydration boundaries. */
export const RegistrationId = Brand.nominal<RegistrationId>();

// NUL cannot appear in a filesystem path or a git ref, unlike `#` or `/`, so
// the two halves of the identity can never be confused with each other.
export function workspaceIdentityKey(
  mainRepoPath: string,
  branch: string,
): WorkspaceIdentityKey {
  return WorkspaceIdentityKey(`${mainRepoPath}\0${branch}`);
}

export function prIdentity(pr: {
  baseRepository: string;
  number: number;
}): PrIdentity {
  return PrIdentity(`${pr.baseRepository.toLowerCase()}#${pr.number}`);
}
