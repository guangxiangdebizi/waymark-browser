"""Example external-process CAPTCHA solver for Waymark's `ocr` slot.

Protocol: one JSON request per line on stdin, one JSON reply per line on stdout.

  request : {"id": 3, "image": "<base64 PNG of the challenge image>"}
  reply   : {"id": 3, "text": "A7B2"}          or   {"id": 3, "error": "why"}

This example runs ddddocr's alternative (beta) model; swap `solve()` for your own model,
a fine-tuned network or another OCR engine. Enable it with:

  { "capabilities": {
      "plugins": [{ "id": "challenge.ocr.ddddocr-beta", "kind": "ocr",
                    "command": ["python", "examples/plugins/ocr_solver.py"] }],
      "challengeOcr": "challenge.ocr.ddddocr-beta" } }

Waymark only sends the cropped challenge image, never the page. The answer is typed by the
browser and never enters the model context or the audit ledger.
"""
import base64
import json
import sys

_engine = None


def solve(png: bytes) -> str:
    global _engine
    if _engine is None:
        import ddddocr  # pip install ddddocr

        _engine = ddddocr.DdddOcr(beta=True, show_ad=False)
    return _engine.classification(png)


for line in sys.stdin:
    request = None
    try:
        request = json.loads(line)
        image = base64.b64decode(request["image"], validate=True)
        if len(image) > 5 * 1024 * 1024:
            raise ValueError("image too large")
        reply = {"id": request["id"], "text": solve(image)}
    except Exception as error:
        reply = {"id": request.get("id") if isinstance(request, dict) else None, "error": str(error)}
    print(json.dumps(reply, ensure_ascii=False), flush=True)
