# -*- coding: utf-8 -*-
"""IDEF1X: логическая структура 18 основных сущностей MEDCORE."""
from pathlib import Path

from diagram_common import (AMBER, AMBER_L, BLUE, BLUE_L, GREEN, GREEN_L, INK,
                            MUTED, PURPLE, PURPLE_L, RULE, TEAL, TEAL_L,
                            WHITE, block, canvas, check_bounds, crow, dot, header,
                            label, line, save, tick, txt)

W, H = 1650, 1170
OUT = Path(__file__).with_name("idef1x.png")

fig, ax = canvas(W, H)
header(ax, W, H,
       "Логическая модель IDEF1X",
       "18 основных + 2 дополнительные сущности · идентифицирующие связи · ключи, FK, МКБ-10",
       sheet=5, total=6)

CW = 232
X = [40, 300, 560, 820, 1080, 1340]

# name: (row, col, kind, lines)
# kind: ind — независимая, dep — зависимая, sub — подтип
ENT = {
    "medical_organizations": (0, 0, "ind", [
        "PK id : bigint", "UQ (id, organization_type)", "name : text",
        "organization_type : text", "address : text", "is_active : boolean",
        "created_at : timestamptz"]),
    "hospitals": (0, 1, "sub", [
        "PK/FK organization_id : bigint", "organization_type : text"]),
    "buildings": (0, 2, "ind", [
        "PK id : bigint", "FK hospital_id : bigint", "code : text",
        "address : text", "is_active : boolean"]),
    "departments": (0, 3, "ind", [
        "PK id : bigint", "FK building_id : bigint",
        "FK specialization_id : bigint", "name : text", "is_active : boolean"]),
    "wards": (0, 4, "ind", [
        "PK id : bigint", "FK department_id : bigint", "number : text",
        "planned_capacity : positive_bed_count", "is_active : boolean"]),
    "beds": (0, 5, "ind", [
        "PK id : bigint", "FK ward_id : bigint", "number : text",
        "is_active : boolean"]),

    "employees": (1, 0, "ind", [
        "PK id : bigint", "FK category_id : bigint", "last_name : text",
        "first_name : text", "birth_date : date", "is_active : boolean"]),
    "doctors": (1, 1, "dep", [
        "PK/FK employee_id : bigint", "FK academic_degree_id : bigint",
        "FK academic_title_id : bigint", "qualification : text"]),
    "patients": (1, 2, "ind", [
        "PK id : bigint", "last_name : text", "first_name : text",
        "birth_date : date", "sex : text", "version : integer"]),
    "medical_cases": (1, 3, "ind", [
        "PK id : bigint", "FK patient_id : bigint", "FK organization_id : bigint",
        "UQ (id, patient_id)", "case_type : text", "status : text",
        "opened_at : timestamptz"]),
    "referrals": (1, 4, "ind", [
        "PK id : bigint", "FK case_id : bigint", "FK referring_doctor_id : bigint",
        "FK target_hospital_id : bigint", "FK specialization_id : bigint",
        "issued_at : timestamptz", "status : text"]),
    "hospitalizations": (1, 5, "ind", [
        "PK id : bigint", "FK case_id : bigint (UQ)",
        "FK referral_id : bigint (UQ)", "FK patient_id : bigint",
        "FK department_id : bigint", "admitted_at : timestamptz",
        "status : hospitalization_status"]),

    "users": (2, 0, "ind", [
        "PK id : bigint", "FK employee_id : bigint (UQ)", "login : text",
        "password_hash : text", "is_active : boolean"]),
    "laboratories": (2, 1, "ind", [
        "PK id : bigint", "name : text", "address : text", "is_active : boolean"]),
    "laboratory_contracts": (2, 2, "ind", [
        "PK id : bigint", "FK laboratory_id : bigint", "FK organization_id : bigint",
        "contract_number : text", "valid_from : date", "valid_until : date"]),
    "lab_orders": (2, 3, "ind", [
        "PK id : bigint", "FK case_id : bigint", "FK doctor_id : bigint",
        "FK contract_id : bigint", "FK test_type_id : bigint",
        "ordered_at : timestamptz", "status : text"]),
    "lab_results": (2, 4, "ind", [
        "PK id : bigint", "FK order_id : bigint", "FK entered_by_user_id : bigint",
        "measured_at : timestamptz", "result_text : text"]),
    "bed_occupancies": (2, 5, "ind", [
        "PK id : bigint", "FK hospitalization_id : bigint", "FK bed_id : bigint",
        "started_at : timestamptz", "ended_at : timestamptz"]),

    # дополнительные карточки под нижним рядом: МКБ-10 и область отделения
    "diagnoses": (3, 0, "ind", [
        "PK id : bigint", "code : text (UQ)", "name : text",
        "chapter : text (МКБ-10)", "is_active : boolean"]),
    "user_organization_scopes": (3, 0, "ind", [
        "PK id : bigint", "FK user_id, role_id : bigint",
        "organization_id : bigint", "laboratory_id : bigint",
        "FK department_id : bigint"]),
}

