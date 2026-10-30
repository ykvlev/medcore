# -*- coding: utf-8 -*-
"""ER-модель MEDCORE: ключевые сущности и связи (crow's foot)."""
from pathlib import Path

from diagram_common import (AMBER, AMBER_L, BLUE, BLUE_L, GREEN, GREEN_L, INK,
                            MUTED, PURPLE, PURPLE_L, RULE, TEAL, TEAL_L,
                            WHITE, block, canvas, check_bounds, crow, header,
                            label, line, save, tick, txt)

W, H = 1650, 1170
OUT = Path(__file__).with_name("er_model.png")

fig, ax = canvas(W, H)
header(ax, W, H,
       "ER-модель данных MEDCORE",
       "Ключевые сущности и связи · нотация «воронья лапка» · полный граф FK — на физической схеме",
       sheet=4, total=6)

COLUMNS = [
    ("Организации", 40, BLUE, BLUE_L, 7),
    ("Персонал", 350, TEAL, TEAL_L, 4),
    ("Пациенты и случаи", 660, GREEN, GREEN_L, 5),
    ("Стационар и лаборатории", 970, AMBER, AMBER_L, 7),
    ("Доступ", 1280, "#55606a", "#f1f3f5", 4),
]
CW, CH = 230, 76
Y_SHIFT = -20

for title, x, color, light, count in COLUMNS:
    txt(ax, x + 4, 1030, title, 8.6, color, weight="bold", ha="left")
    txt(ax, x + CW - 2, 1030, str(count), 7.2, MUTED, ha="right")
    line(ax, [(x, 1022), (x + CW, 1022)], color=color, lw=0.7, z=2)

# name: (column, x, y_top, lines)
ENT = {
    "medical_organizations": (0, 40, 1010, ["PK id", "name", "organization_type"]),
    "hospitals": (0, 40, 915, ["PK/FK organization_id", "organization_type"]),
    "polyclinics": (0, 40, 820, ["PK/FK organization_id", "FK hospital_id"]),
    "buildings": (0, 40, 725, ["PK id", "FK hospital_id", "code"]),
    "departments": (0, 40, 630, ["PK id", "FK building_id", "FK specialization_id"]),
    "wards": (0, 40, 535, ["PK id", "FK department_id", "number"]),
    "beds": (0, 40, 440, ["PK id", "FK ward_id", "number"]),

    "employees": (1, 350, 1010, ["PK id", "last_name", "category_id"]),
    "doctors": (1, 350, 900, ["PK/FK employee_id", "degree_id", "title_id"]),
    "employments": (1, 350, 790, ["PK id", "FK employee_id", "FK organization_id"]),
    "specialties": (1, 350, 680, ["PK id", "code", "name"]),

    "patients": (2, 660, 1010, ["PK id", "last_name", "birth_date"]),
    "patient_attachments": (2, 660, 900, ["PK id", "FK patient_id", "FK polyclinic_id"]),
    "medical_cases": (2, 660, 790, ["PK id", "FK patient_id", "FK organization_id"]),
    "case_diagnoses": (2, 660, 680, ["PK id", "FK case_id", "FK diagnosis_id"]),
    "diagnoses": (2, 660, 570, ["PK id", "code", "name", "chapter (МКБ-10)"]),

    "referrals": (3, 970, 1010, ["PK id", "FK case_id", "FK target_hospital_id"]),
    "hospitalizations": (3, 970, 915, ["PK id", "FK case_id / referral_id", "FK department_id"]),
    "bed_occupancies": (3, 970, 820, ["PK id", "FK hospitalization_id", "FK bed_id"]),
    "laboratories": (3, 970, 725, ["PK id", "name", "is_active"]),
    "laboratory_contracts": (3, 970, 630, ["PK id", "FK laboratory_id", "FK organization_id"]),
    "lab_orders": (3, 970, 535, ["PK id", "FK case_id", "FK contract_id"]),
    "lab_results": (3, 970, 440, ["PK id", "FK order_id", "FK entered_by_user_id"]),

    "users": (4, 1280, 1010, ["PK id", "FK employee_id", "login"]),
    "roles": (4, 1280, 900, ["PK id", "code", "name"]),
    "user_roles": (4, 1280, 790, ["PK/FK user_id", "PK/FK role_id", "—"]),
    "user_organization_scopes": (4, 1280, 680, ["PK id", "FK user_id, role_id",
                                                "organization_id / laboratory_id",
                                                "FK department_id"]),
}


