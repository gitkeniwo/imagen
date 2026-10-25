#!/usr/bin/env python3
"""Generate the menubar template icons (concept D · Frame + banana).

The 16x16 bitmaps below are the design source of truth (docs/design/menubar/,
§3.1 of the menubar plan). Every icon is built the same way:

  1. compose the base grid, optional hollow pass, optional badge (bottom-right,
     with a 1 px expanded knockout);
  2. pad 1 px of transparency around it -> 18x18;
  3. nearest-neighbour 2x -> 36x36 PNG, black + alpha (a macOS template image).

Output: desktop/src-tauri/icons/tray/. Run from the repo root:

    uv run --project backend python desktop/scripts/gen_tray_icons.py

Pillow comes with the backend venv; nothing else is required.
"""
from __future__ import annotations

import argparse
from pathlib import Path

from PIL import Image

BASE = [
    "................",
    "................",
    ".##############.",
    "#..............#",
    "#...........#..#",
    "#..........##..#",
    "#..........###.#",
    "#.........####.#",
    "#........#####.#",
    "#..#....#####..#",
    "#..##..######..#",
    "#...########...#",
    "#....######....#",
    "#.....###......#",
    ".##############.",
    "................",
]

BADGES = {
    "dot": [".###.", "#####", "#####", "#####", ".###."],
    "unlock": [".###.", ".#...", ".#...", "#####", "##.##", "#####"],
    "cross": ["#...#", ".#.#.", "..#..", ".#.#.", "#...#"],
}

DIM_ALPHA = 0.35
SCALE = 2
PAD = 1


def grid(rows: list[str]) -> list[list[bool]]:
    return [[c == "#" for c in row] for row in rows]


def hollow(g: list[list[bool]]) -> list[list[bool]]:
    """Keep only pixels with at least one empty 4-neighbour (out of bounds is
    empty). A 1 px frame stays a frame; the banana becomes an outline."""
    def on(y: int, x: int) -> bool:
        return 0 <= y < 16 and 0 <= x < 16 and g[y][x]

    return [
        [
            on(y, x)
            and not (on(y - 1, x) and on(y + 1, x) and on(y, x - 1) and on(y, x + 1))
            for x in range(16)
        ]
        for y in range(16)
    ]


def compose(badge: str | None, use_hollow: bool) -> list[list[bool]]:
    g = grid(BASE)
    if use_hollow:
        g = hollow(g)
    if badge:
        b = BADGES[badge]
        h, w = len(b), len(b[0])
        ox, oy = 16 - w, 16 - h
        # Knockout: clear one extra pixel around the badge, then draw it.
        for y in range(max(0, oy - 1), 16):
            for x in range(max(0, ox - 1), 16):
                g[y][x] = False
        for yy, row in enumerate(b):
            for xx, c in enumerate(row):
                if c == "#":
                    g[oy + yy][ox + xx] = True
    return g


def knockout_only(badge: str) -> list[list[bool]]:
    """The badge's knockout with no pixels drawn (generating frame B)."""
    g = grid(BASE)
    b = BADGES[badge]
    h, w = len(b), len(b[0])
    ox, oy = 16 - w, 16 - h
    for y in range(max(0, oy - 1), 16):
        for x in range(max(0, ox - 1), 16):
            g[y][x] = False
    return g


def render(g: list[list[bool]], dim: bool = False) -> Image.Image:
    alpha = round(255 * DIM_ALPHA) if dim else 255
    side = 16 + 2 * PAD
    img = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    for y in range(16):
        for x in range(16):
            if g[y][x]:
                img.putpixel((x + PAD, y + PAD), (0, 0, 0, alpha))
    return img.resize(
        (side * SCALE, side * SCALE), resample=Image.Resampling.NEAREST
    )


def icons() -> dict[str, Image.Image]:
    return {
        "off.png": render(grid(BASE), dim=True),
        "idle.png": render(grid(BASE)),
        "active.png": render(compose("dot", False)),
        "generating-b.png": render(knockout_only("dot")),
        "no-code.png": render(compose("unlock", False)),
        "blocked.png": render(compose("cross", False)),
        "stopped.png": render(compose(None, True)),
    }


def main() -> int:
    root = Path(__file__).resolve().parents[2]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--out",
        type=Path,
        default=root / "desktop/src-tauri/icons/tray",
        help="output directory (default: desktop/src-tauri/icons/tray)",
    )
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    for name, img in icons().items():
        path = args.out / name
        img.save(path, format="PNG", optimize=True)
        print(f"wrote {path.relative_to(root)} ({img.width}x{img.height})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
