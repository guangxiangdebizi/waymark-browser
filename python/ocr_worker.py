import sys, json, base64, os, gc, types, importlib

# Waymark speaks UTF-8 JSON lines; on Windows the console default (GBK and the like) would garble Chinese prompts
# and answers in both directions.
sys.stdin.reconfigure(encoding="utf-8")
sys.stdout.reconfigure(encoding="utf-8")


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


# ddddocr imports OpenCV at start-up for its slide, detection and colour-filter helpers. Plain text recognition never
# touches it, so OpenCV (about 15-30 MB resident) loads only when a slider, click or multi-frame challenge needs it.
# Set WAYMARK_OCR_LAZY_CV2=0 to import it eagerly as before.
if os.environ.get("WAYMARK_OCR_LAZY_CV2", "1") != "0" and "cv2" not in sys.modules:
    sys.modules["cv2"] = _LazyModule("cv2")

ocr = None
det = None
slide = None
MAX_IMAGE = 5 * 1024 * 1024
MAX_FRAMES = 60


def model():
    global ocr
    if ocr is None:
        import ddddocr
        ocr = ddddocr.DdddOcr(show_ad=False)
        gc.collect()
    return ocr


def detector():
    global det
    if det is None:
        import ddddocr
        det = ddddocr.DdddOcr(ocr=False, det=True, show_ad=False)
    return det


def slider():
    global slide
    if slide is None:
        import ddddocr
        slide = ddddocr.DdddOcr(ocr=False, det=False, show_ad=False)
    return slide


# ---- the input layer: what ddddocr is shown -------------------------------------------------------------------------
# A challenge is not always one still image. Prompts play one item after another, text blinks in piece by piece, the
# slider gap appears only while the handle is held. The page side samples frames; these helpers turn them into the
# single image (or ordered list of images) each ddddocr model expects.

def raw(value):
    data = base64.b64decode(value, validate=True)
    if len(data) > MAX_IMAGE:
        raise ValueError("image too large")
    return data


def array(value):
    import numpy as np
    from PIL import Image
    import io
    return np.asarray(Image.open(io.BytesIO(raw(value))).convert("RGB")).astype("int16")


def png(img):
    from PIL import Image
    import io
    out = io.BytesIO()
    Image.fromarray(img.clip(0, 255).astype("uint8")).save(out, format="PNG")
    return out.getvalue()


def frames_of(payload, key="frames"):
    frames = [array(f) for f in payload.get(key, [])[:MAX_FRAMES]]
    if not frames:
        raise ValueError("no frames")
    shape = frames[0].shape
    return [f for f in frames if f.shape == shape]


def changed(a, b, threshold=40):
    import numpy as np
    return np.abs(a - b).max(axis=2) > threshold


def keyframes(frames, times=None):
    """Consecutive duplicates collapse into one keyframe; each keeps when it appeared and how long it stayed."""
    import numpy as np
    keys = []
    for i, frame in enumerate(frames):
        t = times[i] if times and i < len(times) else i
        if keys and np.abs(frame - keys[-1]["frame"]).mean() < 1.5:
            keys[-1]["until"] = t
            continue
        keys.append({"frame": frame, "at": t, "until": t})
    return keys


def background(frames, weights=None):
    """Per-pixel median; with weights (how long each frame was on screen) a long blank pause outweighs brief items."""
    import numpy as np
    if weights:
        unit = min(w for w in weights if w > 0) if any(w > 0 for w in weights) else 1
        frames = [f for f, w in zip(frames, weights) for _ in range(max(1, min(20, round(w / unit))))]
    return np.median(np.stack(frames), axis=0)


