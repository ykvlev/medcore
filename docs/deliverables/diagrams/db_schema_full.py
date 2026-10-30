# -*- coding: utf-8 -*-
"""Полный комплект физической схемы MEDCORE: 48 таблиц, 7 листов A3.

Лист 1 — обзор по модулям.
Листы 2–7 — модули с полными таблицами, столбцами и линиями FK.

Схема читается из database/migrations/001_initial_schema.sql,
002_business_rules.sql, 004_roles_icd.sql и 005_specialties.sql.
Скрипт сверяет состав таблиц с контрольным списком и печатает число
таблиц/столбцов на каждом листе.
"""
from __future__ import annotations

import math
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable

from diagram_common import (AMBER, AMBER_L, BLUE, BLUE_L, BROWN, BROWN_L,
                            GREEN, GREEN_L, GRAY, GRAY_L, INK, MUTED, PURPLE,
                            PURPLE_L, RED, RED_L, RULE, SOFT, TEAL, TEAL_L,
                            WHITE, arrow, arrowhead, block, canvas, check_bounds,
                            crow, header, label, line, save, tick, txt, wrap_text)

ROOT = Path(__file__).resolve().parents[3]
SQL_FILES = [ROOT / "database/migrations/001_initial_schema.sql",
             ROOT / "database/migrations/002_business_rules.sql",
             ROOT / "database/migrations/004_roles_icd.sql",
             ROOT / "database/migrations/005_specialties.sql"]
OUT_DIR = Path(__file__).resolve().parent

W, H = 1650, 1170
MM = 3.937007874  # единиц на миллиметр (1 единица = 0.01 дюйма)
FRAME = (20 * MM, 10 * MM, W - 30 * MM, H - 20 * MM)  # x, y, w, h

EXPECTED = {
    "academic_degrees", "academic_titles", "appointment_doctors", "appointments",
    "attending_physician_history", "audit_logs", "bed_occupancies", "beds",
    "buildings", "business_rule_checks", "case_diagnoses",
    "consultation_assignments", "department_specializations", "departments",
    "diagnoses", "doctor_specialties", "doctors", "employee_categories",
    "employees", "employments", "hospitalizations", "hospitals", "lab_orders",
    "lab_results", "lab_test_types", "laboratories", "laboratory_contracts",
    "laboratory_profile_links", "laboratory_profiles", "medical_cases",
    "medical_organizations", "medical_record_entries", "patient_attachments",
    "patients", "polyclinics", "prescriptions", "referrals", "report_exports",
    "roles", "specialties", "specialty_conditions", "surgeries",
    "surgery_participants", "user_organization_scopes", "user_roles",
    "user_sessions", "users", "wards",
}

TYPE_RE = re.compile(
    r"^(bigint|integer|smallint|text\[\]|text|boolean|date|timestamptz|"
    r"numeric(?:\(\d+(?:,\d+)?\))?|jsonb|hospitalization_status|positive_bed_count)",
    re.I,
)
KEYWORDS = ("NOT NULL", "PRIMARY KEY", "UNIQUE", "REFERENCES", "DEFAULT",
            "CHECK", "GENERATED", "COLLATE")


@dataclass
class ForeignKey:
    columns: tuple[str, ...]
    ref_table: str
    ref_columns: tuple[str, ...]
    name: str | None = None
    one_to_one: bool = False


@dataclass
class Column:
    name: str
    type: str
    not_null: bool = False
    pk: bool = False
    unique: bool = False
    identity: bool = False
    fk: list[ForeignKey] = field(default_factory=list)
    check: str | None = None


@dataclass
class Table:
    name: str
    columns: list[Column] = field(default_factory=list)
    pk: tuple[str, ...] = ()
    uniques: list[tuple[str, ...]] = field(default_factory=list)
    fks: list[ForeignKey] = field(default_factory=list)
    checks: list[str] = field(default_factory=list)
    excludes: list[str] = field(default_factory=list)
    service: bool = False

    @property
    def colmap(self):
        return {c.name: c for c in self.columns}


def strip_comment_prefix(item: str) -> str:
    item = item.strip()
    item = re.sub(r"^CONSTRAINT\s+\w+\s+", "", item, flags=re.I)
    return item.strip()


def read_balanced(text: str, start: int) -> tuple[str, int]:
    """Вернуть содержимое скобок и позицию после закрывающей скобки."""
    depth = 0
    i = start
    quote = None
    while i < len(text):
        ch = text[i]
        if quote:
            if quote == "'" and ch == "'" and i + 1 < len(text) and text[i + 1] == "'":
                i += 2
                continue
            if ch == quote:
                quote = None
            i += 1
            continue
        if ch in "'\"":
            quote = ch
            i += 1
            continue
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
            if depth == 0:
                return text[start + 1:i], i + 1
        i += 1
    raise ValueError("незакрытая скобка")


def split_top_level(body: str) -> list[str]:
    parts, current = [], []
    depth = 0
    quote = None
    i = 0
    while i < len(body):
        ch = body[i]
        if quote:
            current.append(ch)
            if quote == "'" and ch == "'" and i + 1 < len(body) and body[i + 1] == "'":
                current.append(body[i + 1])
                i += 2
                continue
            if ch == quote:
                quote = None
            i += 1
            continue
        if ch in "'\"":
            quote = ch
            current.append(ch)
        elif ch == "(":
            depth += 1
            current.append(ch)
        elif ch == ")":
            depth -= 1
            current.append(ch)
        elif ch == "," and depth == 0:
            parts.append("".join(current).strip())
            current = []
        else:
            current.append(ch)
        i += 1
    if current:
        parts.append("".join(current).strip())
    return [p for p in parts if p]


def columns_in(text: str) -> tuple[str, ...]:
    return tuple(x.strip().strip('"') for x in text.split(",") if x.strip())


