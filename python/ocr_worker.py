import sys, json, base64, os, gc, types, importlib


class _LazyModule(types.ModuleType):
    """Stands in for a module until something actually uses it, then imports the real one."""

    def __init__(self, name):
        super().__init__(name)
        self.__dict__["_real"] = None

    def _load(self):
        real = self.__dict__["_real"]
        if real is None:
            if sys.modules.get(self.__name__) is self:
                del sys.modules[self.__name__]
            real = importlib.import_module(self.__name__)
            self.__dict__["_real"] = real
        return real

    def __getattr__(self, name):
        return getattr(self._load(), name)


# ddddocr imports OpenCV at start-up for its slide, detection and colour-filter helpers. Text recognition, the only
# thing Waymark calls, never touches it, so OpenCV (about 15-30 MB resident) loads only if one of those helpers runs.
# Set WAYMARK_OCR_LAZY_CV2=0 to import it eagerly as before.
if os.environ.get("WAYMARK_OCR_LAZY_CV2", "1") != "0" and "cv2" not in sys.modules:
    sys.modules["cv2"] = _LazyModule("cv2")

ocr = None


def model():
    global ocr
    if ocr is None:
        import ddddocr
        ocr = ddddocr.DdddOcr(show_ad=False)
        gc.collect()
    return ocr


for line in sys.stdin:
    request_id = None
    try:
        payload = json.loads(line)
        request_id = payload.get("id")
        if payload.get("warm"):
            # Load the model and run it once so the first real CAPTCHA is as fast as every later one.
            engine = model()
            sample = payload.get("image")
            if sample:
                engine.classification(base64.b64decode(sample, validate=True))
            print(json.dumps({"id": request_id, "text": "", "warm": True}), flush=True)
            continue
        image = base64.b64decode(payload["image"], validate=True)
        if len(image) > 5 * 1024 * 1024:
            raise ValueError("image too large")
        text = model().classification(image)
        if not isinstance(text, str) or len(text) > 128:
            raise ValueError("invalid OCR output")
        print(json.dumps({"id": request_id, "text": text}, ensure_ascii=False), flush=True)
    except Exception as exc:
        print(json.dumps({"id": request_id, "error": str(exc)}, ensure_ascii=False), flush=True)