def rect(name):
    c, x, yt, _ = ENT[name]
    return x, yt + Y_SHIFT - CH, CW, CH


def center(name):
    x, y, w, h = rect(name)
    return x + w / 2, y + h / 2


def edge(name, toward):
    x, y, w, h = rect(name)
    cx, cy = x + w / 2, y + h / 2
    dx, dy = toward[0] - cx, toward[1] - cy
    if abs(dx) > abs(dy):
        return (x + w, cy) if dx > 0 else (x, cy)
    return (cx, y + h) if dy > 0 else (cx, y)


COLOR = [c[2] for c in COLUMNS]
LIGHT = [c[3] for c in COLUMNS]


def draw_entity(name):
    c, x, yt, lines = ENT[name]
    y = yt + Y_SHIFT - CH
    block(ax, x, y, CW, CH, fc=WHITE, ec=COLOR[c], lw=0.9, rounding=0, z=3)
    block(ax, x, y + CH - 17, CW, 17, fc=LIGHT[c], ec=COLOR[c], lw=0.9,
          rounding=0, z=3)
    txt(ax, x + 5, y + CH - 8.5, name, 7.6, COLOR[c], weight="bold", ha="left", z=4)
    for i, a in enumerate(lines[:4]):
        txt(ax, x + 5, y + CH - 28 - i * 11, a, 6.9, INK if i == 0 else MUTED,
            ha="left", z=4)


def rel(child, parent, many=True, color=None, channel=None, label_text=None):
    c = center(child)
    p = center(parent)
    s = edge(child, p)
    t = edge(parent, c)
    col = color or COLOR[ENT[child][0]]
    if abs(s[0] - t[0]) < 2:
        pts = [s, t]
        if s[1] < t[1]:
            sdir, tdir = (0, -1), (0, 1)
        else:
            sdir, tdir = (0, 1), (0, -1)
    elif abs(s[1] - t[1]) < 2:
        pts = [s, t]
        if s[0] < t[0]:
            sdir, tdir = (-1, 0), (1, 0)
        else:
            sdir, tdir = (1, 0), (-1, 0)
    else:
        ch = channel
        if ch is None:
            ch = (s[0] + t[0]) / 2
        if abs(s[0] - t[0]) > abs(s[1] - t[1]):
            pts = [s, (ch, s[1]), (ch, t[1]), t]
            if s[0] < t[0]:
                sdir, tdir = (-1, 0), (1, 0)
            else:
                sdir, tdir = (1, 0), (-1, 0)
        else:
            my = (s[1] + t[1]) / 2
            pts = [s, (s[0], my), (t[0], my), t]
            if s[1] < t[1]:
                sdir, tdir = (0, -1), (0, 1)
            else:
                sdir, tdir = (0, 1), (0, -1)
    line(ax, pts, color=col, lw=0.8, z=2, alpha=0.8)
    if many:
        crow(ax, s, sdir, color=col, size=9, spread=4.5, z=4)
    else:
        tick(ax, s, sdir, color=col, length=9, z=4)
    tick(ax, t, tdir, color=col, length=9, z=4)

    def side_label(pt, d):
        px, py = -d[1], d[0]
        return (pt[0] - d[0] * 10 + px * 8, pt[1] - d[1] * 10 + py * 8)

    q = side_label(s, sdir)
    label(ax, q[0], q[1], "N" if many else "1", size=6.5, color=col, z=5)
    q = side_label(t, tdir)
    label(ax, q[0], q[1], "1", size=6.5, color=col, z=5)
    if label_text:
        mx = sum(q[0] for q in pts) / len(pts)
        my = sum(q[1] for q in pts) / len(pts)
        label(ax, mx, my, label_text, size=6.4, color=col, z=5)


