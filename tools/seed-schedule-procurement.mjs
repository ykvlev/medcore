// Демо-данные для миграции 008: расписание и талоны, закупки, маршруты перевозок.
// Использование:
//   TARGET_DATABASE_URL=postgresql://... node tools/seed-schedule-procurement.mjs
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

const suppliers = [
  ['Городской медицинский склад', '7701000001', 'склад@example.test'],
  ['Учебная фармкомпания', '7701000002', 'sales@example.test'],
  ['МедТехника Поставка', '7701000003', 'info@example.test'],
  ['Расходники Плюс', '7701000004', 'order@example.test'],
  ['ФармЛогистика', '7701000005', 'logistics@example.test'],
  ['СтерильСервис', '7701000006', 'service@example.test']
];

const client = new Client({ ...connection, connectionTimeoutMillis: 20000, statement_timeout: 180000 });
await client.connect();
try {
  await client.query('BEGIN');

  const orgs = (await client.query('SELECT id FROM project.medical_organizations ORDER BY id')).rows.map(r => r.id);
  const doctors = (await client.query(`
      SELECT DISTINCT ON (d.employee_id) d.employee_id, em.organization_id
      FROM project.doctors d
      JOIN project.employments em ON em.employee_id = d.employee_id AND em.ended_on IS NULL
      ORDER BY d.employee_id, em.started_on DESC
      LIMIT 14`)).rows;
  const patients = (await client.query('SELECT id FROM project.patients ORDER BY id LIMIT 300')).rows.map(r => r.id);

  // Расписание на 7 дней вперёд: 09:00–12:00, слоты по 30 минут.
  for (const doctor of doctors) {
    for (let day = 0; day < 7; day += 1) {
      const schedule = await client.query(`
          INSERT INTO project.doctor_schedules(doctor_id, organization_id, work_date, start_time, end_time, slot_minutes, cabinet)
          VALUES ($1, $2, (current_date + $3::int), '09:00', '12:00', 30, $4)
          ON CONFLICT DO NOTHING
          RETURNING id, work_date, start_time, end_time, slot_minutes`,
        [doctor.employee_id, doctor.organization_id, day, `каб. ${100 + (doctor.employee_id % 40)}`]
      );
      const row = schedule.rows[0];
      if (!row) continue;
      await client.query(`
          INSERT INTO project.appointment_slots(schedule_id, doctor_id, organization_id, starts_at, ends_at)
          SELECT $1, $2, $3,
                 (($4::date + ($5::time + (n * $6::int) * interval '1 minute')) AT TIME ZONE 'Europe/Moscow'),
                 (($4::date + ($5::time + ((n + 1) * $6::int) * interval '1 minute')) AT TIME ZONE 'Europe/Moscow')
          FROM generate_series(0, (extract(epoch FROM ($7::time - $5::time)) / 60 / $6::int)::int - 1) AS n
          ON CONFLICT (doctor_id, starts_at) DO NOTHING`,
        [row.id, doctor.employee_id, doctor.organization_id, row.work_date, row.start_time, row.slot_minutes, row.end_time]
      );
    }
  }

  // Часть талонов занята: половина — будущие записи, половина — завершённые приёмы.
  await client.query(`
      WITH free AS (
          SELECT id, row_number() OVER (ORDER BY starts_at, id) AS rn
          FROM project.appointment_slots WHERE status = 'free'
      )
      UPDATE project.appointment_slots s
      SET status = CASE WHEN f.rn % 2 = 0 THEN 'booked' ELSE 'completed' END,
          patient_id = ($1::bigint[])[(f.rn % array_length($1::bigint[], 1)) + 1],
          booked_at = now() - (f.rn || ' hours')::interval
      FROM free f
      WHERE s.id = f.id AND f.rn <= 60`,
    [patients]
  );

  // Поставщики, договоры, тендеры и счета.
  const supplierIds = [];
  for (const [name, inn, contact] of suppliers) {
    const r = await client.query(
      `INSERT INTO project.suppliers(name, inn, contact) VALUES ($1, $2, $3)
       ON CONFLICT (name) DO UPDATE SET inn = excluded.inn, contact = excluded.contact
       RETURNING id`, [name, inn, contact]);
    supplierIds.push(r.rows[0].id);
  }

  const contractIds = [];
  for (let n = 0; n < orgs.length; n += 1) {
    const r = await client.query(
      `INSERT INTO project.procurement_contracts(organization_id, supplier_id, number, signed_at, valid_until, amount, status, note)
       VALUES ($1, $2, $3, current_date - $4::int, current_date + $5::int, $6, $7, 'Учебный договор поставки')
       ON CONFLICT (organization_id, number) DO NOTHING
       RETURNING id`,
      [orgs[n], supplierIds[n % supplierIds.length], `Д-${2026}-${String(n + 1).padStart(3, '0')}`,
       30 + n, 200 + n, 150000 + n * 25000, n % 5 === 0 ? 'closed' : 'active']
    );
    if (r.rows[0]) contractIds.push(r.rows[0].id);
  }

  for (let n = 0; n < 6; n += 1) {
    const status = n % 3 === 0 ? 'awarded' : n % 3 === 1 ? 'announced' : 'evaluating';
    await client.query(
      `INSERT INTO project.procurement_tenders(organization_id, title, announced_at, closes_at, status, budget, winner_supplier_id, note)
       VALUES ($1, $2, now() - ($3 || ' days')::interval, now() + ($4 || ' days')::interval, $5, $6, $7, 'Учебная закупка')
       ON CONFLICT DO NOTHING`,
      [orgs[n % orgs.length], `Закупка расходников № ${n + 1}`, 10 + n, 5 + n, status,
       80000 + n * 15000, status === 'awarded' ? supplierIds[n % supplierIds.length] : null]
    );
  }

  for (const contractId of contractIds) {
    for (let k = 0; k < 2; k += 1) {
      const status = k === 0 ? 'paid' : (contractId % 3 === 0 ? 'overdue' : 'issued');
      await client.query(
        `INSERT INTO project.supplier_invoices(contract_id, number, issued_at, due_at, amount, status, paid_at)
         VALUES ($1, $2, current_date - (20 - $3::int), current_date + (10 - $3::int), $4, $5,
                 CASE WHEN $5 = 'paid' THEN now() - interval '2 days' ELSE NULL END)
         ON CONFLICT (contract_id, number) DO NOTHING`,
        [contractId, `СЧ-${contractId}-${k + 1}`, k * 5, 45000 + k * 15000, status]
      );
    }
  }

  // Маршрут и пробег для существующих перевозок.
  await client.query(`
      UPDATE project.patient_transports
      SET distance_km = 4 + (id * 7 % 38),
          route_points = jsonb_build_array(
              jsonb_build_object('lat', 55.7512 + (id % 7) * 0.004, 'lng', 37.6184 + (id % 5) * 0.005, 'label', 'Пункт отправления'),
              jsonb_build_object('lat', 55.7601 + (id % 5) * 0.003, 'lng', 37.6302 + (id % 3) * 0.004, 'label', 'Промежуточная точка'),
              jsonb_build_object('lat', 55.7688 + (id % 3) * 0.002, 'lng', 37.6421 + (id % 7) * 0.003, 'label', 'Пункт назначения')
          ),
          odometer_start = 12000 + (id * 137) % 40000,
          odometer_end = 12000 + (id * 137) % 40000 + (4 + (id * 7 % 38))::int,
          fuel_liters = round((4 + (id * 7 % 38)) * 0.12, 1)
      WHERE route_points IS NULL`
  );

  const summary = await client.query(`SELECT
      (SELECT count(*)::int FROM project.doctor_schedules) AS schedules,
      (SELECT count(*)::int FROM project.appointment_slots) AS slots,
      (SELECT count(*)::int FROM project.appointment_slots WHERE status <> 'free') AS booked,
      (SELECT count(*)::int FROM project.suppliers) AS suppliers,
      (SELECT count(*)::int FROM project.procurement_contracts) AS contracts,
      (SELECT count(*)::int FROM project.procurement_tenders) AS tenders,
      (SELECT count(*)::int FROM project.supplier_invoices) AS invoices,
      (SELECT count(*)::int FROM project.patient_transports WHERE route_points IS NOT NULL) AS routes`);
  console.log('готово:', JSON.stringify(summary.rows[0]));
  await client.query('COMMIT');
} catch (error) {
  await client.query('ROLLBACK').catch(() => {});
  console.error('ошибка:', error.message);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
