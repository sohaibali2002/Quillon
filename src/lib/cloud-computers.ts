// Cloud computers: register remote machines (a Vast/RunPod/Lambda GPU box, a
// bastion, a self-hosted runner) that unattended jobs can be dispatched to
// over SSH. Status is a cheap reachability probe with a short timeout.

import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/db";

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

export function listComputers(): CloudComputer[] {
  return (
    getDb().prepare("SELECT * FROM cloud_computers ORDER BY created_at DESC").all() as Record<string, unknown>[]
  ).map(rowToComputer);
}

export function addComputer(input: {
  name: string;
  provider?: string;
  host: string;
  user?: string;
  workdir?: string;
}): CloudComputer {
  const id = randomUUID();
  getDb()
    .prepare("INSERT INTO cloud_computers (id, name, provider, host, user, workdir) VALUES (?, ?, ?, ?, ?, ?)")
    .run(id, input.name, input.provider ?? "ssh", input.host, input.user ?? "ubuntu", input.workdir ?? "/home/ubuntu/quillon");
  return (
    getDb().prepare("SELECT * FROM cloud_computers WHERE id = ?").get(id) as Record<string, unknown>
  ) && rowToComputer(getDb().prepare("SELECT * FROM cloud_computers WHERE id = ?").get(id) as Record<string, unknown>);
}

export function deleteComputer(id: string): boolean {
  return getDb().prepare("DELETE FROM cloud_computers WHERE id = ?").run(id).changes > 0;
}

export async function checkComputer(id: string): Promise<CloudComputer | null> {
  const row = getDb().prepare("SELECT * FROM cloud_computers WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  if (!row) return null;
  const computer = rowToComputer(row);
  const status = await probe(computer.host, computer.user);
  getDb()
    .prepare("UPDATE cloud_computers SET status = ?, last_checked_at = ? WHERE id = ?")
    .run(status, new Date().toISOString(), id);
  return { ...computer, status, lastCheckedAt: new Date().toISOString() };
}

async function probe(host: string, user: string): Promise<"online" | "offline"> {
  if (host === "localhost" || host === "127.0.0.1") return "online";
  try {
    const { execFile } = await import("node:child_process");
    await new Promise<void>((resolve, reject) => {
      execFile("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5", `${user}@${host}`, "true"], { timeout: 7000 }, (err) =>
        err ? reject(err) : resolve(),
      );
    });
    return "online";
  } catch {
    return "offline";
  }
}