def parse_sql(sql: str, tables: dict[str, Table]) -> None:
    pattern = re.compile(
        r"CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:project\.)?([a-z_][a-z0-9_]*)",
        re.I,
    )
    for m in pattern.finditer(sql):
        name = m.group(1).lower()
        paren = sql.find("(", m.end())
        if paren < 0:
            continue
        if sql[m.end():paren].strip():
            continue
        body, _ = read_balanced(sql, paren)
        table = Table(name=name)
        for raw in split_top_level(body):
            item = strip_comment_prefix(raw)
            upper = item.upper()
            if upper.startswith("PRIMARY KEY"):
                inside = item[item.find("(") + 1:item.rfind(")")]
                table.pk = columns_in(inside)
            elif upper.startswith("UNIQUE"):
                inside = item[item.find("(") + 1:item.rfind(")")]
                table.uniques.append(columns_in(inside))
            elif upper.startswith("FOREIGN KEY"):
                fm = re.match(
                    r"FOREIGN\s+KEY\s*\((.*?)\)\s*REFERENCES\s+([\w.]+)\s*\((.*?)\)",
                    item, re.I | re.S)
                if not fm:
                    print("!! не разобран FK:", item[:120])
                    continue
                ref = fm.group(2).split(".")[-1].lower()
                table.fks.append(ForeignKey(columns_in(fm.group(1)), ref,
                                            columns_in(fm.group(3))))
            elif upper.startswith("CHECK"):
                table.checks.append(item)
            elif upper.startswith("EXCLUDE"):
                table.excludes.append(item)
            else:
                cm = re.match(r"^([a-z_][a-z0-9_]*)\s+(.+)$", item, re.I | re.S)
                if not cm:
                    print("!! не разобрана строка:", item[:100])
                    continue
                col = Column(cm.group(1).lower(), "")
                rest = cm.group(2).strip()
                tm = TYPE_RE.match(rest)
                if not tm:
                    head = rest
                    for kw in KEYWORDS:
                        idx = re.search(rf"\b{kw}\b", head, re.I)
                        if idx:
                            head = head[:idx.start()]
                    col.type = " ".join(head.split())
                else:
                    col.type = tm.group(1).lower()
                col.not_null = bool(re.search(r"\bNOT\s+NULL\b", rest, re.I))
                col.pk = bool(re.search(r"\bPRIMARY\s+KEY\b", rest, re.I))
                col.unique = bool(re.search(r"\bUNIQUE\b", rest, re.I))
                col.identity = bool(re.search(r"GENERATED\s+ALWAYS\s+AS\s+IDENTITY", rest, re.I))
                rm = re.search(r"\bREFERENCES\s+([\w.]+)\s*\(([^)]*)\)", rest, re.I)
                if rm:
                    fk = ForeignKey((col.name,), rm.group(1).split(".")[-1].lower(),
                                    columns_in(rm.group(2)))
                    col.fk.append(fk)
                    table.fks.append(fk)
                chm = re.search(r"\bCHECK\s*\((.*)\)\s*$", rest, re.I | re.S)
                if chm:
                    col.check = "CHECK (" + chm.group(1) + ")"
                table.columns.append(col)
        if not table.pk:
            table.pk = tuple(c.name for c in table.columns if c.pk)
        for c in table.columns:
            if c.name in table.pk:
                c.pk = True
                c.not_null = True
        if not table.pk:
            print(f"!! {name}: не найден PRIMARY KEY")
        tables[name] = table


def parse_unique_indexes(sql: str, tables: dict[str, Table]) -> None:
    pattern = re.compile(r"CREATE\s+UNIQUE\s+INDEX\s+(\w+)\s+ON\s+(?:project\.)?([a-z_][a-z0-9_]*)\s*\(",
                         re.I)
    for m in pattern.finditer(sql):
        name = m.group(2).lower()
        start = sql.find("(", m.end() - 1)
        try:
            body, end = read_balanced(sql, start)
        except ValueError:
            continue
        tail = sql[end:end + 220]
        where = ""
        wm = re.match(r"\s*WHERE\s+(.+?);", tail, re.I | re.S)
        if wm:
            where = " WHERE " + " ".join(wm.group(1).split())
        table = tables.get(name)
        if table is None:
            continue
        expr = " ".join(body.split())
        table.uniques.append((f"{expr}{where}",))


def parse_alter_columns(sql: str, tables: dict[str, Table]) -> None:
    """ALTER TABLE ... ADD COLUMN из миграции 004 (и будущих миграций)."""
    pattern = re.compile(
        r"ALTER\s+TABLE\s+(?:project\.)?([a-z_][a-z0-9_]*)\s+"
        r"ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?([^;]+);",
        re.I | re.S,
    )
    for m in pattern.finditer(sql):
        table = tables.get(m.group(1).lower())
        if table is None:
            continue
        definition = " ".join(m.group(2).split())
        cm = re.match(r"^([a-z_][a-z0-9_]*)\s+(.+)$", definition, re.I | re.S)
        if not cm:
            continue
        col = Column(cm.group(1).lower(), "")
        rest = cm.group(2).strip()
        tm = TYPE_RE.match(rest)
        if tm:
            col.type = tm.group(1).lower()
        else:
            head = rest
            for kw in KEYWORDS:
                idx = re.search(rf"\b{kw}\b", head, re.I)
                if idx:
                    head = head[:idx.start()]
            col.type = " ".join(head.split())
        col.not_null = bool(re.search(r"\bNOT\s+NULL\b", rest, re.I))
        col.pk = bool(re.search(r"\bPRIMARY\s+KEY\b", rest, re.I))
        col.unique = bool(re.search(r"\bUNIQUE\b", rest, re.I))
        rm = re.search(r"\bREFERENCES\s+([\w.]+)\s*\(([^)]*)\)", rest, re.I)
        if rm:
            fk = ForeignKey((col.name,), rm.group(1).split(".")[-1].lower(),
                            columns_in(rm.group(2)))
            col.fk.append(fk)
            table.fks.append(fk)
        existing = table.colmap.get(col.name)
        if existing is None:
            table.columns.append(col)
        else:
            # повторное применение ADD COLUMN IF NOT EXISTS не должно дублировать столбец
            existing.type = col.type
            existing.not_null = existing.not_null or col.not_null
            existing.fk = col.fk


def load_schema() -> dict[str, Table]:
    sql = "\n".join(p.read_text(encoding="utf-8") for p in SQL_FILES)
    tables: dict[str, Table] = {}
    parse_sql(sql, tables)
    parse_unique_indexes(sql, tables)
    parse_alter_columns(sql, tables)
    if "business_rule_checks" in tables:
        tables["business_rule_checks"].service = True
    return tables


