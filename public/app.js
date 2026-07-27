'use strict';
/* ============================================================
   Sprint Board - client
   Writes go over HTTP PATCH (with optimistic locking via `version`).
   The socket only receives broadcasts; it never writes.
   ============================================================ */

const TODAY = new Date().toISOString().slice(0,10);
const SPRINT = { start:'2026-07-20', end:'2026-08-02' };

const state = {
  actor: '',
  tasks: [], meetings: [], milestones: [],
  meta: { people:[], streams:[], statuses:[], pris:[], msStatuses:[], kinds:[], settings:null },
  view: 'board',
  scope: 'all',                 // board scope: all | mine | backlog | done
  openId: null,
  evEdit: null,                 // { kind, id } while editing an event in the modal
  wlPerson: null,               // selected person on the Team Workload view
  collapsed: new Set(),         // collapsed timeline sections
  ganttAnchor: new Date('2026-07-20T00:00:00'),
  calMonth: new Date('2026-07-01T00:00:00'),
  socket: null,
};

const $  = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));

/* -- utils ------------------------------------------------- */
function esc(s){
  return String(s ?? '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
const initials = n => String(n||'?').trim().split(/\s+/).map(w=>w[0]).join('').slice(0,2).toUpperCase();
const iso = d => { const x=new Date(d); x.setMinutes(x.getMinutes()-x.getTimezoneOffset()); return x.toISOString().slice(0,10); };
const addDays = (d,n) => { const x=new Date(d); x.setDate(x.getDate()+n); return x; };
const isWeekend = ds => { const g=new Date(ds+'T00:00:00').getDay(); return g===0||g===6; };
const shortDate = ds => ds ? new Date(String(ds).slice(0,10)+'T00:00:00').toLocaleDateString('en-US',{month:'short',day:'numeric'}) : '--';
const slug = s => String(s||'').toLowerCase().replace(/[^a-z]/g,'');

/* Display unit for effort/capacity. Never hardcode: it comes from settings. */
const unitAbbrev = () => (state.meta.settings && state.meta.settings.unit_abbrev) || 'h';
const fmtEffort  = v => `${Number(v || 0)} ${unitAbbrev()}`;
/* people arrive as { name, capacity }; everywhere we only need the names */
const peopleNames = () => (state.meta.people || []).map(p => (p && typeof p === 'object') ? p.name : p);
const sprintPct = () => state.tasks.length
  ? Math.round(state.tasks.reduce((a,b)=>a+Number(b.prog||0),0)/state.tasks.length) : 0;

function toast(msg, warn){
  const t = $('#toast');
  t.innerHTML = msg;
  t.className = 'toast show' + (warn ? ' warn' : '');
  clearTimeout(t._h);
  t._h = setTimeout(() => { t.className = 'toast'; }, warn ? 4200 : 1500);
}

function options(list, sel){
  return (list||[]).map(v => {
    const val = (v && typeof v === 'object') ? v.name : v;   // tolerate people objects
    return `<option value="${esc(val)}"${String(val)===String(sel)?' selected':''}>${esc(val)}</option>`;
  }).join('');
}

/* -- API --------------------------------------------------- */
const COLL = { task:'tasks', meeting:'meetings', milestone:'milestones' };

async function req(method, url, body){
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type':'application/json', 'X-Actor': state.actor },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try { data = await res.json(); } catch(e){ /* e.g. 204 No Content */ }
  if (!res.ok){
    const err = new Error((data && data.error) || `HTTP ${res.status}`);
    err.status = res.status;
    Object.assign(err, data || {});
    throw err;
  }
  return data;
}

/** Field-level update. On conflict we never silently overwrite: we refresh the
 *  local row from the server's current value and tell the user. */
async function patchRow(entity, id, patch){
  const coll = COLL[entity];
  const row  = state[coll].find(r => r.id === id);
  if (!row) return;
  try {
    const updated = await req('PATCH', `/api/${coll}/${id}`, { patch, version: row.version });
    replaceRow(coll, updated);
    renderCurrent();
    toast('Saved');
  } catch (e){
    if (e.status === 409){
      if (e.current) replaceRow(coll, e.current);
      renderCurrent();
      toast(`Modified by <b>${esc(e.lastEditor || 'someone else')}</b>. Refreshed to the latest values — please re-check your change.`, true);
    } else {
      renderCurrent();
      toast(`Save failed: ${esc(e.message)}`, true);
    }
  }
}

function replaceRow(coll, row){
  const i = state[coll].findIndex(r => r.id === row.id);
  if (i >= 0) state[coll][i] = row; else state[coll].push(row);
}

/* -- Name gate (demo only, not authentication) --------------------------- */
function initGate(){
  const saved = sessionStorage.getItem('sb_actor');
  const quick = ['Kevin','Alice','Bob','Maya','Daniel','Charlie'];
  $('#gateQuick').innerHTML = quick.map(n => `<button data-n="${esc(n)}">${esc(n)}</button>`).join('');
  $('#gateQuick').addEventListener('click', e => {
    const b = e.target.closest('[data-n]');
    if (b){ $('#gateName').value = b.dataset.n; enter(); }
  });
  $('#gateGo').addEventListener('click', enter);
  $('#gateName').addEventListener('keydown', e => { if (e.key === 'Enter') enter(); });

  if (saved){ $('#gateName').value = saved; enter(); }
  else $('#gateName').focus();

  function enter(){
    const name = $('#gateName').value.trim().slice(0,40);
    if (!name){ $('#gateName').focus(); return; }
    state.actor = name;
    sessionStorage.setItem('sb_actor', name);
    $('#gate').hidden = true;
    $('#app').hidden = false;
    $('#userName').textContent = name;
    $('#userAvatar').textContent = initials(name);
    boot();
  }
}
$('#userChip').addEventListener('click', () => {
  sessionStorage.removeItem('sb_actor');
  location.reload();
});

/* -- Bootstrap ----------------------------------------------------------- */
async function boot(){
  /* Register the gate name so it reaches every client's dropdowns, then load. */
  try { await req('POST','/api/people', { name: state.actor }); } catch(e){ /* non-fatal */ }

  try {
    const [meta, tasks, meetings, milestones] = await Promise.all([
      req('GET','/api/meta'), req('GET','/api/tasks'),
      req('GET','/api/meetings'), req('GET','/api/milestones'),
    ]);
    state.meta = meta;
    state.tasks = tasks; state.meetings = meetings; state.milestones = milestones;
  } catch (e){
    toast(`Load failed: ${esc(e.message)}`, true);
    return;
  }

  applySettings();
  populateFilters();

  $('#sprintRange').textContent = `${shortDate(SPRINT.start)} – ${shortDate(SPRINT.end)}`;
  const end = new Date(SPRINT.end + 'T00:00:00');
  const dl = Math.round((end - new Date(TODAY + 'T00:00:00')) / 864e5);
  $('#daysLeft').textContent = dl >= 0 ? `${dl} days left` : `ended ${-dl}d ago`;

  connectSocket();
  setView('board');
}

/* project name (settings) drives the sidebar brand and the tab title */
function applySettings(){
  const name = (state.meta.settings && state.meta.settings.project_name) || 'Sprint Board';
  /* Brand logotype: the last word takes the blue accent, joined tight (e.g.
     "Sprint" + "Board" -> "SprintBoard"). */
  const parts = name.trim().split(/\s+/);
  if (parts.length > 1){
    const last = parts.pop();
    $('#brand').innerHTML = esc(parts.join(' ')) + '<span class="brand-accent">' + esc(last) + '</span>';
  } else {
    $('#brand').textContent = name;
  }
  document.title = name;
}

function populateFilters(){
  const m = state.meta, names = peopleNames();
  const keep = { o:$('#fOwner').value, r:$('#fReviewer').value, s:$('#fStatus').value, w:$('#fStream').value };
  $('#fOwner').innerHTML    = '<option value="">All owners</option>'     + options(names, keep.o);
  $('#fReviewer').innerHTML = '<option value="">All reviewers</option>'  + options(names, keep.r);
  $('#fStatus').innerHTML   = '<option value="">All statuses</option>'   + options(m.statuses, keep.s);
  $('#fStream').innerHTML   = '<option value="">All workstreams</option>'+ options(m.streams, keep.w);
}

/* -- Socket ------------------------------------------------ */
function connectSocket(){
  const socket = io({ auth: { actor: state.actor } });
  state.socket = socket;

  const setConn = (txt, cls) => { const c = $('#conn'); c.textContent = txt; c.className = 'conn ' + cls; };
  socket.on('connect',    () => setConn('LIVE', 'on'));
  socket.on('disconnect', () => setConn('OFFLINE', 'off'));
  socket.on('connect_error', () => setConn('CONNECT FAILED', 'off'));

  for (const [entity, coll] of Object.entries(COLL)){
    socket.on(`${entity}:updated`, ({ row, _actor }) => {
      replaceRow(coll, row);
      renderCurrent();
      if (_actor !== state.actor) flash(entity, row.id);
    });
    socket.on(`${entity}:created`, ({ row, _actor }) => {
      replaceRow(coll, row);
      renderCurrent();
      if (_actor !== state.actor) toast(`<b>${esc(_actor)}</b> added a ${esc(entity)}`);
    });
    socket.on(`${entity}:deleted`, ({ id }) => {
      state[coll] = state[coll].filter(r => r.id !== id);
      if (entity === 'task' && state.openId === id) closeDrawer();
      renderCurrent();
    });
  }

  /* A name entered at another gate, or a capacity change, updates the roster. */
  socket.on('people:updated', ({ row }) => {
    if (!row || !row.name) return;
    upsertMetaPerson(row);
    populateFilters();
    renderCurrent();
  });

  /* A settings change (e.g. the capacity unit) must reflect on open tabs. */
  socket.on('settings:updated', ({ row }) => {
    if (!row) return;
    state.meta.settings = row;
    applySettings();
    if (state.openId != null) $('#dEffortUnit').textContent = unitAbbrev();
    renderCurrent();
  });

  socket.on('presence', names => {
    const el = $('#presenceList');
    el.innerHTML = names.length
      ? names.map(n => `<span class="av" title="${esc(n)}">${esc(initials(n))}</span>`).join('')
      : '<span class="none">--</span>';
  });
}

function flash(entity, id){
  if (entity !== 'task' || state.view !== 'board') return;
  const tr = document.querySelector(`#rows tr[data-id="${id}"]`);
  if (tr){ tr.classList.remove('flash'); void tr.offsetWidth; tr.classList.add('flash'); }
}

/* -- View switching ------------------------------------------------------ */
const HAS_VIEW = { board:1, timeline:1, calendar:1, meetings:1, milestones:1 };

function setActiveNav(btn){
  $$('.nav-item').forEach(b => b.setAttribute('aria-current', String(b === btn)));
}

function setView(v){
  state.view = v;
  $$('.view').forEach(el => { el.hidden = el.id !== `view-${v}`; });

  const acts = $('#viewActions');
  acts.innerHTML =
    v === 'board'      ? `<button class="btn btn-primary" id="addTask">New task</button>`
  : v === 'meetings'   ? `<button class="btn btn-primary" id="addMeet">New meeting</button>`
  : v === 'milestones' ? `<button class="btn btn-primary" id="addMs">New milestone</button>`
  : '';
  renderCurrent();
}

function renderCurrent(){
  if (state.view === 'board')      { renderSummary(); renderBoard(); }
  else if (state.view === 'timeline')    renderGantt();
  else if (state.view === 'calendar')    renderCalendar();
  else if (state.view === 'meetings')    renderMeetings();
  else if (state.view === 'milestones')  renderMilestones();
  else if (state.view === 'workstreams') renderWorkstreams();
  else if (state.view === 'workload')    renderWorkload();
  else if (state.view === 'reports')     renderReports();
  renderCounts();
}

function renderCounts(){
  $('#nBoard').textContent = state.tasks.length;
  $('#nMine').textContent  = state.tasks.filter(t => inScope(t,'mine')).length;
  $('#nBack').textContent  = state.tasks.filter(t => inScope(t,'backlog')).length;
  $('#nComp').textContent  = state.tasks.filter(t => inScope(t,'done')).length;
  $('#nMeet').textContent  = state.meetings.length;
  $('#nMs').textContent    = state.milestones.length;
  $('#topPct').textContent = sprintPct() + '%';
}

/* -- Board ------------------------------------------------- */
const STATUS_CLASS = {
  'Not Started':'s-not','In Progress':'s-prog','In Review':'s-review','Blocked':'s-block','Done':'s-done'
};
const FIELDS = ['title','stream','owner','reviewer','status','pri','effort','start_date','eta','prog','notes'];

/* Base scope (from the Workspace nav) applied before the toolbar filters. */
function inScope(t, scope){
  if (scope === 'mine')    return (t.owner === state.actor || t.reviewer === state.actor) && t.status !== 'Done';
  if (scope === 'backlog') return t.status === 'Not Started';
  if (scope === 'done')    return t.status === 'Done';
  return true;
}

function visibleTasks(){
  const q  = ($('#q').value || '').trim().toLowerCase();
  const fo = $('#fOwner').value, fr = $('#fReviewer').value, fs = $('#fStatus').value, fw = $('#fStream').value;
  return state.tasks.filter(t =>
    inScope(t, state.scope) &&
    (!q || `${t.sim} ${t.title}`.toLowerCase().includes(q)) &&
    (!fo || t.owner === fo) && (!fr || t.reviewer === fr) &&
    (!fs || t.status === fs) && (!fw || t.stream === fw)
  );
}

function paintTaskCell(td){
  const t = state.tasks.find(x => x.id === +td.dataset.id);
  if (!t) return;
  const f = td.dataset.field;
  let inner = '', cls = 'cell', pick = false;

  switch (f){
    case 'title':
      inner = `<span class="t-title">${esc(t.title)}</span><span class="t-sim" data-open="${t.id}">${esc(t.sim)}</span>`;
      break;
    case 'stream':
      inner = `<span class="cell-val">${esc(t.stream)}</span>`; pick = true; break;
    case 'owner': case 'reviewer':
      inner = `<span class="person"><span class="avatar">${esc(initials(t[f]))}</span><span class="nm">${esc(t[f]||'--')}</span></span>`;
      pick = true; break;
    case 'status':
      inner = `<span class="chip ${STATUS_CLASS[t.status]||'s-not'}">${esc(t.status)}</span>`; pick = true; break;
    case 'pri':
      inner = `<span class="pri pri-${esc(t.pri)}">${esc(t.pri)}</span>`; pick = true; break;
    case 'effort':
      inner = `<span class="cell-val effort-val">${esc(fmtEffort(t.effort))}</span>`; pick = true; break;
    case 'start_date': case 'eta': {
      const late = f === 'eta' && t.eta && t.eta < TODAY && t.status !== 'Done';
      inner = `<span class="date-val${late?' late':''}">${esc(shortDate(t[f]))}</span>`; pick = true; break;
    }
    case 'prog':
      /* The slider is both the display and the control, so it skips the
         click-to-turn-into-an-input pattern used by the other cells. */
      td.innerHTML = `<div class="prog">
          <input type="range" class="prog-range" min="0" max="100" step="5"
                 value="${t.prog}" style="--pct:${t.prog}%"
                 data-id="${t.id}" aria-label="Progress for ${esc(t.title)}">
          <span class="prog-num">${t.prog}%</span>
        </div>`;
      return;
    case 'notes':
      inner = `<span class="cell-val notes-val">${esc(t.notes) || '--'}</span>`;
      if (!t.notes) cls += ' empty';
      break;
  }
  if (pick) cls += ' pick';
  td.innerHTML = `<div class="${cls}" tabindex="0" role="button">${inner}</div>`;
}

function renderBoard(){
  const tbody = $('#rows');
  const list = visibleTasks();

  /* When someone else's change arrives, don't yank the slider the user is
     currently dragging, or the cell they're editing. */
  const active = document.activeElement;
  const keepId = active && active.classList && active.classList.contains('prog-range')
    ? active.dataset.id : null;

  tbody.innerHTML = '';
  if (!list.length){
    tbody.innerHTML = `<tr><td colspan="12"><div class="empty-state">
      <span class="eyebrow">No tasks</span>Nothing matches the current view.</div></td></tr>`;
    $('#rowCount').textContent = '0 tasks';
    return;
  }

  list.forEach(t => {
    const tr = document.createElement('tr');
    tr.dataset.id = t.id;
    if (t.status === 'Blocked') tr.className = 'blocked';
    else if (t.status === 'Done') tr.className = 'is-done';

    FIELDS.forEach(f => {
      const td = document.createElement('td');
      td.dataset.id = t.id; td.dataset.field = f;
      if (f === 'title') td.className = 'task-cell';
      paintTaskCell(td);
      tr.appendChild(td);
    });
    const last = document.createElement('td');
    last.innerHTML = `<button class="row-open" data-open="${t.id}" aria-label="Open detail">&rsaquo;</button>`;
    tr.appendChild(last);
    tbody.appendChild(tr);
  });

  $('#rowCount').textContent = `${list.length} of ${state.tasks.length} tasks`;

  if (keepId){
    const el = document.querySelector(`#rows .prog-range[data-id="${keepId}"]`);
    if (el) el.focus();
  }
}

function renderSummary(){
  const n = s => state.tasks.filter(t => t.status === s).length;
  const cards = [
    ['Not Started', n('Not Started')],
    ['In Progress', n('In Progress')],
    ['In Review',   n('In Review')],
    ['Blocked',     n('Blocked')],
    ['Done',        n('Done')],
    ['Sprint Completion', sprintPct() + '%'],
  ];
  $('#summary').innerHTML = cards.map(([label, val]) =>
    `<div class="metric"><div class="label">${esc(label)}</div><div class="value">${esc(val)}</div></div>`).join('');
}

/* -- Shared inline editing (board / meetings / milestones) --------------- */
function editCell(td, cfg){
  const { coll, entity } = cfg;
  const id  = +td.dataset.id;
  const f   = td.dataset.field;
  const row = state[coll].find(r => r.id === id);
  if (!row) return;

  const m = state.meta;
  const SELECTS = {
    stream:m.streams, owner:peopleNames(), reviewer:peopleNames(), status:null,
    pri:m.pris, kind:m.kinds,
  };
  let el;
  if (f === 'status'){
    el = document.createElement('select');
    el.innerHTML = options(coll === 'milestones' ? m.msStatuses : m.statuses, row[f]);
  } else if (SELECTS[f]){
    el = document.createElement('select');
    el.innerHTML = options(SELECTS[f], row[f]);
  } else if (f === 'effort'){
    el = document.createElement('input'); el.type = 'number'; el.min = '0'; el.step = '0.5';
    el.value = Number(row.effort || 0);
  } else if (/(_date|^eta$)/.test(f)){
    el = document.createElement('input'); el.type = 'date'; el.value = row[f] || '';
  } else if (/_time$/.test(f)){
    el = document.createElement('input'); el.type = 'time'; el.value = row[f] || '';
  } else if (f === 'attendees'){
    el = document.createElement('input'); el.type = 'text';
    el.value = (row.attendees || []).join(', ');
    el.placeholder = 'comma separated';
  } else {
    el = document.createElement('input'); el.type = 'text'; el.value = row[f] ?? '';
  }
  el.className = 'cell-edit';
  td.innerHTML = ''; td.appendChild(el);
  el.focus();
  if (el.select) try { el.select(); } catch(e){}

  let done = false;
  const repaint = () => cfg.paint(td);
  const commit = () => {
    if (done) return; done = true;
    let val = el.value;
    if (f === 'attendees') val = val.split(',').map(s=>s.trim()).filter(Boolean);
    const same = f === 'attendees'
      ? JSON.stringify(val) === JSON.stringify(row.attendees || [])
      : f === 'effort'
      ? Number(val || 0) === Number(row.effort || 0)
      : String(row[f] ?? '') === String(val);
    if (same){ repaint(); return; }
    patchRow(entity, id, { [f]: f === 'effort' ? Number(val || 0) : val });
  };
  el.addEventListener('blur', commit);
  el.addEventListener('change', () => { if (el.tagName === 'SELECT' || el.type === 'date' || el.type === 'time') commit(); });
  el.addEventListener('keydown', e => {
    if (e.key === 'Enter'){ e.preventDefault(); commit(); }
    if (e.key === 'Escape'){ done = true; repaint(); }
  });
}

/* -- Timeline (collapsible workstream sections) -------------------------- */
const GDAYS = 14;
const CHEV = `<svg class="chev" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

function renderGantt(){
  const dates = Array.from({length:GDAYS},(_,i)=>iso(addDays(state.ganttAnchor,i)));
  const grid = $('#ganttGrid');
  grid.style.setProperty('--days', GDAYS);

  let html = '<div class="g-head first">Workstream / task</div>';
  dates.forEach(d => {
    const dt = new Date(d+'T00:00:00');
    html += `<div class="g-head${isWeekend(d)?' wknd':''}">${dt.toLocaleDateString('en-US',{weekday:'narrow'})}<br>${dt.getDate()}</div>`;
  });
  const bands = dates.map((d,i) => isWeekend(d)
    ? `<span class="wknd-band" style="left:${i/GDAYS*100}%;width:${100/GDAYS}%"></span>` : '').join('');

  const section = (key, cls, label, count, open) =>
    `<div class="g-stream${cls}" role="button" tabindex="0" data-stream="${esc(key)}" aria-expanded="${open}">
       ${CHEV}${esc(label)}<span class="g-count">${count}</span></div>`;

  const list = visibleTasks();
  (state.meta.streams||[]).forEach(ws => {
    const rows = list.filter(t => t.stream === ws)
      .sort((a,b) => String(a.start_date).localeCompare(String(b.start_date)));
    if (!rows.length) return;
    const open = !state.collapsed.has(ws);
    html += section(ws, '', ws, rows.length, open);
    if (!open) return;
    rows.forEach(t => {
      html += `<div class="g-label"><div class="nm">${esc(t.title)}</div><div class="mt">${esc(t.owner)} · ${t.prog}%</div></div>`;
      const s = dates.indexOf(t.start_date), e = dates.indexOf(t.eta);
      const from = s>=0 ? s : (t.start_date && t.start_date < dates[0] ? 0 : GDAYS);
      const to   = e>=0 ? e : (t.eta && t.eta > dates[GDAYS-1] ? GDAYS-1 : -1);
      let bar = '';
      if (to >= 0 && from < GDAYS){
        const a = Math.max(0,from), b = Math.min(GDAYS-1,to);
        const left = a/GDAYS*100, width = Math.max(2.4,(b-a+1)/GDAYS*100-0.5);
        const cls = ' ' + (STATUS_CLASS[t.status] || 's-prog');   // colour the bar by status, matching the board badges
        bar = `<div class="g-bar${cls}" data-open="${t.id}" style="left:${left}%;width:${width}%"
                title="${esc(t.title)} · ${esc(t.start_date)} → ${esc(t.eta)}">${t.prog}%</div>`;
      }
      html += `<div class="g-track">${bands}${bar}</div>`;
    });
  });

  /* Milestones and meetings share a collapsible group of dated markers:
     diamonds for milestones, amber squares for meetings. */
  const events = [
    ...state.milestones.filter(x => dates.includes(x.due_date))
        .map(x => ({ kind:'ms', date:x.due_date, title:x.title, sub:x.status, done:x.status === 'Done' })),
    ...state.meetings.filter(m => dates.includes(m.meeting_date))
        .map(m => ({ kind:'meet', date:m.meeting_date, title:m.title, sub:(m.start_time || '').slice(0,5) || 'Meeting' })),
  ].sort((a,b) => a.date.localeCompare(b.date));
  if (events.length){
    const open = !state.collapsed.has('__events');
    html += section('__events', ' ms', 'Milestones & meetings', events.length, open);
    if (open) events.forEach(e => {
      const i = dates.indexOf(e.date), left = (i + 0.5) / GDAYS * 100;
      const attrs = `data-ev-kind="${e.kind}" data-ev-id="${e.id}"`;
      const marker = e.kind === 'ms'
        ? `<div class="g-dia${e.done ? ' done' : ''}" ${attrs} style="left:${left}%" title="${esc(e.title)} · ${esc(e.date)}"></div>`
        : `<div class="g-meet" ${attrs} style="left:${left}%" title="${esc(e.title)} · ${esc(e.date)} ${esc(e.sub)}"></div>`;
      html += `<div class="g-label"><div class="nm">${esc(e.title)}</div><div class="mt">${esc(e.sub)}</div></div>`;
      html += `<div class="g-track">${bands}${marker}</div>`;
    });
  }

  grid.innerHTML = html;

  const ti = dates.indexOf(TODAY);
  if (ti >= 0){
    const pos = `calc(200px + (100% - 200px) * ${(ti+0.5)/GDAYS})`;
    const line = document.createElement('div'); line.className='g-today'; line.style.left=pos;
    const tag  = document.createElement('div'); tag.className='g-today-tag'; tag.style.left=pos; tag.textContent='TODAY';
    grid.append(line, tag);
  }
}

function toggleSection(key){
  if (state.collapsed.has(key)) state.collapsed.delete(key); else state.collapsed.add(key);
  renderGantt();
}

/* -- Calendar ---------------------------------------------- */
function renderCalendar(){
  const anchor = state.calMonth;
  const y = anchor.getFullYear(), mo = anchor.getMonth();
  $('#calTitle').textContent = anchor.toLocaleDateString('en-US',{month:'long',year:'numeric'});

  const first = new Date(y, mo, 1);
  const startOffset = first.getDay();              // week starts Sunday
  const gridStart = addDays(first, -startOffset);

  const byDay = {};
  const push = (d,ev) => { if(!d) return; (byDay[d] = byDay[d] || []).push(ev); };
  state.meetings.forEach(m => push(m.meeting_date, {
    sort:m.start_time || '',
    html:`<div class="cal-ev meet" title="${esc(m.title)} · ${esc(m.start_time)}-${esc(m.end_time)} · ${esc((m.attendees||[]).join(', '))}"><span class="tm">${esc((m.start_time||'').slice(0,5))}</span>${esc(m.title)}</div>`
  }));
  state.milestones.forEach(x => push(x.due_date, {
    sort:'!',
    html:`<div class="cal-ev ms" title="${esc(x.title)} · ${esc(x.status)}">◆ ${esc(x.title)}</div>`
  }));
  state.tasks.forEach(t => { if (t.status !== 'Done') push(t.eta, {
    sort:'zz',
    html:`<div class="cal-ev eta" data-open="${t.id}" title="ETA · ${esc(t.title)} · ${esc(t.owner)}">ETA ${esc(t.title)}</div>`
  }); });

  const dows = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  let html = dows.map(d => `<div class="cal-dow">${d}</div>`).join('');

  const weeks = Math.ceil((startOffset + new Date(y, mo+1, 0).getDate()) / 7);
  for (let i = 0; i < weeks * 7; i++){
    const d  = addDays(gridStart, i);
    const ds = iso(d);
    const out = d.getMonth() !== mo;
    const cls = ['cal-cell'];
    if (out) cls.push('out');
    else if (isWeekend(ds)) cls.push('wknd');
    if (ds === TODAY) cls.push('today');

    const evs = (byDay[ds] || []).sort((a,b) => String(a.sort).localeCompare(String(b.sort)));
    const shown = evs.slice(0,3), extra = evs.length - shown.length;

    html += `<div class="${cls.join(' ')}">
      <span class="cal-dnum">${d.getDate()}</span>
      ${shown.map(e => e.html).join('')}
      ${extra > 0 ? `<span class="cal-more">+${extra} more</span>` : ''}
    </div>`;
  }
  $('#cal').innerHTML = `<div class="cal-grid">${html}</div>`;
}

/* -- Meetings ---------------------------------------------- */
const MEET_FIELDS = ['title','meeting_date','start_time','end_time','kind','attendees','agenda'];

function paintMeetCell(td){
  const m = state.meetings.find(x => x.id === +td.dataset.id);
  if (!m) return;
  const f = td.dataset.field;
  let inner, cls = 'cell pick';
  switch (f){
    case 'title':        inner = `<span class="t-title">${esc(m.title)}</span>`; break;
    case 'meeting_date': inner = `<span class="date-val">${esc(shortDate(m.meeting_date))}</span>`; break;
    case 'start_time': case 'end_time':
      inner = `<span class="date-val">${esc((m[f]||'').slice(0,5))}</span>`; break;
    case 'kind':
      inner = `<span class="chip k-${slug(m.kind)}">${esc(m.kind)}</span>`; break;
    case 'attendees':
      inner = `<span class="att">${(m.attendees||[]).map(a =>
        `<span class="av" title="${esc(a)}">${esc(initials(a))}</span>`).join('')}</span>`; break;
    default:
      inner = `<span class="cell-val notes-val">${esc(m.agenda)||'--'}</span>`;
      if (!m.agenda) cls += ' empty';
  }
  td.innerHTML = `<div class="${cls}" tabindex="0" role="button">${inner}</div>`;
}

function renderMeetings(){
  const tb = $('#meetRows');
  tb.innerHTML = '';
  if (!state.meetings.length){
    tb.innerHTML = `<tr><td colspan="8"><div class="empty-state"><span class="eyebrow">No meetings</span>No meetings yet.</div></td></tr>`;
    return;
  }
  state.meetings.forEach(m => {
    const tr = document.createElement('tr');
    tr.dataset.id = m.id;
    MEET_FIELDS.forEach(f => {
      const td = document.createElement('td');
      td.dataset.id = m.id; td.dataset.field = f;
      paintMeetCell(td); tr.appendChild(td);
    });
    const last = document.createElement('td');
    last.innerHTML = `<button class="row-del" data-del="${m.id}" aria-label="Delete">&times;</button>`;
    tr.appendChild(last);
    tb.appendChild(tr);
  });
}

/* -- Milestones -------------------------------------------- */
const MS_FIELDS = ['title','due_date','status','owner','notes'];

function paintMsCell(td){
  const x = state.milestones.find(r => r.id === +td.dataset.id);
  if (!x) return;
  const f = td.dataset.field;
  let inner, cls = 'cell pick';
  switch (f){
    case 'title':    inner = `<span class="t-title">◆ ${esc(x.title)}</span>`; break;
    case 'due_date': {
      const late = x.due_date < TODAY && x.status !== 'Done';
      inner = `<span class="date-val${late?' late':''}">${esc(shortDate(x.due_date))}</span>`; break;
    }
    case 'status':   inner = `<span class="chip m-${slug(x.status)}">${esc(x.status)}</span>`; break;
    case 'owner':    inner = `<span class="person"><span class="avatar">${esc(initials(x.owner))}</span><span class="nm">${esc(x.owner||'--')}</span></span>`; break;
    default:
      inner = `<span class="cell-val notes-val">${esc(x.notes)||'--'}</span>`;
      if (!x.notes) cls += ' empty';
  }
  td.innerHTML = `<div class="${cls}" tabindex="0" role="button">${inner}</div>`;
}

function renderMilestones(){
  const tb = $('#msRows');
  tb.innerHTML = '';
  if (!state.milestones.length){
    tb.innerHTML = `<tr><td colspan="6"><div class="empty-state"><span class="eyebrow">No milestones</span>No milestones yet.</div></td></tr>`;
    return;
  }
  state.milestones.forEach(x => {
    const tr = document.createElement('tr');
    tr.dataset.id = x.id;
    MS_FIELDS.forEach(f => {
      const td = document.createElement('td');
      td.dataset.id = x.id; td.dataset.field = f;
      paintMsCell(td); tr.appendChild(td);
    });
    const last = document.createElement('td');
    last.innerHTML = `<button class="row-del" data-del="${x.id}" aria-label="Delete">&times;</button>`;
    tr.appendChild(last);
    tb.appendChild(tr);
  });
}

/* -- Drawer ------------------------------------------------ */
const FIELD_LABEL = {
  start_date:'Start', eta:'ETA', prog:'Progress', pri:'Priority', effort:'Effort',
  stream:'Workstream', owner:'Owner', reviewer:'Reviewer', status:'Status', title:'Task', notes:'Notes',
};
const actLabel = f => FIELD_LABEL[f] || f;      // fall back to the raw column name
function actVal(f, v){
  if (v === null || v === undefined || v === '') return 'empty';
  if (f === 'prog') return v + '%';
  if (f === 'effort') return Number(v) + ' ' + unitAbbrev();
  if (f === 'start_date' || f === 'eta') return shortDate(v);
  return String(v);
}

async function openDrawer(id){
  const t = state.tasks.find(x => x.id === id);
  if (!t) return;
  state.openId = id;
  const m = state.meta, names = peopleNames();
  $('#dSim').textContent = t.sim;
  $('#dTitleH').textContent = t.title;
  $('#dTitle').value = t.title;
  $('#dStream').innerHTML   = options(m.streams, t.stream);
  $('#dPri').innerHTML      = options(m.pris, t.pri);
  $('#dOwner').innerHTML    = options(names, t.owner);
  $('#dReviewer').innerHTML = options(names, t.reviewer);
  $('#dStatus').innerHTML   = options(m.statuses, t.status);
  $('#dEffort').value = Number(t.effort || 0);
  $('#dEffortUnit').textContent = unitAbbrev();
  $('#dStart').value = t.start_date || '';
  $('#dEta').value   = t.eta || '';
  const pr = $('#dProg');
  pr.value = t.prog; pr.style.setProperty('--pct', t.prog + '%');
  $('#dProgVal').textContent = t.prog + '%';
  $('#dNotes').value = t.notes || '';
  $('#dHistory').innerHTML = '<div class="hist-row"><div style="color:var(--muted)">Loading&hellip;</div></div>';

  $('#drawer').classList.add('open');
  $('#scrim').classList.add('open');
  $('#dTitle').focus();

  try {
    const rows = await req('GET', `/api/activity?entity=task&id=${id}&limit=30`);
    $('#dHistory').innerHTML = rows.length ? rows.map(a => {
      const when = new Date(a.at).toLocaleString('en-US',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});
      const what = a.action === 'create' ? 'created this task'
        : a.action === 'delete' ? 'deleted this task'
        : `changed <b>${esc(actLabel(a.field))}</b> from ${esc(actVal(a.field, a.old_value))} to <b>${esc(actVal(a.field, a.new_value))}</b>`;
      return `<div class="hist-row"><time>${esc(when)}</time><div><b>${esc(a.actor)}</b> ${what}</div></div>`;
    }).join('') : '<div class="hist-row"><div style="color:var(--muted)">No changes recorded yet.</div></div>';
  } catch (e){
    $('#dHistory').innerHTML = `<div class="hist-row"><div style="color:var(--danger)">Could not load activity.</div></div>`;
  }
}
function closeDrawer(){
  state.openId = null;
  $('#drawer').classList.remove('open');
  $('#scrim').classList.remove('open');
}
async function saveDrawer(){
  const id = state.openId;
  const t = state.tasks.find(x => x.id === id);
  if (!t) return;
  const patch = {
    title: $('#dTitle').value.trim() || t.title,
    stream: $('#dStream').value, pri: $('#dPri').value,
    owner: $('#dOwner').value, reviewer: $('#dReviewer').value,
    status: $('#dStatus').value, effort: Number($('#dEffort').value || 0),
    start_date: $('#dStart').value, eta: $('#dEta').value,
    prog: Number($('#dProg').value), notes: $('#dNotes').value,
  };
  closeDrawer();
  await patchRow('task', id, patch);
}

/* -- Create meeting / milestone (shared by the topbar and the timeline) --- */
async function createMeeting(){
  try {
    const row = await req('POST','/api/meetings', {
      title:'New meeting', meeting_date:TODAY, start_time:'09:00', end_time:'10:00',
      kind:'Internal', attendees:[state.actor], agenda:'',
    });
    replaceRow('meetings', row); renderCurrent(); toast('Meeting added');
  } catch (err){ toast(`Create failed: ${esc(err.message)}`, true); }
}
async function createMilestone(){
  try {
    const row = await req('POST','/api/milestones', {
      title:'New milestone', due_date:TODAY, status:'On Track', owner:state.actor, notes:'',
    });
    replaceRow('milestones', row); renderCurrent(); toast('Milestone added');
  } catch (err){ toast(`Create failed: ${esc(err.message)}`, true); }
}

/* -- Meeting / milestone modal (create + edit) --------------------------
   One modal serves both entities. Type maps to a table; the generic Title /
   Date / Time / Notes fields map to that table's columns. Editing reuses
   patchRow (optimistic locking); creating POSTs; both land on the timeline. */
const addHour = t => {
  const [h,m] = String(t || '09:00').split(':').map(Number);
  return String(((h||0)+1) % 24).padStart(2,'0') + ':' + String(m||0).padStart(2,'0');
};
function evTimeVisibility(){ $('#evTimeField').style.display = $('#evType').value === 'meeting' ? '' : 'none'; }

function openEventModal(type, edit){
  state.evEdit = edit || null;
  const kind = edit ? edit.kind : (type === 'meeting' ? 'meet' : 'ms');
  let row = null;
  if (edit){
    row = (kind === 'ms' ? state.milestones : state.meetings).find(r => r.id === edit.id);
    if (!row) return;
  }
  $('#evType').value = kind === 'meet' ? 'meeting' : 'milestone';
  $('#evType').disabled = !!edit;                       // no cross-type conversion on edit
  $('#evTitleInput').value = row ? (row.title || '') : '';
  if (kind === 'ms'){
    $('#evDate').value  = row ? (row.due_date || '') : TODAY;
    $('#evTime').value  = '';
    $('#evNotes').value = row ? (row.notes || '') : '';
  } else {
    $('#evDate').value  = row ? (row.meeting_date || '') : TODAY;
    $('#evTime').value  = row ? (row.start_time || '').slice(0,5) : '';
    $('#evNotes').value = row ? (row.agenda || '') : '';
  }
  evTimeVisibility();
  $('#evTitle').textContent = (edit ? 'Edit ' : 'Add ') + (kind === 'meet' ? 'meeting' : 'milestone');
  $('#evDelete').hidden = !edit;
  $('#evModal').classList.add('open');
  $('#evScrim').classList.add('open');
  setTimeout(() => $('#evTitleInput').focus(), 40);
}
function closeEventModal(){
  state.evEdit = null;
  $('#evModal').classList.remove('open');
  $('#evScrim').classList.remove('open');
}
async function saveEventModal(){
  const typeVal = $('#evType').value;
  const title = $('#evTitleInput').value.trim();
  const date  = $('#evDate').value;
  const time  = $('#evTime').value;
  const notes = $('#evNotes').value;
  if (!title || !date){ toast('Please enter a title and date', true); return; }

  const edit = state.evEdit;
  if (edit){
    if (edit.kind === 'ms') await patchRow('milestone', edit.id, { title, due_date: date, notes });
    else                    await patchRow('meeting',   edit.id, { title, meeting_date: date, start_time: time || '09:00', agenda: notes });
    closeEventModal();
    return;
  }
  try {
    if (typeVal === 'milestone'){
      const row = await req('POST','/api/milestones', { title, due_date: date, status:'On Track', owner:state.actor, notes });
      replaceRow('milestones', row);
    } else {
      const st = time || '09:00';
      const row = await req('POST','/api/meetings', { title, meeting_date: date, start_time: st, end_time: addHour(st), kind:'Internal', attendees:[state.actor], agenda: notes });
      replaceRow('meetings', row);
    }
    renderCurrent();
    toast(typeVal === 'milestone' ? 'Milestone added' : 'Meeting added');
    closeEventModal();
  } catch (err){ toast(`Save failed: ${esc(err.message)}`, true); }
}
function deleteEventModal(){
  const edit = state.evEdit;
  if (!edit) return;
  if (!confirm('Delete this ' + (edit.kind === 'ms' ? 'milestone' : 'meeting') + '?')) return;
  const coll = edit.kind === 'ms' ? 'milestones' : 'meetings';
  req('DELETE', `/api/${coll}/${edit.id}`).catch(err => toast(esc(err.message), true));
  closeEventModal();
}

/* -- CSV export (shared by board and reports) ---------------------------- */
function taskCsv(rows){
  const cols = ['sim','title','stream','owner','reviewer','status','pri','effort','start_date','eta','prog','notes'];
  const qv = v => `"${String(v ?? '').replace(/"/g,'""')}"`;
  return [cols.join(',')].concat(rows.map(t => cols.map(c => qv(t[c])).join(','))).join('\n');
}
function downloadCsv(csv, filename){
  const url = URL.createObjectURL(new Blob([csv], { type:'text/csv;charset=utf-8' }));
  const a = document.createElement('a'); a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

/* -- Workstreams (cards) ------------------------------------------------- */
function streamStats(ws){
  const rows = state.tasks.filter(t => t.stream === ws);
  const prog = rows.length ? Math.round(rows.reduce((a,b) => a + Number(b.prog || 0), 0) / rows.length) : 0;
  const counts = {};                                   // most frequent owner in the stream
  rows.forEach(t => { if (t.owner) counts[t.owner] = (counts[t.owner] || 0) + 1; });
  let owner = '--', best = 0;
  Object.entries(counts).forEach(([o,c]) => { if (c > best){ best = c; owner = o; } });
  return { count: rows.length, prog, owner };
}
function renderWorkstreams(){
  const streams = (state.meta.streams || []).filter(ws => state.tasks.some(t => t.stream === ws));
  $('#wsCards').innerHTML = streams.length ? streams.map(ws => {
    const s = streamStats(ws);
    return `<button class="ws-card" data-stream="${esc(ws)}">
      <div class="ws-name">${esc(ws)}</div>
      <div class="ws-row"><span>Progress</span><b>${s.prog}%</b></div>
      <div class="ws-row"><span>Owner</span><b>${esc(s.owner)}</b></div>
      <div class="ws-row"><span>Tasks</span><b>${s.count}</b></div>
      <div class="ws-bar"><span style="width:${s.prog}%"></span></div>
    </button>`;
  }).join('') : `<div class="empty-state"><span class="eyebrow">No workstreams</span>No tasks yet.</div>`;
}

/* -- Team workload ------------------------------------------------------- */
function personCapacity(name){
  const p = (state.meta.people || []).find(x => (x.name || x) === name);
  const cap = (p && typeof p === 'object') ? Number(p.capacity) : NaN;   // meta capacity is already effective
  return Number.isFinite(cap) ? cap : Number((state.meta.settings && state.meta.settings.default_capacity) || 0);
}
function personWorkload(name){
  const cap = personCapacity(name);
  let assigned = 0, completed = 0;
  state.tasks.forEach(t => {
    if (t.owner !== name) return;
    const e = Number(t.effort || 0);
    if (t.status === 'Done') completed += e; else assigned += e;
  });
  const remaining = Math.max(0, assigned - completed);
  let status = 'Available';
  if (cap > 0 && assigned > cap) status = 'Overloaded';
  else if (cap > 0 && assigned >= 0.9 * cap) status = 'At capacity';
  return { cap, assigned, completed, remaining, status };
}
function renderWorkload(){
  const names = peopleNames();
  if (!names.length){ $('#wlPeople').innerHTML = ''; $('#wlDetail').innerHTML = `<div class="empty-state">No people yet.</div>`; return; }
  if (!state.wlPerson || !names.includes(state.wlPerson)) state.wlPerson = names.includes(state.actor) ? state.actor : names[0];
  const sel = state.wlPerson;
  $('#wlPeople').innerHTML = names.map(n =>
    `<button class="wl-person${n === sel ? ' active' : ''}" data-person="${esc(n)}"><span class="avatar">${esc(initials(n))}</span><span class="nm">${esc(n)}</span></button>`).join('');
  const w = personWorkload(sel);
  const badge = w.status === 'Overloaded' ? 'over' : w.status === 'At capacity' ? 'at' : 'ok';
  const tasks = state.tasks.filter(t => t.owner === sel && t.status !== 'Done')
    .sort((a,b) => String(a.eta).localeCompare(String(b.eta)));
  $('#wlDetail').innerHTML = `
    <div class="wl-head"><span class="avatar lg">${esc(initials(sel))}</span><h3>${esc(sel)}</h3><span class="wl-badge ${badge}">${esc(w.status)}</span></div>
    <div class="wl-stats">
      <div><span>Capacity</span><b class="wl-cap" data-person="${esc(sel)}" data-cap="${w.cap}" tabindex="0" role="button" title="Click to edit capacity">${esc(fmtEffort(w.cap))}</b></div>
      <div><span>Assigned</span><b>${esc(fmtEffort(w.assigned))}</b></div>
      <div><span>Completed</span><b>${esc(fmtEffort(w.completed))}</b></div>
      <div><span>Remaining</span><b>${esc(fmtEffort(w.remaining))}</b></div>
    </div>
    <div class="wl-tasks"><span class="eyebrow">Assigned tasks</span>
      ${tasks.length ? tasks.map(t => `<div class="wl-task" data-open="${t.id}">
        <span class="chip ${STATUS_CLASS[t.status] || 's-not'}">${esc(t.status)}</span>
        <span class="wl-task-title">${esc(t.title)}</span>
        <span class="wl-task-eff">${esc(fmtEffort(t.effort))}</span>
      </div>`).join('') : `<div class="wl-empty">No open tasks.</div>`}
    </div>`;
}

/* Merge a people-table row into meta.people as an effective-capacity entry. */
function upsertMetaPerson(row){
  const arr = state.meta.people || (state.meta.people = []);
  const def = state.meta.settings ? Number(state.meta.settings.default_capacity) : null;
  const entry = { name: row.name, capacity: row.capacity == null ? def : Number(row.capacity) };
  const i = arr.findIndex(p => (p.name || p) === row.name);
  if (i >= 0) arr[i] = entry; else arr.push(entry);
  arr.sort((a,b) => String(a.name).localeCompare(String(b.name)));
}
async function savePersonCapacity(name, val){
  const capacity = val === '' ? null : Math.max(0, Number(val) || 0);   // blank -> fall back to default
  try {
    const row = await req('PATCH', `/api/people/${encodeURIComponent(name)}`, { patch: { capacity } });
    upsertMetaPerson(row);
    renderWorkload();
    toast('Capacity updated');
  } catch (e){
    renderWorkload();
    toast(`Save failed: ${esc(e.message)}`, true);
  }
}
/* Click-to-edit the Capacity figure; writes via PATCH /api/people/:name. */
function editCapacity(el){
  const name = el.dataset.person;
  const input = document.createElement('input');
  input.type = 'number'; input.min = '0'; input.step = '0.5';
  input.className = 'wl-cap-input';
  input.value = Number(el.dataset.cap) || 0;
  el.replaceWith(input);
  input.focus(); try { input.select(); } catch(e){}
  let done = false;
  const commit = () => { if (done) return; done = true; savePersonCapacity(name, input.value); };
  input.addEventListener('blur', commit);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter'){ e.preventDefault(); input.blur(); }
    else if (e.key === 'Escape'){ done = true; renderWorkload(); }
  });
}

