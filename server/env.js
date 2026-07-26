'use strict';
/* Minimal .env loader - no dependency.
   Reads a .env file from the project root if present and copies any keys that
   are not already set in process.env. Real environments (Render, ECS, Azure)
   inject variables directly, so the file is optional everywhere. */
const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '..', '.env');
if (fs.existsSync(file)){
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)){
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))){
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
  console.log('[env] loaded .env');
}
