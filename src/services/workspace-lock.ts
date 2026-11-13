import { dlopen, ptr, read } from "bun:ffi";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  openSync,
  readFileSync,
} from "node:fs";

function loadNativeLock() {
  if (process.platform === "darwin") {
    const { symbols } = dlopen("/usr/lib/libSystem.B.dylib", {
      flock: { args: ["int", "int"], returns: "int" },
      fcntl: { args: ["int", "int"], returns: "int" },
      ioctl: { args: ["int", "u64"], returns: "int" },
      __error: { args: [], returns: "ptr" },
    });
    return {
      ...symbols,
      errno: () => {
        const pointer = symbols.__error();
        if (pointer === null) throw new Error("Cannot read errno");
        return read.i32(pointer);
      },
    };
  }
  if (process.platform === "linux") {
    const { symbols } = dlopen("libc.so.6", {
      flock: { args: ["int", "int"], returns: "int" },
      fcntl: { args: ["int", "int"], returns: "int" },
      ioctl: { args: ["int", "u64"], returns: "int" },
      __errno_location: { args: [], returns: "ptr" },
    });
    return {
      ...symbols,
      errno: () => {
        const pointer = symbols.__errno_location();
        if (pointer === null) throw new Error("Cannot read errno");
        return read.i32(pointer);
      },
    };
  }
  throw new Error("Workspace coordination requires macOS or Linux");
}

let nativeLock: ReturnType<typeof loadNativeLock> | undefined;
const native = () => (nativeLock ??= loadNativeLock());

/** Use regular files only: filesystem support for directory F_FULLFSYNC is
 * not assumed. Darwin's command ignores arg, preserving the two-argument ABI. */
export function fullSyncWorkspaceFile(fd: number): void {
  if (!fstatSync(fd).isFile())
    throw new Error("Workspace media flush requires a regular file");
  if (process.platform !== "darwin") {
    fsyncSync(fd);
    return;
  }
  const api = native();
  const F_FULLFSYNC = 51; // Darwin sys/fcntl.h; arg is ignored.
  if (api.fcntl(fd, F_FULLFSYNC) < 0)
    throw new Error(`Cannot fully flush Workspace journal (${api.errno()})`);
}

// Never LOCK_UN: worker duplicates share the open-file description. Closing
// only our reference preserves custody until the last custodian closes it.
export function closeWorkspaceLock(fd: number): void {
  closeSync(fd);
}

export function protectWorkspaceDescriptor(fd: number): void {
  const api = native();
  // FIOCLEX takes no variadic argument. Supplying F_SETFD's variadic integer
  // through a fixed FFI signature is ABI-incorrect on Darwin arm64.
  const cloexec = process.platform === "darwin" ? 0x20006601 : 0x5451;
  if (api.ioctl(fd, cloexec) < 0 || (api.fcntl(fd, 1) & 1) !== 1) {
    throw new Error(
      `Cannot set close-on-exec on Workspace lock (${api.errno()})`,
    );
  }
}

export function tryWorkspaceLock(fd: number): boolean {
  const api = native();
  if (api.flock(fd, 2 | 4) === 0) return true; // LOCK_EX | LOCK_NB
  const errno = api.errno();
  if (errno === (process.platform === "darwin" ? 35 : 11)) return false;
  throw new Error(`Cannot lock Workspace (${errno})`);
}

export function openWorkspaceLock(path: string): number {
  const fd = openSync(
    path,
    constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    if (!fstatSync(fd).isFile())
      throw new Error("Workspace lock is not a regular file");
    protectWorkspaceDescriptor(fd);
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

export interface ProcessGeneration {
  pid: number;
  boot: string;
  started: string;
}

let darwinProcess: ReturnType<typeof loadDarwinProcess> | undefined;
function loadDarwinProcess() {
  return dlopen("/usr/lib/libSystem.B.dylib", {
    proc_pidinfo: { args: ["int", "int", "u64", "ptr", "int"], returns: "int" },
    sysctlbyname: { args: ["ptr", "ptr", "ptr", "ptr", "u64"], returns: "int" },
  });
}

/** Generations diagnose PID reuse; they never authorize clearing a fence. */
export function processGeneration(pid: number): ProcessGeneration {
  if (process.platform === "linux") {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat
      .slice(stat.lastIndexOf(")") + 2)
      .trim()
      .split(/\s+/);
    const started = fields[19]; // field 22, after pid and parenthesized comm
    if (!started || !/^\d+$/.test(started))
      throw new Error("Invalid process start time");
    return {
      pid,
      boot: readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(),
      started,
    };
  }
  if (process.platform === "darwin") {
    const api = (darwinProcess ??= loadDarwinProcess()).symbols;
    const info = new Uint8Array(136); // proc_bsdinfo, x64/arm64 Darwin ABI
    const boot = new Uint8Array(128);
    const size = new BigUint64Array([BigInt(boot.byteLength)]);
    if (
      api.proc_pidinfo(pid, 3, 0, ptr(info), info.byteLength) !==
        info.byteLength ||
      api.sysctlbyname(
        ptr(Buffer.from("kern.bootsessionuuid\0")),
        ptr(boot),
        ptr(size),
        null,
        0,
      ) !== 0
    ) {
      throw new Error(`Cannot establish process generation for PID ${pid}`);
    }
    const view = new DataView(info.buffer);
    return {
      pid,
      boot: Buffer.from(boot).toString().split("\0")[0] ?? "",
      started: `${view.getBigUint64(120, true)}:${view.getBigUint64(128, true)}`,
    };
  }
  throw new Error("Process generations require macOS or Linux");
}

export function sameProcessGeneration(
  left: ProcessGeneration,
  right: ProcessGeneration,
): boolean {
  return (
    left.pid === right.pid &&
    left.boot === right.boot &&
    left.started === right.started
  );
}
