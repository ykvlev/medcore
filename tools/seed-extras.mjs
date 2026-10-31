// Демонстрационные данные для снабжения, транспортировки и тяжёлых диагнозов.
// Использование:
//   TARGET_DATABASE_URL=postgresql://... node tools/seed-extras.mjs
// Без TARGET_DATABASE_URL данные пишутся в учебную базу из PG*-переменных .env.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try { process.loadEnvFile(path.join(root, '.env')); } catch (error) { if (error.code !== 'ENOENT') throw error; }

const url = process.env.TARGET_DATABASE_URL;
const connection = url
  ? { connectionString: url, ssl: /sslmode=disable/.test(url) ? false : { rejectUnauthorized: false } }
  : {
      host: process.env.PGHOST, port: Number(process.env.PGPORT ?? 5432), database: process.env.PGDATABASE,
      user: process.env.PGUSER, password: process.env.PGPASSWORD,
      ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: true }
    };

const items = [
  ['MED-001', 'Анальгин 500 мг, ампулы', 'medicine', 'уп.'],
  ['MED-002', 'Адреналин 0,1%, ампулы', 'medicine', 'уп.'],
  ['MED-003', 'Амоксициллин 500 мг', 'medicine', 'уп.'],
  ['MED-004', 'Гепарин 5000 ЕД', 'medicine', 'фл.'],
  ['MED-005', 'Инсулин короткого действия', 'medicine', 'фл.'],
  ['MED-006', 'Морфин 1%, ампулы', 'medicine', 'уп.'],
  ['MED-007', 'Норадреналин, ампулы', 'medicine', 'уп.'],
  ['MED-008', 'Омепразол 20 мг', 'medicine', 'уп.'],
  ['MED-009', 'Парацетамол 500 мг', 'medicine', 'уп.'],
  ['MED-010', 'Преднизолон 30 мг', 'medicine', 'уп.'],
  ['MED-011', 'Цефтриаксон 1 г', 'medicine', 'фл.'],
  ['MED-012', 'Раствор натрия хлорида 0,9% 500 мл', 'medicine', 'фл.'],
  ['CON-001', 'Шприц 5 мл', 'consumable', 'шт.'],
  ['CON-002', 'Шприц 20 мл', 'consumable', 'шт.'],
  ['CON-003', 'Система для инфузий', 'consumable', 'шт.'],
  ['CON-004', 'Перчатки смотровые', 'consumable', 'уп.'],
  ['CON-005', 'Маска медицинская', 'consumable', 'уп.'],
  ['CON-006', 'Бинт стерильный', 'consumable', 'шт.'],
  ['CON-007', 'Катетер венозный', 'consumable', 'шт.'],
  ['CON-008', 'Салфетки антисептические', 'consumable', 'уп.'],
  ['CON-009', 'Тест-полоски глюкозы', 'consumable', 'уп.'],
  ['CON-010', 'Контейнер для анализов', 'consumable', 'шт.'],
  ['CON-011', 'Набор для катетеризации', 'consumable', 'шт.'],
  ['CON-012', 'Плёнка для стерилизации', 'consumable', 'уп.']
];

