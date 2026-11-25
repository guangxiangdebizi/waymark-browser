# Memory: where it goes and what Waymark does about it

Speed and feel come first: nothing here may make a page open, an action, a CAPTCHA or switching tabs slower, or make
the pointer and keyboard less human. Within that, Waymark holds as little memory as it can. Every change below was
measured with the benchmark in `benchmarks/memory/` against the previous release, and the ones that did not pay off
were dropped (listed at the end).

## What a Waymark process tree is made of

| Piece | Why it exists | Can it go? |
|---|---|---|
| Electron browser process | Window, tabs, IPC, and (since 0.6) the agent runtime | No. The runtime now lives here, so there is one JS runtime instead of two |
| Agent runtime (Playwright client, MCP server, local web server, ledger) | Talks to agents, drives tabs | Its separate Node process is gone; its V8 young generation is capped at 2 MB semi-spaces |
| Network service | HTTP stack | Runs as a thread of the browser process instead of a process (`NetworkServiceInProcess2`) |
| GPU process | Compositing, smooth scrolling and video | Kept: software compositing would cost frame rate |
| Renderer: window shell (tab strip, side panel) | The UI you use | Kept; polls the ledger only when it changed |
| Renderer: start page and every tab | The pages | Kept per site (site isolation is a security boundary) |
| OCR worker (Python, ddddocr) | Local CAPTCHA recognition | Loaded when an agent connects, not at launch; OpenCV is not imported unless used; unloaded after 20 idle minutes |

## Changes

1. **One runtime process instead of two.** Until 0.5, `waymark start` ran a Node process that drove Electron through
   Playwright. Electron's main process already embeds Node, so the runtime now runs there (`src/app/inprocess.ts`) and
   connects to the browser over a loopback DevTools endpoint on a random port, as Playwright's Electron launcher did.
   The test harness still uses the external driver (`startWaymark()`), and `WAYMARK_LEGACY_DRIVER=1` brings the old
   layout back.
2. **Smaller young generation for the runtime.** V8 sizes the young generation for servers (tens of MB). The runtime
   allocates small request and response objects, so 2 MB semi-spaces only mean more scavenges of well under a
   millisecond each. Web pages run in renderers and keep V8's defaults. `WAYMARK_SEMI_SPACE_MB` overrides it.
3. **Network service in-process.** One process fewer. `browser.memory.networkServiceInProcess: false` restores it.
4. **OCR model ready exactly when an agent might need it.** v0.5 started Python and loaded the model on the first
   CAPTCHA, so that CAPTCHA waited for both. Now the model loads in the background the moment any agent talks to
   Waymark (MCP connect, tool call or CLI command), which in practice is seconds or minutes before its first page,
   and is unloaded after `challenge.ocrIdleUnloadMinutes` (20) without agent activity. `challenge.ocrPrewarm:
   "startup"` also loads it at launch; `"off"` restores the old behaviour.
5. **OpenCV only when used.** ddddocr imports OpenCV for its slider, detection and colour-filter helpers. Text
   recognition never touches it, so the worker defers the import until something does (`WAYMARK_OCR_LAZY_CV2=0`
   restores eager import). Same answers, a smaller worker and a faster model load.
6. **The ledger stays on disk.** The runtime keeps only the newest 1,000 entries in memory (was 5,000), counts today's
   actions as it writes instead of scanning, and the dashboards stream the time window they need from disk, skipping
   older lines by their timestamp without parsing them; a parsed window is shared for 15 s and then dropped.
7. **Screenshots never sit in front of the agent.** Trace screenshots are taken beside the agent's next step, at most
   one per tab at a time, written straight to disk as small JPEGs.
8. **No growth over time.** Snapshot hashes were kept for every snapshot ever taken; now only those a live element ref
   still points to are kept.
9. **The side panel reads the timeline only when it changed** instead of fetching 200 entries every two seconds.

## Measuring