def validate(tables: dict[str, Table]) -> None:
    got = set(tables)
    missing = EXPECTED - got
    extra = got - EXPECTED
    print(f"Разобрано таблиц: {len(tables)}; ожидалось: {len(EXPECTED)}")
    if missing:
        print("НЕ НАЙДЕНЫ:", ", ".join(sorted(missing)))
    if extra:
        print("ЛИШНИЕ:", ", ".join(sorted(extra)))
    if len(tables) != 48 or missing or extra:
        raise SystemExit("Состав таблиц не совпадает с контрольным списком")
    for t in tables.values():
        if not t.columns:
            raise SystemExit(f"У таблицы {t.name} нет столбцов")
        if not t.pk:
            raise SystemExit(f"У таблицы {t.name} нет PK")
    total_cols = sum(len(t.columns) for t in tables.values())
    print(f"Всего столбцов: {total_cols}")
    print(f"Всего FK: {sum(len(t.fks) for t in tables.values())}")


# ---------------------------------------------------------------------------
# Модули
# ---------------------------------------------------------------------------
MODULES = [
    {
        "key": "org", "sheet": 2, "title": "Организации и структура",
        "short": "Организации", "color": BLUE, "light": BLUE_L,
        "tables": ["medical_organizations", "hospitals", "polyclinics", "buildings",
                   "department_specializations", "departments", "wards", "beds"],
    },
    {
        "key": "hr", "sheet": 3, "title": "Персонал",
        "short": "Персонал", "color": TEAL, "light": TEAL_L,
        "tables": ["employee_categories", "employees", "doctors", "specialties",
                   "doctor_specialties", "employments", "consultation_assignments",
                   "academic_degrees", "academic_titles", "specialty_conditions"],
    },
    {
        "key": "pat", "sheet": 4, "title": "Пациенты и случаи",
        "short": "Пациенты", "color": GREEN, "light": GREEN_L,
        "tables": ["patients", "patient_attachments", "medical_cases", "diagnoses",
                   "case_diagnoses", "appointments", "appointment_doctors",
                   "medical_record_entries", "prescriptions"],
    },
    {
        "key": "hosp", "sheet": 5, "title": "Стационар",
        "short": "Стационар", "color": AMBER, "light": AMBER_L,
        "tables": ["referrals", "hospitalizations", "attending_physician_history",
                   "bed_occupancies", "surgeries", "surgery_participants"],
    },
    {
        "key": "lab", "sheet": 6, "title": "Лаборатории",
        "short": "Лаборатории", "color": PURPLE, "light": PURPLE_L,
        "tables": ["laboratories", "laboratory_profiles", "laboratory_profile_links",
                   "laboratory_contracts", "lab_test_types", "lab_orders", "lab_results"],
    },
    {
        "key": "adm", "sheet": 7, "title": "Администрирование, аудит и служебные",
        "short": "Администрирование", "color": GRAY, "light": GRAY_L,
        "tables": ["users", "roles", "user_roles", "user_organization_scopes",
                   "user_sessions", "audit_logs", "report_exports",
                   "business_rule_checks"],
    },
]

TABLE_MODULE = {t: m for m in MODULES for t in m["tables"]}
TABLE_SHEET = {t: m["sheet"] for m in MODULES for t in m["tables"]}

TABLE_CHK = {
    "medical_organizations": ["CHK organization_type IN ('hospital','polyclinic')"],
    "hospitals": ["CHK organization_type = 'hospital'"],
    "polyclinics": ["CHK organization_type = 'polyclinic'"],
    "wards": ["CHK planned_capacity > 0 (домен)"],
    "employments": ["CHK ended_on > started_on",
                    "EXC (employee_id, organization_id, daterange[))"],
    "consultation_assignments": ["EXC (doctor_id, organization_id, daterange[))"],
    "specialty_conditions": ["CHK pay_coefficient >= 1, extra_leave_days >= 0"],
    "patient_attachments": ["EXC (patient_id, tstzrange[))"],
    "case_diagnoses": ["UQ (case_id) WHERE is_primary"],
    "referrals": ["CHK status IN ('issued','used','cancelled')"],
    "hospitalizations": ["CHK status/discharged_at согласованы",
                         "EXC (patient_id, tstzrange[)) WHERE status <> 'cancelled'"],
    "attending_physician_history": ["EXC (hospitalization_id, tstzrange[))"],
    "bed_occupancies": ["EXC (bed_id, tstzrange[))",
                        "EXC (hospitalization_id, tstzrange[))"],
    "surgeries": ["CHK outcome IN ('pending','survived','fatal','cancelled')"],
    "surgery_participants": ["UQ (surgery_id) WHERE participation_role = 'lead'"],
    "laboratory_contracts": ["CHK valid_until >= valid_from"],
    "lab_orders": ["CHK status IN ('ordered','in_progress','completed','cancelled')"],
    "lab_results": ["UQ (order_id) WHERE supersedes_result_id IS NULL"],
    "users": ["UQ lower(login)"],
    "roles": ["CHK code IN (11 ролей)"],
    "user_organization_scopes": ["CHK num_nonnulls(organization_id, laboratory_id) = 1"],
    "user_sessions": ["CHK expires_at > created_at"],
    "audit_logs": ["CHK outcome IN ('success','failure','denied')"],
    "report_exports": ["CHK format IN ('csv','pdf'), status IN (4 значения)"],
}

ONE_TO_ONE = {
    ("hospitals", "medical_organizations"),
    ("polyclinics", "medical_organizations"),
    ("doctors", "employees"),
    ("specialty_conditions", "specialties"),
    ("users", "employees"),
    ("hospitalizations", "medical_cases"),
    ("hospitalizations", "referrals"),
    ("lab_results", "lab_results"),
}


def fk_one_to_one(table_name: str, fk: ForeignKey) -> bool:
    if (table_name, fk.ref_table) in ONE_TO_ONE:
        if table_name == "hospitalizations" and fk.columns not in (("case_id",), ("referral_id",)):
            return False
        return True
    return False


