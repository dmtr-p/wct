---
status: accepted
---

# Workspace custody uses flock and durable uncertainty fencing

Workspace Operations require host-local mutual exclusion across processes,
including a detached shutdown worker. The identity is the canonical Main
Repository path and exact branch, encoded by `workspaceIdentityKey`.
This is groundwork for shared CLI/TUI lifecycle ownership; it does not authorize
a daemon or clear the RFC's later rollout gates.

## Mechanism

Use one persistent `flock` inode per Workspace, under
`~/.wct-coordination`, outside the registry database and its watched directory.
Hash the full identity with SHA-256; verify the full identity in its journal.
Keep the inode permanently: unlinking a locked file permits a second inode and
breaks exclusion. The root is owner-only, and files are mode 0600. Require a
local filesystem providing correct advisory locks, atomic rename and fsync.

| Candidate                                | Decision                                                                                                                                                             |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Transaction in shared registry SQLite    | Reject: blocks unrelated registry/cache writers and causes watched WAL activity.                                                                                     |
| Dedicated SQLite database per Workspace  | Isolates writers and releases locks on crash, but a connection cannot transfer across fork/exec. Release/reacquire needs an additional durable reservation protocol. |
| PID files, mkdir locks, renewable leases | Reject as authority: stale recovery and PID reuse do not prove quiescence.                                                                                           |
| Dedicated flock through Bun FFI          | Choose: kernel exclusion, cancellable nonblocking acquisition, and shared open-file-description custody across controlled spawn. No additional runtime dependency.   |

Use `LOCK_EX | LOCK_NB` in an Effect sleep loop. Waiting is interruptible and
can report progress; cancellation closes only that waiter's descriptor.
Different identities have independent locks. Ordinary process launches receive
no custody descriptor. Set close-on-exec in each custodian. Only a controlled
worker spawn explicitly receives a duplicate through Bun's stdio mapping.

The parent and worker share an open-file description, not two independently
acquired locks. Close a custodian's reference; **never call `LOCK_UN`** through
one of those references, because that would unlock it for every custodian.

## Command completion and uncertainty

An acquired operation owns both the kernel lock and a durable reservation with
an operation ID, ownership generation, and owner PID/boot/start generation.
Keep the operation reservation and custody across every lifecycle step.
Completing one command changes its phase back to owned; it never releases the
encompassing operation.

Before launching a process, persist a command boundary with a fresh command ID.
Write a mode-0600 temporary journal in the same directory, fsync it, rename over
the journal, and fsync the directory. Only then may user code execute. Record
the child's PID and OS start generation after spawning. A child that exits too
quickly to inspect has an explicitly unknown diagnostic generation; the durable
boundary already protects the spawn/inspection window.

Collection of the direct command's exit and output acknowledges command
completion, including a known nonzero exit. This ends that command's descendant
boundary: intentional background workloads with detached output may survive.
Output inherited by a background process can delay collection; scripts that
intentionally leave workloads running must detach their output. This preserves
the existing process helper's pipe-draining behavior. Coordinated commands
disable Effect's detached-process-group cleanup: it otherwise kills background
work even on successful shell exit. Cancellation stops the direct child and
retains uncertainty fencing rather than treating group cleanup as proof.

Interruption, defects, output collection failure, ambiguous launch failure, or
loss of any authoritative supervisor before acknowledgement retain the durable
reservation. A free kernel lock plus a retained reservation means
`outcome-unknown`, never permission to retry. Even a crash between acknowledged
commands conservatively retains the operation reservation. Nothing replays
scripts. A normal scoped release clears the reservation only if no command or
transfer is uncertain, then closes custody.

PID/start-generation comparison is diagnostic. It does not establish a complete
descendant set after a fork, setsid, descriptor closure or reparenting. Neither
a dead parent, PGID, timeout, reboot inference, nor a free lock clears a fence.
Linux subreapers lose authority when the subreaper dies; macOS kqueue recursive
process tracking is unsupported. A properly provisioned Linux cgroup could
preserve membership, but it needs delegation and migration containment and has
no portable counterpart. Keep macOS and Linux support with explicit recovery
rather than pretending these mechanisms prove universal automatic recovery.

## Worker transfer

