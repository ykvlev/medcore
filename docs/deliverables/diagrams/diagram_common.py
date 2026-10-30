# -*- coding: utf-8 -*-
"""Общие примитивы для диаграмм MEDCORE (matplotlib, 300 dpi).

Система координат: 1 единица = 0.01 дюйма, поэтому кадр 1650 x 1170
соответствует листу A3 в альбомной ориентации.
"""
from __future__ import annotations

import math
from functools import lru_cache
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.font_manager import FontProperties
from matplotlib.patches import Circle, FancyBboxPatch, Polygon, Rectangle
from matplotlib.textpath import TextPath

FONT = "DejaVu Sans"
MONO = "DejaVu Sans Mono"
UNITS_PER_POINT = 100.0 / 72.0

INK = "#1c1c1c"
MUTED = "#4d555c"
SOFT = "#6b747c"
RULE = "#aab3ba"
WHITE = "#ffffff"

BLUE = "#2f5d8a"
BLUE_L = "#eaf1f8"
BLUE_LL = "#f5f9fc"
TEAL = "#26736b"
TEAL_L = "#e7f3f1"
GREEN = "#3f7048"
GREEN_L = "#ecf4ed"
AMBER = "#8a6418"
AMBER_L = "#fbf3e1"
PURPLE = "#5d4a7e"
PURPLE_L = "#f0ecf7"
RED = "#8a3b3b"
RED_L = "#f8ecec"
GRAY = "#55606a"
GRAY_L = "#f1f3f5"
BROWN = "#6b4a2f"
BROWN_L = "#f6eee7"


def canvas(width: int, height: int):
    """Создать лист width x height (единицы 0.01 дюйма) с белым фоном."""
    fig = plt.figure(figsize=(width / 100.0, height / 100.0), dpi=300)
    fig.patch.set_facecolor(WHITE)
    ax = fig.add_axes([0, 0, 1, 1])
    ax.set_xlim(0, width)
    ax.set_ylim(0, height)
    ax.set_axis_off()
    ax.set_facecolor(WHITE)
    return fig, ax


def header(ax, width, height, title, subtitle, sheet, total=7, eyebrow="MEDCORE · Приложение А"):
    txt(ax, 42, height - 44, eyebrow, 9.5, color=MUTED, ha="left")
    txt(ax, 42, height - 84, title, 21, color=INK, weight="bold", ha="left")
    txt(ax, 42, height - 119, subtitle, 10.5, color=MUTED, ha="left")
    ax.plot([42, width - 42], [height - 142, height - 142], color=RULE, lw=0.9, zorder=2)
    txt(ax, width - 42, 28, f"Лист {sheet} из {total}", 9, color=MUTED, ha="right")
    txt(ax, 42, 28, "Диаграммы по ТЗ MEDCORE, разделы 14.1–14.7", 9, color=MUTED, ha="left")


@lru_cache(maxsize=8192)
def _text_width_units(s: str, size: float, weight: str = "normal") -> float:
    if not s:
        return 0.0
    tp = TextPath((0, 0), s, size=size, prop=FontProperties(family=FONT, weight=weight))
    return float(tp.get_extents().width) * UNITS_PER_POINT


def wrap_text(s: str, max_width: float, size: float, weight: str = "normal") -> list[str]:
    """Перенос по словам с измерением реальной ширины строки."""
    s = " ".join(str(s).split())
    if not s:
        return [""]
    if _text_width_units(s, size, weight) <= max_width:
        return [s]
    words = s.split(" ")
    lines: list[str] = []
    current = ""
    for word in words:
        candidate = word if not current else current + " " + word
        if _text_width_units(candidate, size, weight) <= max_width:
            current = candidate
            continue
        if current:
            lines.append(current)
            current = word
        else:
            # Очень длинное слово: режем по символам.
            piece = ""
            for ch in word:
                if _text_width_units(piece + ch, size, weight) <= max_width:
                    piece += ch
                else:
                    if piece:
                        lines.append(piece)
                    piece = ch
            current = piece
    if current:
        lines.append(current)
    return lines


