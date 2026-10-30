# -*- coding: utf-8 -*-
"""IDEF0 A0: декомпозиция контекстной функции на процессы A1–A6."""
from pathlib import Path

from diagram_common import (AMBER, BLUE, BLUE_L, GREEN, GREEN_L, INK, MUTED,
                            PURPLE, PURPLE_L, RULE, TEAL, TEAL_L, WHITE, arrow,
                            block, canvas, check_bounds, fit_text, header, label,
                            save, txt, wrap_text)

W, H = 1650, 1170
OUT = Path(__file__).with_name("idef0_a0.png")

fig, ax = canvas(W, H)
header(ax, W, H,
       "Функциональная модель IDEF0. Декомпозиция A0",
       "Процессы A1–A6: организации, персонал, пациенты, лечение, лаборатории, отчётность",
       sheet=2, total=6)

block(ax, 45, 80, W - 90, 940, fc="none", ec=RULE, lw=0.8, rounding=0, z=1)

# --- Блоки процессов -------------------------------------------------------
def process(x, y, w, h, node, title, subtitle, fc, ec, title_size=10.6):
    block(ax, x, y, w, h, fc=fc, ec=ec, lw=1.35, rounding=2, z=3)
    size, lines = fit_text(title, w - 26, 2, [title_size, title_size - 0.6, title_size - 1.2, 9.4])
    txt(ax, x + w / 2, y + h * 0.62, "\n".join(lines), size, INK, weight="bold")
    if subtitle:
        ssize, slines = fit_text(subtitle, w - 24, 2, [8.5, 8.0, 7.5])
        txt(ax, x + w / 2, y + h * 0.24, "\n".join(slines), ssize, MUTED)
    txt(ax, x + w - 9, y + 11, node, 11.5, ec, weight="bold", ha="right")


process(210, 760, 270, 110, "A1", "Управление организациями",
        "учреждения, корпуса, отделения,\nпалаты, койки", BLUE_L, BLUE, 11.0)
process(520, 760, 270, 110, "A2", "Управление персоналом",
        "сотрудники, врачи, специальности,\nтрудоустройство", TEAL_L, TEAL, 11.0)
process(830, 760, 270, 110, "A3", "Учёт пациентов",
        "карточки, прикрепление,\nпоиск, обращения", GREEN_L, GREEN, 11.0)
process(210, 360, 420, 140, "A4", "Управление лечебными процессами",
        "случаи, приёмы, направления,\nгоспитализации, операции", "#fdf6ea", AMBER, 11.6)
process(680, 360, 270, 140, "A5", "Лабораторные исследования",
        "заказы, договоры,\nрезультаты", PURPLE_L, PURPLE, 11.0)

# A6 высокий: заголовок, подзаголовок и перечень отчётов
ax6 = (1120, 380, 370, 520)
block(ax, *ax6[:2], ax6[2], ax6[3], fc="#f8f9fa", ec="#5a5a5a", lw=1.35, rounding=2, z=3)
txt(ax, 1305, 810, "Формирование\nотчётности", 13.2, INK, weight="bold", linespacing=1.15)
txt(ax, 1305, 738, "шесть отчётов за период,\nэкспорт CSV и PDF", 8.8, MUTED)
txt(ax, 1477, 391, "A6", 11.5, "#5a5a5a", weight="bold", ha="right")
block(ax, 1142, 425, 326, 185, fc=WHITE, ec="#c9cdd1", lw=0.8, rounding=3, z=4)
txt(ax, 1305, 585, "Отчёты (REP-01)", 8.8, MUTED, weight="bold")
txt(ax, 1305, 520, "коечный фонд · пациенты\nгоспитализации · врачи\nоперации · исследования",
    8.4, INK, linespacing=1.28)

# --- Управления ------------------------------------------------------------
ax.plot([120, 1470], [980, 980], color=AMBER, lw=1.2, zorder=4)
for x, text in [(345, "Правила предметной области"),
                (800, "Политики доступа"),
                (1310, "Регламенты обработки данных")]:
    label(ax, x, 1001, text, size=9.2, color=AMBER, weight="bold")

for x in (345, 655, 965):
    arrow(ax, [(x, 980), (x, 870)], color=AMBER, lw=1.2)
arrow(ax, [(120, 980), (60, 980), (60, 540), (260, 540), (260, 500)],
      color=AMBER, lw=1.2)
arrow(ax, [(820, 980), (820, 500)], color=AMBER, lw=1.2)
arrow(ax, [(1390, 980), (1390, 900)], color=AMBER, lw=1.2)

