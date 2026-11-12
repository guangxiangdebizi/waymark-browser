# Test double for the `ocr` plugin slot: answers every image with its byte length.
import base64, json, sys

for line in sys.stdin:
    request = json.loads(line)
    print(json.dumps({"id": request["id"], "text": f"LEN{len(base64.b64decode(request['image']))}"}), flush=True)
