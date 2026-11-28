// Operating-system isolation for code the model writes.
//
// The sandbox runs real interpreters as child processes; timeouts and output
// caps are resource controls, not a security boundary. This module supplies the
// boundary, in order of strength:
//
//   bwrap   bubblewrap: read-only root, private /tmp, dropped capabilities,
//           network namespace (denied unless QUILLON_SANDBOX_NETWORK=1)
//   chroot  unprivileged user+mount+pid+net namespace with a chrooted,
//           read-only /usr,/lib root and a bind-mounted work directory
//   netns   network namespace only (filesystem stays the host's)
//   none    no isolation available on this host
//
//   QUILLON_SANDBOX_NETWORK=1             allow outbound network inside the jail
//   QUILLON_SANDBOX_REQUIRE_ISOLATION=1   refuse to execute unless jailed
//   QUILLON_SANDBOX_ISOLATION=off         run unwrapped (development only)
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type IsolationMode = "bwrap" | "chroot" | "netns" | "none";

export type SandboxIsolation = {
  mode: IsolationMode;
  /** argv inserted before the interpreter, empty when mode === "none". */
  prefix: string[];
  network: boolean;
  detail: string;
};

type Caps = { bwrap: string[] | null; chroot: boolean; netns: boolean };

let probe: Promise<Caps> | null = null;

const JAIL_SCRIPT = `set -e
R="$1"; W="$2"; NM="$3"; NET="$4"; shift 4
mkdir -p "$R"/usr "$R"/bin "$R"/sbin "$R"/lib "$R"/lib64 "$R"/etc "$R"/tmp "$R"/nm "$R"/proc
mount --rbind /usr "$R/usr" 2>/dev/null || exit 41
for d in /bin /sbin /lib /lib64; do [ -e "$d" ] && { mkdir -p "$R$d"; mount --rbind "$d" "$R$d" 2>/dev/null || true; }; done
mount -t tmpfs none "$R/tmp" 2>/dev/null || true
mount -t proc proc "$R/proc" 2>/dev/null || true
[ -d /etc/ssl ] && { mkdir -p "$R/etc/ssl"; mount --rbind /etc/ssl "$R/etc/ssl" 2>/dev/null || true; }
[ -n "$NM" ] && { mkdir -p "$R/nm"; mount --rbind "$NM" "$R/nm" 2>/dev/null || true; }
printf 'root:x:0:0:root:/root:/bin/sh\\n' > "$R/etc/passwd"
if [ "$NET" = "1" ] && [ -r /etc/resolv.conf ]; then cp /etc/resolv.conf "$R/etc/resolv.conf" 2>/dev/null || : > "$R/etc/resolv.conf"; else : > "$R/etc/resolv.conf"; fi
mkdir -p "$R$W"
mount --bind "$W" "$R$W" 2>/dev/null || exit 42
exec chroot "$R" /usr/bin/env -i PATH=/usr/local/bin:/usr/bin:/bin HOME="$W" TMPDIR=/tmp NODE_PATH=/nm /bin/sh -c 'cd "$0" || exit 1; exec "$@"' "$W" "$@"
`;

