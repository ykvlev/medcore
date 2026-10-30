"""Сборка ведомости документов MEDCORE по выданному шаблону.

Шаблон: docs/deliverables/templates/Ведомость-шаблон.docx (форма с основной надписью).
Скрипт копирует шаблон и заменяет реквизиты, сохраняя всё оформление, объединения
ячеек, границы и ширины столбцов. Запуск:

    python tools/build-vedomost.py
"""

from __future__ import annotations

import copy
import shutil
from pathlib import Path

import docx
from docx.oxml.ns import qn

ROOT = Path(__file__).resolve().parents[1]
TEMPLATE = ROOT / "docs" / "deliverables" / "templates" / "Ведомость-шаблон.docx"
OUTPUT = ROOT / "docs" / "deliverables" / "Ведомость-MEDCORE.docx"

DESIGNATION = "ПТК.КП 5996 01.000ПЗ"
TITLE = "ИНФОРМАЦИОННАЯ СИСТЕМА ДЛЯ МЕДИЦИНСКИХ ОРГАНИЗАЦИЙ ГОРОДА"
DEVELOPER = "Яковлев А.С."
SUPERVISOR = "Цымбалюк Л.Н."
SHEETS = "102"  # число листов пояснительной записки по фактической вёрстке


def set_text(cell: docx.table._Cell, text: str) -> None:
    """Заменяет текст ячейки, сохраняя шрифт первого прогона и выравнивание."""
    paragraph = cell.paragraphs[0]
    run_properties = None
    if paragraph.runs:
        run_properties = copy.deepcopy(paragraph.runs[0]._element.get_or_add_rPr())
    for extra in cell.paragraphs[1:]:
        extra._element.getparent().remove(extra._element)
    for run in list(paragraph.runs):
        run._element.getparent().remove(run._element)
    run = paragraph.add_run(text)
    if run_properties is not None:
        run._element.insert(0, run_properties)


def unique_cells(row: docx.table._Row) -> dict[int, docx.table._Cell]:
    """Возвращает ячейки строки по исходным индексам столбцов без повторов объединений."""
    seen: set[int] = set()
    result: dict[int, docx.table._Cell] = {}
    for index, cell in enumerate(row.cells):
        key = id(cell._tc)
        if key in seen:
            continue
        seen.add(key)
        result[index] = cell
    return result


def strip_highlight(paragraph: docx.text.paragraph.Paragraph) -> None:
    """Убирает жёлтую заливку шаблона, сохраняя остальное оформление прогона."""
    for run in paragraph.runs:
        properties = run._element.find(qn("w:rPr"))
        if properties is None:
            continue
        highlight = properties.find(qn("w:highlight"))
        if highlight is not None:
            properties.remove(highlight)


def main() -> None:
    shutil.copyfile(TEMPLATE, OUTPUT)
    document = docx.Document(OUTPUT)
    table = document.tables[0]

    rows = {index: unique_cells(row) for index, row in enumerate(table.rows)}

    # Строка 6 — пояснительная записка.
    set_text(rows[6][1], "А4")
    set_text(rows[6][2], DESIGNATION)
    set_text(rows[6][6], " Пояснительная записка")
    set_text(rows[6][8], SHEETS)

    # Основная надпись: обозначение документа и тема.
    replacements = {
        "ПТК.КП 2996 01.000ПЗ": DESIGNATION,
        "РАЗРАБОТКА АВТОМАТИЗИРОВАННОЙ СИСТЕМЫ ДЛЯ МАГАЗИНА ОБУВИ": TITLE,
        "ФИО": DEVELOPER,
        "Сазонова Н.В.": SUPERVISOR,
    }
    seen: set[int] = set()
    for row in table.rows:
        for cell in row.cells:
            key = id(cell._tc)
            if key in seen:
                continue
            seen.add(key)
            text = cell.text.strip()
            if text in replacements:
                set_text(cell, replacements[text])

    # Жёлтая заливка в шаблоне отмечает поле, которое нужно заполнить;
    # в готовом документе она не нужна.
    for paragraph in document.paragraphs:
        strip_highlight(paragraph)
    for table in document.tables:
        for row in table.rows:
            for cell in row.cells:
                for paragraph in cell.paragraphs:
                    strip_highlight(paragraph)

    document.save(OUTPUT)
    print(f"Сохранено: {OUTPUT.relative_to(ROOT)}")

if __name__ == "__main__":
    main()