EXTRA_POS = {
    "diagnoses": (700, 320, 232),
    "user_organization_scopes": (960, 320, 232),
}

ROW_TOP = [1020, 780, 540]
KIND_COLOR = {"ind": BLUE, "dep": GREEN, "sub": AMBER}
KIND_LIGHT = {"ind": BLUE_L, "dep": GREEN_L, "sub": AMBER_L}
KIND_LABEL = {"ind": "независимая", "dep": "зависимая", "sub": "подтип"}


def lines_of(name):
    return ENT[name][3]


def height_of(name):
    return 24 + len(lines_of(name)) * 12.2 + 6


def rect(name):
    if name in EXTRA_POS:
        x, y_top, w = EXTRA_POS[name]
        return x, y_top - height_of(name), w, height_of(name)
    row, col, kind, _ = ENT[name]
    return X[col], ROW_TOP[row] - height_of(name), CW, height_of(name)


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


def draw(name):
    row, col, kind, lines = ENT[name]
    x, y, w, h = rect(name)
    color, light = KIND_COLOR[kind], KIND_LIGHT[kind]
    block(ax, x, y, w, h, fc=WHITE, ec=color, lw=0.95, rounding=0, z=3)
    block(ax, x, y + h - 20, w, 20, fc=light, ec=color, lw=0.95, rounding=0, z=3)
    txt(ax, x + 5, y + h - 10, name, 7.8, color, weight="bold", ha="left", z=4)
    txt(ax, x + w - 5, y + h - 10, KIND_LABEL[kind], 5.8, MUTED, ha="right", z=4)
    # разделитель после PK-блока
    first_non_pk = next((i for i, s in enumerate(lines) if not s.startswith("PK")), len(lines))
    sep_y = y + h - 24 - first_non_pk * 12.2 + 4
    if 0 < first_non_pk < len(lines):
        line(ax, [(x + 4, sep_y), (x + w - 4, sep_y)], color=color, lw=0.45, z=4)
    for i, s in enumerate(lines):
        yy = y + h - 33 - i * 12.2
        if s.startswith("PK"):
            txt(ax, x + 5, yy, s, 6.9, INK, weight="bold", ha="left", z=4)
        elif s.startswith("FK"):
            txt(ax, x + 5, yy, s, 6.9, INK, ha="left", z=4)
        elif s.startswith("UQ"):
            txt(ax, x + 5, yy, s, 6.6, TEAL, ha="left", z=4)
        else:
            txt(ax, x + 5, yy, s, 6.7, MUTED, ha="left", z=4)


def link(child, parent, ident=False, many=True, channel=None, parent_card="1"):
    c = center(child)
    p = center(parent)
    s = edge(child, p)
    t = edge(parent, c)
    col = "#41637f"
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
        ch = channel if channel is not None else (s[0] + t[0]) / 2
        if abs(s[0] - t[0]) > abs(s[1] - t[1]):
            pts = [s, (ch, s[1]), (ch, t[1]), t]
            sdir, tdir = ((-1, 0), (1, 0)) if s[0] < t[0] else ((1, 0), (-1, 0))
        else:
            my = (s[1] + t[1]) / 2
            pts = [s, (s[0], my), (t[0], my), t]
            sdir, tdir = ((0, -1), (0, 1)) if s[1] < t[1] else ((0, 1), (0, -1))
    line(ax, pts, color=col, lw=1.0 if ident else 0.8,
         ls="-" if ident else (0, (4, 3)), z=2, alpha=0.9)
    if ident:
        dot(ax, t, color=col, r=3.6, z=4)
    else:
        tick(ax, t, tdir, color=col, length=8, z=4)
    # кардинальность
    def side(pt, d):
        px, py = -d[1], d[0]
        return (pt[0] - d[0] * 9 + px * 8, pt[1] - d[1] * 9 + py * 8)
    q = side(t, tdir)
    label(ax, q[0], q[1], parent_card, size=6.4, color=col, z=5)
    q = side(s, sdir)
    label(ax, q[0], q[1], "N" if many else "1", size=6.4, color=col, z=5)