@dataclass
class Card:
    table: Table
    x: float
    y: float
    w: float
    h: float
    rows: dict[str, int] = field(default_factory=dict)
    note_lines: list[tuple[str, list[str]]] = field(default_factory=list)

    @property
    def right(self):
        return self.x + self.w

    @property
    def top(self):
        return self.y + self.h

    @property
    def cx(self):
        return self.x + self.w / 2

    @property
    def cy(self):
        return self.y + self.h / 2

    def row_y(self, col: str) -> float:
        row = self.rows.get(col)
        if row is None:
            return self.cy
        y = self.top - HEADER - 5 - row * LINE - LINE * 0.55
        return max(self.y + 8, min(self.top - HEADER - 2, y))


HEADER = 25.0
LINE = 16.4
NOTE_LINE = 11.4
CARD_W = 710.0
LEFT_X = 90.0
RIGHT_X = 870.0
CHANNEL = 835.0


def note_lines(table: Table, module_names: set[str]) -> list[tuple[str, list[str]]]:
    notes: list[tuple[str, str]] = []
    # составные и частичные уникальности
    for uq in table.uniques:
        text = uq[0].strip()
        m = re.match(r"^(.*?)(\s+WHERE\s+.*)$", text, re.I)
        cols_part, where = (m.group(1), m.group(2)) if m else (text, "")
        cols = [c.strip() for c in cols_part.split(",") if c.strip()]
        if len(cols) > 1:
            note = "(" + ", ".join(cols) + ")" + where
        elif where:
            note = "(" + cols[0] + ")" + where
        elif cols_part not in table.colmap:
            note = cols_part
        else:
            continue
        notes.append(("UQ", note))
    # ключевые CHECK/EXCLUDE
    for text in TABLE_CHK.get(table.name, []):
        kind, rest = text.split(" ", 1) if " " in text else (text, "")
        notes.append((kind, rest))
    # внешние ключи — текстом, чтобы не тянуть линии через весь лист
    seen = set()
    for fk in table.fks:
        if fk.ref_table in module_names:
            continue
        key = (fk.ref_table, fk.ref_columns)
        if key in seen:
            continue
        seen.add(key)
        ref = fk.ref_table + "." + ", ".join(fk.ref_columns)
        notes.append(("FK", f"→ {ref} (лист {TABLE_SHEET.get(fk.ref_table, '?')})"))
    # убрать дубли (например, UQ lower(login) из индекса и из ручной пометки)
    unique_notes: list[tuple[str, str]] = []
    seen_note = set()
    for kind, text in notes:
        key = (kind, text)
        if key in seen_note:
            continue
        seen_note.add(key)
        unique_notes.append((kind, text))
    out = []
    for kind, text in unique_notes:
        lines = wrap_text(text, 650, 7.0)
        out.append((kind, lines))
    return out


def card_height(table: Table, module_names: set[str]) -> float:
    n = len(table.columns)
    rows = math.ceil(n / 2) if n > 6 else n
    notes = note_lines(table, module_names)
    note_h = sum(len(lines) for _, lines in notes) * NOTE_LINE
    return HEADER + rows * LINE + (note_h + 10 if notes else 0) + 8


def make_card(table: Table, x: float, y_top: float, module_names: set[str],
              w: float = CARD_W) -> Card:
    h = card_height(table, module_names)
    card = Card(table, x, y_top - h, w, h)
    n = len(table.columns)
    for i, col in enumerate(table.columns):
        row = i // 2 if n > 6 else i
        card.rows[col.name] = row
    card.note_lines = note_lines(table, module_names)
    return card


def chain(schema, names, x, top, gap, module_names):
    y = top
    cards = []
    for name in names:
        c = make_card(schema[name], x, y, module_names)
        cards.append(c)
        y = c.y - gap
    return cards


def spread_chain(schema, names, x, top, bottom, module_names):
    """Цепочка с равномерными промежутками, заполняющая лист до bottom."""
    heights = [card_height(schema[n], module_names) for n in names]
    total = sum(heights)
    gap = (top - bottom - total) / max(1, len(names) - 1)
    gap = max(16.0, gap)
    y = top
    cards = []
    for name in names:
        c = make_card(schema[name], x, y, module_names)
        cards.append(c)
        y = c.y - gap
    return cards


def place_center(schema, name, x, cy, module_names):
    h = card_height(schema[name], module_names)
    return make_card(schema[name], x, cy + h / 2, module_names)


def draw_card(ax, card: Card, module):
    t = card.table
    color, light = module["color"], module["light"]
    block(ax, card.x, card.y, card.w, card.h, fc=WHITE, ec=color, lw=0.95,
          rounding=0, z=3)
    # шапка
    block(ax, card.x, card.top - HEADER, card.w, HEADER, fc=light, ec=color,
          lw=0.95, rounding=0, z=3)
    txt(ax, card.x + 7, card.top - 12, t.name, 8.7, color, weight="bold", ha="left", z=5)
    if t.service:
        txt(ax, card.right - 8, card.top - 12, "служебная", 6.9, AMBER,
            weight="bold", ha="right", z=5)
    else:
        txt(ax, card.right - 8, card.top - 12, f"{len(t.columns)} стлб.", 6.8,
            MUTED, ha="right", z=5)
    # строки
    n = len(t.columns)
    two = n > 6
    for i, col in enumerate(t.columns):
        row = i // 2 if two else i
        sub = i % 2 if two else 0
        x0 = card.x + 7 + sub * 355
        y = card.top - HEADER - 5 - row * LINE - LINE * 0.55
        if row % 2 == 1:
            block(ax, card.x + 2, y - LINE * 0.55, card.w - 4, LINE, fc="#f6f8f9",
                  ec="none", lw=0, rounding=0, z=3.2)
        txt(ax, x0, y, col.name, 7.2, INK, weight="bold" if col.pk else "normal",
            ha="left", z=5)
        txt(ax, x0 + 150, y, col.type, 7.0, SOFT, ha="left", z=5)
        fx = x0 + 278
        if col.pk:
            txt(ax, fx, y, "PK", 7.0, color, weight="bold", ha="left", z=5)
            fx += 20
        if col.fk:
            txt(ax, fx, y, "FK", 7.0, BLUE, weight="bold", ha="left", z=5)
            fx += 20
        if col.unique:
            txt(ax, fx, y, "UQ", 7.0, TEAL, weight="bold", ha="left", z=5)
            fx += 20
        if col.not_null and not col.pk:
            txt(ax, fx, y, "NN", 7.0, MUTED, ha="left", z=5)
    # примечания
    if card.note_lines:
        rows = math.ceil(n / 2) if n > 6 else n
        top_note = card.top - HEADER - 5 - rows * LINE - 6
        line(ax, [(card.x + 4, top_note + 2), (card.right - 4, top_note + 2)],
             color=color, lw=0.45, z=4)
        y = top_note - 7
        for kind, lines in card.note_lines:
            prefix_color = {"UQ": TEAL, "CHK": AMBER, "EXC": RED, "FK": BLUE}.get(kind, MUTED)
            txt(ax, card.x + 7, y, kind, 6.9, prefix_color, weight="bold", ha="left", z=5)
            for j, ln in enumerate(lines):
                txt(ax, card.x + 34, y, ln, 7.0, MUTED, ha="left", z=5)
                y -= NOTE_LINE


