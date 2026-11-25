"""Where the OCR worker's memory goes, and what each step costs in time.

    python benchmarks/memory/ocr_probe.py [--lean 0|1]

Reports resident memory (private working set on Windows, PSS on Linux) after the interpreter starts, after importing
ddddocr, after loading the model and after recognising images, with the time of each step. With --lazy-cv2 1 (the default, as in Waymark's
worker) OpenCV is only imported when something uses it.
"""
import json, os, sys, time, base64, subprocess

lazy = "--lazy-cv2" not in sys.argv or sys.argv[sys.argv.index("--lazy-cv2") + 1] != "0"


def memory_mb():
    if sys.platform == "win32":
        import ctypes
        from ctypes import wintypes

        class Counters(ctypes.Structure):
            _fields_ = [("cb", wintypes.DWORD), ("PageFaultCount", wintypes.DWORD), ("PeakWorkingSetSize", ctypes.c_size_t), ("WorkingSetSize", ctypes.c_size_t),
                        ("QuotaPeakPagedPoolUsage", ctypes.c_size_t), ("QuotaPagedPoolUsage", ctypes.c_size_t), ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
                        ("QuotaNonPagedPoolUsage", ctypes.c_size_t), ("PagefileUsage", ctypes.c_size_t), ("PeakPagefileUsage", ctypes.c_size_t), ("PrivateUsage", ctypes.c_size_t)]
        counters = Counters()
        counters.cb = ctypes.sizeof(Counters)
        ctypes.windll.psapi.GetProcessMemoryInfo(ctypes.windll.kernel32.GetCurrentProcess(), ctypes.byref(counters), counters.cb)
        # Private working set via the performance counter (what Task Manager shows), working set and commit for context.
        pid = os.getpid()
        try:
            out = subprocess.run(["powershell", "-NoProfile", "-Command", f"(Get-CimInstance Win32_PerfFormattedData_PerfProc_Process -Filter 'IDProcess={pid}').WorkingSetPrivate"], capture_output=True, text=True, timeout=30).stdout.strip()
            private = int(out) / 1048576
        except Exception:
            private = 0
        return {"private": round(private, 1), "ws": round(counters.WorkingSetSize / 1048576, 1), "commit": round(counters.PrivateUsage / 1048576, 1)}
    with open("/proc/self/smaps_rollup") as handle:
        values = {line.split(":")[0]: int(line.split()[1]) for line in handle if ":" in line and line.split()[1].isdigit()}
    return {"private": round(values.get("Pss", 0) / 1024, 1), "ws": round(values.get("Rss", 0) / 1024, 1)}


steps = []
def mark(name, started):
    steps.append({"step": name, "ms": round((time.perf_counter() - started) * 1000), **memory_mb()})


t = time.perf_counter(); mark("interpreter", t)
t = time.perf_counter()
if lazy:
    import types, importlib

    class LazyModule(types.ModuleType):
        def __init__(self, name):
            super().__init__(name)
            self.__dict__["_real"] = None

        def __getattr__(self, attr):
            if self.__dict__["_real"] is None:
                if sys.modules.get(self.__name__) is self:
                    del sys.modules[self.__name__]
                self.__dict__["_real"] = importlib.import_module(self.__name__)
            return getattr(self.__dict__["_real"], attr)
    sys.modules["cv2"] = LazyModule("cv2")
import ddddocr  # noqa: E402
mark("import ddddocr", t)
heavy = sorted(name for name in sys.modules if name in {"cv2", "torch", "scipy", "pandas", "matplotlib", "numpy", "PIL", "onnxruntime"} and not (name == "cv2" and lazy and getattr(sys.modules[name], "_real", 1) is None))
t = time.perf_counter(); ocr = ddddocr.DdddOcr(show_ad=False); mark("load model", t)
image = open(os.path.join(os.path.dirname(__file__), "..", "..", "data", "ocr-smoke.png"), "rb").read()
t = time.perf_counter(); first = ocr.classification(image); mark("first recognition", t)
times = []
for _ in range(20):
    t0 = time.perf_counter(); ocr.classification(image); times.append((time.perf_counter() - t0) * 1000)
times.sort()
mark("20 more recognitions", time.perf_counter())
print(json.dumps({"lazyCv2": lazy, "answer": first, "steps": steps, "laterMedianMs": round(times[10], 1), "laterP95Ms": round(times[18], 1), "heavyModules": heavy, "ddddocr": getattr(ddddocr, "__version__", "?")}, indent=2))