# Внутри модулей
rel("hospitals", "medical_organizations", many=False)
rel("polyclinics", "hospitals", many=False)
rel("buildings", "hospitals", many=True, channel=300)
rel("departments", "buildings", many=True)
rel("wards", "departments", many=True)
rel("beds", "wards", many=True)

rel("doctors", "employees", many=False)
rel("employments", "employees", many=True, channel=610)
rel("doctors", "specialties", many=True, channel=610, label_text="M:N")

rel("patient_attachments", "patients", many=True)
rel("medical_cases", "patients", many=True, channel=920)
rel("case_diagnoses", "medical_cases", many=True)
rel("case_diagnoses", "diagnoses", many=True)

rel("hospitalizations", "referrals", many=False)
rel("bed_occupancies", "hospitalizations", many=True)
rel("laboratory_contracts", "laboratories", many=True)
rel("lab_orders", "laboratory_contracts", many=True)
rel("lab_results", "lab_orders", many=True)

rel("user_roles", "users", many=True, channel=1560)
rel("user_roles", "roles", many=True)
rel("user_organization_scopes", "user_roles", many=True)

# Связи между соседними колонками
rel("employments", "medical_organizations", many=True, channel=320)
rel("case_diagnoses", "doctors", many=True, channel=630)
rel("referrals", "medical_cases", many=True, channel=940)
rel("hospitalizations", "medical_cases", many=False, channel=940)
rel("lab_orders", "medical_cases", many=True, channel=940)
rel("lab_results", "users", many=True, channel=1250)

# department_id у области доступа заведующего: обход по нижнему полю
line(ax, [(1395, 584), (1395, 300), (290, 300), (290, 572), (270, 572)],
     color="#55606a", lw=0.8, z=2, alpha=0.8)
crow(ax, (1395, 584), (0, 1), color="#55606a", size=9, spread=4.5, z=4)
tick(ax, (270, 572), (-1, 0), color="#55606a", length=9, z=4)
label(ax, 820, 288, "FK department_id", size=6.5, color="#55606a", z=5)

for name in ENT:
    draw_entity(name)

# Подписи колонок уже нарисованы; пояснение
block(ax, 40, 150, 400, 118, fc="#fbfcfd", ec=RULE, lw=0.8, rounding=3, z=8)
txt(ax, 52, 250, "Обозначения", 8.2, INK, weight="bold", ha="left", z=9)
ax.plot([52, 102], [234, 234], color=INK, lw=0.8, zorder=9)
tick(ax, (102, 234), (-1, 0), color=INK, length=9, z=9)
crow(ax, (52, 234), (1, 0), color=INK, size=8, spread=4, z=9)
txt(ax, 110, 234, "многие → один", 6.8, MUTED, ha="left", z=9)
txt(ax, 52, 214, "PK — первичный ключ; FK — внешний ключ.", 6.8, MUTED, ha="left", z=9)
txt(ax, 52, 196, "1 — один; N — много; M:N — многие ко многим.", 6.7, MUTED, ha="left", z=9)
txt(ax, 52, 176, "Показаны ключевые сущности; полный состав и все FK —", 6.7, MUTED, ha="left", z=9)
txt(ax, 52, 162, "на физической схеме, листы 1–7.", 6.7, MUTED, ha="left", z=9)

# Пояснение о не показанных связях
block(ax, 470, 150, 760, 90, fc="#fbfcfd", ec=RULE, lw=0.8, rounding=3, z=8)
txt(ax, 482, 225, "Что упрощено", 7.8, INK, weight="bold", ha="left", z=9)
txt(ax, 482, 207,
    "Не показаны как отдельные линии: прикрепление к поликлинике, договор лаборатории с организацией,",
    6.7, MUTED, ha="left", z=9)
txt(ax, 482, 193,
    "области доступа к организации/лаборатории и аудит. Эти FK перечислены в карточках физической схемы.",
    6.7, MUTED, ha="left", z=9)
txt(ax, 482, 179,
    "Показаны chapter (глава МКБ-10) и department_id — область заведующего отделением.",
    6.7, MUTED, ha="left", z=9)

check_bounds(fig, ax, "ER")
save(fig, OUT)
print("saved", OUT)