def safe_overlap(cards):
    for i in range(len(cards)):
        for j in range(i + 1, len(cards)):
            a, b = cards[i], cards[j]
            if (a.x < b.right - 2 and b.x < a.right - 2 and
                    a.y < b.top - 2 and b.y < a.top - 2):
                print(f"!! НАЛОЖЕНИЕ: {a.table.name} и {b.table.name}")
                return True
    return False


def draw_fk(ax, child: Card, parent: Card, fk: ForeignKey, cards: list[Card],
            color: str, idx: int, used_labels: list[tuple[float, float]]):
    one = fk_one_to_one(child.table.name, fk)

    # самоссылка (corrects_entry_id, supersedes_result_id) — петля сбоку
    if child is parent:
        cy = child.cy
        if child.x < 800:
            side = child.right + 30
            pts = [(child.right, cy + 20), (side, cy + 20), (side, cy - 20),
                   (child.right, cy - 20)]
            sdir, tdir = (-1, 0), (-1, 0)
        else:
            side = child.x - 30
            pts = [(child.x, cy + 20), (side, cy + 20), (side, cy - 20),
                   (child.x, cy - 20)]
            sdir, tdir = (1, 0), (1, 0)
        line(ax, pts, color=color, lw=0.75, z=2.9)
        crow(ax, pts[0], sdir, color=color, size=9, spread=4.5, z=4.4)
        arrowhead(ax, (pts[-1][0] + tdir[0] * 2, pts[-1][1]),
                  tdir, color=color, length=8, width=4.6, z=4.5)
        label(ax, side + (8 if child.x < 800 else -8), cy, "1:M", size=6.8,
              color=color, z=6)
        return

    between = [c for c in cards if c is not child and c is not parent
               and min(child.cy, parent.cy) < c.cy < max(child.cy, parent.cy)]
    same_col = abs(child.cx - parent.cx) < 60
    direct_vertical = same_col and not between

    if direct_vertical:
        if parent.cy > child.cy:
            pts = [(child.cx, child.top), (parent.cx, parent.y)]
            sdir, tdir = (0, -1), (0, 1)
        else:
            pts = [(child.cx, child.y), (parent.cx, parent.top)]
            sdir, tdir = (0, 1), (0, -1)
    elif same_col:
        # обход по внешнему краю колонки, вход в центр боковой грани
        if child.x < 800:
            ch = 812 + (idx % 4) * 4
            pts = [(child.right, child.cy), (ch, child.cy), (ch, parent.cy),
                   (parent.right, parent.cy)]
            sdir, tdir = (-1, 0), (-1, 0)
        else:
            ch = 858 + (idx % 4) * 4
            pts = [(child.x, child.cy), (ch, child.cy), (ch, parent.cy),
                   (parent.x, parent.cy)]
            sdir, tdir = (1, 0), (1, 0)
    else:
        # разные колонки: центр боковой грани → центр боковой грани
        if parent.cx > child.cx:
            if abs(child.cy - parent.cy) < 18:
                pts = [(child.right, child.cy), (parent.x, parent.cy)]
            else:
                ch = CHANNEL + ((idx % 5) - 2) * 4
                pts = [(child.right, child.cy), (ch, child.cy),
                       (ch, parent.cy), (parent.x, parent.cy)]
            sdir, tdir = (-1, 0), (1, 0)
        else:
            if abs(child.cy - parent.cy) < 18:
                pts = [(child.x, child.cy), (parent.right, parent.cy)]
            else:
                ch = CHANNEL + ((idx % 5) - 2) * 4
                pts = [(child.x, child.cy), (ch, child.cy),
                       (ch, parent.cy), (parent.right, parent.cy)]
            sdir, tdir = (1, 0), (-1, 0)

    line(ax, pts, color=color, lw=0.75, z=2.9)
    s_pt, t_pt = pts[0], pts[-1]
    if one:
        tick(ax, s_pt, sdir, color=color, length=9, z=4.4)
    else:
        crow(ax, s_pt, sdir, color=color, size=9, spread=4.5, z=4.4)
    # наконечник чуть заходит на границу, чтобы не было визуального зазора
    tip = (t_pt[0] + tdir[0] * 2.0, t_pt[1] + tdir[1] * 2.0)
    arrowhead(ax, tip, tdir, color=color, length=8, width=4.6, z=4.5)

    # одна подпись 1:M / 1:1; несколько вариантов вдоль линии, без наложений
    def inside(p):
        return any(c.x + 3 < p[0] < c.right - 3 and c.y + 3 < p[1] < c.top - 3
                   for c in cards)

    def clear_of_cards(q):
        # с запасом по ширине/высоте текста, чтобы не залезать на рамку и текст таблицы
        for c in cards:
            if not (q[0] + 16 < c.x or q[0] - 16 > c.right
                    or q[1] + 9 < c.y or q[1] - 9 > c.top):
                return False
        return True

    segs = sorted(zip(pts[:-1], pts[1:]), key=lambda s: math.dist(*s), reverse=True)
    candidates: list[tuple[float, float, bool]] = []
    for a, b in segs:
        for frac in (0.50, 0.33, 0.67, 0.20, 0.80):
            cx, cy = a[0] + (b[0] - a[0]) * frac, a[1] + (b[1] - a[1]) * frac
            if clear_of_cards((cx, cy)):
                candidates.append((cx, cy, abs(b[0] - a[0]) < 1))
    chosen = None
    for cx, cy, vert in candidates:
        if vert:
            side = -18 if cx > 840 else 18
            offsets = [(side, 0), (side, 22), (side, -22), (side, 44), (side, -44)]
        else:
            offsets = [(0, 14), (0, -14), (24, 14), (-24, 14)]
        for ox, oy in offsets:
            q = (cx + ox, cy + oy)
            if not clear_of_cards(q):
                continue
            if all((q[0] - ux) ** 2 + (q[1] - uy) ** 2 > 45 ** 2
                   for ux, uy in used_labels):
                chosen = q
                break
        if chosen:
            break
    if chosen is None:
        return
    used_labels.append(chosen)
    label(ax, chosen[0], chosen[1], "1:1" if one else "1:M", size=6.8,
          color=color, z=6)


