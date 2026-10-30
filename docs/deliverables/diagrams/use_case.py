# -*- coding: utf-8 -*-
"""Use Case: 11 ролей MEDCORE и маршруты API (001–005, api-contract + roles-and-icd)."""
from pathlib import Path

from matplotlib.patches import Circle, Ellipse

from diagram_common import (AMBER, BLUE, GREEN, INK, MUTED, PURPLE, RED, RULE,
                            SOFT, TEAL, WHITE, block as draw_block, canvas,
                            check_bounds, fit_text, header, line, save, txt)

W, H = 1650, 1170
OUT = Path(__file__).with_name("use_case.png")

fig, ax = canvas(W, H)
header(ax, W, H,
       "Диаграмма прецедентов Use Case",
       "11 ролей и 33 прецедента · маршруты API, МКБ-10 и области отделения",
       sheet=3, total=6)

bx, by, bw, bh = 210, 60, 1220, 950
draw_block(ax, bx, by, bw, bh, fc="#fcfdfe", ec=RULE, lw=0.9, rounding=4, z=1)
txt(ax, bx + 12, by + bh - 18, "MEDCORE · API /api · схема project", 8.2, MUTED,
    ha="left", z=2)

ROWS = [930, 810, 690, 570, 450, 330, 210]
COLS = [320, 550, 780, 1010, 1240]
EW, EH = 210, 96


def ellipse(cx, cy, state):
    ec = INK if state == "impl" else AMBER
    ls = "-" if state == "impl" else "--"
    ax.add_patch(Ellipse((cx, cy), EW, EH, facecolor=WHITE, edgecolor=ec,
                         linewidth=1.15, linestyle=ls, zorder=3))


# id, row, col, name, route, state, actors
CASES = [
    (1, 0, 0, "Войти в систему\nи завершить сессию", "POST /api/auth/login · /logout", "impl", ["base"]),
    (2, 0, 1, "Управлять\nпользователями", "GET/POST/PUT /api/admin/users", "contract", ["sys"]),
    (3, 0, 2, "Просматривать роли", "GET /api/admin/roles", "contract", ["sys"]),
    (4, 0, 3, "Просматривать\nжурнал аудита", "GET /api/admin/audit", "contract", ["sys"]),
    (5, 0, 4, "Просматривать\nорганизации", "GET /api/organizations", "impl", ["base", "minister", "governor"]),

    (6, 1, 0, "Просматривать\nсправочники", "GET /api/dictionaries", "contract", ["base"]),
    (7, 1, 1, "Создавать и изменять\nорганизацию", "POST/PUT /api/organizations", "contract", ["sys", "org"]),
    (8, 1, 2, "Настраивать структуру\nучреждения", "POST /api/hospitals/{id}/buildings …", "contract", ["sys", "org"]),
    (9, 1, 3, "Управлять персоналом\nи структурой больницы", "GET/POST/PUT /api/employees · /hospitals/…", "contract", ["chief"]),
    (10, 1, 4, "Вести карточки\nсотрудников", "GET/POST/PUT /api/employees", "contract", ["org"]),

    (11, 2, 0, "Назначать специальности\nи занятость", "POST /api/doctors/{id}/…", "contract", ["org"]),
    (12, 2, 1, "Искать пациентов", "GET /api/patients?search=", "impl", ["doctor", "registrar"]),
    (13, 2, 2, "Регистрировать\nпациента", "POST /api/patients", "impl", ["registrar"]),
    (14, 2, 3, "Изменять контакты\nпациента", "PUT /api/patients/{id}", "impl", ["registrar"]),
    (15, 2, 4, "Просматривать\nкарточку пациента", "GET /api/patients/{id}", "impl", ["doctor", "chief", "deputy", "head", "registrar"]),

    (16, 3, 0, "Добавлять диагноз", "POST /api/patients/{id}/diagnoses", "impl", ["doctor", "chief"]),
    (17, 3, 1, "История болезни\nс кодами МКБ", "GET /api/patients/{id} · history", "contract", ["doctor", "chief", "deputy", "head"]),
    (18, 3, 2, "Поиск по справочнику\nМКБ-10", "GET /api/diagnoses?search=", "contract", ["doctor", "chief", "deputy", "head"]),
    (19, 3, 3, "Выбор случая лечения", "caseId в /patients/{id}/diagnoses", "contract", ["doctor", "chief"]),
    (20, 3, 4, "Просматривать\nгоспитализации", "GET /api/hospitalizations", "impl", ["org", "doctor", "registrar", "chief", "deputy", "head"]),

    (21, 4, 0, "Просматривать\nсвободные койки", "GET /api/beds/available", "contract", ["org", "doctor", "registrar", "chief", "head"]),
    (22, 4, 1, "Оформлять\nгоспитализацию", "POST /api/hospitalizations", "contract", ["doctor", "chief"]),
    (23, 4, 2, "Переводить\nи выписывать", "PUT /transfer · POST /discharge", "contract", ["doctor", "chief"]),
    (24, 4, 3, "Создавать\nнаправление", "POST /api/referrals", "contract", ["doctor", "chief"]),
    (25, 4, 4, "Статистика отделения", "GET /api/reports/{kind}", "contract", ["head"]),

    (26, 5, 0, "Заказывать\nлабораторное исследование", "POST /api/lab-orders", "contract", ["doctor", "chief"]),
    (27, 5, 1, "Вводить результат\nисследования", "POST /api/lab-orders/{id}/results", "contract", ["lab"]),
    (28, 5, 2, "Просматривать\nлабораторные заказы", "GET /api/lab-orders", "contract", ["lab", "doctor"]),
    (29, 5, 3, "Просматривать\nлаборатории", "GET /api/laboratories/{id}", "contract", ["lab", "org", "doctor", "an"]),
    (30, 5, 4, "Формировать отчёт", "GET /api/reports/{kind}", "contract", ["org", "an", "chief", "deputy", "minister", "governor"]),

    (31, 6, 0, "Экспортировать отчёт", "GET /api/reports/{kind}/export", "contract", ["org", "an", "chief", "deputy"]),
    (32, 6, 1, "Просматривать\nдашборд", "GET /api/dashboard/summary", "impl", ["base", "chief", "deputy", "an"]),
    (33, 6, 2, "Сводные отчёты\nгорода и региона", "без ПДн · /api/reports/{kind}", "contract", ["minister", "governor"]),
]