/* -- Reports (executive) ------------------------------------------------- */
function renderReports(){
  const n = s => state.tasks.filter(t => t.status === s).length;
  const pct = sprintPct();
  const statusRows = [['Completed', n('Done')], ['In Progress', n('In Progress')], ['Blocked', n('Blocked')], ['Not Started', n('Not Started')]];
  const rows = peopleNames().map(nm => ({ nm, ...personWorkload(nm) }));
  $('#reportBody').innerHTML = `
    <section class="rpt-section"><span class="eyebrow">Sprint progress</span><div class="rpt-big">${pct}%</div></section>
    <section class="rpt-section"><span class="eyebrow">Status</span>
      <div class="rpt-status">${statusRows.map(([l,v]) => `<div class="rpt-stat"><div class="rpt-stat-v">${v}</div><div class="rpt-stat-l">${esc(l)}</div></div>`).join('')}</div>
    </section>
    <section class="rpt-section"><span class="eyebrow">Workload</span>
      <div class="rpt-workload">${rows.map(w => {
        const pctCap = w.cap ? Math.min(100, Math.round(w.assigned / w.cap * 100)) : 0;
        return `<div class="rpt-wl-row">
          <span class="rpt-wl-name">${esc(w.nm)}</span>
          <span class="rpt-wl-bar${w.status === 'Overloaded' ? ' over' : ''}"><span style="width:${pctCap}%"></span></span>
          <span class="rpt-wl-num">${esc(fmtEffort(w.assigned))} / ${esc(fmtEffort(w.cap))}</span>
          ${w.status === 'Overloaded' ? '<span class="rpt-over">Over</span>' : ''}
        </div>`;
      }).join('')}</div>
    </section>
    <section class="rpt-section"><span class="eyebrow">AI summary</span>
      <div class="rpt-ai">
        <div class="rpt-ai-label">Sample text — illustrative only, not generated</div>
        <p>This is placeholder narrative showing where an at-a-glance summary would sit. It is not produced from the data on this page and no model was called. A future iteration could summarise progress, call out blockers, and flag schedule risks here.</p>
      </div>
    </section>`;
}

