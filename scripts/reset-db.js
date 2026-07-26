'use strict';
/* Drop every table and rebuild from schema.sql + seed.sql.
   Destructive by design - intended for the demo database only.
   Usage: npm run db:reset */
require('../server/env');
const fs = require('fs');
const path = require('path');
const { pool } = require('../server/db');

(async () => {
  if (!process.env.DATABASE_URL){
    console.error('DATABASE_URL is not set.');
    process.exit(1);
  }
  const dir = path.join(__dirname, '..', 'db');
  const client = await pool.connect();
  try {
    console.log('[reset] dropping tables');
    await client.query('DROP TABLE IF EXISTS activity, tasks, meetings, milestones CASCADE');
    console.log('[reset] applying schema');
    await client.query(fs.readFileSync(path.join(dir, 'schema.sql'), 'utf8'));
    console.log('[reset] loading seed data');
    await client.query(fs.readFileSync(path.join(dir, 'seed.sql'), 'utf8'));
    console.log('[reset] done');
  } catch (e){
    console.error('[reset] failed:', e.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
})();
