# -*- coding: utf-8 -*-
"""IDEF0 A-0: контекстная функция «Управлять медицинской информацией организаций города»."""
from pathlib import Path

from diagram_common import (AMBER, AMBER_L, BLUE, BLUE_L, GREEN, GREEN_L, INK,
                            MUTED, PURPLE, PURPLE_L, RED, RULE, TEAL, WHITE, arrow,
                            block, canvas, check_bounds, header, label, save, txt)

W, H = 1650, 1170
OUT = Path(__file__).with_name("idef0_a_minus_0.png")

fig, ax = canvas(W, H)
header(ax, W, H,
       "Функциональная модель IDEF0. Контекстная диаграмма A-0",
       "Управлять медицинской информацией организаций города · по разделу 14.1 ТЗ",
       sheet=1, total=6)

# Центральная функция
fx, fy, fw, fh = 610, 450, 420, 310
block(ax, fx, fy, fw, fh, fc="#fbfcfd", ec=INK, lw=2.0, rounding=2, z=4)
txt(ax, fx + fw / 2, fy + fh / 2 + 18,
    "Управлять медицинской\nинформацией\nорганизаций города",
    18, INK, weight="bold", linespacing=1.18)
txt(ax, fx + fw / 2, fy + 40, "Контекстная функция", 9.5, MUTED, style="italic")
txt(ax, fx + fw - 18, fy + 16, "A-0", 15, INK, weight="bold", ha="right")

# Входы
inputs = [
    ("Сведения о пациентах", 720, BLUE),
    ("Сведения о персонале", 650, TEAL),
    ("Медицинские обращения", 580, GREEN),
    ("Результаты исследований", 510, PURPLE),
]
for text, y, color in inputs:
    arrow(ax, [(340, y), (fx, y)], color=color, lw=1.4, head=13, head_w=7)
    label(ax, 340, y + 22, text, size=10.2, color=color, ha="left", weight="bold")

# Управления
controls = [
    ("Правила\nпредметной области", 675, AMBER),
    ("Политики\nдоступа", 810, RED),
    ("Регламенты\nобработки данных", 945, AMBER),
]
for text, x, color in controls:
    arrow(ax, [(x, 925), (x, fy + fh)], color=color, lw=1.4, head=13, head_w=7)
    label(ax, x, 955, text, size=9.6, color=color, weight="bold")

# Механизмы
mechanisms = [
    ("Пользователи", 665),
    ("MEDCORE", 790),
    ("PostgreSQL", 900),
    ("Сервер\nприложения", 1005),
]
for text, x in mechanisms:
    arrow(ax, [(x, 330), (x, fy)], color=MUTED, lw=1.3, head=13, head_w=7)
    label(ax, x, 300, text, size=9.6, color=INK, weight="bold")

# Выходы
outputs = [
    ("Обновлённые\nмедицинские записи", 720, BLUE),
    ("Отчёты", 650, AMBER),
    ("Результаты поиска", 580, TEAL),
    ("Статистика", 510, GREEN),
]
for text, y, color in outputs:
    arrow(ax, [(fx + fw, y), (1320, y)], color=color, lw=1.4, head=13, head_w=7)
    label(ax, 1330, y, text, size=10.0, color=color, ha="left", weight="bold")

# Пояснение к нотации
block(ax, 55, 55, 470, 150, fc="#f7f9fb", ec=RULE, lw=0.9, rounding=5, z=3)
txt(ax, 75, 178, "Нотация IDEF0", 10.5, INK, weight="bold", ha="left")
txt(ax, 75, 150, "Слева — входы, сверху — управления,", 9.2, MUTED, ha="left")
txt(ax, 75, 130, "снизу — механизмы, справа — выходы.", 9.2, MUTED, ha="left")
txt(ax, 75, 98, "A-0 — верхний уровень модели;", 9.2, MUTED, ha="left")
txt(ax, 75, 78, "декомпозиция A1–A6 — на листе 2.", 9.2, MUTED, ha="left")

# Рамка поля диаграммы
block(ax, 45, 215, W - 90, 805, fc="none", ec=RULE, lw=0.8, rounding=0, z=2)

check_bounds(fig, ax, "IDEF0 A-0")
save(fig, OUT)
print("saved", OUT)

