import koffi from "koffi";
import { cpus } from "os";
import { capture } from "./native/process.ts";

/** One process of the app's tree (the app itself and everything it started). */
export type ProcessInfo = {
  pid: number;
  /** null for the root. */
  parentPid: number | null;
  /** Executable file name (`msedgewebview2.exe`, `pwsh.exe`…). */
  name: string;
  commandLine: string;
  /**
   * Bytes of memory the process holds on its own: the private working set on
   * Windows (what Task Manager's Memory column shows), the resident set elsewhere.
   */
  memory: number;
  /** CPU use since the previous call, as a share of all cores (0–100); null on the first sample. */
  cpu: number | null;
};

type RawProcess = { pid: number; parentPid: number; name: string };
type Sample = { pid: number; parentPid: number; name: string; commandLine: string; memory: number; cpuTime: number };

/** CPU time (ms) per process at the previous call, keyed by pid and name so a reused pid starts over. */
let previous: { at: number; times: Map<string, number> } | null = null;

/**
 * The process `rootPid` (default: this one) and all of its descendants, with
 * memory and CPU use. CPU use is measured between consecutive calls.
 */
export async function processTree(rootPid: number = process.pid): Promise<ProcessInfo[]> {
  const samples = process.platform === "win32" ? sampleWin32(rootPid) : await samplePosix(rootPid);
  const now = Date.now();
  const elapsed = previous ? now - previous.at : 0;
  const times = new Map<string, number>();
  const result = samples.map((sample): ProcessInfo => {
    const id = `${sample.pid}:${sample.name}`;
    times.set(id, sample.cpuTime);
    const before = previous?.times.get(id);
    const cpu = before !== undefined && elapsed > 0 ? Math.max(0, ((sample.cpuTime - before) / elapsed / cpus().length) * 100) : null;
    return {
      pid: sample.pid,
      parentPid: sample.pid === rootPid ? null : sample.parentPid,
      name: sample.name,
      commandLine: sample.commandLine,
      memory: sample.memory,
      cpu,
    };
  });
  previous = { at: now, times };
  return result;
}

/** `root` and the processes below it, parents first. */
function descendants<T extends RawProcess>(all: T[], root: number): T[] {
  const children = new Map<number, T[]>();
  for (const entry of all) {
    if (entry.pid === entry.parentPid) continue;
    const list = children.get(entry.parentPid) ?? [];
    list.push(entry);
    children.set(entry.parentPid, list);
  }
  const self = all.find((entry) => entry.pid === root);
  if (!self) return [];
  const out = [self];
  for (let i = 0; i < out.length; i++) out.push(...(children.get(out[i]!.pid) ?? []));
  return out;
}

/* ── Windows ──────────────────────────────────────────────────────────── */

const TH32CS_SNAPPROCESS = 0x2;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const ProcessCommandLineInformation = 60;
const STATUS_INFO_LENGTH_MISMATCH = 0xc0000004 | 0;
/** PROCESSENTRY32W on 64-bit Windows. */
const ENTRY_SIZE = 568;
/** PROCESS_MEMORY_COUNTERS_EX2 (Windows 10 1809+), which adds PrivateWorkingSetSize. */
const COUNTERS_EX2_SIZE = 96;
const COUNTERS_EX_SIZE = 80;

function loadWin32() {
  const kernel32 = koffi.load("kernel32.dll");
  const ntdll = koffi.load("ntdll.dll");
  return {
    CreateToolhelp32Snapshot: kernel32.func("void *__stdcall CreateToolhelp32Snapshot(uint32_t flags, uint32_t pid)"),
    Process32FirstW: kernel32.func("int __stdcall Process32FirstW(void *snapshot, void *entry)"),
    Process32NextW: kernel32.func("int __stdcall Process32NextW(void *snapshot, void *entry)"),
    OpenProcess: kernel32.func("void *__stdcall OpenProcess(uint32_t access, int inherit, uint32_t pid)"),
    CloseHandle: kernel32.func("int __stdcall CloseHandle(void *handle)"),
    GetProcessTimes: kernel32.func(
      "int __stdcall GetProcessTimes(void *process, void *creation, void *exit, void *kernel, void *user)",
    ),
    K32GetProcessMemoryInfo: kernel32.func("int __stdcall K32GetProcessMemoryInfo(void *process, void *counters, uint32_t size)"),
    NtQueryInformationProcess: ntdll.func(
      "int32_t __stdcall NtQueryInformationProcess(void *process, int infoClass, void *info, uint32_t size, _Out_ uint32_t *returned)",
    ),
  };
}

