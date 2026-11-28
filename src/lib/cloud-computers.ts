// Cloud computers: register remote machines (a Vast/RunPod/Lambda GPU box, a
// bastion, a self-hosted runner) that unattended jobs can be dispatched to
// over SSH. Status is a cheap reachability probe with a short timeout.
//
// Every host and account name is validated before it reaches ssh: OpenSSH
// parses any argv element that starts with "-" as an option, so an unchecked
// user/host is an option-injection hole that ends in arbitrary command
// execution (CWE-88). The probe also passes "--" so a destination can never be
// read as an option, and refuses rows that predate validation.

import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/db";
import { tenantScope } from "@/lib/tenant-context";

export type CloudComputer = {
  id: string;
  name: string;
  provider: string;
  host: string;
  user: string;
  workdir: string;
  status: "unknown" | "online" | "offline";
  lastCheckedAt: string | null;
};

const SAFE_SSH_PART = /^(?!-)[A-Za-z0-9._-]{1,64}$/;

/** Why a host/user pair may not be handed to ssh, or null when it is safe. */
export function sshTargetReason(host: string, user: string): string | null {
  if (!SAFE_SSH_PART.test(host)) {
    return "Host must be a hostname or IP address (letters, digits, dot, dash, underscore) and may not start with '-'.";
  }
  if (!SAFE_SSH_PART.test(user)) {
    return "User must be a plain account name (letters, digits, dot, dash, underscore) and may not start with '-'.";
  }
  return null;
}

function rowToComputer(r: Record<string, unknown>): CloudComputer {
  return {
    id: String(r.id),
    name: String(r.name),
    provider: String(r.provider),
    host: String(r.host),
    user: String(r.user),
    workdir: String(r.workdir),
    status: r.status as CloudComputer["status"],
    lastCheckedAt: (r.last_checked_at as string | null) ?? null,
  };
}

export function listComputers(tenant?: string | null): CloudComputer[] {
  return (
    getDb()
      .prepare("SELECT * FROM cloud_computers WHERE tenant_id = ? ORDER BY created_at DESC")
      .all(tenantScope(tenant)) as Record<string, unknown>[]
  ).map(rowToComputer);
}

export function addComputer(input: {
  name: string;
  provider?: string;
  host: string;
  user?: string;
  workdir?: string;
  tenant?: string | null;
}): CloudComputer {
  const user = input.user ?? "ubuntu";
  const host = input.host.trim();
  const problem = sshTargetReason(host, user);
  if (problem) throw new Error(problem);
  const id = randomUUID();
  getDb()
    .prepare(
      "INSERT INTO cloud_computers (id, tenant_id, name, provider, host, user, workdir) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .run(id, tenantScope(input.tenant), input.name, input.provider ?? "ssh", host, user, input.workdir ?? "/home/ubuntu/quillon");
  return rowToComputer(getDb().prepare("SELECT * FROM cloud_computers WHERE id = ?").get(id) as Record<string, unknown>);
}

export function deleteComputer(id: string, tenant?: string | null): boolean {
  return (
    getDb()
      .prepare("DELETE FROM cloud_computers WHERE id = ? AND tenant_id = ?")
      .run(id, tenantScope(tenant)).changes > 0
  );
}

export async function checkComputer(id: string, tenant?: string | null): Promise<CloudComputer | null> {
  const row = getDb()
    .prepare("SELECT * FROM cloud_computers WHERE id = ? AND tenant_id = ?")
    .get(id, tenantScope(tenant)) as Record<string, unknown> | undefined;
  if (!row) return null;
  const computer = rowToComputer(row);
  const status = await probe(computer.host, computer.user);
  getDb()
    .prepare("UPDATE cloud_computers SET status = ?, last_checked_at = ? WHERE id = ?")
    .run(status, new Date().toISOString(), id);
  return { ...computer, status, lastCheckedAt: new Date().toISOString() };
}

async function probe(host: string, user: string): Promise<"online" | "offline"> {
  // A legacy or hand-edited row never reaches ssh.
  if (sshTargetReason(host, user)) return "offline";
  if (host === "localhost" || host === "127.0.0.1") return "online";
  try {
    const { execFile } = await import("node:child_process");
    await new Promise<void>((resolve, reject) => {
      execFile(
        "ssh",
        ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "--", `${user}@${host}`, "true"],
        { timeout: 7000 },
        (err) => (err ? reject(err) : resolve()),
      );
    });
    return "online";
  } catch {
    return "offline";
  }
}
