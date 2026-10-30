-- MEDCORE, миграция 005: расширение справочника врачебных специальностей.
-- Добавляет распространённые специальности, чтобы карточку сотрудника можно было
-- заполнить полноценно. Существующие специальности и назначения не меняются.
BEGIN;
SET LOCAL search_path = project, public;
SELECT set_config('medcore.actor_user_id',
    coalesce((SELECT id::text FROM project.users WHERE login = 'admin'), ''), true);
SELECT set_config('medcore.request_id', 'migration-005', true);

INSERT INTO project.specialties(code, name, allows_surgery) VALUES
    ('cardiologist', 'Кардиолог', false),
    ('pediatrician', 'Педиатр', false),
    ('endocrinologist', 'Эндокринолог', false),
    ('urologist', 'Уролог', true),
    ('traumatologist', 'Травматолог-ортопед', true),
    ('oncologist', 'Онколог', true),
    ('psychiatrist', 'Психиатр', false),
    ('gastroenterologist', 'Гастроэнтеролог', false),
    ('pulmonologist', 'Пульмонолог', false),
    ('dermatologist', 'Дерматовенеролог', false),
    ('infectious_disease', 'Инфекционист', false),
    ('nephrologist', 'Нефролог', false),
    ('otolaryngologist', 'Оториноларинголог', true),
    ('functional_diagnostics', 'Врач функциональной диагностики', false)
ON CONFLICT (code) DO UPDATE SET name = excluded.name, allows_surgery = excluded.allows_surgery;

COMMIT;