def item_masks(frames, weights=None):
    """Per keyframe, the pixels where it shows something on top of the common background.

    Only pixels that change between keyframes can belong to an item. Prompt areas are nearly always plain, so the
    colour those pixels show most often is the background, even when the items take up more screen time than the
    blank pauses and overlap in the same spot. On textured backgrounds the time-weighted median is used instead.
    """
    import numpy as np
    stack = np.stack(frames)
    varying = (stack.max(axis=0) - stack.min(axis=0)).max(axis=2) > 40
    masks = [np.zeros(varying.shape, bool) for _ in frames]
    if not varying.any():
        return masks
    values = stack[:, varying]
    codes = (values // 32) @ np.array([64, 8, 1])
    found, counts = np.unique(codes, return_counts=True)
    if counts.max() / codes.size >= 0.4:
        colour = values[codes == found[counts.argmax()]].mean(axis=0)
        for mask, v in zip(masks, values):
            mask[varying] = np.abs(v - colour).max(axis=1) > 60
        return masks
    bg = background(frames, weights)
    return [changed(f, bg) for f in frames]


def union(frames):
    """One frame holding everything any frame showed: per pixel, the value furthest from the common background."""
    import numpy as np
    stack = np.stack(frames)
    bg = np.median(stack, axis=0)
    deviation = np.abs(stack - bg).sum(axis=3)
    pick = deviation.argmax(axis=0)
    rows, cols = np.indices(pick.shape)
    return stack[pick, rows, cols]


def components(mask, min_area=24, close=3):
    import cv2
    import numpy as np
    m = mask.astype("uint8") * 255
    if close:
        m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, np.ones((close, close), "uint8"))
    count, _, stats, _ = cv2.connectedComponentsWithStats(m, 8)
    found = [{"x": int(s[0]), "y": int(s[1]), "w": int(s[2]), "h": int(s[3]), "area": int(s[4])} for s in stats[1:count] if s[4] >= min_area]
    return sorted(found, key=lambda c: -c["area"])


def bbox(mask, pad=2):
    import numpy as np
    ys, xs = np.nonzero(mask)
    if not len(xs):
        return None
    h, w = mask.shape
    return [max(0, int(xs.min()) - pad), max(0, int(ys.min()) - pad), min(w, int(xs.max()) + pad + 1), min(h, int(ys.max()) + pad + 1)]


def crop(img, box):
    x0, y0, x1, y1 = box
    return img[y0:y1, x0:x1]


def region(img, r):
    return img[int(r["y"]):int(r["y"] + r["h"]), int(r["x"]):int(r["x"] + r["w"])]


def similarity(a, b):
    """Shape similarity of two small crops (normalised correlation of their ink at 32x32), in [-1, 1]."""
    import cv2
    import numpy as np

    def ink(img):
        gray = cv2.cvtColor(img.clip(0, 255).astype("uint8"), cv2.COLOR_RGB2GRAY)
        _, bw = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
        if (bw > 0).mean() > 0.5:
            bw = 255 - bw
        box = bbox(bw > 0, 0)
        if box:
            bw = crop(bw, box)
        v = cv2.resize(bw, (32, 32), interpolation=cv2.INTER_AREA).astype("float32").ravel()
        v -= v.mean()
        return v / (np.linalg.norm(v) or 1)

    return float(ink(a) @ ink(b))


def read_one(img, size=64):
    """One short item (usually a single character). A tight crop reads badly (山 comes back as "ll"); centred on a
    white margin at a fixed size it reads like the text the model was trained on."""
    import cv2
    import numpy as np
    h, w = img.shape[:2]
    if not h or not w:
        return ""
    scale = size / max(h, w)
    big = cv2.resize(img.clip(0, 255).astype("uint8"), (max(1, int(w * scale)), max(1, int(h * scale))), interpolation=cv2.INTER_CUBIC)
    text = model().classification(png(np.pad(big, ((16, 16), (16, 16), (0, 0)), constant_values=255).astype("int16")))
    return text.strip() if isinstance(text, str) else ""


def search(item, field, taken, min_gap=14):
    """Find a prompt item in the image by its shape, at the sizes and slight rotations challenges draw it with.

    Used when the detector misses the target or the text cannot be read (icons). Places already chosen for earlier
    items are excluded. Returns (score, (x, y)) of the best match.
    """
    import cv2
    import numpy as np

    def ink(img):
        return (255 - cv2.cvtColor(img.clip(0, 255).astype("uint8"), cv2.COLOR_RGB2GRAY)).astype("float32")

    template, ground = ink(item), ink(field)
    best = (-1.0, None)
    for scale in np.arange(0.8, 1.75, 0.1):
        t = cv2.resize(template, None, fx=scale, fy=scale)
        h, w = t.shape
        if h >= ground.shape[0] or w >= ground.shape[1] or h < 6 or w < 6:
            continue
        for angle in (-15, -8, 0, 8, 15):
            r = cv2.warpAffine(t, cv2.getRotationMatrix2D((w / 2, h / 2), angle, 1), (w, h))
            res = cv2.matchTemplate(ground, r, cv2.TM_CCOEFF_NORMED)
            for x, y in taken:
                x0, y0 = int(max(0, x - w / 2 - min_gap)), int(max(0, y - h / 2 - min_gap))
                res[y0:int(max(0, y - h / 2 + min_gap)) + 1, x0:int(max(0, x - w / 2 + min_gap)) + 1] = -1
            _, value, _, loc = cv2.minMaxLoc(res)
            if value > best[0]:
                best = (float(value), (loc[0] + w / 2, loc[1] + h / 2))
    return best