# ---------------------------------------------------------------------------
# Рамка, штамп, легенда
# ---------------------------------------------------------------------------
def schema_frame(ax, sheet, total, title, subtitle):
    block(ax, FRAME[0], FRAME[1], FRAME[2], FRAME[3], fc="none", ec=INK, lw=1.2,
          rounding=0, z=10)
    txt(ax, FRAME[0] + 14, FRAME[1] + FRAME[3] - 28, title, 17.5, INK,
        weight="bold", ha="left", z=12)
    txt(ax, FRAME[0] + 14, FRAME[1] + FRAME[3] - 50, subtitle, 9.2, MUTED,
        ha="left", z=12)
    line(ax, [(FRAME[0] + 14, FRAME[1] + FRAME[3] - 61),
              (FRAME[0] + FRAME[2] - 14, FRAME[1] + FRAME[3] - 61)],
         color=RULE, lw=0.8, z=12)
    draw_title_block(ax, sheet, total)


def draw_title_block(ax, sheet, total):
    bw, bh = 480, 100
    x = FRAME[0] + FRAME[2] - bw
    y = FRAME[1]
    block(ax, x, y, bw, bh, fc=WHITE, ec=INK, lw=1.0, rounding=0, z=11)
    line(ax, [(x + 250, y), (x + 250, y + bh)], color=INK, lw=0.9, z=12)
    line(ax, [(x + 335, y), (x + 335, y + bh)], color=INK, lw=0.9, z=12)
    line(ax, [(x + 250, y + 50), (x + bw, y + 50)], color=INK, lw=0.8, z=12)
    txt(ax, x + 10, y + 80, "MEDCORE-DB", 10.0, INK, weight="bold", ha="left", z=12)
    txt(ax, x + 10, y + 58, "Схема базы данных", 8.0, INK, ha="left", z=12)
    txt(ax, x + 10, y + 38, "project · PostgreSQL 18", 6.8, MUTED, ha="left", z=12)
    txt(ax, x + 10, y + 17, "ГОСТ 2.104, упрощённо", 6.0, SOFT, ha="left", z=12)
    txt(ax, x + 258, y + 80, f"Лист {sheet}", 8.0, INK, weight="bold", ha="left", z=12)
    txt(ax, x + 258, y + 63, f"Листов {total}", 6.8, MUTED, ha="left", z=12)
    txt(ax, x + 258, y + 30, "Масштаб 1:1", 6.8, INK, ha="left", z=12)
    txt(ax, x + 258, y + 13, "Формат A3", 6.8, MUTED, ha="left", z=12)
    txt(ax, x + 343, y + 80, "Обозначение:", 6.2, MUTED, ha="left", z=12)
    txt(ax, x + 343, y + 62, "MEDCORE-DB-01", 7.0, INK, weight="bold", ha="left", z=12)
    txt(ax, x + 343, y + 36, "Стадия:", 6.2, MUTED, ha="left", z=12)
    txt(ax, x + 343, y + 18, "проектирование", 6.6, INK, ha="left", z=12)


def module_legend(ax, module):
    x, y, w, h = 95, 145, 1000, 108
    block(ax, x, y, w, h, fc="#fbfcfd", ec=RULE, lw=0.8, rounding=3, z=8)
    txt(ax, x + 10, y + h - 17, "Обозначения", 8.4, INK, weight="bold", ha="left", z=9)
    txt(ax, x + 10, y + h - 37,
        "PK — первичный ключ;   FK — внешний ключ;   UQ — уникальность;   NN — NOT NULL",
        7.4, MUTED, ha="left", z=9)
    txt(ax, x + 10, y + h - 57,
        "1:M / 1:1 — кардинальность;  линии — FK внутри листа, наконечник направлен к родителю.",
        7.3, MUTED, ha="left", z=9)
    txt(ax, x + 10, y + h - 77,
        "Внешние FK перечислены текстом в карточке;  рамка 20/10/10/10 мм;  A3;  300 dpi.",
        7.1, MUTED, ha="left", z=9)
    ax.plot([x + 10, x + 120], [y + 17, y + 17], color="#41637f", lw=0.9, zorder=9)
    arrowhead(ax, (x + 120, y + 17), (1, 0), color="#41637f", length=8, width=4.5, z=9)
    crow(ax, (x + 10, y + 17), (-1, 0), color="#41637f", size=8, spread=4, z=9)
    txt(ax, x + 130, y + 17, "многие → один", 6.8, MUTED, ha="left", z=9)


# ---------------------------------------------------------------------------
# Раскладки модулей
# ---------------------------------------------------------------------------
def layout_org(schema, names):
    left = chain(schema, ["medical_organizations", "hospitals", "polyclinics",
                          "buildings"], LEFT_X, 1045, 48, names)
    right = chain(schema, ["departments", "wards", "beds",
                           "department_specializations"], RIGHT_X, 1045, 48, names)
    return left + right


def layout_hr(schema, names):
    left = spread_chain(schema, ["employee_categories", "employees", "doctors",
                                 "doctor_specialties", "specialties"], LEFT_X, 1045, 365, names)
    right = spread_chain(schema, ["academic_degrees", "academic_titles", "employments",
                                  "consultation_assignments", "specialty_conditions"],
                         RIGHT_X, 1045, 365, names)
    return left + right


