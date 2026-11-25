"""Windows: what handing an idle OCR worker's pages back to the OS (EmptyWorkingSet) saves, and what the next
recognition then costs.  python benchmarks/memory/ocr_trim_probe.py"""
import sys, os, time, json, ctypes, subprocess, types, importlib


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


if "--eager" not in sys.argv:
    sys.modules["cv2"] = LazyModule("cv2")


def private_mb():
    out = subprocess.run(["powershell", "-NoProfile", "-Command", f"(Get-CimInstance Win32_PerfFormattedData_PerfProc_Process -Filter 'IDProcess={os.getpid()}').WorkingSetPrivate"], capture_output=True, text=True).stdout.strip()
    return round(int(out) / 1048576, 1)


steps = {"interpreter": private_mb()}
t = time.perf_counter()
import ddddocr
ocr = ddddocr.DdddOcr(show_ad=False)
steps["load_ms"] = round((time.perf_counter() - t) * 1000)
image = open(os.path.join(os.path.dirname(__file__), "..", "..", "data", "ocr-smoke.png"), "rb").read()
t = time.perf_counter(); answer = ocr.classification(image); steps["first_ms"] = round((time.perf_counter() - t) * 1000)
times = []
for _ in range(10):
    t = time.perf_counter(); ocr.classification(image); times.append((time.perf_counter() - t) * 1000)
steps["warm_median_ms"] = round(sorted(times)[5], 1)
steps["loaded_private"] = private_mb()
kernel32 = ctypes.windll.kernel32
ctypes.windll.psapi.EmptyWorkingSet(kernel32.GetCurrentProcess())
time.sleep(1)
steps["trimmed_private"] = private_mb()
t = time.perf_counter(); ocr.classification(image); steps["after_trim_ms"] = round((time.perf_counter() - t) * 1000, 1)
t = time.perf_counter(); ocr.classification(image); steps["after_trim_second_ms"] = round((time.perf_counter() - t) * 1000, 1)
steps["after_use_private"] = private_mb()
steps["answer"] = answer
steps["cv2_loaded"] = not isinstance(sys.modules.get("cv2"), LazyModule) or sys.modules["cv2"].__dict__["_real"] is not None
print(json.dumps(steps))
