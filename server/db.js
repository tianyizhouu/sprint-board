'use strict';
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Render's managed Postgres requires TLS but uses an internal CA
  ssl: process.env.PGSSL === 'require' ? { rejectUnauthorized: false } : false,
  max: 10,
  idleTimeoutMillis: 30000,
});

pool.on('error', err => console.error('[pg] idle client error', err.message));

const q = (sql, params) => pool.query(sql, params);

/* -- Auto-migration on boot ----------------------------------------------
   Creates the schema and loads seed data the first time the app connects to an
   empty database. This is what makes deployment a single `git push`: no psql
   client needed, no shell access on the host, no manual step.

   Guarded two ways:
     - the full schema+seed only runs when the `tasks` table is absent, so it
       can never wipe data
     - takes a Postgres advisory lock, so two instances starting at the same
       time cannot both run it
   Set SEED_ON_INIT=false to create the schema without the demo rows.

   After that check, a short block of ADDITIVE_MIGRATIONS runs on every boot.
   Every statement is idempotent and non-destructive, so an already-deployed
   database is brought up to the current shape without a drop/recreate.        */
const MIGRATION_LOCK = 727301;

/* Additive, idempotent DDL. Safe to run repeatedly and never destroys data.
   Mirrors the canonical definitions in db/schema.sql; this is the path that
   upgrades a database that already holds rows. */
const ADDITIVE_MIGRATIONS = `
  ALTER TABLE tasks ADD COLUMN IF NOT EXISTS effort NUMERIC(6,1) NOT NULL DEFAULT 0;

  CREATE TABLE IF NOT EXISTS settings (
    id                 INTEGER PRIMARY KEY DEFAULT 1,
    project_name       TEXT NOT NULL DEFAULT 'Sprint Board',
    capacity_unit      TEXT NOT NULL DEFAULT 'Hours',
    unit_abbrev        TEXT NOT NULL DEFAULT 'h',
    default_capacity   NUMERIC(6,1) NOT NULL DEFAULT 40,
    sprint_length_days INTEGER NOT NULL DEFAULT 14,
    timezone           TEXT NOT NULL DEFAULT 'America/Chicago',
    version            INTEGER NOT NULL DEFAULT 1,
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by         TEXT,
    CONSTRAINT settings_single_row CHECK (id = 1)
  );

  CREATE TABLE IF NOT EXISTS people (
    name       TEXT PRIMARY KEY,
    capacity   NUMERIC(6,1),
    active     BOOLEAN NOT NULL DEFAULT true,
    version    INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  -- Guarantee the single settings row exists even on a database that predates
  -- the table (a fresh seed inserts its own row first, so this no-ops there).
  INSERT INTO settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

  -- Backfill people from names already present in the data, so an upgraded
  -- database has populated owner/reviewer dropdowns without needing a reseed.
  -- (On a fresh seed the seven people already exist, so every row no-ops.)
  INSERT INTO people (name)
  SELECT name FROM (
    SELECT owner            AS name FROM tasks
    UNION SELECT reviewer          FROM tasks
    UNION SELECT owner             FROM milestones
    UNION SELECT unnest(attendees) FROM meetings
  ) src
  WHERE name IS NOT NULL AND btrim(name) <> ''
  ON CONFLICT (name) DO NOTHING;
`;

async function migrate(){
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK]);

    const found = await client.query("SELECT to_regclass('public.tasks') AS t");
    let migrated = false;
    if (found.rows[0].t){
      console.log('[db] schema already present, skipping full migration');
    } else {
      console.log('[db] empty database detected - creating schema');
      const dir = path.join(__dirname, '..', 'db');
      await client.query(fs.readFileSync(path.join(dir, 'schema.sql'), 'utf8'));

      if (process.env.SEED_ON_INIT === 'false'){
        console.log('[db] SEED_ON_INIT=false, skipping seed data');
      } else {
        await client.query(fs.readFileSync(path.join(dir, 'seed.sql'), 'utf8'));
        console.log('[db] seed data loaded (mock data only)');
      }
      migrated = true;
    }

    // Always applied, whether the schema was just created or already existed.
    await client.query(ADDITIVE_MIGRATIONS);

    return { migrated };
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK]).catch(() => {});
    client.release();
  }
}

/* -- Per-table whitelist of client-editable columns ----------------------
   First line of defence against injection and privilege escalation: any field
   in the request that is not on this list is rejected outright.
   Never interpolate keys from req.body straight into SQL.                  */
const EDITABLE = {
  tasks:      ['sim','title','stream','owner','reviewer','status','pri','start_date','eta','prog','notes','effort'],
  meetings:   ['title','meeting_date','start_time','end_time','kind','attendees','agenda'],
  milestones: ['title','due_date','status','owner','notes'],
};

const ENTITY_OF = { tasks:'task', meetings:'meeting', milestones:'milestone' };

/* Value coercion / validation. Out-of-range values are clamped here rather
   than being pushed down to the database as an error. */