const client = new Client({ ...connection, connectionTimeoutMillis: 20000, statement_timeout: 120000 });
await client.connect();
try {
  await client.query('BEGIN');

  const jurisdiction = (await client.query('SELECT id FROM project.medical_organizations ORDER BY id')).rows.map(r => r.id);
  const itemsInserted = await client.query(
    `INSERT INTO project.supply_items(code, name, category, unit)
     SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[])
     ON CONFLICT (code) DO UPDATE SET name = excluded.name, category = excluded.category, unit = excluded.unit
     RETURNING id`,
    [items.map(i => i[0]), items.map(i => i[1]), items.map(i => i[2]), items.map(i => i[3])]
  );
  const itemIds = (await client.query('SELECT id FROM project.supply_items ORDER BY id')).rows.map(r => r.id);

  // Остатки: часть позиций ниже минимума, чтобы отчёт о дефиците был содержательным.
  await client.query(
    `INSERT INTO project.supply_stock(organization_id, item_id, quantity, min_quantity)
     SELECT o, i, (10 + ((o * 7 + i * 13) % 90))::numeric, 30
     FROM unnest($1::bigint[]) o CROSS JOIN unnest($2::bigint[]) i
     ON CONFLICT (organization_id, item_id) DO NOTHING`,
    [jurisdiction, itemIds]
  );

  // Заказы: часть получена, часть в пути.
  for (let n = 1; n <= 15; n += 1) {
    const org = jurisdiction[(n * 3) % jurisdiction.length];
    const status = n % 4 === 0 ? 'ordered' : 'received';
    const orderedAt = `2026-10-${String((n % 27) + 1).padStart(2, '0')}T09:00:00+03:00`;
    const order = await client.query(
      `INSERT INTO project.supply_orders(organization_id, supplier, status, ordered_at, expected_at, received_at, note)
       VALUES ($1, $2, $3, $4::timestamptz, ($4::timestamptz + interval '5 days')::date,
               CASE WHEN $3 = 'received' THEN ($4::timestamptz + interval '3 days') ELSE NULL END,
               'Учебная поставка')
       RETURNING id`,
      [org, n % 2 === 0 ? 'Городской медицинский склад' : 'Учебная фармкомпания', status, orderedAt]
    );
    const orderId = order.rows[0].id;
    for (let k = 0; k < 3; k += 1) {
      const item = itemIds[(n * 5 + k) % itemIds.length];
      await client.query(
        `INSERT INTO project.supply_order_items(order_id, item_id, quantity, unit_price)
         VALUES ($1, $2, $3, $4) ON CONFLICT (order_id, item_id) DO NOTHING`,
        [orderId, item, 10 + k * 5, 100 + k * 250]
      );
    }
  }

  // Транспортировка: пациенты с госпитализацией, часть рейсов завершена.
  const patients = (await client.query(
    `SELECT DISTINCT h.patient_id FROM project.hospitalizations h ORDER BY h.patient_id LIMIT 60`
  )).rows.map(r => r.patient_id);
  for (let n = 0; n < 20; n += 1) {
    const patient = patients[(n * 7) % patients.length];
    const from = jurisdiction[(n * 5) % jurisdiction.length];
    let to = jurisdiction[(n * 5 + 4) % jurisdiction.length];
    if (to === from) to = jurisdiction[(n * 5 + 5) % jurisdiction.length];
    const status = n % 5 === 0 ? 'requested' : n % 5 === 1 ? 'in_progress' : 'completed';
    const requestedAt = `2026-10-${String((n % 27) + 1).padStart(2, '0')}T08:30:00+03:00`;
    await client.query(
      `INSERT INTO project.patient_transports(patient_id, from_organization_id, to_organization_id, status, reason,
              requested_at, started_at, completed_at, vehicle, accompanying_employee_id)
       VALUES ($1, $2, $3, $4, $5, $6::timestamptz,
               CASE WHEN $4 <> 'requested' THEN ($6::timestamptz + interval '20 minutes') ELSE NULL END,
               CASE WHEN $4 = 'completed' THEN ($6::timestamptz + interval '90 minutes') ELSE NULL END,
               $7, (SELECT id FROM project.employees ORDER BY id LIMIT 1 OFFSET $8))`,
      [patient, from, to, status, n % 2 === 0 ? 'Перевод в учреждение с нужным профилем' : 'Доставка на исследование',
       requestedAt, n % 3 === 0 ? 'Реанимобиль' : 'Санитарный транспорт', n % 20]
    );
  }

  // Тяжёлые диагнозы: часть случаев получает опасные состояния.
  await client.query(
    `WITH severe AS (
        SELECT array_agg(id) AS ids FROM project.diagnoses
        WHERE code IN ('I21.0','I21.4','I26.9','I60.9','I61.9','A40.9','A41.9','J96.0','K72.9','K92.2','N17.9','S06.5','T78.2','G41.9')
     ), targets AS (
        SELECT id, row_number() OVER (ORDER BY random()) AS rn FROM project.case_diagnoses LIMIT 120
     )
     UPDATE project.case_diagnoses cd
     SET diagnosis_id = severe.ids[1 + (targets.rn % array_length(severe.ids, 1))]
     FROM targets, severe
     WHERE cd.id = targets.id`
  );

  const summary = await client.query(`SELECT
      (SELECT count(*)::int FROM project.supply_items) AS items,
      (SELECT count(*)::int FROM project.supply_orders) AS orders,
      (SELECT count(*)::int FROM project.patient_transports) AS transports,
      (SELECT count(*)::int FROM project.diagnoses WHERE code IN ('I21.0','A41.9','S06.5','T78.2')) AS severe_codes`);
  console.log('готово:', JSON.stringify(summary.rows[0]));
  await client.query('COMMIT');
} catch (error) {
  await client.query('ROLLBACK').catch(() => {});
  console.error('ошибка:', error.message);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