def fit_text(s: str, max_width: float, max_lines: int, sizes):
    """Подобрать размер шрифта так, чтобы текст уложился в max_lines строк."""
    for size in sizes:
        lines = wrap_text(s, max_width, size)
        if len(lines) <= max_lines:
            return size, lines
    size = sizes[-1]
    return size, wrap_text(s, max_width, size)


def txt(ax, x, y, s, size=10, color=INK, weight="normal", ha="center", va="center",
        style="normal", rotation=0, z=6, bbox=None, linespacing=1.13, alpha=1.0,
        family=FONT):
    return ax.text(x, y, str(s), fontsize=size, color=color, fontweight=weight,
                   ha=ha, va=va, fontstyle=style, rotation=rotation,
                   zorder=z, bbox=bbox, linespacing=linespacing, alpha=alpha,
                   family=family)


def label(ax, x, y, s, size=8.4, color=MUTED, ha="center", va="center",
          rotation=0, weight="normal", z=7, pad=0.18):
    return txt(ax, x, y, s, size=size, color=color, ha=ha, va=va, rotation=rotation,
               weight=weight, z=z,
               bbox=dict(boxstyle=f"round,pad={pad}", fc=WHITE, ec="none", alpha=0.94))


def block(ax, x, y, w, h, fc=WHITE, ec=INK, lw=1.0, ls="-", z=3, rounding=6, alpha=1.0):
    patch = FancyBboxPatch((x, y), w, h,
                           boxstyle=f"round,pad=0,rounding_size={rounding}",
                           linewidth=lw, edgecolor=ec, facecolor=fc, zorder=z,
                           linestyle=ls, alpha=alpha)
    ax.add_patch(patch)
    return patch


def panel(ax, x, y, w, h, title, fc=GRAY_L, ec=RULE, title_color=INK,
          subtitle=None, rounding=10, z=1, lw=1.0, title_size=10):
    block(ax, x, y, w, h, fc=fc, ec=ec, lw=lw, z=z, rounding=rounding)
    txt(ax, x + 14, y + h - 18, title, title_size, title_color, weight="bold", ha="left", z=z + 1)
    if subtitle:
        txt(ax, x + 14, y + h - 36, subtitle, 8.2, SOFT, ha="left", z=z + 1)


def line(ax, pts, color=INK, lw=1.0, ls="-", z=4, alpha=1.0):
    if len(pts) < 2:
        return
    ax.plot([p[0] for p in pts], [p[1] for p in pts], color=color, lw=lw, ls=ls,
            zorder=z, alpha=alpha, solid_capstyle="butt", solid_joinstyle="miter",
            dash_capstyle="butt")


def arrowhead(ax, tip, direction, color=INK, length=12.0, width=6.0, z=6):
    dx, dy = direction
    norm = math.hypot(dx, dy)
    if norm == 0:
        return
    ux, uy = dx / norm, dy / norm
    px, py = -uy, ux
    base = (tip[0] - ux * length, tip[1] - uy * length)
    left = (base[0] + px * width / 2, base[1] + py * width / 2)
    right = (base[0] - px * width / 2, base[1] - py * width / 2)
    ax.add_patch(Polygon([tip, left, right], closed=True, facecolor=color,
                         edgecolor=color, lw=0.3, zorder=z))


def arrow(ax, pts, color=INK, lw=1.1, ls="-", head=12.0, head_w=6.0, z=5, alpha=1.0):
    pts = [(float(p[0]), float(p[1])) for p in pts]
    line(ax, pts, color=color, lw=lw, ls=ls, z=z, alpha=alpha)
    if len(pts) >= 2:
        arrowhead(ax, pts[-1], (pts[-1][0] - pts[-2][0], pts[-1][1] - pts[-2][1]),
                  color=color, length=head, width=head_w, z=z + 1)


def dot(ax, p, color=INK, r=4.0, z=7):
    ax.add_patch(Circle(p, r, facecolor=color, edgecolor=color, lw=0.4, zorder=z))


def open_dot(ax, p, color=INK, r=5.0, z=7):
    ax.add_patch(Circle(p, r, facecolor=WHITE, edgecolor=color, lw=1.0, zorder=z))


