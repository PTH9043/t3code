// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as NodeUtil from "node:util";

export type SkillProcessIdentity = {
  readonly platform: "win32" | "linux";
  readonly pid: number;
  readonly boot: string;
  readonly namespace: string;
  readonly started: string;
};
export type ProcessLiveness = "alive" | "dead" | "unknown";
type Probe = {
  readonly boot: string;
  readonly namespace: string;
  readonly state: "alive" | "dead";
  readonly started?: string;
};
const execFile = NodeUtil.promisify(NodeChildProcess.execFile);

const WINDOWS_PROBE = String.raw`
import ctypes, json, sys
from ctypes import wintypes
def out(x): print(json.dumps(x, separators=(',', ':')))
try:
    pid = int(sys.argv[1])
    if pid <= 0 or pid > 0xffffffff: raise ValueError()
    k = ctypes.WinDLL('kernel32', use_last_error=True)
    n = ctypes.WinDLL('ntdll')
    boot = ctypes.create_string_buffer(64)
    returned = wintypes.ULONG()
    n.NtQuerySystemInformation.argtypes = [wintypes.ULONG, ctypes.c_void_p, wintypes.ULONG, ctypes.POINTER(wintypes.ULONG)]
    n.NtQuerySystemInformation.restype = ctypes.c_long
    if n.NtQuerySystemInformation(90, boot, len(boot), ctypes.byref(returned)) != 0: raise RuntimeError()
    bootid = boot.raw[:16].hex()
    if bootid == '00000000000000000000000000000000': raise RuntimeError()
    k.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    k.OpenProcess.restype = wintypes.HANDLE
    handle = k.OpenProcess(0x101000, False, pid)
    if not handle:
        p = ctypes.WinDLL('psapi', use_last_error=True)
        items = (wintypes.DWORD * 32768)()
        size = wintypes.DWORD()
        p.EnumProcesses.argtypes = [ctypes.POINTER(wintypes.DWORD), wintypes.DWORD, ctypes.POINTER(wintypes.DWORD)]
        p.EnumProcesses.restype = wintypes.BOOL
        if not p.EnumProcesses(items, ctypes.sizeof(items), ctypes.byref(size)) or size.value >= ctypes.sizeof(items): raise RuntimeError()
        if pid in items[:size.value // ctypes.sizeof(wintypes.DWORD)]: raise RuntimeError()
        out({'boot':bootid,'state':'dead'})
    else:
        try:
            a=wintypes.FILETIME(); e=wintypes.FILETIME(); c=wintypes.FILETIME(); u=wintypes.FILETIME()
            k.GetProcessTimes.argtypes=[wintypes.HANDLE,ctypes.POINTER(wintypes.FILETIME),ctypes.POINTER(wintypes.FILETIME),ctypes.POINTER(wintypes.FILETIME),ctypes.POINTER(wintypes.FILETIME)]
            k.GetProcessTimes.restype=wintypes.BOOL
            if not k.GetProcessTimes(handle,ctypes.byref(a),ctypes.byref(e),ctypes.byref(c),ctypes.byref(u)): raise RuntimeError()
            k.WaitForSingleObject.argtypes=[wintypes.HANDLE,wintypes.DWORD]
            k.WaitForSingleObject.restype=wintypes.DWORD
            wait=k.WaitForSingleObject(handle,0)
            if wait not in (0,258): raise RuntimeError()
            out({'boot':bootid,'state':'dead' if wait == 0 else 'alive','started':str((a.dwHighDateTime<<32)|a.dwLowDateTime)})
        finally:
            k.CloseHandle.argtypes=[wintypes.HANDLE]
            k.CloseHandle(handle)
except Exception:
    out({'state':'unknown'})
`;

async function windowsPython(): Promise<string | null> {
  for (const entry of (NodeProcess.env.PATH ?? "").split(NodePath.delimiter)) {
    const directory = entry.replace(/[\\/]+$/u, "");
    if (!/(?:[\\/]Programs[\\/]Python[\\/]Python\d+|[\\/]Python\d+)$/iu.test(directory)) continue;
    const candidate = NodePath.join(directory, "python.exe");
    try {
      const stat = await NodeFSP.lstat(candidate);
      if (stat.isFile() && !stat.isSymbolicLink()) return candidate;
    } catch {
      /* Try the next installed interpreter. */
    }
  }
  return null;
}