```bash
npm run build
node benchmarks/memory/bench.mjs --target waymark                   # this build
node benchmarks/memory/bench.mjs --target waymark --app-dir ../old  # another build (0.5 runs through its Node launcher)
node benchmarks/memory/bench.mjs --target chrome                    # or edge; same pages through CDP
node benchmarks/memory/run-all.mjs --baseline ../old --soak 20      # everything, plus a 20-minute soak; writes report.md
python benchmarks/memory/ocr_probe.py --lazy-cv2 1                  # where the OCR worker's memory and time go
```

Scenarios: cold start, idle, one tab, five tabs (local article pages, or `--sites web` for Bing, Wikipedia, GitHub,
Baidu and MDN), an agent task (snapshot, fill, select, type, click), a first and a second CAPTCHA (ddddocr), restoring
a background tab, pointer smoothness measured inside the page (mousemove events per path and the gaps between them),
`--cold-captcha` (the very first agent action opens a CAPTCHA page) and `--soak N` (N minutes of agent work, memory per
minute). Memory is the private working set of the whole process tree (what Windows Task Manager shows), PSS on Linux,
sampled every second. Waymark's page-open time includes its deliberate 250 ms settle wait and CAPTCHA detection.

## Results (Windows 11, i7-10750H, 64 GB; private working set, median of 3 runs)

| | v0.5.0 | 0.6 branch | change | Chrome | Edge |
|---|---|---|---|---|---|
| Idle (start page) | 196 MB | 154 MB | −22% | 153 MB | 227 MB |
| After an agent task and a CAPTCHA | 428 MB | 378 MB | −12% | | |
| Peak | 432 MB | 379 MB | −12% | | |
| 1 / 5 tabs open, agent connected | 200 / 294 MB | 237 / 330 MB | +18% / +12% | 181 / 243 MB | 191 / 255 MB |
| Cold start to ready | 2.0 s | 1.5 s | faster | | |
| First CAPTCHA (navigate → solved) | 2.07 s | 0.74 s | 2.8× faster | | |
| Snapshot, click, select, typing, tab restore, pointer smoothness | | | unchanged | | |

The one row that goes up is the price of the fast first CAPTCHA: once an agent is connected the OCR worker
(~50 MB) is resident, where v0.5 loaded it only when a CAPTCHA appeared. `challenge.ocrPrewarm: "off"` trades it back.
Per change (one turned back at a time): runtime in its own Node process +41 MB idle and +57 MB after work, and cold
start 2.5 s instead of 1.5 s; network service as a process +8 MB; 32 MB young generation +8 MB after work; eager
OpenCV +8 MB with the OCR worker loaded and 0.4 s slower model load; trace screenshots cost no measurable speed.
In a 15-minute soak the runtime heap stayed flat (45.7 → 43.9 MB).

## Tried and dropped

- **Memory-pressure signal to idle background tabs** (drop decoded images and caches without reloading): no
  measurable difference on Windows with five tabs left for a minute. Removed.
- **One-byte sources for Playwright** (its 7 MB of bundles hold ~200 non-Latin-1 characters in comments, so V8 stores
  them two bytes per character): transcoding at load time cut the runtime heap by 6.3 MB, but the process's memory
  did not move beyond noise. Removed.
- **Handing the idle OCR worker's pages back to Windows** (`EmptyWorkingSet`): private working set unchanged.

- **ONNX Runtime without its memory arena** (`enable_cpu_mem_arena=False`, `enable_mem_pattern=False`): the ddddocr
  model is small; no measurable difference in the worker.
- **GPU in the browser process** (`--in-process-gpu`): no saving worth the risk of a GPU fault taking the window down.
- **Sharing one renderer per site** (`--process-per-site`): saves memory when several tabs show one site, but a busy
  tab would then slow the others on that site; against the speed rule.
- **Smaller young generation for web pages** (renderer `--js-flags`): would slow script-heavy sites.
- **Discarding background tabs** (Chrome's Memory Saver): frees the most, but a discarded tab reloads on return, loses
  unsaved input and invalidates an agent's refs.