def ordered_items(keys):
    """What a playing prompt showed, in order: one entry per shown item over one cycle, starting after the longest pause.

    Each keyframe either shows an item (it differs from the background) or is blank. A blank keyframe's dwell adds to
    the pause before the next item. Once the sequence repeats, the item after the longest pause is the first one, so
    sampling that began mid-cycle still yields the order the page intended.
    """
    dwell = [keys[i + 1]["at"] - keys[i]["at"] for i in range(len(keys) - 1)]
    dwell.append((keys[-1]["until"] - keys[-1]["at"]) or (sorted(dwell)[len(dwell) // 2] if dwell else 1))
    masks = item_masks([k["frame"] for k in keys], dwell)
    seq, pause = [], 0
    for k, d, mask in zip(keys, dwell, masks):
        box = bbox(mask)
        if not box or (box[2] - box[0]) * (box[3] - box[1]) < 30:
            pause += d
            continue
        c = crop(k["frame"], box)
        if seq and not pause and similarity(c, seq[-1]["crop"]) > 0.92:
            continue
        seq.append({"crop": c, "box": box, "pause": pause})
        pause = 0
    if not seq:
        return [], False
    period = len(seq)
    for p in range(1, len(seq)):
        if all(similarity(seq[i]["crop"], seq[i + p]["crop"]) > 0.9 for i in range(len(seq) - p)):
            period = p
            break
    cycled = period < len(seq)
    cycle = seq[:period]
    if cycled:
        pauses = [max(seq[j]["pause"] for j in range(i, len(seq), period)) for i in range(period)]
        start = max(range(period), key=lambda i: pauses[i])
        cycle = cycle[start:] + cycle[:start]
    return cycle, cycled


def strip(crops, height=48):
    """Ordered crops side by side in one image: the "one frame" form of a played sequence that keeps its order."""
    import cv2
    import numpy as np
    tiles = []
    for c in crops:
        h, w = c.shape[:2]
        scale = height / max(h, 1)
        tile = cv2.resize(c.clip(0, 255).astype("uint8"), (max(1, int(w * scale)), height))
        tiles.append(np.pad(tile, ((4, 4), (8, 8), (0, 0)), constant_values=255))
    return np.concatenate(tiles, axis=1).astype("int16")


def op_classify_frames(payload):
    frames = frames_of(payload)
    keys = keyframes(frames)
    merged = union([k["frame"] for k in keys]) if len(keys) > 1 else frames[0]
    text = model().classification(png(merged))
    return {"text": text, "keyframes": len(keys)}


def op_reveal(payload):
    """What the press revealed: regions that differ between the frame before the press and while it is held."""
    before = array(payload["before"])
    during = frames_of(payload)
    after = during[-1]
    if after.shape != before.shape:
        raise ValueError("frame sizes differ")
    found = components(changed(after, before, payload.get("threshold", 30)), min_area=max(60, before.shape[0] * before.shape[1] // 2000), close=5)
    return {"width": before.shape[1], "height": before.shape[0], "regions": found[:6]}


def op_slide_match(payload):
    result = slider().slide_match(raw(payload["piece"]), raw(payload["background"]), simple_target=bool(payload.get("simple")))
    return {"target": result.get("target"), "confidence": result.get("confidence")}


def op_click_plan(payload):
    """Where to click, in order, for "click the items in this order" challenges whose prompt may play over time."""
    frames = frames_of(payload)
    times = payload.get("times")
    prompt_r, canvas_r = payload.get("prompt"), payload["canvas"]
    canvas_keys = keyframes([region(f, canvas_r) for f in frames], times)
    canvas = background([k["frame"] for k in canvas_keys]) if len(canvas_keys) > 1 else canvas_keys[0]["frame"]
    tokens = [t for t in payload.get("tokens") or [] if t]
    crops, cycled, method = [], False, "dom-text"
    if not tokens and prompt_r:
        prompt_keys = keyframes([region(f, prompt_r) for f in frames], times)
        if len(prompt_keys) > 1:
            items, cycled = ordered_items(prompt_keys)
            crops = [item["crop"] for item in items]
            method = "prompt-sequence"
        else:
            still = prompt_keys[0]["frame"]
            boxes = sorted(detector().detection(png(still)), key=lambda b: b[0])
            ex = payload.get("exclude")
            if ex:
                # Characters of the instruction text itself are not targets.
                ox, oy = ex["x"] - prompt_r["x"], ex["y"] - prompt_r["y"]
                boxes = [b for b in boxes if not (ox - 2 <= (b[0] + b[2]) / 2 <= ox + ex["w"] + 2 and oy - 2 <= (b[1] + b[3]) / 2 <= oy + ex["h"] + 2)]
            crops = [crop(still, b) for b in boxes]
            method = "prompt-still"
        tokens = [read_one(c) for c in crops]
    if not tokens and not crops and len(canvas_keys) > 1:
        # No prompt to read: the image itself highlights the targets one after another.
        items, cycled = ordered_items(canvas_keys)
        points = [((i["box"][0] + i["box"][2]) / 2, (i["box"][1] + i["box"][3]) / 2) for i in items]
        return {"points": [{"x": canvas_r["x"] + x, "y": canvas_r["y"] + y} for x, y in points], "method": "canvas-highlight", "items": len(points), "cycled": cycled}
    if not tokens:
        return {"points": [], "method": method, "items": 0, "reason": "nothing to click was found in the prompt"}
    boxes = detector().detection(png(canvas))
    candidates = [{"box": b, "crop": crop(canvas, b)} for b in boxes]
    for c in candidates:
        c["text"] = read_one(c["crop"])
    used, taken, points, matched, searched = set(), [], [], 0, 0
    for i, token in enumerate(tokens):
        # 1. The detector found it and it reads the same as the prompt item.
        pick = next((j for j, c in enumerate(candidates) if j not in used and token and c["text"] and token[0] in c["text"]), None)
        if pick is not None:
            b = candidates[pick]["box"]
            used.add(pick)
            matched += 1
            point = ((b[0] + b[2]) / 2, (b[1] + b[3]) / 2)
        elif i < len(crops):
            # 2. Look for the prompt item's shape anywhere in the image (detector miss, unreadable icon).
            score, point = search(crops[i], canvas, taken)
            searched += 1
            if score < 0.55:
                # 3. Closest detected shape.
                scored = [(similarity(crops[i], c["crop"]), j) for j, c in enumerate(candidates) if j not in used]
                best = max(scored, default=(-1.0, None))
                if best[0] < 0.35:
                    return {"points": [], "method": method, "items": len(tokens), "textMatched": matched, "candidates": len(candidates), "reason": f"item {i + 1} of {len(tokens)} has no match in the image"}
                b = candidates[best[1]]["box"]
                used.add(best[1])
                point = ((b[0] + b[2]) / 2, (b[1] + b[3]) / 2)
        else:
            return {"points": [], "method": method, "items": len(tokens), "textMatched": matched, "candidates": len(candidates), "reason": f"item {i + 1} ({len(token)} chars) is not in the image"}
        taken.append(point)
        points.append({"x": canvas_r["x"] + point[0], "y": canvas_r["y"] + point[1]})
    result = {"points": points, "method": method, "items": len(tokens), "textMatched": matched, "searched": searched, "candidates": len(candidates), "cycled": cycled}
    if crops:
        # The ordered prompt as one image, for the ledger's debugging view and for providers that read a whole strip.
        result["stripText"] = model().classification(png(strip(crops)))
    return result


def op_prepare(payload):
    """Load what a slider or click challenge will need while the pointer is still on its way to the widget."""
    import cv2, numpy  # noqa: F401
    cv2.setNumThreads(1)
    if payload.get("kind") == "click_sequence":
        detector()
        model()
    return {"ready": True}


OPS = {"prepare": op_prepare, "classify_frames": op_classify_frames, "reveal": op_reveal, "slide_match": op_slide_match, "click_plan": op_click_plan}

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
        op = payload.get("op")
        if op:
            if op not in OPS:
                raise ValueError(f"unknown op {op}")
            result = OPS[op](payload)
            result.pop("crop", None)
            print(json.dumps({"id": request_id, **result}, ensure_ascii=False), flush=True)
            continue
        image = raw(payload["image"])
        text = model().classification(image)
        if not isinstance(text, str) or len(text) > 128:
            raise ValueError("invalid OCR output")
        print(json.dumps({"id": request_id, "text": text}, ensure_ascii=False), flush=True)
    except Exception as exc:
        print(json.dumps({"id": request_id, "error": str(exc)}, ensure_ascii=False), flush=True)
