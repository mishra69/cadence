#!/usr/bin/env python3
"""Generate Cadence's icons as PNGs with no third-party deps.

Abstract by requirement (plan §0): five bars in a rising-and-falling rhythm,
vertically centred. No lettering, no glyph that hints at what the app tracks,
nothing that reads as anything but a generic utility on a home screen.

Bars are the right shape here because this encoder can only fill rectangles —
no anti-aliasing, so curves and diagonals would come out visibly stepped at
180px, which is the size that actually matters.

Backgrounds are fully opaque: iOS renders alpha in an apple-touch-icon as black.
"""
import struct
import zlib
import os

BG     = (32, 38, 56)      # #202638 — deep slate, calm and unremarkable
BAR    = (232, 236, 245)   # #e8ecf5
ACCENT = (124, 156, 245)   # #7c9cf5 — one bar picked out, so it reads as rhythm

# Relative bar heights. Deliberately not symmetric: a symmetric set reads as a
# signal-strength meter, which looks like a system icon.
HEIGHTS = [0.42, 0.72, 1.00, 0.62, 0.34]
ACCENT_INDEX = 2

OUT = os.environ.get('ICON_OUT', os.path.join(os.path.dirname(__file__), '..', 'frontend', 'icons'))


class Canvas:
    def __init__(self, size, bg):
        self.size = size
        self.px = bytearray(bytes(bg) * (size * size))

    def rect(self, x0, y0, x1, y1, color):
        x0, y0 = max(0, int(round(x0))), max(0, int(round(y0)))
        x1, y1 = min(self.size, int(round(x1))), min(self.size, int(round(y1)))
        if x1 <= x0 or y1 <= y0:
            return
        row = bytes(color) * (x1 - x0)
        for y in range(y0, y1):
            start = (y * self.size + x0) * 3
            self.px[start:start + len(row)] = row

    def png(self, path):
        raw = bytearray()
        stride = self.size * 3
        for y in range(self.size):
            raw.append(0)  # filter: none
            raw.extend(self.px[y * stride:(y + 1) * stride])

        def chunk(tag, data):
            out = struct.pack('>I', len(data)) + tag + data
            return out + struct.pack('>I', zlib.crc32(tag + data) & 0xFFFFFFFF)

        ihdr = struct.pack('>IIBBBBB', self.size, self.size, 8, 2, 0, 0, 0)
        blob = (b'\x89PNG\r\n\x1a\n'
                + chunk(b'IHDR', ihdr)
                + chunk(b'IDAT', zlib.compress(bytes(raw), 9))
                + chunk(b'IEND', b''))
        with open(path, 'wb') as f:
            f.write(blob)


def draw(size, pad_frac):
    c = Canvas(size, BG)
    pad = size * pad_frac
    inner = size - 2 * pad
    n = len(HEIGHTS)

    # Gap is a fixed fraction of bar pitch, so proportions hold at every size.
    pitch = inner / n
    bar_w = pitch * 0.56
    mid_y = size / 2.0

    for i, h in enumerate(HEIGHTS):
        x = pad + i * pitch + (pitch - bar_w) / 2.0
        bar_h = inner * h
        color = ACCENT if i == ACCENT_INDEX else BAR
        c.rect(x, mid_y - bar_h / 2.0, x + bar_w, mid_y + bar_h / 2.0, color)
    return c


OUT = os.path.abspath(OUT)
os.makedirs(OUT, exist_ok=True)
# apple-touch-icon: iOS squircle-crops the corners, so keep content inset.
draw(180, 0.14).png(os.path.join(OUT, 'apple-touch-icon.png'))
draw(192, 0.14).png(os.path.join(OUT, 'icon-192.png'))
draw(512, 0.14).png(os.path.join(OUT, 'icon-512.png'))
# maskable: the safe zone is the middle 80%, so pad harder.
draw(512, 0.24).png(os.path.join(OUT, 'icon-maskable-512.png'))

for f in sorted(os.listdir(OUT)):
    print(f, os.path.getsize(os.path.join(OUT, f)), 'bytes')