let win32: ReturnType<typeof loadWin32> | null = null;

function listWin32(api: ReturnType<typeof loadWin32>): RawProcess[] {
  const snapshot = api.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  if (!snapshot || koffi.address(snapshot) === 0xffffffffffffffffn) return [];
  const entry = Buffer.alloc(ENTRY_SIZE);
  entry.writeUInt32LE(ENTRY_SIZE, 0);
  const list: RawProcess[] = [];
  try {
    for (let ok = api.Process32FirstW(snapshot, entry); ok; ok = api.Process32NextW(snapshot, entry)) {
      const name = entry.toString("utf16le", 44, 564).split("\0")[0]!;
      list.push({ pid: entry.readUInt32LE(8), parentPid: entry.readUInt32LE(32), name });
    }
  } finally {
    api.CloseHandle(snapshot);
  }
  return list;
}

function commandLineWin32(api: ReturnType<typeof loadWin32>, handle: unknown): string {
  let info = Buffer.alloc(4096);
  const returned = [0];
  let status = api.NtQueryInformationProcess(handle, ProcessCommandLineInformation, info, info.length, returned);
  if (status === STATUS_INFO_LENGTH_MISMATCH && returned[0]) {
    info = Buffer.alloc(returned[0]);
    status = api.NtQueryInformationProcess(handle, ProcessCommandLineInformation, info, info.length, returned);
  }
  if (status !== 0) return "";
  // A UNICODE_STRING whose text lives later in the same buffer.
  const length = info.readUInt16LE(0);
  const offset = Number(info.readBigUInt64LE(8) - koffi.address(info));
  if (offset < 16 || offset + length > info.length) return "";
  return info.toString("utf16le", offset, offset + length);
}

function sampleWin32(rootPid: number): Sample[] {
  const api = (win32 ??= loadWin32());
  const counters = Buffer.alloc(COUNTERS_EX2_SIZE);
  const times = Buffer.alloc(32);
  return descendants(listWin32(api), rootPid).map((entry) => {
    const sample: Sample = { ...entry, commandLine: "", memory: 0, cpuTime: 0 };
    const handle = api.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, entry.pid);
    if (!handle) return sample;
    try {
      counters.fill(0);
      counters.writeUInt32LE(COUNTERS_EX2_SIZE, 0);
      if (api.K32GetProcessMemoryInfo(handle, counters, COUNTERS_EX2_SIZE)) {
        sample.memory = Number(counters.readBigUInt64LE(80));
      } else {
        counters.writeUInt32LE(COUNTERS_EX_SIZE, 0);
        if (api.K32GetProcessMemoryInfo(handle, counters, COUNTERS_EX_SIZE)) sample.memory = Number(counters.readBigUInt64LE(72));
      }
      // FILETIMEs: creation, exit, kernel, user (100 ns units).
      if (api.GetProcessTimes(handle, times.subarray(0, 8), times.subarray(8, 16), times.subarray(16, 24), times.subarray(24, 32))) {
        sample.cpuTime = Number(times.readBigUInt64LE(16) + times.readBigUInt64LE(24)) / 10_000;
      }
      sample.commandLine = commandLineWin32(api, handle);
    } finally {
      api.CloseHandle(handle);
    }
    return sample;
  });
}

/* ── macOS / Linux ────────────────────────────────────────────────────── */

/** `[[dd-]hh:]mm:ss[.cc]` → ms */
function parseCpuTime(value: string): number {
  const [days, rest] = value.includes("-") ? value.split("-") : ["0", value];
  const parts = rest!.split(":").map(Number);
  while (parts.length < 3) parts.unshift(0);
  const [hours, minutes, seconds] = parts as [number, number, number];
  return (((Number(days) * 24 + hours) * 60 + minutes) * 60 + seconds) * 1000;
}

async function samplePosix(rootPid: number): Promise<Sample[]> {
  const { code, stdout } = await capture("ps", ["-A", "-o", "pid=,ppid=,rss=,time=,args="]);
  if (code !== 0) return [];
  const all: Sample[] = [];
  for (const line of stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!match) continue;
    const commandLine = match[5]!;
    const executable = commandLine.split(" ")[0] ?? "";
    all.push({
      pid: Number(match[1]),
      parentPid: Number(match[2]),
      name: executable.slice(executable.lastIndexOf("/") + 1),
      commandLine,
      memory: Number(match[3]) * 1024,
      cpuTime: parseCpuTime(match[4]!),
    });
  }
  return descendants(all, rootPid);
}