ACTORS = {
    "base": dict(x=120, y=1000, name="Пользователь\nсистемы", code="все 11 ролей", color="#4f5963", abstract=True),
    "sys": dict(x=120, y=910, name="Администратор\nсистемы", code="system_admin", color=RED),
    "org": dict(x=120, y=820, name="Администратор\nорганизации", code="organization_admin", color=BLUE),
    "chief": dict(x=120, y=730, name="Главный врач", code="chief_physician", color="#8a3b3b"),
    "deputy": dict(x=120, y=640, name="Заместитель\nглавного врача", code="deputy_chief_physician", color="#a0522d"),
    "head": dict(x=120, y=550, name="Заведующий\nотделением", code="head_of_department", color="#6b4a2f"),
    "doctor": dict(x=120, y=460, name="Врач", code="doctor", color=GREEN),
    "reg": dict(x=120, y=370, name="Регистратор", code="registrar", color=AMBER),
    "lab": dict(x=1510, y=830, name="Сотрудник\nлаборатории", code="lab_staff", color=PURPLE),
    "an": dict(x=1510, y=740, name="Аналитик", code="analyst", color=TEAL),
    "minister": dict(x=1510, y=620, name="Министр\nздравоохранения", code="minister_of_health", color="#2f5d8a"),
    "governor": dict(x=1510, y=530, name="Губернатор", code="governor", color="#3f5f6f"),
}
ACTORS["registrar"] = ACTORS["reg"]


def actor_point(key):
    a = ACTORS[key]
    return (a["x"] + 10, a["y"] - 8)