Transfer starts only with no uncertain/in-flight command. Durable uncertainty
from earlier work cannot be erased by offering a worker a lock. The worker
inherits the same flock description at descriptor 4; Bun owns its IPC channel
separately. It validates the inode, full identity, exact operation/generation,
fresh transfer nonce, and its intended recipient PID/boot/start generation before
`Ready`. The caller durably fixes that recipient before sending the ticket.
Restarting a worker cannot adopt an old ticket even with an independently opened
descriptor to the same now-free inode. It does not reacquire by path.

The caller announces handoff before `Start`. Committing Start durably marks the
transfer and irrevocably retires the caller's mutation authority **before** the
IPC send. The worker accepts only that committed transfer, persists a new owner
generation, then sends `Adopted` before any operation side effects. Losing that
acknowledgement cannot restore parent authority. After adoption the worker runs
independently of caller disconnect; both descriptors may overlap until the
caller closes its reference.

| Crash/failure window                               | Custody and recovery                                                                                                                                                 |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Before worker spawn or before Ready, caller alive  | Caller keeps custody. Kill/reap any rejected worker, then cancel the uncommitted transfer. Normal caller release may clear its known reservation.                    |
| Caller dies before Ready                           | Any worker duplicate still holds custody until it observes disconnect/timeout and closes. Retained reservation becomes outcome-unknown when all custodians exit.     |
| Ready received, before Start committed             | Worker has validated custody but cannot mutate. Caller cancellation kills/reaps worker before cancelling the offer. Caller death leaves the durable transfer fenced. |
| Start committed, before send or receipt            | Caller may never resume mutation. Worker cannot act without matching Start. A failed send or lost caller leaves the reservation fenced; no automatic rollback.       |
| Start received, before adoption journal is durable | Caller and/or worker duplicates protect the interval. Worker death leaves the committed transfer fenced; a free lock does not clear it.                              |
| Adoption durable, before Adopted is delivered      | New generation is authoritative. Worker continues if caller disconnects; caller never retries. Worker crash leaves the new generation fenced.                        |
| Adopted delivered, caller dies                     | Worker retains the same locked open-file description and operation reservation. No reacquisition and no gap.                                                         |
| All custodians die during script work              | Kernel custody releases but durable command/operation fencing remains. Explicit reconciliation is required.                                                          |
| Worker completes normally                          | It acknowledges each command, finishes the operation, durably clears its reservation and closes its descriptor. Intentional background workloads may remain.         |

## Reconciliation

Inspection reports busy while any custodian holds the kernel lock, including a
prospective worker. Reconciliation first obtains that lock nonblockingly and
refuses live custody. It then compare-and-swaps the exact operation ID and
ownership generation; a stale parent generation cannot release an adopted or
newer reservation. The request requires
`acknowledgeUncertainSideEffects: true`, `resolution: release-after-inspection`,
a request ID and an inspection reason. The operator is responsible for inspecting
and stopping or accepting uncertain side effects before requesting release.
Store the last reconciliation alongside the now-empty reservation. Release
does not signal children, declare them dead, resume work, or replay scripts.

The host-local target is implicitly this host plus canonical repository/branch;
a future protocol can wrap it in the host-qualified fence without changing
these semantics. Runtime and host validation belong at that protocol boundary.

## Evidence and limitations

The separate-process suite exercises actual Bun descriptor inheritance and
custody, cancellation, crashes, surviving children, reconciliation, independent
Workspaces and unrelated SQLite writes on the host running the suite. Native
generation inspection uses Darwin `proc_bsdinfo` start seconds/microseconds and
boot-session UUID, or Linux `/proc` start ticks plus boot ID. Both native ABIs
are selected explicitly; unsupported platforms fail instead of disabling locks.
Running on macOS is not evidence of Linux execution or vice versa. Both targets
must run this suite before asserting platform validation.

Sources: [flock semantics](https://man7.org/linux/man-pages/man2/flock.2.html),
[SQLite fork restriction](https://www.sqlite.org/howtocorrupt.html#_carrying_an_open_database_connection_across_a_fork_),
[Apple kqueue flags](https://raw.githubusercontent.com/apple-oss-distributions/xnu/main/bsd/sys/event.h),
[Linux subreapers](https://man7.org/linux/man-pages/man2/PR_SET_CHILD_SUBREAPER.2const.html),
[Bun cgroup spawn](https://bun.com/docs/runtime/child-process#resource-limits-with-cgroups-linux),
and [cgroup membership](https://docs.kernel.org/admin-guide/cgroup-v2.html).