/** Move a prepared directory only if the destination does not already exist. */
export async function moveSkillDirectoryNoReplace(
  source: string,
  destination: string,
  platform: NodeJS.Platform,
): Promise<boolean> {
  const python =
    platform === "win32" ? await windowsPython() : platform === "linux" ? "/usr/bin/python3" : null;
  if (!python) return false;
  const script =
    platform === "win32"
      ? String.raw`import ctypes, sys
from ctypes import wintypes
k=ctypes.WinDLL('kernel32',use_last_error=True)
k.MoveFileW.argtypes=[wintypes.LPCWSTR,wintypes.LPCWSTR]
k.MoveFileW.restype=wintypes.BOOL
sys.exit(0 if k.MoveFileW(sys.argv[1],sys.argv[2]) else 1)`
      : String.raw`import ctypes, os, sys
lib=ctypes.CDLL(None,use_errno=True)
lib.renameat2.argtypes=[ctypes.c_int,ctypes.c_char_p,ctypes.c_int,ctypes.c_char_p,ctypes.c_uint]
lib.renameat2.restype=ctypes.c_int
sys.exit(0 if lib.renameat2(-100,os.fsencode(sys.argv[1]),-100,os.fsencode(sys.argv[2]),1)==0 else 1)`;
  try {
    await execFile(python, ["-I", "-S", "-c", script, source, destination], {
      windowsHide: true,
      timeout: 5_000,
      maxBuffer: 8_192,
    });
    return true;
  } catch {
    return false;
  }
}

async function probeWindows(pid: number): Promise<Probe | null> {
  try {
    const python = await windowsPython();
    if (!python) return null;
    const result = await execFile(python, ["-I", "-S", "-c", WINDOWS_PROBE, String(pid)], {
      windowsHide: true,
      timeout: 5_000,
      maxBuffer: 8_192,
    });
    const value: unknown = JSON.parse(result.stdout);
    if (!value || typeof value !== "object") return null;
    const entry = value as Record<string, unknown>;
    if (
      typeof entry.boot !== "string" ||
      !/^[a-f0-9]{32}$/u.test(entry.boot) ||
      (entry.state !== "alive" && entry.state !== "dead") ||
      (entry.started !== undefined &&
        (typeof entry.started !== "string" || !/^\d{1,24}$/u.test(entry.started)))
    )
      return null;
    return {
      boot: entry.boot,
      namespace: "windows",
      state: entry.state,
      ...(typeof entry.started === "string" ? { started: entry.started } : {}),
    };
  } catch {
    return null;
  }
}

async function probeLinux(pid: number): Promise<Probe | null> {
  try {
    const boot = (await NodeFSP.readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
    const namespace = await NodeFSP.readlink("/proc/self/ns/pid");
    if (!/^[a-f0-9-]{36}$/u.test(boot) || !/^pid:\[\d+\]$/u.test(namespace)) return null;
    const self = await NodeFSP.readFile("/proc/self/stat", "utf8");
    if (Number(self.slice(0, self.indexOf(" "))) !== NodeProcess.pid) return null;
    let stat: string;
    try {
      stat = await NodeFSP.readFile(`/proc/${pid}/stat`, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { boot, namespace, state: "dead" };
      return null;
    }
    const targetNamespace = await NodeFSP.readlink(`/proc/${pid}/ns/pid`);
    if (targetNamespace !== namespace) return null;
    const end = stat.lastIndexOf(") ");
    const fields = end < 0 ? [] : stat.slice(end + 2).split(" ");
    const state = fields[0];
    const started = fields[19];
    if (!started || !/^\d+$/u.test(started) || !state) return null;
    return { boot, namespace, started, state: state === "Z" || state === "X" ? "dead" : "alive" };
  } catch {
    return null;
  }
}

async function probe(
  pid: number,
  platform: SkillProcessIdentity["platform"],
  hostPlatform: NodeJS.Platform,
): Promise<Probe | null> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  if (hostPlatform !== platform) return null;
  return platform === "win32" ? probeWindows(pid) : probeLinux(pid);
}

export async function currentSkillProcessIdentity(
  platform: NodeJS.Platform,
): Promise<SkillProcessIdentity | null> {
  if (platform !== "win32" && platform !== "linux") return null;
  const result = await probe(NodeProcess.pid, platform, platform);
  if (!result || result.state !== "alive" || !result.started) return null;
  return {
    platform,
    pid: NodeProcess.pid,
    boot: result.boot,
    namespace: result.namespace,
    started: result.started,
  };
}

export async function skillProcessLiveness(
  identity: SkillProcessIdentity,
  platform: NodeJS.Platform,
): Promise<ProcessLiveness> {
  const current = await probe(identity.pid, identity.platform, platform);
  if (!current || current.boot !== identity.boot || current.namespace !== identity.namespace)
    return "unknown";
  if (current.started && current.started !== identity.started) return "dead";
  return current.state;
}