/* -- Settings drawer ----------------------------------------------------- */
function openSettings(){
  const s = state.meta.settings || {};
  $('#setProject').value = s.project_name || '';
  const presets = ['Hours','Days','Story Points'];
  if (presets.includes(s.capacity_unit)){ $('#setUnit').value = s.capacity_unit; $('#setCustomField').hidden = true; $('#setUnitCustom').value = ''; }
  else { $('#setUnit').value = '__custom'; $('#setCustomField').hidden = false; $('#setUnitCustom').value = s.capacity_unit || ''; }
  $('#setAbbrev').value = s.unit_abbrev || '';
  $('#setCapacity').value = Number(s.default_capacity || 0);
  $('#setSprint').value = s.sprint_length_days || 14;
  $('#setTz').value = s.timezone || '';
  $('#setDrawer').classList.add('open'); $('#setScrim').classList.add('open');
  setTimeout(() => $('#setProject').focus(), 40);
}
function closeSettings(){ $('#setDrawer').classList.remove('open'); $('#setScrim').classList.remove('open'); }
async function saveSettings(){
  const unitSel = $('#setUnit').value;
  const patch = {
    project_name: $('#setProject').value.trim() || 'Sprint Board',
    capacity_unit: unitSel === '__custom' ? ($('#setUnitCustom').value.trim() || 'Custom') : unitSel,
    unit_abbrev: $('#setAbbrev').value.trim() || 'h',
    default_capacity: Number($('#setCapacity').value || 0),
    sprint_length_days: parseInt($('#setSprint').value, 10) || 14,
    timezone: $('#setTz').value.trim() || 'UTC',
  };
  const version = state.meta.settings ? state.meta.settings.version : undefined;
  try {
    const row = await req('PATCH','/api/settings', { patch, version });
    state.meta.settings = row; applySettings(); renderCurrent();
    closeSettings(); toast('Settings saved');
  } catch (e){
    if (e.status === 409 && e.current){ state.meta.settings = e.current; applySettings(); renderCurrent(); toast('Settings were changed elsewhere — reloaded.', true); }
    else toast(`Save failed: ${esc(e.message)}`, true);
  }
}