# Горизонтальные цепочки
link("hospitals", "medical_organizations", ident=True, many=False, parent_card="Z",
     channel=286)
link("buildings", "hospitals", channel=546)
link("departments", "buildings", channel=806)
link("wards", "departments", channel=1066)
link("beds", "wards", channel=1326)

link("doctors", "employees", ident=True, many=False, channel=286)
link("medical_cases", "patients", channel=806)
link("referrals", "medical_cases", channel=1066)
link("hospitalizations", "referrals", many=False, channel=1326)

link("laboratory_contracts", "laboratories", channel=546)
link("lab_orders", "laboratory_contracts", channel=806)
link("lab_results", "lab_orders", channel=1066)

# Вертикальные и межстрочные связи
link("users", "employees", many=False, channel=286)
link("hospitalizations", "medical_cases", many=False, channel=1060)
link("bed_occupancies", "hospitalizations", channel=1326)
link("bed_occupancies", "beds", channel=1590)
link("medical_cases", "medical_organizations", channel=880)
link("referrals", "doctors", channel=1100)
link("lab_orders", "medical_cases", channel=880)
link("lab_orders", "doctors", channel=900)
link("lab_results", "users", channel=1080)
link("laboratory_contracts", "medical_organizations", channel=300)

# Дополнительные карточки: МКБ-10 и область отделения заведующего
line(ax, [(700, 310), (545, 310), (545, 752), (660, 752)],
     color="#41637f", lw=0.8, ls=(0, (4, 3)), z=2, alpha=0.9)
crow(ax, (700, 310), (1, 0), color="#41637f", size=9, spread=4.5, z=4)
tick(ax, (660, 752), (1, 0), color="#41637f", length=8, z=4)
label(ax, 690, 210, "case_diagnoses (M:N)", size=6.2, color="#41637f",
      ha="left", z=5)

line(ax, [(1192, 274), (1210, 274), (1210, 400), (1060, 400),
          (1060, 929), (1052, 929)],
     color="#41637f", lw=0.8, ls=(0, (4, 3)), z=2, alpha=0.9)
crow(ax, (1192, 274), (-1, 0), color="#41637f", size=9, spread=4.5, z=4)
tick(ax, (1052, 929), (-1, 0), color="#41637f", length=8, z=4)
label(ax, 1080, 910, "FK department_id", size=6.2, color="#41637f",
      ha="left", z=5)

for name in ENT:
    draw(name)

# Легенда
block(ax, 40, 150, 640, 150, fc="#fbfcfd", ec=RULE, lw=0.8, rounding=3, z=8)
txt(ax, 52, 283, "Обозначения IDEF1X", 8.2, INK, weight="bold", ha="left", z=9)
# образцы линий
ax.plot([52, 122], [262, 262], color="#41637f", lw=1.0, zorder=9)
dot(ax, (122, 262), color="#41637f", r=3.6, z=9)
txt(ax, 132, 262, "идентифицирующая связь (точка у родителя)", 6.7, MUTED, ha="left", z=9)
ax.plot([52, 122], [242, 242], color="#41637f", lw=0.8, ls=(0, (4, 3)), zorder=9)
tick(ax, (122, 242), (-1, 0), color="#41637f", length=8, z=9)
txt(ax, 132, 242, "неидентифицирующая связь (пунктир)", 6.7, MUTED, ha="left", z=9)
txt(ax, 52, 218, "1 / Z — ровно один / ноль или один; N — много; 1:1 — уникальный FK.",
    6.6, MUTED, ha="left", z=9)
txt(ax, 52, 198, "PK — первичный ключ; FK — внешний ключ; UQ — уникальность.",
    6.6, MUTED, ha="left", z=9)
txt(ax, 52, 182, "18 основных + diagnoses (chapter, is_active) и",
    6.6, MUTED, ha="left", z=9)
txt(ax, 52, 168, "user_organization_scopes (department_id);  поликлиники,",
    6.6, MUTED, ha="left", z=9)
txt(ax, 52, 154, "роли и служебные — на физической схеме, листы 1–7.",
    6.6, MUTED, ha="left", z=9)

check_bounds(fig, ax, "IDEF1X")
save(fig, OUT)
print("saved", OUT)

