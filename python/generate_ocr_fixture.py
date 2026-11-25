from PIL import Image, ImageDraw, ImageFont
from pathlib import Path

output = Path('data/ocr-smoke.png')
output.parent.mkdir(parents=True, exist_ok=True)
image = Image.new('RGB', (220, 70), 'white')
draw = ImageDraw.Draw(image)
font = None
# Arial on Windows and macOS; DejaVu Sans on most Linux systems (the default bitmap font is too small to read).
for name in ('arial.ttf', 'Arial.ttf', 'DejaVuSans.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', '/usr/share/fonts/dejavu/DejaVuSans.ttf'):
    try:
        font = ImageFont.truetype(name, 42)
        break
    except OSError:
        continue
font = font or ImageFont.load_default()
draw.text((18, 10), 'A7B2', fill='black', font=font)
image.save(output)
print(output)
