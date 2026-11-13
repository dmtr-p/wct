import { randomBytes, timingSafeEqual } from "node:crypto";
import { policy } from "./protocol";

const secret = () => randomBytes(32).toString("base64url");
export class LocalAuth {
  readonly bootstrap = secret();
  readonly cookieName = `wct_${secret().slice(0, 16)}`;
  private readonly bootstrapUntil: number;
  private used = false;
  private failures = 0;
  private failureWindow: number;
  private readonly sessions = new Map<string, number>();
  constructor(private readonly now = () => Date.now()) {
    this.bootstrapUntil = now() + policy.bootstrapMs;
    this.failureWindow = now();
  }
  exchange(value: string): string | undefined {
    const now = this.now();
    this.prune();
    if (now - this.failureWindow >= 60_000) {
      this.failureWindow = now;
      this.failures = 0;
    }
    if (this.failures >= 10) return;
    const bytes = Buffer.from(value);
    const expected = Buffer.from(this.bootstrap);
    if (
      this.used ||
      now >= this.bootstrapUntil ||
      bytes.length !== expected.length ||
      !timingSafeEqual(bytes, expected)
    ) {
      this.failures++;
      return;
    }
    if (this.sessions.size >= policy.maxSessions) return;
    this.used = true;
    const token = secret();
    this.sessions.set(token, now + policy.sessionMs);
    return `${this.cookieName}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${policy.sessionMs / 1000}`;
  }
  owner(request: Request): string | undefined {
    this.prune();
    const cookies = (request.headers.get("cookie") ?? "")
      .split(";")
      .map((part) => part.trim());
    const entries = cookies.filter((part) =>
      part.startsWith(`${this.cookieName}=`),
    );
    if (entries.length !== 1) return;
    const value = entries[0]?.slice(this.cookieName.length + 1);
    return value && this.sessions.has(value) ? value : undefined;
  }
  alive(owner: string): boolean {
    this.prune();
    return this.sessions.has(owner);
  }
  private prune() {
    for (const [key, expiry] of this.sessions)
      if (this.now() >= expiry) this.sessions.delete(key);
  }
  clear() {
    this.sessions.clear();
    this.used = true;
  }
}

export function validRequestAuthority(
  request: Request,
  authority: string,
  privileged: boolean,
): boolean {
  if (request.headers.get("host") !== authority) return false;
  const origin = request.headers.get("origin");
  if (origin === null) return !privileged;
  return origin === `http://${authority}`;
}

export async function boundedJson(
  request: Request,
  signal?: AbortSignal,
): Promise<unknown> {
  const declared = request.headers.get("content-length");
  if (
    declared !== null &&
    (!/^\d+$/.test(declared) || Number(declared) > policy.controlBytes)
  )
    throw new Error("HTTP body exceeds bounds");
  if (request.headers.get("content-type") !== "application/json")
    throw new Error("Expected JSON");
  const reader = request.body?.getReader();
  if (!reader) throw new Error("Missing request body");
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) cancel();
  const buffer = new Uint8Array(policy.controlBytes);
  let offset = 0;
  let expired = false;
  const deadline = setTimeout(() => {
    expired = true;
    void reader.cancel().catch(() => {});
  }, policy.handshakeMs);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (expired || signal?.aborted)
        throw new Error("HTTP body deadline exceeded");
      if (done) break;
      if (value.length > buffer.length - offset)
        throw new Error("HTTP body exceeds bounds");
      buffer.set(value, offset);
      offset += value.length;
    }
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        buffer.subarray(0, offset),
      ),
    );
  } finally {
    clearTimeout(deadline);
    signal?.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