/* -- Event wiring -------------------------------------------------------- */
$$('.nav-item').forEach(b => b.addEventListener('click', () => {
  setActiveNav(b);
  state.scope = b.dataset.scope || 'all';         // Views/Planning reset to the full board
  setView(b.dataset.view);
}));

['#q','#fOwner','#fReviewer','#fStatus','#fStream'].forEach(s => {
  $(s).addEventListener('input', () => { renderBoard(); renderSummary(); });
  $(s).addEventListener('change', () => { renderBoard(); renderSummary(); });
});
$('#clearF').addEventListener('click', () => {
  $('#q').value=''; $('#fOwner').value=''; $('#fReviewer').value=''; $('#fStatus').value=''; $('#fStream').value='';
  renderBoard(); renderSummary();
});
$('#exportBtn').addEventListener('click', () => downloadCsv(taskCsv(visibleTasks()), 'sprint-24-board.csv'));

/* Board: one delegated listener handles open / edit / slider */
$('#board').addEventListener('click', e => {
  const op = e.target.closest('[data-open]');
  if (op){ openDrawer(+op.dataset.open); return; }
  if (e.target.classList.contains('prog-range')) return;   // the slider handles its own events
  const cell = e.target.closest('.cell');
  if (cell && !cell.classList.contains('plain')) editCell(cell.parentElement, { coll:'tasks', entity:'task', paint:paintTaskCell });
});
$('#board').addEventListener('keydown', e => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const cell = e.target.closest('.cell');
  if (cell){ e.preventDefault(); editCell(cell.parentElement, { coll:'tasks', entity:'task', paint:paintTaskCell }); }
});
/* Slider: update visuals while dragging, fire a single request on release (change) */
$('#board').addEventListener('input', e => {
  if (!e.target.classList.contains('prog-range')) return;
  const v = e.target.value;
  e.target.style.setProperty('--pct', v + '%');
  const num = e.target.parentElement.querySelector('.prog-num');
  if (num) num.textContent = v + '%';
});
$('#board').addEventListener('change', e => {
  if (!e.target.classList.contains('prog-range')) return;
  patchRow('task', +e.target.dataset.id, { prog: Number(e.target.value) });
});

