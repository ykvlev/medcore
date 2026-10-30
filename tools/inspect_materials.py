from pathlib import Path
import shutil, json, hashlib
from docx import Document
from pypdf import PdfReader

root = Path(__file__).resolve().parents[1]
sources = root / 'materials' / 'originals'
extracted = root / 'materials' / 'extracted'
sources.mkdir(parents=True, exist_ok=True)
extracted.mkdir(parents=True, exist_ok=True)
downloads = Path.home() / 'Downloads'
names = ['ГОСТ Р 59793-2021.pdf', 'ГОСТ 2.105-2019.pdf', 'ГОСТ 7.32-2017.pdf', 'ГОСТ 19.001-77.pdf', 'ГОСТ 19.101-24.pdf', 'ГОСТ 19.201-78 (1).pdf', 'ГОСТ 19.202-78.pdf', 'ГОСТ 34.201-2020.pdf', 'ГОСТ 34.601-90.pdf', 'ГОСТ 34.602-20.pdf', 'Аннотация.docx', 'Поянительная записка.docx', 'Содержание.docx', 'План-график.docx', 'Ведомость.docx', 'Введение.docx']
paths = [downloads / name for name in names]
paths.append(Path(r'C:\Users\tema6\.codex\attachments\0fc38239-dd44-4a04-94b8-a70051481e3f\Вставленный текст.txt'))
paths.extend(Path(r'C:\Users\tema6\AppData\Local\Temp') / name for name in ['codex-clipboard-e7153345-ca1f-45b4-bdfe-9095624243b6.png', 'codex-clipboard-a5d4b90b-e6b9-4acf-9cba-a611d344edca.png', 'codex-clipboard-bddf339d-43b0-4176-897e-30a7bb0d8214.png', 'codex-clipboard-fae3658b-a2fb-485a-af1f-a0af43049713.png', 'codex-clipboard-5a14226e-68ae-4797-a688-fc2423a4d6b9.png', 'codex-clipboard-e56cf3cf-5de7-43b5-826c-4a17087d42de.png', 'codex-clipboard-f897633e-1fab-469b-a181-0331209bf91e.png', 'codex-clipboard-5ad63904-d897-43bb-bcb9-85741f2d6bef.png'])
manifest = []
for src in paths:
    entry = {'source': str(src), 'exists': src.exists()}
    if not src.exists():
        manifest.append(entry)
        continue
    dst = sources / ('MEDCORE-ТЗ.txt' if src.suffix == '.txt' else src.name)
    shutil.copy2(src, dst)
    entry.update(copy=str(dst.relative_to(root)), sha256=hashlib.sha256(dst.read_bytes()).hexdigest())
    if dst.suffix == '.pdf':
        pdf = PdfReader(dst)
        texts = [f'\n--- Страница {i+1} ---\n{page.extract_text()}' for i, page in enumerate(pdf.pages)]
        entry.update(pages=len(pdf.pages), text_characters=sum(map(len, texts)))
        (extracted / (dst.stem + '.txt')).write_text(''.join(texts), encoding='utf-8')
    elif dst.suffix == '.docx':
        doc = Document(dst)
        text = '\n'.join(p.text for p in doc.paragraphs)
        for i, table in enumerate(doc.tables):
            text += f'\n\nТаблица {i+1}\n' + '\n'.join(' | '.join(c.text for c in row.cells) for row in table.rows)
        (extracted / (dst.stem + '.txt')).write_text(text, encoding='utf-8')
        entry['sections'] = [{'width_mm': round(s.page_width.mm, 1), 'height_mm': round(s.page_height.mm, 1), 'left_mm': round(s.left_margin.mm, 1), 'right_mm': round(s.right_margin.mm, 1), 'top_mm': round(s.top_margin.mm, 1), 'bottom_mm': round(s.bottom_margin.mm, 1)} for s in doc.sections]
        entry['styles'] = {name: {'font': doc.styles[name].font.name, 'size_pt': doc.styles[name].font.size.pt if doc.styles[name].font.size else None} for name in ['Normal', 'Title', 'Heading 1', 'Heading 2'] if name in doc.styles}
        entry['text_characters'] = len(text)
    manifest.append(entry)
(root / 'materials' / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf-8')
for e in manifest:
    print(Path(e['source']).name, 'OK' if e['exists'] else 'MISSING', e.get('pages', ''), e.get('text_characters', ''))
