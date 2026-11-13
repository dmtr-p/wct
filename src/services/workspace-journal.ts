import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fsyncSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { fullSyncWorkspaceFile } from "./workspace-lock";

export interface WorkspaceJournalSync {
  file: (fd: number) => void;
  directory: (fd: number) => void;
}

export const liveWorkspaceJournalSync: WorkspaceJournalSync = {
  file: fullSyncWorkspaceFile,
  directory: fsyncSync,
};

/** File contents and namespace publication have separate persistence barriers.
 * Keep the same regular-file FD across rename: Darwin's final full flush drains
 * the directory metadata submitted by fsync without full-syncing a directory. */
export function publishWorkspaceJournal(
  path: string,
  content: string,
  sync: WorkspaceJournalSync = liveWorkspaceJournalSync,
): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(
    temporary,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
    0o600,
  );
  let published = false;
  try {
    writeFileSync(fd, content);
    sync.file(fd);
    renameSync(temporary, path);
    published = true;
    const directory = openSync(dirname(path), constants.O_RDONLY);
    try {
      sync.directory(directory);
      sync.file(fd);
    } finally {
      closeSync(directory);
    }
  } finally {
    // Once renamed, a failed namespace/media flush is an uncertain publication,
    // not a rollback. The lease's pre-write latch retains its reservation.
    try {
      closeSync(fd);
    } finally {
      if (!published) {
        try {
          unlinkSync(temporary);
        } catch {
          /* Preserve the original write/flush/rename failure. */
        }
      }
    }
  }
}
