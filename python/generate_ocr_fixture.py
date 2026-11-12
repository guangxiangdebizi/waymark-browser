from PIL import Image, ImageDraw, ImageFont
from pathlib import Path

output = Path('data/ocr-smoke.png')
output.parent.mkdir(parents=True, exist_ok=True)
image = Image.new('RGB', (220, 70), 'white')
draw = ImageDraw.Draw(image)
try:
    font = ImageFont.truetype('arial.ttf', 42)
except OSError:
    font = ImageFont.load_default()
draw.text((18, 10), 'A7B2', fill='black', font=font)
image.save(output)
print(output)
