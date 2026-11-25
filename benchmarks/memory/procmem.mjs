// Process-tree memory sampling. Windows: one CIM query returns private working set (what Task Manager shows as
// "Memory"), working set and private bytes for every process with its parent, so a whole browser tree is one call.
// Linux: /proc/<pid>/smaps_rollup gives PSS, which shares memory fairly between processes.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, readdirSync } from 'node:fs';

const run = promisify(execFile);

export async function snapshotProcesses() {
  if (process.platform === 'win32') {
    const script = "Get-CimInstance Win32_PerfFormattedData_PerfProc_Process | Where-Object { $_.IDProcess -ne 0 } | Select-Object IDProcess,CreatingProcessID,Name,WorkingSet,WorkingSetPrivate,PrivateBytes | ConvertTo-Json -Compress";
    const { stdout } = await run('powershell.exe', ['-NoProfile', '-Command', script], { maxBuffer: 64 * 1024 * 1024, windowsHide: true });
    return JSON.parse(stdout).map(p => ({ pid: p.IDProcess, ppid: p.CreatingProcessID, name: String(p.Name).replace(/#\d+$/, ''), ws: Number(p.WorkingSet), private: Number(p.WorkingSetPrivate), commit: Number(p.PrivateBytes) }));
  }
  const result = [];
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = readFileSync(`/proc/${entry}/stat`, 'utf8');
      const name = stat.slice(stat.indexOf('(') + 1, stat.lastIndexOf(')'));
      const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
      const rollup = readFileSync(`/proc/${entry}/smaps_rollup`, 'utf8');
      const kb = key => Number(rollup.match(new RegExp(`^${key}:\\s+(\\d+)`, 'm'))?.[1] ?? 0) * 1024;
      result.push({ pid: Number(entry), ppid, name, ws: kb('Rss'), private: kb('Pss'), commit: kb('Private_Dirty') + kb('Private_Clean') });
    } catch { /* gone */ }
  }
  return result;
}

/** Every process descended from root (inclusive), with a role guessed from its command name. */
export function tree(processes, rootPid) {
  const children = new Map();
  for (const p of processes) { if (!children.has(p.ppid)) children.set(p.ppid, []); children.get(p.ppid).push(p); }
  const out = [];
  const seen = new Set();
  const visit = pid => {
    for (const child of children.get(pid) ?? []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid); out.push(child); visit(child.pid);
    }
  };
  const root = processes.find(p => p.pid === rootPid);
  if (root) { out.push(root); seen.add(root.pid); }
  visit(rootPid);
  return out;
}

export function summarize(list) {
  const sum = key => list.reduce((total, p) => total + p[key], 0);
  const byName = {};
  for (const p of list) {
    const entry = byName[p.name] ??= { count: 0, private: 0, ws: 0 };
    entry.count++; entry.private += p.private; entry.ws += p.ws;
  }
  return { processes: list.length, privateMB: mb(sum('private')), wsMB: mb(sum('ws')), commitMB: mb(sum('commit')), byName: Object.fromEntries(Object.entries(byName).map(([k, v]) => [k, { count: v.count, privateMB: mb(v.private), wsMB: mb(v.ws) }])) };
}

export const mb = bytes => Math.round(bytes / 1048576 * 10) / 10;

/** Name each process's role from its command line (browser, renderer, gpu-process, utility:network, ocr-worker, ...). */
export async function describe(list) {
  const lines = new Map();
  if (process.platform === 'win32') {
    const ids = list.map(p => p.pid).join(',');
    if (ids) {
      const script = `Get-CimInstance Win32_Process -Filter "ProcessId=${list.map(p => p.pid).join(' OR ProcessId=')}" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress`;
      try {
        const { stdout } = await run('powershell.exe', ['-NoProfile', '-Command', script], { maxBuffer: 16 * 1024 * 1024, windowsHide: true });
        const parsed = JSON.parse(stdout || '[]');
        for (const item of Array.isArray(parsed) ? parsed : [parsed]) lines.set(item.ProcessId, item.CommandLine ?? '');
      } catch { /* roles stay generic */ }
    }
  } else {
    for (const p of list) { try { lines.set(p.pid, readFileSync(`/proc/${p.pid}/cmdline`, 'utf8').replace(/\0/g, ' ')); } catch { /* gone */ } }
  }
  return list.map(p => {
    const cmd = lines.get(p.pid) ?? '';
    const type = cmd.match(/--type=([\w-]+)/)?.[1];
    const sub = cmd.match(/--utility-sub-type=([\w.]+)/)?.[1];
    const extension = /--extension-process/.test(cmd);
    const role = /ocr_worker\.py/.test(cmd) ? 'ocr-worker' : /launcher\.js/.test(cmd) ? 'node-runtime' : type ? (type === 'utility' && sub ? `utility:${sub.split('.').pop()}` : extension ? 'extension-renderer' : type) : (p.name === 'node' || p.name === 'MainThread') ? 'node-runtime' : 'browser';
    return { pid: p.pid, role, privateMB: mb(p.private), wsMB: mb(p.ws) };
  }).sort((a, b) => b.privateMB - a.privateMB);
}
