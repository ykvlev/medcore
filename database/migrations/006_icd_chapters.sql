-- MEDCORE, миграция 006: главы МКБ-10 для пяти базовых диагнозов.
-- На учебной базе эти коды были заменены из DEMO-01…05 и уже имеют главу.
-- На чистой установке демонстрационный набор вставляет их до миграции 004,
-- когда колонки chapter ещё нет, поэтому глава заполняется здесь.
BEGIN;
SET LOCAL search_path = project, public;
SELECT set_config('medcore.actor_user_id',
    coalesce((SELECT id::text FROM project.users WHERE login = 'admin'), ''), true);
SELECT set_config('medcore.request_id', 'migration-006', true);

UPDATE project.diagnoses d
SET chapter = v.chapter
FROM (VALUES
    ('I10', 'IX'),
    ('E11.9', 'IV'),
    ('J18.9', 'X'),
    ('K29.7', 'XI'),
    ('M54.5', 'XIII')
) AS v(code, chapter)
WHERE d.code = v.code AND d.chapter IS NULL;

COMMIT;