def tick(ax, p, direction, color=INK, length=13.0, z=6):
    dx, dy = direction
    norm = math.hypot(dx, dy) or 1.0
    px, py = -dy / norm, dx / norm
    c = (p[0] - dx / norm * 7.0, p[1] - dy / norm * 7.0)
    line(ax, [(c[0] + px * length / 2, c[1] + py * length / 2),
              (c[0] - px * length / 2, c[1] - py * length / 2)], color=color, lw=1.2, z=z)


def crow(ax, p, direction, color=INK, size=14.0, spread=7.0, z=6):
    """«Воронья лапка»: много на конце линии, направление — внутрь сущности."""
    dx, dy = direction
    norm = math.hypot(dx, dy) or 1.0
    ux, uy = dx / norm, dy / norm
    px, py = -uy, ux
    base = (p[0] - ux * size, p[1] - uy * size)
    line(ax, [p, base], color=color, lw=1.0, z=z)
    line(ax, [p, (base[0] + px * spread, base[1] + py * spread)], color=color, lw=1.0, z=z)
    line(ax, [p, (base[0] - px * spread, base[1] - py * spread)], color=color, lw=1.0, z=z)


def cardinality(ax, p, direction, text, color=MUTED, size=7.6, z=7, offset=13.0):
    dx, dy = direction
    norm = math.hypot(dx, dy) or 1.0
    px, py = -dy / norm, dx / norm
    q = (p[0] + dx / norm * offset + px * 9.0, p[1] + dy / norm * offset + py * 9.0)
    label(ax, q[0], q[1], text, size=size, color=color, z=z, pad=0.1)


def er_link(ax, pts, color=INK, parent="1", child="N", label_text=None,
            lw=1.0, z=4, both_many=False, ls="-"):
    pts = [(float(p[0]), float(p[1])) for p in pts]
    line(ax, pts, color=color, lw=lw, ls=ls, z=z)
    p0, p1 = pts[0], pts[1]
    pn, pprev = pts[-1], pts[-2]
    if parent:
        d0 = (p1[0] - p0[0], p1[1] - p0[1])
        tick(ax, p0, d0, color=color, length=12, z=z + 1)
        cardinality(ax, p0, d0, parent, color=color)
    dc = (pn[0] - pprev[0], pn[1] - pprev[1])
    crow(ax, pn, dc, color=color, size=12, spread=6, z=z + 1)
    cardinality(ax, pn, dc, child, color=color)
    if both_many:
        crow(ax, p0, (p0[0] - p1[0], p0[1] - p1[1]), color=color, size=12, spread=6, z=z + 1)
    if label_text:
        # подпись на самом длинном сегменте
        seg = max(zip(pts[:-1], pts[1:]), key=lambda s: math.dist(s[0], s[1]))
        mx, my = (seg[0][0] + seg[1][0]) / 2, (seg[0][1] + seg[1][1]) / 2
        label(ax, mx, my, label_text, size=7.4, color=color, z=z + 2)


def legend_swatch(ax, x, y, w, h, fc, ec, text, size=8.4, dashed=False):
    block(ax, x, y, w, h, fc=fc, ec=ec, lw=1.0, ls="--" if dashed else "-", z=5, rounding=3)
    txt(ax, x + w + 8, y + h / 2, text, size, INK, ha="left")


def save(fig, path: Path):
    path.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(path, dpi=300, facecolor=WHITE, edgecolor=WHITE,
                bbox_inches=None, pad_inches=0)
    plt.close(fig)


def check_bounds(fig, ax, name):
    """Проверить, что ни одна подпись не выходит за пределы листа."""
    fig.canvas.draw()
    renderer = fig.canvas.get_renderer()
    fw, fh = fig.bbox.width, fig.bbox.height
    bad = []
    for t in ax.texts:
        if not t.get_text().strip():
            continue
        bb = t.get_window_extent(renderer)
        if bb.x0 < -0.5 or bb.y0 < -0.5 or bb.x1 > fw + 0.5 or bb.y1 > fh + 0.5:
            bad.append((t.get_text()[:60], round(bb.x0, 1), round(bb.y0, 1),
                        round(bb.x1, 1), round(bb.y1, 1)))
    if bad:
        print(f"[{name}] ВНИМАНИЕ: подписи вне листа: {len(bad)}")
        for item in bad[:12]:
            print("   ", item)
    else:
        print(f"[{name}] все подписи внутри листа")
