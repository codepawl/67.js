"""Labels the jelly bounce preview and builds its contact sheet.

Usage: uv run --no-project --with pillow python scripts/label-jelly-bounce.py <output directory>
Reads jelly-bounce.mp4, the stills and jelly-bounce.json written by render-jelly-bounce.mjs, burns a label under each cube
(its name, named colour and measured dent and rebound), relabels the stills, writes soft-dent-full.png and sheet.jpg
(three columns by two rows of frames with frame numbers and which colour is which cube).
"""
import json
import subprocess
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

WIDTH, HEIGHT = 960, 540
COLUMN_CENTERS = {"firm": 197, "medium": 480, "soft": 763}
CHIP_COLORS = {"blue": (38, 115, 242), "orange": (240, 90, 10), "pink": (217, 31, 115)}
FONT_PATH = "C:/Windows/Fonts/segoeuib.ttf"


def font(size):
    return ImageFont.truetype(FONT_PATH, size)


def build_overlay(summary):
    overlay = Image.new("RGBA", (WIDTH, HEIGHT), (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)
    for cube_id, center in COLUMN_CENTERS.items():
        cube = summary["cubes"][cube_id]
        title = f"{cube_id.upper()}"
        lines = [f"{cube['colorName']} cube", f"dent {cube['dentMeters'] * 100:.1f} cm", f"rebound {cube['reboundMeters'] * 100:.0f} cm"]
        left, right = center - 100, center + 100
        draw.rounded_rectangle([left, 426, right, 526], radius=10, fill=(20, 24, 32, 215))
        draw.ellipse([left + 12, 435, left + 30, 453], fill=CHIP_COLORS[cube["colorName"]] + (255,))
        draw.text((left + 40, 428), title, font=font(26), fill=(255, 255, 255, 255))
        for index, line in enumerate(lines):
            draw.text((left + 14, 458 + index * 21), line, font=font(18), fill=(215, 220, 230, 255))
    return overlay


def run(command):
    subprocess.run(command, check=True, capture_output=True)


def main():
    output = Path(sys.argv[1])
    summary = json.loads((output / "jelly-bounce.json").read_text())
    overlay_path = output / "labels-overlay.png"
    overlay = build_overlay(summary)
    overlay.save(overlay_path)
    raw_video = output / "jelly-bounce-raw.mp4"
    labelled_video = output / "jelly-bounce.mp4"
    labelled_video.replace(raw_video)
    run(["ffmpeg", "-y", "-i", str(raw_video), "-i", str(overlay_path), "-filter_complex", "overlay=0:0", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18", "-r", "60", str(labelled_video)])
    for name in summary["files"].values():
        if name.endswith(".png"):
            still = Image.open(output / name).convert("RGBA")
            still.alpha_composite(overlay)
            still.convert("RGB").save(output / name)
    cubes = summary["cubes"]
    picks = [
        ("falling", 36),
        ("contact", cubes["soft"]["contactStep"]),
        ("deepest dent (soft)", cubes["soft"]["deepestDentStep"]),
        ("firm rebound top", cubes["firm"]["reboundTopStep"]),
        ("soft rebound top", cubes["soft"]["reboundTopStep"]),
        ("end", 239),
    ]
    frames = []
    for label, step in picks:
        frame_path = output / f"sheet-frame-{step}.png"
        run(["ffmpeg", "-y", "-i", str(labelled_video), "-vf", f"select=eq(n\\,{step})", "-vframes", "1", str(frame_path)])
        image = Image.open(frame_path).convert("RGB")
        image.load()
        frames.append((label, step, image))
        if label.startswith("deepest"):
            image.save(output / "soft-dent-full.png")
        frame_path.unlink()
    cell_width, cell_height, header = 640, 360, 96
    sheet = Image.new("RGB", (cell_width * 3, (cell_height + 34) * 2 + header), (18, 20, 26))
    draw = ImageDraw.Draw(sheet)
    draw.text((16, 10), "Jelly bounce, 960x540 60 fps. Same drop from 1.95 m. Frame number = step at 60 per second.", font=font(24), fill=(255, 255, 255))
    key_x = 16
    for cube_id in ("firm", "medium", "soft"):
        cube = cubes[cube_id]
        draw.ellipse([key_x, 54, key_x + 22, 76], fill=CHIP_COLORS[cube["colorName"]])
        text = f"{cube['colorName']} = {cube_id}: shape {cube['shape']}, bounce {cube['bounce']}, stiffness {cube.get('stiffness', 0.9)}"
        draw.text((key_x + 30, 52), text, font=font(20), fill=(230, 232, 238))
        key_x += 30 + int(draw.textlength(text, font=font(20))) + 40
    for index, (label, step, image) in enumerate(frames):
        column, row = index % 3, index // 3
        left, top = column * cell_width, header + row * (cell_height + 34)
        sheet.paste(image.resize((cell_width, cell_height), Image.LANCZOS), (left, top + 34))
        draw.text((left + 10, top + 4), f"frame {step}: {label}", font=font(22), fill=(255, 220, 120))
    sheet.save(output / "sheet.jpg", quality=88)
    print("sheet", output / "sheet.jpg")


main()
