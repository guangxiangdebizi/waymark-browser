import sys, json, base64, uuid

ocr = None
for line in sys.stdin:
    request_id = None
    try:
        payload = json.loads(line)
        request_id = payload.get("id")
        image = base64.b64decode(payload["image"], validate=True)
        if len(image) > 5 * 1024 * 1024:
            raise ValueError("image too large")
        if ocr is None:
            import ddddocr
            ocr = ddddocr.DdddOcr(show_ad=False)
        text = ocr.classification(image)
        if not isinstance(text, str) or len(text) > 128:
            raise ValueError("invalid OCR output")
        print(json.dumps({"id": request_id, "text": text}, ensure_ascii=False), flush=True)
    except Exception as exc:
        print(json.dumps({"id": request_id, "error": str(exc)}, ensure_ascii=False), flush=True)