function coerce(table, field, raw){
  if (table === 'tasks' && field === 'prog'){
    const n = Number(raw);
    if (Number.isNaN(n)) throw new HttpError(400, 'prog must be a number');
    return Math.max(0, Math.min(100, Math.round(n)));
  }
  if (table === 'tasks' && field === 'effort'){
    if (raw === '' || raw === null || raw === undefined) return 0;   // cleared field -> 0
    const n = Number(raw);
    if (Number.isNaN(n)) throw new HttpError(400, 'effort must be a number');
    return Math.max(0, n);                                           // NUMERIC(6,1): Postgres rounds to 1 decimal
  }
  if (field === 'attendees'){
    if (!Array.isArray(raw)) throw new HttpError(400, 'attendees must be an array');
    return raw.map(String);
  }
  if (raw === '' && /(_date|^eta$)/.test(field)) return null;   // store empty dates as NULL
  return raw === undefined || raw === null ? null : String(raw);
}

class HttpError extends Error {
  constructor(status, message, extra){ super(message); this.status = status; Object.assign(this, extra || {}); }
}

/* -- Field-level update with optimistic locking -------------------------
   WHERE version = $expected: zero rows returned means somebody else got there
   first, which becomes a 409.
   This is the layer socket broadcasts cannot replace: sockets make you see a
   conflict sooner, but `version` is what decides who wins.                */
async function updateFields(table, id, patch, expectedVersion, actor){
  const allowed = EDITABLE[table];
  if (!allowed) throw new HttpError(400, 'unknown table');

  const fields = Object.keys(patch).filter(f => allowed.includes(f));
  if (!fields.length) throw new HttpError(400, 'no updatable fields supplied');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const before = await client.query(`SELECT * FROM ${table} WHERE id = $1 FOR UPDATE`, [id]);
    if (!before.rows.length) throw new HttpError(404, 'record not found');
    const row = before.rows[0];

    if (expectedVersion !== undefined && expectedVersion !== null
        && Number(expectedVersion) !== row.version){
      throw new HttpError(409, 'This record was modified by someone else', {
        conflict: true, current: row, lastEditor: row.updated_by,
      });
    }

    const sets = fields.map((f,i) => `${f} = $${i + 1}`);
    const vals = fields.map(f => coerce(table, f, patch[f]));

    /* Status/progress coupling lives on the server; the client must not be the
       only thing enforcing it. */
    if (table === 'tasks'){
      const nextStatus = fields.includes('status') ? patch.status : row.status;
      const nextProg   = fields.includes('prog')   ? coerce('tasks','prog',patch.prog) : row.prog;
      if (nextStatus === 'Done' && nextProg !== 100 && !fields.includes('prog')){
        sets.push(`prog = 100`); // literal, no parameter needed
      }
      if (nextProg === 100 && nextStatus !== 'Done' && !fields.includes('status')){
        sets.push(`status = 'Done'`);
      }
    }

    const sql = `UPDATE ${table}
                    SET ${sets.join(', ')},
                        version = version + 1,
                        updated_at = now(),
                        updated_by = $${vals.length + 1}
                  WHERE id = $${vals.length + 2} AND version = $${vals.length + 3}
              RETURNING *`;
    const res = await client.query(sql, [...vals, actor, id, row.version]);

    if (!res.rows.length){
      // FOR UPDATE should already have prevented this; kept as a belt-and-braces check
      throw new HttpError(409, 'Concurrent write conflict - please reload', { conflict: true, current: row });
    }

    const after = res.rows[0];
    for (const f of fields){
      const oldV = row[f], newV = after[f];
      if (String(oldV) !== String(newV)){
        await client.query(
          `INSERT INTO activity (entity, entity_id, field, old_value, new_value, actor, action)
           VALUES ($1,$2,$3,$4,$5,$6,'update')`,
          [ENTITY_OF[table], id, f, fmt(oldV), fmt(newV), actor]
        );
      }
    }

    await client.query('COMMIT');
    return after;
  } catch (e){
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

async function createRow(table, patch, actor){
  const allowed = EDITABLE[table];
  if (!allowed) throw new HttpError(400, 'unknown table');
  const fields = Object.keys(patch).filter(f => allowed.includes(f));
  if (!fields.length) throw new HttpError(400, 'no fields supplied');

  const vals = fields.map(f => coerce(table, f, patch[f]));
  const ph   = fields.map((_,i) => `$${i + 1}`);
  const res = await q(
    `INSERT INTO ${table} (${fields.join(',')}, updated_by)
     VALUES (${ph.join(',')}, $${fields.length + 1}) RETURNING *`,
    [...vals, actor]
  );
  const row = res.rows[0];
  await q(`INSERT INTO activity (entity, entity_id, actor, action, new_value)
           VALUES ($1,$2,$3,'create',$4)`,
          [ENTITY_OF[table], row.id, actor, row.title || String(row.id)]);
  return row;
}

async function deleteRow(table, id, actor){
  if (!EDITABLE[table]) throw new HttpError(400, 'unknown table');
  const res = await q(`DELETE FROM ${table} WHERE id = $1 RETURNING *`, [id]);
  if (!res.rows.length) throw new HttpError(404, 'record not found');
  await q(`INSERT INTO activity (entity, entity_id, actor, action, old_value)
           VALUES ($1,$2,$3,'delete',$4)`,
          [ENTITY_OF[table], id, actor, res.rows[0].title || String(id)]);
  return res.rows[0];
}

const fmt = v => v === null || v === undefined ? null
  : v instanceof Date ? v.toISOString().slice(0,10)
  : Array.isArray(v) ? v.join(', ') : String(v);

module.exports = { pool, q, migrate, updateFields, createRow, deleteRow, HttpError, EDITABLE, ENTITY_OF };
