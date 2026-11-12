"""Example external-process pointer model for Waymark (WindMouse-style path).

Any language works: read one JSON request per line on stdin, answer one JSON line on stdout.

  request : {"id": 1, "from": {"x": 0, "y": 0}, "to": {"x": 400, "y": 300},
             "viewport": {"width": 1280, "height": 800}, "purpose": "click" | "hover" | "ambient"}
  response: {"id": 1, "points": [{"x": 3.2, "y": 1.9, "dt": 8}, ...], "pressMs": 70}

Swap the body of `path()` for your own trained model. Enable it with:

  { "capabilities": {
      "plugins": [{ "id": "action.pointer.windmouse", "command": ["python", "examples/plugins/pointer_model.py"] }],
      "pointer": "action.pointer.windmouse" } }
"""
import json
import math
import random
import sys


def path(start, end, gravity=9.0, wind=3.0, max_step=14.0, target_area=10.0):
    """WindMouse: a damped random walk pulled toward the target."""
    x, y = start["x"], start["y"]
    vx = vy = wx = wy = 0.0
    points = []
    for _ in range(600):
        distance = math.hypot(end["x"] - x, end["y"] - y)
        if distance < 1:
            break
        w = min(wind, distance)
        if distance >= target_area:
            wx = wx / math.sqrt(3) + (2 * random.random() - 1) * w / math.sqrt(5)
            wy = wy / math.sqrt(3) + (2 * random.random() - 1) * w / math.sqrt(5)
        else:
            wx /= math.sqrt(3)
            wy /= math.sqrt(3)
            max_step = max(3.0, max_step / math.sqrt(5))
        vx += wx + gravity * (end["x"] - x) / distance
        vy += wy + gravity * (end["y"] - y) / distance
        speed = math.hypot(vx, vy)
        if speed > max_step:
            clip = max_step / 2 + random.random() * max_step / 2
            vx, vy = vx / speed * clip, vy / speed * clip
        x, y = x + vx, y + vy
        points.append({"x": round(x, 1), "y": round(y, 1), "dt": random.randint(5, 12)})
    points.append({"x": end["x"], "y": end["y"], "dt": 0})
    return points


for line in sys.stdin:
    request = None
    try:
        request = json.loads(line)
        reply = {"id": request["id"], "points": path(request["from"], request["to"]), "pressMs": random.randint(60, 110)}
    except Exception as error:  # report, never crash the loop
        reply = {"id": request.get("id") if isinstance(request, dict) else None, "error": str(error)}
    print(json.dumps(reply), flush=True)
