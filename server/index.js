'use strict';
require('./env');                    // must run before anything reads process.env
const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const { q, migrate, HttpError } = require('./db');
const crudRouter = require('./routes/crud');

const app  = express();
const srv  = http.createServer(app);

/* Render requires listening on the PORT it injects; a hardcoded port fails to deploy */
const PORT = process.env.PORT || 3000;

const io = new Server(srv, {
  path: '/socket.io',
  cors: { origin: process.env.CORS_ORIGIN || true, credentials: true },
});
const getIO = () => io;

app.set('trust proxy', 1);                       // ALB and Render both sit a proxy in front
app.use(express.json({ limit: '256kb' }));
app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: '5m' }));

/* -- actor -------------------------------------------------
   Demo-grade "identity": the client puts a display name in the X-Actor header.
   This is NOT authentication - anyone can forge it. In production this must be
   replaced with Entra ID / OIDC, taking identity from a verified token.
   Search for REPLACE-WITH-SSO to find every place that needs changing.   */
app.use((req, res, next) => {                    // REPLACE-WITH-SSO
  const raw = req.get('X-Actor') || '';
  req.actor = raw.trim().slice(0, 40) || 'Anonymous';
  next();
});

app.get('/api/health', async (req, res) => {
  try {
    await q('SELECT 1');
    res.json({ ok: true, db: 'up', demo: true });
  } catch (e){
    res.status(503).json({ ok: false, db: 'down', error: e.message });
  }
});

app.get('/api/meta', (req, res) => {
  res.json({
    actor: req.actor,
    demo: true,
    people:   ['Kevin','Alice','Bob','Maya','Daniel','Mike','Charlie'],
    streams:  ['Backend','Frontend','QA','PMO'],
    statuses: ['Not Started','In Progress','In Review','Blocked','Done'],
    pris:     ['P0','P1','P2'],
    msStatuses: ['On Track','At Risk','Missed','Done'],
    kinds:    ['Stand-up','Review','Planning','Internal','Client'],
  });
});

app.use('/api/tasks',      crudRouter('tasks',      'eta NULLS LAST, id',        getIO));
app.use('/api/meetings',   crudRouter('meetings',   'meeting_date, start_time',  getIO));
app.use('/api/milestones', crudRouter('milestones', 'due_date, id',              getIO));

/* Activity feed - backs the Activity section in the task drawer */
app.get('/api/activity', async (req, res, next) => {
  try {
    const { entity, id, limit } = req.query;
    const lim = Math.min(200, Math.max(1, Number(limit) || 40));
    const rows = entity && id
      ? await q(`SELECT * FROM activity WHERE entity=$1 AND entity_id=$2
                 ORDER BY at DESC LIMIT $3`, [entity, Number(id), lim])
      : await q(`SELECT * FROM activity ORDER BY at DESC LIMIT $1`, [lim]);
    res.json(rows.rows);
  } catch (e){ next(e); }
});

/* SPA fallback - must come after the API routes or it swallows their 404s */
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api') || req.path.startsWith('/socket.io')) return next();
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

/* -- Central error handler ----------------------------------------------- */
app.use((err, req, res, next) => {                                  // eslint-disable-line
  const status = err.status || 500;
  if (status >= 500) console.error('[api]', err);
  const body = { error: err.message || 'server error' };
  if (err.conflict){
    body.conflict = true;
    body.current = err.current ? crudRouter.serialize(err.current) : undefined;
    body.lastEditor = err.lastEditor;
  }
  res.status(status).json(body);
});

/* -- Socket.IO: broadcast only, never writes ----------------------------
   All mutations go through HTTP PATCH, which keeps status codes, curl-based
   debugging and retry semantics. The socket only tells other clients that
   something changed.                                                      */
const online = new Map();   // socket.id -> name

io.on('connection', socket => {
  const name = String(socket.handshake.auth?.actor || 'Anonymous').slice(0, 40);
  online.set(socket.id, name);
  io.emit('presence', [...new Set(online.values())]);

  socket.on('disconnect', () => {
    online.delete(socket.id);
    io.emit('presence', [...new Set(online.values())]);
  });
});

async function start(){
  if (!process.env.DATABASE_URL){
    console.error('[fatal] DATABASE_URL is not set. See README for local setup.');
    process.exit(1);
  }
  try {
    await migrate();
  } catch (e){
    console.error('[fatal] database setup failed:', e.message);
    console.error('        Check DATABASE_URL and that Postgres is reachable.');
    process.exit(1);
  }
  srv.listen(PORT, '0.0.0.0', () => {
    console.log(`[sprint-board] listening on :${PORT}  (DEMO -- mock data only)`);
    console.log(`[sprint-board] open http://localhost:${PORT}`);
  });
}

start();

/* Graceful shutdown: Render sends SIGTERM on redeploy */
for (const sig of ['SIGTERM','SIGINT']){
  process.on(sig, () => {
    console.log(`[sprint-board] ${sig} received, closing`);
    srv.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 8000);
  });
}