def layout_pat(schema, names):
    left = chain(schema, ["patients", "medical_cases", "appointments",
                          "prescriptions", "medical_record_entries"],
                 LEFT_X, 1045, 18, names)
    by = {c.table.name: c for c in left}
    att = place_center(schema, "patient_attachments", RIGHT_X, by["patients"].cy, names)
    cd = place_center(schema, "case_diagnoses", RIGHT_X, by["medical_cases"].cy, names)
    diag = place_center(schema, "diagnoses", RIGHT_X, 560, names)
    ad = place_center(schema, "appointment_doctors", RIGHT_X, by["appointments"].cy, names)
    return left + [att, cd, diag, ad]


def layout_hosp(schema, names):
    left = chain(schema, ["referrals", "hospitalizations", "bed_occupancies"],
                 LEFT_X, 1045, 40, names)
    right = chain(schema, ["attending_physician_history", "surgeries",
                           "surgery_participants"], RIGHT_X, 1000, 40, names)
    return left + right


def layout_lab(schema, names):
    left = chain(schema, ["laboratories", "laboratory_contracts", "lab_orders",
                          "lab_results"], LEFT_X, 1045, 38, names)
    right = chain(schema, ["laboratory_profiles", "laboratory_profile_links",
                           "lab_test_types"], RIGHT_X, 900, 35, names)
    return left + right


def layout_adm(schema, names):
    left = spread_chain(schema, ["users", "user_roles", "user_organization_scopes",
                                 "user_sessions"], LEFT_X, 1045, 372, names)
    right = spread_chain(schema, ["roles", "audit_logs", "report_exports",
                                  "business_rule_checks"], RIGHT_X, 1045, 372, names)
    return left + right


LAYOUTS = {
    "org": layout_org,
    "hr": layout_hr,
    "pat": layout_pat,
    "hosp": layout_hosp,
    "lab": layout_lab,
    "adm": layout_adm,
}


def draw_module_sheet(schema, module, sheet, total):
    fig, ax = canvas(W, H)
    names = set(module["tables"])
    schema_frame(ax, sheet, total,
                 f"Схема базы данных. Модуль «{module['title']}»",
                 f"{len(module['tables'])} таблиц · полные столбцы, PK/UQ/NOT NULL и связи FK · схема project")
    cards = LAYOUTS[module["key"]](schema, names)
    if safe_overlap(cards):
        raise SystemExit(f"Наложение карточек в модуле {module['key']}")
    for card in cards:
        if card.y < 350:
            raise SystemExit(f"Карточка {card.table.name} выходит ниже поля: y={card.y:.1f}")
    used_labels: list[tuple[float, float]] = []
    for i, card in enumerate(cards):
        for fk in card.table.fks:
            parent = next((c for c in cards if c.table.name == fk.ref_table), None)
            if parent is not None:
                draw_fk(ax, card, parent, fk, cards, module["color"], i, used_labels)
    for card in cards:
        draw_card(ax, card, module)
    module_legend(ax, module)
    cols = sum(len(t.columns) for t in schema.values() if t.name in names)
    fks = sum(len(t.fks) for t in schema.values() if t.name in names)
    block(ax, 95, 270, 1490, 76, fc="#f7f9fb", ec=RULE, lw=0.8,
          rounding=3, z=8)
    txt(ax, 110, 327,
        f"Модуль «{module['title']}»: {len(module['tables'])} таблиц, {cols} столбцов, {fks} FK",
        8.2, INK, weight="bold", ha="left", z=9)
    txt(ax, 110, 307, MODULE_NOTE[module["key"]], 7.4, MUTED, ha="left", z=9)
    txt(ax, 110, 287,
        "Линии — FK внутри листа (наконечник к родителю); внешние FK перечислены в карточках; полный перечень — лист 1.",
        7.1, MUTED, ha="left", z=9)
    check_bounds(fig, ax, f"DB {sheet}")
    out = OUT_DIR / f"db-schema-full-{sheet}-{module['key']}.png"
    save(fig, out)
    print(f"Лист {sheet}: {module['title']} — {len(module['tables'])} таблиц, "
          f"{sum(len(t.columns) for t in schema.values() if t.name in names)} столбцов -> {out.name}")
    return {c.table.name for c in cards}


# ---------------------------------------------------------------------------
# Обзор
# ---------------------------------------------------------------------------
MODULE_DESC = {
    "org": "Иерархия учреждения: больница → корпус → отделение → палата → койка; поликлиники.",
    "hr": "Сотрудники, врачи, специальности, трудоустройство и консультации.",
    "pat": "Карточка пациента, прикрепление, случаи, приёмы, диагнозы и записи.",
    "hosp": "Направления, госпитализации, размещение по койкам, операции.",
    "lab": "Лаборатории, профили, договоры, заказы и результаты.",
    "adm": "Пользователи, роли, области доступа, сессии, аудит, выгрузки.",
}

MODULE_NOTE = {
    "org": "Иерархия: больница → корпус → отделение → палата → койка; поликлиника — подтип организации.",
    "hr": "Врач — профиль сотрудника; трудоустройство и консультации — интервальные; справочник специальностей дополнен 14 строками (данные).",
    "pat": "Случай связывает пациента и организацию; у диагнозов — глава МКБ-10; приёмы, записи и назначения относятся к случаю.",
    "hosp": "Госпитализация связана с направлением и случаем; размещение и лечащий врач — интервалы; операции — отдельные события.",
    "lab": "Договор соединяет лабораторию и организацию; заказ и результат связаны со случаем; исправление результата — цепочкой.",
    "adm": "11 ролей; права = роль + область действия; сессии, аудит и выгрузки ссылаются на пользователя; business_rule_checks — служебная.",
}

PANEL_NOTE = {
    "org": "Подтипы больниц/поликлиник; иерархия корпусов и коек.",
    "hr": "Врач — профиль сотрудника; интервалы работы.",
    "pat": "Случай связывает пациента, учреждение и лечение.",
    "hosp": "Направление → госпитализация → размещение.",
    "lab": "Договор → заказ → результат.",
    "adm": "Роль + область действия; аудит и сессии.",
}