# --- Механизмы -------------------------------------------------------------
ax.plot([60, 1390], [150, 150], color=MUTED, lw=1.2, zorder=4)
for x, text in [(270, "Пользователи"), (620, "MEDCORE"),
                (970, "PostgreSQL"), (1300, "Сервер приложения")]:
    label(ax, x, 112, text, size=9.2, color=INK, weight="bold")

for x, y in [(310, 360), (655, 760), (820, 360), (965, 760), (1300, 380)]:
    arrow(ax, [(x, 150), (x, y)], color=MUTED, lw=1.1)
arrow(ax, [(60, 150), (60, 700), (345, 700), (345, 760)], color=MUTED, lw=1.1)

# --- Входы -----------------------------------------------------------------
arrow(ax, [(45, 940), (800, 940), (800, 780), (830, 780)], color=BLUE, lw=1.4)
label(ax, 55, 960, "Сведения о пациентах", size=9.6, color=BLUE, weight="bold", ha="left")

arrow(ax, [(45, 820), (210, 820)], color=TEAL, lw=1.4)
arrow(ax, [(70, 820), (70, 905), (500, 905), (500, 800), (520, 800)],
      color=TEAL, lw=1.2)
label(ax, 52, 846, "Сведения\nо персонале", size=9.2, color=TEAL, weight="bold", ha="left")

arrow(ax, [(45, 450), (210, 450)], color=GREEN, lw=1.4)
arrow(ax, [(60, 450), (60, 600), (805, 600), (805, 780), (830, 780)],
      color=GREEN, lw=1.2)
label(ax, 52, 478, "Медицинские\nобращения", size=9.2, color=GREEN, weight="bold", ha="left")

arrow(ax, [(45, 400), (650, 400), (650, 430), (680, 430)], color=PURPLE, lw=1.4)
label(ax, 52, 420, "Результаты\nисследований", size=9.2, color=PURPLE, weight="bold", ha="left")

# --- Внутренние потоки -----------------------------------------------------
arrow(ax, [(345, 760), (345, 680), (310, 680), (310, 500)], color=BLUE, lw=1.2)
arrow(ax, [(655, 760), (655, 650), (410, 650), (410, 500)], color=TEAL, lw=1.2)
arrow(ax, [(965, 760), (965, 620), (540, 620), (540, 500)], color=GREEN, lw=1.2)
label(ax, 600, 700, "сведения об учреждениях,\nкадрах и пациентах", size=8.2, color=MUTED)

arrow(ax, [(630, 480), (680, 480)], color=AMBER, lw=1.3)
label(ax, 655, 502, "заказ", size=8.0, color=AMBER)
arrow(ax, [(680, 420), (630, 420)], color=PURPLE, lw=1.3)

arrow(ax, [(950, 430), (1120, 430)], color=PURPLE, lw=1.3)
label(ax, 1035, 452, "результаты", size=8.2, color=PURPLE)
arrow(ax, [(510, 360), (510, 270), (1300, 270), (1300, 380)], color=AMBER, lw=1.3)
label(ax, 800, 248, "данные о лечении и коечном фонде", size=8.4, color=AMBER)

# --- Выходы ---------------------------------------------------------------
arrow(ax, [(450, 360), (450, 220), (1600, 220)], color=AMBER, lw=1.4)
label(ax, 930, 198, "Обновлённые медицинские записи", size=9.2, color=AMBER, weight="bold")

arrow(ax, [(1100, 820), (1110, 820), (1110, 930), (1600, 930)], color=GREEN, lw=1.4)
label(ax, 1260, 952, "Результаты поиска", size=9.2, color=GREEN, weight="bold")

for y, text, color in [(700, "Отчёты", "#5a5a5a"),
                       (610, "Статистика", "#5a5a5a"),
                       (520, "Экспорт CSV/PDF", "#5a5a5a")]:
    arrow(ax, [(1490, y), (1600, y)], color=color, lw=1.4)
    label(ax, 1545, y + 19, text, size=9.0, color=color, weight="bold")

# --- Пояснение ------------------------------------------------------------
block(ax, 1400, 92, 188, 104, fc="#f7f9fb", ec=RULE, lw=0.8, rounding=4, z=3)
txt(ax, 1412, 176, "IDEF0 A0", 9.4, INK, weight="bold", ha="left")
txt(ax, 1412, 152, "Декомпозиция A-0:", 8.0, MUTED, ha="left")
txt(ax, 1412, 132, "6 процессов;", 8.0, MUTED, ha="left")
txt(ax, 1412, 112, "стрелки — потоки.", 8.0, MUTED, ha="left")

check_bounds(fig, ax, "IDEF0 A0")
save(fig, OUT)
print("saved", OUT)