$('#meetTable').addEventListener('click', e => {
  const del = e.target.closest('[data-del]');
  if (del){ if (confirm('Delete this meeting?')) req('DELETE', `/api/meetings/${del.dataset.del}`).catch(err=>toast(esc(err.message),true)); return; }
  const cell = e.target.closest('.cell');
  if (cell) editCell(cell.parentElement, { coll:'meetings', entity:'meeting', paint:paintMeetCell });
});
$('#msTable').addEventListener('click', e => {
  const del = e.target.closest('[data-del]');
  if (del){ if (confirm('Delete this milestone?')) req('DELETE', `/api/milestones/${del.dataset.del}`).catch(err=>toast(esc(err.message),true)); return; }
  const cell = e.target.closest('.cell');
  if (cell) editCell(cell.parentElement, { coll:'milestones', entity:'milestone', paint:paintMsCell });
});
$('#cal').addEventListener('click', e => {
  const op = e.target.closest('[data-open]');
  if (op){ openDrawer(+op.dataset.open); }
});
$('#ganttGrid').addEventListener('click', e => {
  const sec = e.target.closest('.g-stream');
  if (sec){ toggleSection(sec.dataset.stream); return; }
  const ev = e.target.closest('[data-ev-id]');
  if (ev){ openEventModal(null, { kind: ev.dataset.evKind, id: +ev.dataset.evId }); return; }
  const op = e.target.closest('[data-open]');
  if (op) openDrawer(+op.dataset.open);
});
$('#ganttGrid').addEventListener('keydown', e => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const sec = e.target.closest('.g-stream');
  if (sec){ e.preventDefault(); toggleSection(sec.dataset.stream); }
});

