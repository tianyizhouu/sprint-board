-- ============================================================
-- Sprint Board -- schema
-- Every entity table carries a `version` column: field-level updates use it
-- for optimistic locking.
-- ============================================================

DROP TABLE IF EXISTS activity;
DROP TABLE IF EXISTS tasks;
DROP TABLE IF EXISTS meetings;
DROP TABLE IF EXISTS milestones;
DROP TABLE IF EXISTS people;
DROP TABLE IF EXISTS settings;

-- -- Tasks ---------------------------------------------------
-- Column names deliberately match the frontend task object, so no mapping layer
CREATE TABLE tasks (
  id          SERIAL PRIMARY KEY,
  sim         TEXT UNIQUE NOT NULL,
  title       TEXT NOT NULL,
  stream      TEXT NOT NULL DEFAULT 'PMO',
  owner       TEXT NOT NULL,
  reviewer    TEXT,
  status      TEXT NOT NULL DEFAULT 'Not Started',
  pri         TEXT NOT NULL DEFAULT 'P2',
  start_date  DATE,
  eta         DATE,
  prog        INTEGER NOT NULL DEFAULT 0 CHECK (prog BETWEEN 0 AND 100),
  notes       TEXT DEFAULT '',
  effort      NUMERIC(6,1) NOT NULL DEFAULT 0,   -- bare number; the display unit lives in settings

  version     INTEGER NOT NULL DEFAULT 1,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by  TEXT
);

-- -- Meetings ------------------------------------------------
CREATE TABLE meetings (
  id           SERIAL PRIMARY KEY,
  title        TEXT NOT NULL,
  meeting_date DATE NOT NULL,
  start_time   TEXT NOT NULL DEFAULT '09:00',
  end_time     TEXT NOT NULL DEFAULT '10:00',
  kind         TEXT NOT NULL DEFAULT 'Internal',
  attendees    TEXT[] NOT NULL DEFAULT '{}',
  agenda       TEXT DEFAULT '',

  version      INTEGER NOT NULL DEFAULT 1,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by   TEXT
);

-- -- Milestones ----------------------------------------------
CREATE TABLE milestones (
  id         SERIAL PRIMARY KEY,
  title      TEXT NOT NULL,
  due_date   DATE NOT NULL,
  status     TEXT NOT NULL DEFAULT 'On Track',
  owner      TEXT,
  notes      TEXT DEFAULT '',

  version    INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by TEXT
);

-- -- Settings -----------------------------------------------
-- Single-row table (id is pinned to 1) holding project-wide configuration.
-- capacity_unit / unit_abbrev drive how every effort figure is labelled.
CREATE TABLE settings (
  id                 INTEGER PRIMARY KEY DEFAULT 1,
  project_name       TEXT NOT NULL DEFAULT 'Sprint Board',
  capacity_unit      TEXT NOT NULL DEFAULT 'Hours',      -- Hours | Days | Story Points | custom
  unit_abbrev        TEXT NOT NULL DEFAULT 'h',          -- shown next to numbers, e.g. "6 h"
  default_capacity   NUMERIC(6,1) NOT NULL DEFAULT 40,
  sprint_length_days INTEGER NOT NULL DEFAULT 14,
  timezone           TEXT NOT NULL DEFAULT 'America/Chicago',

  version            INTEGER NOT NULL DEFAULT 1,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by         TEXT,
  CONSTRAINT settings_single_row CHECK (id = 1)
);

-- -- People -------------------------------------------------
-- A name typed at the gate is upserted here, so it shows up in everyone's
-- owner/reviewer dropdowns. capacity NULL means fall back to default_capacity.
CREATE TABLE people (
  name       TEXT PRIMARY KEY,
  capacity   NUMERIC(6,1),
  active     BOOLEAN NOT NULL DEFAULT true,

  version    INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- -- Activity log --------------------------------------------
-- Append-only. Backs the Activity section in the task drawer, and doubles as
-- the audit trail when two people edit the same record.
CREATE TABLE activity (
  id          BIGSERIAL PRIMARY KEY,
  entity      TEXT NOT NULL,          -- 'task' | 'meeting' | 'milestone'
  entity_id   INTEGER NOT NULL,
  field       TEXT,
  old_value   TEXT,
  new_value   TEXT,
  actor       TEXT NOT NULL,
  action      TEXT NOT NULL DEFAULT 'update',  -- create | update | delete
  at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_activity_entity ON activity (entity, entity_id, at DESC);
CREATE INDEX idx_activity_at     ON activity (at DESC);
CREATE INDEX idx_tasks_status    ON tasks (status);
CREATE INDEX idx_tasks_owner     ON tasks (owner);
CREATE INDEX idx_meetings_date   ON meetings (meeting_date);
CREATE INDEX idx_milestones_due  ON milestones (due_date);