def draw_actor(key):
    a = ACTORS[key]
    x, y, color = a["x"], a["y"], a["color"]
    ax.add_patch(Circle((x, y + 8), 8, facecolor=WHITE, edgecolor=color,
                        lw=1.2, zorder=5))
    line(ax, [(x, y), (x, y - 20)], color=color, lw=1.2, z=5)
    line(ax, [(x - 11, y - 5), (x + 11, y - 5)], color=color, lw=1.2, z=5)
    line(ax, [(x, y - 20), (x - 9, y - 36)], color=color, lw=1.2, z=5)
    line(ax, [(x, y - 20), (x + 9, y - 36)], color=color, lw=1.2, z=5)
    style = "italic" if a.get("abstract") else "normal"
    txt(ax, x, y - 50, a["name"], 8.1, color, weight="bold", style=style,
        linespacing=1.05, z=5)
    txt(ax, x, y - 64, a["code"], 6.0, MUTED, z=5)


def draw_case(case):
    num, row, col, name, route, state, actors = case
    cx, cy = COLS[col], ROWS[row]
    ellipse(cx, cy, state)
    txt(ax, cx, cy + 32, f"UC-{num:02d}", 6.2, MUTED, ha="center", z=4)
    size, lines = fit_text(name, EW - 30, 3, [9.0, 8.6, 8.2, 7.8])
    txt(ax, cx, cy + 7, "\n".join(lines), size, INK, weight="bold", z=4,
        linespacing=1.03)
    rsize, rlines = fit_text(route, EW - 24, 2, [6.4, 6.2, 6.0, 5.8])
    txt(ax, cx, cy - 30, "\n".join(rlines), rsize, SOFT, z=4, linespacing=1.0)


def connect(actor_key, case):
    num, row, col, *_ = case
    cx, cy = COLS[col], ROWS[row]
    ax_, ay_ = actor_point(actor_key)
    dx, dy = cx - ax_, cy - ay_
    rx, ry = EW / 2 - 4, EH / 2 - 4
    t = 1.0 / ((dx / rx) ** 2 + (dy / ry) ** 2) ** 0.5
    ex, ey = cx - dx * t, cy - dy * t
    color = ACTORS[actor_key]["color"]
    line(ax, [(ax_, ay_), (ex, ey)], color=color, lw=0.6, z=2, alpha=0.36)


for case in CASES:
    for key in case[6]:
        connect(key, case)

for case in CASES:
    draw_case(case)

for key in ACTORS:
    if key not in {"registrar"}:
        draw_actor(key)

# Легенда
draw_block(ax, 24, 70, 180, 185, fc="#fbfcfd", ec=RULE, lw=0.8, rounding=3, z=6)
txt(ax, 34, 240, "Обозначения", 7.4, INK, weight="bold", ha="left", z=7)
ax.plot([34, 78], [222, 222], color=INK, lw=1.1, zorder=7)
txt(ax, 84, 222, "реализовано", 6.2, MUTED, ha="left", z=7)
ax.plot([34, 78], [205, 205], color=AMBER, lw=1.0, ls="--", zorder=7)
txt(ax, 84, 205, "маршрут контракта,", 6.2, MUTED, ha="left", z=7)
txt(ax, 84, 195, "endpoint — заготовка", 6.0, MUTED, ha="left", z=7)
txt(ax, 34, 174, "Цвет линии — актор.", 6.2, MUTED, ha="left", z=7)
txt(ax, 34, 158, "Базовый актор — общие", 6.1, MUTED, ha="left", z=7)
txt(ax, 34, 147, "маршруты 11 ролей.", 6.1, MUTED, ha="left", z=7)
txt(ax, 34, 128, "33 прецедента; вымышленных", 6.1, MUTED, ha="left", z=7)
txt(ax, 34, 117, "маршрутов нет.", 6.1, MUTED, ha="left", z=7)
txt(ax, 34, 96, "Роли и МКБ — 004.", 6.1, MUTED, ha="left", z=7)
txt(ax, 34, 85, "Специальности — 005 (данные).", 6.1, MUTED, ha="left", z=7)
txt(ax, 34, 74, "МКБ: chapter, is_active.", 6.0, MUTED, ha="left", z=7)

check_bounds(fig, ax, "Use Case")
save(fig, OUT)
print("saved", OUT)