/* Top-bar create buttons are rendered per view, so delegate */
$('#viewActions').addEventListener('click', async e => {
  const id = e.target.id;
  if (id === 'addTask'){
    try {
      const row = await req('POST','/api/tasks', {
        sim:`SIM-${Date.now().toString().slice(-5)}`, title:'New task', stream:'PMO',
        owner:state.actor, reviewer:'', status:'Not Started', pri:'P2',
        start_date:TODAY, eta:iso(addDays(new Date(TODAY+'T00:00:00'),5)), prog:0, notes:'', effort:0,
      });
      replaceRow('tasks', row); renderCurrent(); openDrawer(row.id);
    } catch (err){ toast(`Create failed: ${esc(err.message)}`, true); }
  }
  if (id === 'addMeet') createMeeting();
  if (id === 'addMs')   createMilestone();
});

$('#gearBtn').addEventListener('click', openSettings);

$('#dSave').addEventListener('click', saveDrawer);
$('#dClose').addEventListener('click', closeDrawer);
$('#scrim').addEventListener('click', closeDrawer);
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if ($('#evModal').classList.contains('open')) closeEventModal();
  else if ($('#setDrawer').classList.contains('open')) closeSettings();
  else if (state.openId !== null) closeDrawer();
});
$('#dProg').addEventListener('input', e => {
  e.target.style.setProperty('--pct', e.target.value + '%');
  $('#dProgVal').textContent = e.target.value + '%';
});

