-- ============================================================
-- Demo seed data. Entirely fictional - no real client, project or personal data.
-- ============================================================

TRUNCATE activity, tasks, meetings, milestones RESTART IDENTITY;

INSERT INTO tasks (sim, title, stream, owner, reviewer, status, pri, start_date, eta, prog, notes) VALUES
 ('SIM-12345','Implement login API',         'Backend', 'Kevin',  'Alice','In Progress','P0','2026-07-20','2026-07-27', 70,'REST endpoints for login and refresh'),
 ('SIM-12346','User authentication',         'Backend', 'Kevin',  'Mike', 'In Review',  'P1','2026-07-21','2026-07-26', 90,'Security review in progress'),
 ('SIM-12347','Payment service',             'Backend', 'Alice',  'Kevin','In Progress','P0','2026-07-23','2026-07-29', 45,'Authorization retry logic'),
 ('SIM-12348','Checkout UI',                 'Frontend','Bob',    'Alice','In Progress','P1','2026-07-21','2026-07-28', 60,'Responsive checkout page'),
 ('SIM-12349','Order history',               'Frontend','Bob',    'Mike', 'Not Started','P2','2026-07-27','2026-07-31',  0,'Awaiting API contract'),
 ('SIM-12350','Admin dashboard',             'Frontend','Charlie','Bob',  'Blocked',    'P1','2026-07-27','2026-07-31', 20,'Blocked by permissions API'),
 ('SIM-12351','Integration testing',         'QA',      'Maya',   'Kevin','In Progress','P1','2026-07-22','2026-07-30', 40,'Cross-service regression'),
 ('SIM-12352','UAT sign-off',                'QA',      'Daniel', 'Maya', 'Not Started','P1','2026-07-29','2026-08-02',  0,'Business sign-off'),
 ('SIM-12353','Bug fix: login redirect loop','Backend', 'Kevin',  'Alice','Done',       'P0','2026-07-20','2026-07-23',100,'Released to staging');

INSERT INTO meetings (title, meeting_date, start_time, end_time, kind, attendees, agenda) VALUES
 ('Daily stand-up',            '2026-07-27','09:15','09:30','Stand-up', ARRAY['Kevin','Alice','Bob','Maya'],        'Blockers and today''s plan'),
 ('Sprint review',             '2026-07-31','14:00','15:30','Review',   ARRAY['Kevin','Alice','Bob','Maya','Daniel'],'Demo completed items, collect feedback'),
 ('Architecture walkthrough',  '2026-07-28','11:00','12:00','Internal', ARRAY['Kevin','Alice','Charlie'],           'Payment service retry design'),
 ('Permissions API unblock',   '2026-07-27','16:00','16:45','Internal', ARRAY['Charlie','Bob','Kevin'],             'Resolve admin dashboard blocker'),
 ('Sprint planning 25',        '2026-08-03','10:00','12:00','Planning', ARRAY['Kevin','Alice','Bob','Maya','Daniel','Charlie'],'Scope next sprint'),
 ('QA sync',                   '2026-07-30','13:00','13:30','Stand-up', ARRAY['Maya','Daniel'],                     'Regression status');

INSERT INTO milestones (title, due_date, status, owner, notes) VALUES
 ('Auth complete',            '2026-07-27','At Risk',  'Kevin', 'Depends on security review closing'),
 ('Checkout feature freeze',  '2026-07-31','On Track', 'Bob',   'No new scope after this date'),
 ('Sprint 24 close',          '2026-08-02','On Track', 'Kevin', 'All P0/P1 done or carried over'),
 ('UAT sign-off received',    '2026-08-02','At Risk',  'Daniel','Business availability unconfirmed');

INSERT INTO activity (entity, entity_id, field, old_value, new_value, actor, action, at) VALUES
 ('task',2,'status','In Progress','In Review','Mike','update', now() - interval '18 hours'),
 ('task',6,'status','In Progress','Blocked',  'Charlie','update', now() - interval '1 day'),
 ('task',9,'prog','80','100','Kevin','update', now() - interval '2 days');