function runnable(command: string, args: string[], timeout = 8_000): boolean {
  try {
    return spawnSync(command, args, { timeout, stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
}

function bwrapBase(): string[] | null {
  const base = [
    "--unshare-all",
    "--die-with-parent",
    "--new-session",
    "--ro-bind-try",
    "/usr",
    "/usr",
    "--ro-bind-try",
    "/bin",
    "/bin",
    "--ro-bind-try",
    "/sbin",
    "/sbin",
    "--ro-bind-try",
    "/lib",
    "/lib",
    "--ro-bind-try",
    "/lib64",
    "/lib64",
  ];
  return runnable("bwrap", [...base, "--", "/usr/bin/true"]) ? base : null;
}

/** A real run through the jail, because every mount can fail on its own. */
function chrootWorks(): boolean {
  const dir = mkdtempSync(join(tmpdir(), "quillon-jail-probe-"));
  try {
    const root = join(dir, ".root");
    const jail = join(dir, "jail.sh");
    mkdirSync(root, { recursive: true });
    writeFileSync(jail, JAIL_SCRIPT);
    return runnable("unshare", ["-rmpf", "-n", "--", "/bin/bash", jail, root, dir, "", "0", "/usr/bin/true"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function detect(): Promise<Caps> {
  probe ??= Promise.resolve({
    bwrap: existsSync("/usr/bin/bwrap") || existsSync("/bin/bwrap") ? bwrapBase() : null,
    chroot: existsSync("/usr/bin/unshare") || existsSync("/bin/unshare") ? chrootWorks() : false,
    netns: runnable("unshare", ["-rn", "true"], 5_000),
  });
  return probe;
}

/** Writes the minimal /etc the bubblewrap jail needs, avoiding the host's own. */
function makeEtc(dir: string, network: boolean): string {
  const etc = join(dir, ".etc");
  mkdirSync(etc, { recursive: true });
  writeFileSync(join(etc, "passwd"), "root:x:0:0:root:/root:/bin/sh\nsandbox:x:1000:1000:sandbox:/sandbox:/bin/sh\n");
  writeFileSync(join(etc, "group"), "root:x:0:\nsandbox:x:1000:\n");
  writeFileSync(join(etc, "nsswitch.conf"), "hosts: files dns\npasswd: files\ngroup: files\n");
  writeFileSync(join(etc, "hosts"), "127.0.0.1 localhost\n::1 localhost\n");
  if (network && existsSync("/etc/resolv.conf")) {
    writeFileSync(join(etc, "resolv.conf"), readFileSync("/etc/resolv.conf"));
  } else {
    writeFileSync(join(etc, "resolv.conf"), "");
  }
  return etc;
}

/**
 * Builds the isolation wrapper for one run directory. `nodeModules` is mounted
 * read-only so require("exceljs") still resolves without exposing the project.
 */
export async function sandboxIsolation(
  dir: string,
  opts: { nodeModules?: string } = {},
): Promise<SandboxIsolation> {
  const network = process.env.QUILLON_SANDBOX_NETWORK === "1";
  if (process.env.QUILLON_SANDBOX_ISOLATION === "off") {
    return { mode: "none", prefix: [], network: true, detail: "isolation disabled by QUILLON_SANDBOX_ISOLATION=off" };
  }
  const caps = await detect();

  if (caps.bwrap) {
    const etc = makeEtc(dir, network);
    const scratch = join(dir, ".tmp");
    mkdirSync(scratch, { recursive: true });
    const prefix = [
      "bwrap",
      ...caps.bwrap,
      ...(network ? ["--share-net"] : []),
      "--bind",
      scratch,
      "/tmp",
      "--dev",
      "/dev",
      "--proc",
      "/proc",
      "--ro-bind",
      etc,
      "/etc",
      "--ro-bind-try",
      "/etc/ssl",
      "/etc/ssl",
      "--ro-bind-try",
      "/etc/alternatives",
      "/etc/alternatives",
      ...(opts.nodeModules ? ["--ro-bind-try", opts.nodeModules, "/node_modules"] : []),
      "--bind",
      dir,
      dir,
      "--chdir",
      dir,
      "--",
    ];
    return {
      mode: "bwrap",
      prefix,
      network,
      detail:
        "bubblewrap jail: read-only root, private /tmp, capabilities dropped, network " +
        (network ? "allowed" : "denied"),
    };
  }

  if (caps.chroot) {
    const root = join(dir, ".root");
    mkdirSync(root, { recursive: true });
    const jail = join(dir, ".jail.sh");
    writeFileSync(jail, JAIL_SCRIPT);
    return {
      mode: "chroot",
      prefix: [
        "unshare",
        "-rmpf",
        ...(network ? [] : ["-n"]),
        "--",
        "/bin/bash",
        jail,
        root,
        dir,
        opts.nodeModules ?? "",
        network ? "1" : "0",
      ],
      network,
      detail:
        "chroot jail in a user/mount/pid namespace: read-only /usr,/lib root, private /tmp, network " +
        (network ? "allowed" : "denied"),
    };
  }

  if (caps.netns) {
    return {
      mode: "netns",
      prefix: ["unshare", "-rn", "--"],
      network,
      detail: "network namespace only: the filesystem is still the host's (install bubblewrap for a full jail)",
    };
  }
  return { mode: "none", prefix: [], network: true, detail: "no isolation available on this host" };
}

// A subprocess timeout is a resource limit, not a security boundary: unless the
// code runs inside an OS jail it can read what the platform can read and reach
// the network it can reach. Production therefore requires isolation, and a
// deployment that wants unjailed execution has to say so explicitly.
export function isolationRequired(): boolean {
  if (process.env.QUILLON_SANDBOX_REQUIRE_ISOLATION === "1") return true;
  if (process.env.QUILLON_SANDBOX_ALLOW_UNJAILED === "1") return false;
  return process.env.NODE_ENV === "production";
}
