// Resource containment for sandboxed runs (cgroup v2, best effort).
//
// A timeout kills a process; it does not stop the process from eating the
// machine's memory or forking until the box falls over before the timeout
// fires. When the host exposes a writable cgroup v2 hierarchy, each run gets a
// private cgroup with a memory cap, a pid cap and a CPU cap, and the child is
// moved into it before it can allocate anything meaningful.
//
// Everything here is optional by design: unprivileged containers usually have a
// read-only /sys/fs/cgroup, so the sandbox stays correct (timeout + output caps
// + the OS jail) without it. The result says whether limits were actually
// applied so callers can report it instead of implying protection it lacks.
import { mkdirSync, readFileSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const ROOT = "/sys/fs/cgroup";

export type CgroupLimits = {
  /** Bytes of memory the run may allocate, or 0 for unlimited. */
  memoryBytes: number;
  /** Maximum number of processes/threads in the group. */
  pids: number;
  /** CPU bandwidth: quota per period, e.g. 200000/100000 = 2 CPUs. */
  cpuQuota: number;
  cpuPeriod: number;
};

export const DEFAULT_LIMITS: CgroupLimits = {
  memoryBytes: 1024 * 1024 * 1024,
  pids: 64,
  cpuQuota: 200_000,
  cpuPeriod: 100_000,
};

export type CgroupHandle = {
  dir: string;
  /** Moves a live pid into the group; false when the move failed. */
  attach: (pid: number) => boolean;
  remove: () => void;
};

/** cgroup v2 exists and this process may create a child group. */
export function cgroupAvailable(): boolean {
  try {
    if (!readFileSync(join(ROOT, "cgroup.controllers"), "utf8")) return false;
  } catch {
    return false;
  }
  return true;
}

/**
 * Creates a one-run cgroup and returns a handle, or null when the host does not
 * allow it. Never throws: containment is an addition, not a precondition.
 */
export function createCgroup(limits: CgroupLimits = DEFAULT_LIMITS): CgroupHandle | null {
  if (!cgroupAvailable()) return null;
  const dir = join(ROOT, `quillon-${randomUUID().slice(0, 8)}`);
  try {
    mkdirSync(dir);
  } catch {
    return null;
  }
  const write = (file: string, value: string) => {
    try {
      writeFileSync(join(dir, file), value);
      return true;
    } catch {
      return false;
    }
  };
  // Controllers must be enabled in the parent for the child's files to accept
  // values; no-op when the parent already delegates them.
  try {
    writeFileSync(join(ROOT, "cgroup.subtree_control"), "+memory +pids +cpu");
  } catch {
    /* inherited delegation is fine */
  }
  if (limits.memoryBytes > 0) write("memory.max", String(limits.memoryBytes));
  write("memory.swap.max", "0");
  if (limits.pids > 0) write("pids.max", String(limits.pids));
  if (limits.cpuQuota > 0) write("cpu.max", `${limits.cpuQuota} ${limits.cpuPeriod}`);
  // Kill the whole group on teardown so nothing escapes by re-parenting.
  write("cgroup.kill", "0");

  return {
    dir,
    attach: (pid: number) => {
      try {
        writeFileSync(join(dir, "cgroup.procs"), String(pid));
        return true;
      } catch {
        return false;
      }
    },
    remove: () => {
      try {
        writeFileSync(join(dir, "cgroup.kill"), "1");
      } catch {
        /* already empty */
      }
      // cgroupfs control files cannot be unlinked, so a recursive rm fails with
      // EPERM on every one of them; only rmdir removes the group itself. Kernel
      // files disappear with it. Never throw: teardown must not fail a run that
      // already produced its result.
      try {
        rmdirSync(dir);
      } catch {
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch {
          /* delegated parent refuses removal; the group is empty and inert */
        }
      }
    },
  };
}