$('#gPrev').addEventListener('click',  () => { state.ganttAnchor = addDays(state.ganttAnchor,-7); renderGantt(); });
$('#gNext').addEventListener('click',  () => { state.ganttAnchor = addDays(state.ganttAnchor, 7); renderGantt(); });
$('#gToday').addEventListener('click', () => { state.ganttAnchor = addDays(new Date(TODAY+'T00:00:00'),-3); renderGantt(); });
$('#cPrev').addEventListener('click',  () => { state.calMonth = new Date(state.calMonth.getFullYear(), state.calMonth.getMonth()-1, 1); renderCalendar(); });
$('#cNext').addEventListener('click',  () => { state.calMonth = new Date(state.calMonth.getFullYear(), state.calMonth.getMonth()+1, 1); renderCalendar(); });
$('#cToday').addEventListener('click', () => { const d=new Date(TODAY+'T00:00:00'); state.calMonth = new Date(d.getFullYear(), d.getMonth(), 1); renderCalendar(); });

$('#tlAddMs').addEventListener('click', () => openEventModal('milestone'));
$('#tlAddMeet').addEventListener('click', () => openEventModal('meeting'));

$('#evType').addEventListener('change', () => {
  evTimeVisibility();
  if (!state.evEdit) $('#evTitle').textContent = 'Add ' + ($('#evType').value === 'meeting' ? 'meeting' : 'milestone');
});
$('#evSave').addEventListener('click', saveEventModal);
$('#evCancel').addEventListener('click', closeEventModal);
$('#evDelete').addEventListener('click', deleteEventModal);
$('#evScrim').addEventListener('click', closeEventModal);

