'use strict';
const express = require('express');
const { q, updateFields, createRow, deleteRow, HttpError, ENTITY_OF } = require('../db');

/* Normalise date columns to YYYY-MM-DD in JSON so a timezone shift can never
   move a date by a day. */
function serialize(row){
  const out = {};
  for (const [k,v] of Object.entries(row)){
    out[k] = v instanceof Date && /(_date|^eta$)/.test(k) ? toISODate(v) : v;
  }
  return out;
}
const toISODate = d => {
  const x = new Date(d);
  x.setMinutes(x.getMinutes() - x.getTimezoneOffset());
  return x.toISOString().slice(0,10);
};

/**
 * @param {string} table    tasks | meetings | milestones
 * @param {string} orderBy  default ORDER BY clause
 * @param {() => import('socket.io').Server} getIO
 */
module.exports = function crudRouter(table, orderBy, getIO){
  const router = express.Router();
  const entity = ENTITY_OF[table];

  const broadcast = (event, payload, actor) => {
    const io = getIO();
    if (io) io.emit(event, { ...payload, _actor: actor });
  };

  router.get('/', async (req, res, next) => {
    try {
      const r = await q(`SELECT * FROM ${table} ORDER BY ${orderBy}`);
      res.json(r.rows.map(serialize));
    } catch (e){ next(e); }
  });

  router.post('/', async (req, res, next) => {
    try {
      const row = await createRow(table, req.body, req.actor);
      const payload = serialize(row);
      broadcast(`${entity}:created`, { row: payload }, req.actor);
      res.status(201).json(payload);
    } catch (e){ next(e); }
  });

  /* Field-level update. Body: { patch: {...}, version: N }
     PATCH rather than PUT on purpose: two people editing different fields of
     the same record should not conflict. */
  router.patch('/:id', async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id)) throw new HttpError(400, 'bad id');
      const patch   = req.body && req.body.patch ? req.body.patch : req.body;
      const version = req.body ? req.body.version : undefined;
      const row = await updateFields(table, id, patch, version, req.actor);
      const payload = serialize(row);
      broadcast(`${entity}:updated`, { row: payload }, req.actor);
      res.json(payload);
    } catch (e){ next(e); }
  });

  router.delete('/:id', async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id)) throw new HttpError(400, 'bad id');
      const row = await deleteRow(table, id, req.actor);
      broadcast(`${entity}:deleted`, { id }, req.actor);
      res.json({ id: row.id });
    } catch (e){ next(e); }
  });

  return router;
};

module.exports.serialize = serialize;