def overview_panel(ax, module, x, y, w, h):
    names = module["tables"]
    block(ax, x, y, w, h, fc=module["light"], ec=module["color"], lw=1.0,
          rounding=6, z=2)
    txt(ax, x + 12, y + h - 20, module["title"], 10.2, module["color"],
        weight="bold", ha="left", z=4)
    txt(ax, x + 12, y + h - 38, f"{len(names)} таблиц · лист {module['sheet']}",
        7.8, MUTED, ha="left", z=4)
    desc = wrap_text(MODULE_DESC[module["key"]], w - 24, 7.0)
    for i, ln in enumerate(desc[:2]):
        txt(ax, x + 12, y + h - 55 - i * 12, ln, 7.0, MUTED, ha="left", z=4)
    chip_w = (w - 30) / 2
    for i, name in enumerate(names):
        col = i % 2
        row = i // 2
        cx = x + 12 + col * (chip_w + 6)
        cy = y + h - 88 - row * 37
        fc = WHITE
        ec = module["color"]
        if name == "business_rule_checks":
            fc = AMBER_L
            ec = AMBER
        block(ax, cx, cy - 27, chip_w, 28, fc=fc, ec=ec, lw=0.6, rounding=3, z=4)
        txt(ax, cx + 6, cy - 13, name, 7.3, INK, ha="left", z=5)
        if name == "business_rule_checks":
            txt(ax, cx + chip_w - 5, cy - 13, "служ.", 6.2, AMBER,
                weight="bold", ha="right", z=5)
    txt(ax, x + 12, y + 38, PANEL_NOTE[module["key"]], 6.6, MUTED,
        ha="left", z=4)
    txt(ax, x + 12, y + 14, f"Полные столбцы — лист {module['sheet']}", 6.6,
        SOFT, ha="left", z=4)
    return (x, y, w, h)


def draw_overview(schema, total):
    fig, ax = canvas(W, H)
    schema_frame(ax, 1, total,
                 "Схема базы данных. Обзор 48 таблиц",
                 "Шесть модулей · все таблицы схемы project · межмодульные связи · полные столбцы — на листах 2–7")
    panels = {}
    positions = {
        "org": (95, 690, 470, 320), "hr": (610, 690, 470, 320),
        "pat": (1125, 690, 470, 320), "adm": (95, 290, 470, 320),
        "hosp": (610, 290, 470, 320), "lab": (1125, 290, 470, 320),
    }
    for module in MODULES:
        x, y, w, h = positions[module["key"]]
        panels[module["key"]] = overview_panel(ax, module, x, y, w, h)

    link_color = "#41637f"
    # горизонтальные связи верхнего ряда
    arrow(ax, [(565, 900), (610, 900)], color=link_color, lw=1.0, head=8)
    label(ax, 587, 916, "кадры", size=6.4, color=link_color)
    arrow(ax, [(1080, 900), (1125, 900)], color=link_color, lw=1.0, head=8)
    label(ax, 1102, 916, "случаи", size=6.4, color=link_color)
    # вертикальные и обходные связи
    arrow(ax, [(300, 690), (300, 610)], color=link_color, lw=1.0, head=8)
    label(ax, 310, 650, "доступ", size=6.4, color=link_color)
    arrow(ax, [(430, 690), (430, 660), (760, 660), (760, 610)],
          color=link_color, lw=1.0, head=8)
    label(ax, 590, 674, "госпитализации", size=6.4, color=link_color)
    arrow(ax, [(1320, 690), (1320, 610)], color=link_color, lw=1.0, head=8)
    label(ax, 1330, 650, "направления", size=6.4, color=link_color)
    arrow(ax, [(1470, 690), (1470, 610)], color=link_color, lw=1.0, head=8)
    label(ax, 1480, 650, "заказы", size=6.4, color=link_color)
    # нижняя связь административного модуля с лабораториями
    arrow(ax, [(300, 290), (300, 275), (1320, 275), (1320, 290)],
          color=link_color, lw=1.0, head=8)
    label(ax, 800, 260, "доступ к лабораториям и результатам", size=6.6, color=link_color)

    # легенда
    block(ax, 95, 150, 760, 95, fc="#fbfcfd", ec=RULE, lw=0.8, rounding=3, z=8)
    txt(ax, 105, 225, "Обозначения", 8.4, INK, weight="bold", ha="left", z=9)
    txt(ax, 105, 205,
        "Цветной блок — модуль; в нём перечислены все его таблицы. Стрелки — межмодульные FK.",
        7.2, MUTED, ha="left", z=9)
    txt(ax, 105, 187,
        "Полные столбцы, PK/UQ/NOT NULL и линии FK — на листах 2–7. Служебная таблица — business_rule_checks.",
        7.0, MUTED, ha="left", z=9)
    line(ax, [(105, 170), (190, 170)], color=link_color, lw=1.0, z=9)
    arrowhead(ax, (190, 170), (1, 0), color=link_color, length=8, width=4, z=9)
    txt(ax, 200, 170, "связь модулей", 6.8, MUTED, ha="left", z=9)

    check_bounds(fig, ax, "DB 1")
    out = OUT_DIR / "db-schema-full-1-overview.png"
    save(fig, out)
    print(f"Лист 1: обзор — {sum(len(m['tables']) for m in MODULES)} таблиц -> {out.name}")


def draw_all(schema):
    validate(schema)
    total = 7
    draw_overview(schema, total)
    covered = set()
    for module in MODULES:
        covered |= draw_module_sheet(schema, module, module["sheet"], total)
    missing = EXPECTED - covered
    if missing:
        raise SystemExit("Не показаны таблицы: " + ", ".join(sorted(missing)))
    print(f"Покрытие: {len(covered)} из {len(EXPECTED)} таблиц")


if __name__ == "__main__":
    schema = load_schema()
    validate(schema)
    if "--list" in sys.argv:
        for name in sorted(schema):
            t = schema[name]
            print(f"\n{name}  PK={','.join(t.pk)}  cols={len(t.columns)}")
            for c in t.columns:
                flags = "".join([" PK" if c.pk else "", " UQ" if c.unique else "",
                                 " NN" if c.not_null else "", " FK" if c.fk else ""])
                print(f"   {c.name:24s} {c.type:28s}{flags}")
            if t.uniques:
                print("   UQ:", t.uniques)
            if t.fks:
                print("   FK:", [(f.columns, f.ref_table, f.ref_columns) for f in t.fks])
    else:
        draw_all(schema)