/* Phase 3: workstreams, workload, reports, settings */
$('#wsCards').addEventListener('click', e => {
  const c = e.target.closest('.ws-card');
  if (!c) return;
  $('#fStream').value = c.dataset.stream; state.scope = 'all';   // open the board filtered to this workstream
  const nav = document.querySelector('.nav-item[data-view="board"][data-scope="all"]');
  if (nav) setActiveNav(nav);
  setView('board');
});
$('#wlPeople').addEventListener('click', e => {
  const p = e.target.closest('[data-person]');
  if (p){ state.wlPerson = p.dataset.person; renderWorkload(); }
});
$('#wlDetail').addEventListener('click', e => {
  const cap = e.target.closest('.wl-cap');
  if (cap){ editCapacity(cap); return; }
  const op = e.target.closest('[data-open]');
  if (op) openDrawer(+op.dataset.open);
});
$('#wlDetail').addEventListener('keydown', e => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const cap = e.target.closest('.wl-cap');
  if (cap){ e.preventDefault(); editCapacity(cap); }
});
$('#rptCsv').addEventListener('click', () => downloadCsv(taskCsv(state.tasks), 'sprint-24-report.csv'));
$('#rptPdf').addEventListener('click', () => window.print());
$('#setSave').addEventListener('click', saveSettings);
$('#setCancel').addEventListener('click', closeSettings);
$('#setScrim').addEventListener('click', closeSettings);
$('#setUnit').addEventListener('change', () => {
  const v = $('#setUnit').value;
  $('#setCustomField').hidden = v !== '__custom';
  const ab = { 'Hours':'h', 'Days':'d', 'Story Points':'pts' }[v];
  if (ab) $('#setAbbrev').value = ab;
});

initGate();
