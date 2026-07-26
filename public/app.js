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
  meta: { people:[], streams:[], statuses:[], pris:[], msStatuses:[], kinds:[] },
  view: 'board',
  openId: null,
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
const shortDate = ds => ds ? new Date(ds+'T00:00:00').toLocaleDateString('en-US',{month:'short',day:'numeric'}) : '--';
const slug = s => String(s||'').toLowerCase().replace(/[^a-z]/g,'');

function toast(msg, warn){
  const t = $('#toast');
  t.innerHTML = msg;
  t.className = 'toast show' + (warn ? ' warn' : '');
  clearTimeout(t._h);
  t._h = setTimeout(() => { t.className = 'toast'; }, warn ? 4200 : 1500);
}

function options(list, sel){
  return (list||[]).map(v =>
    `<option value="${esc(v)}"${String(v)===String(sel)?' selected':''}>${esc(v)}</option>`).join('');
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
      toast(`Modified by <b>${esc(e.lastEditor || 'someone else')}</b>. Refreshed to the latest values \u2014 please re-check your change.`, true);
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
    $('#whoami').innerHTML = `Acting as <b style="color:#fff">${esc(name)}</b>`;
    boot();
  }
}
$('#switchUser').addEventListener('click', () => {
  sessionStorage.removeItem('sb_actor');
  location.reload();
});

/* -- Bootstrap ----------------------------------------------------------- */
async function boot(){
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

  const m = state.meta;
  $('#fOwner').innerHTML  = '<option value="">All owners</option>'     + options(m.people);
  $('#fStatus').innerHTML = '<option value="">All statuses</option>'   + options(m.statuses);
  $('#fStream').innerHTML = '<option value="">All workstreams</option>'+ options(m.streams);

  const end = new Date(SPRINT.end + 'T00:00:00');
  const dl = Math.round((end - new Date(TODAY + 'T00:00:00')) / 864e5);
  $('#daysLeft').textContent = dl >= 0 ? `${dl} days left` : `ended ${-dl}d ago`;

  connectSocket();
  renderAll();
}

/* -- Socket ------------------------------------------------ */
function connectSocket(){
  const socket = io({ auth: { actor: state.actor } });
  state.socket = socket;

  const setConn = (txt, cls) => { const c = $('#conn'); c.textContent = txt; c.className = 'conn ' + cls; };
  socket.on('connect',    () => setConn('LIVE', 'on'));
  socket.on('disconnect', () => setConn('OFFLINE - reconnecting', 'off'));
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
const VIEW_TITLE = { board:'Board', timeline:'Timeline', calendar:'Calendar', meetings:'Meetings', milestones:'Milestones' };

function setView(v){
  state.view = v;
  $$('.nav-item').forEach(b => b.setAttribute('aria-current', String(b.dataset.view === v)));
  $$('.view').forEach(el => { el.hidden = el.id !== `view-${v}`; });
  $('#viewTitle').textContent = VIEW_TITLE[v] || v;

  const acts = $('#viewActions');
  acts.innerHTML =
    v === 'board'      ? `<button class="btn" id="exportBtn">Export CSV</button><button class="btn btn-primary" id="addTask">New task</button>`
  : v === 'meetings'   ? `<button class="btn btn-primary" id="addMeet">New meeting</button>`
  : v === 'milestones' ? `<button class="btn btn-primary" id="addMs">New milestone</button>`
  : '';
  renderCurrent();
}

function renderCurrent(){
  if (state.view === 'board')      { renderRibbon(); renderBoard(); }
  else if (state.view === 'timeline')  renderGantt();
  else if (state.view === 'calendar')  renderCalendar();
  else if (state.view === 'meetings')  renderMeetings();
  else if (state.view === 'milestones')renderMilestones();
  renderCounts();
}
function renderAll(){ renderCurrent(); }

function renderCounts(){
  $('#nBoard').textContent = state.tasks.filter(t => t.status !== 'Done').length;
  $('#nMeet').textContent  = state.meetings.length;
  $('#nMs').textContent    = state.milestones.length;
}

/* -- Board ------------------------------------------------- */
const STATUS_CLASS = {
  'Not Started':'s-not','In Progress':'s-prog','In Review':'s-review','Blocked':'s-block','Done':'s-done'
};
const FIELDS = ['title','stream','owner','reviewer','status','pri','start_date','eta','prog','notes'];

function visibleTasks(){
  const q  = ($('#q').value || '').trim().toLowerCase();
  const fo = $('#fOwner').value, fs = $('#fStatus').value, fw = $('#fStream').value;
  return state.tasks.filter(t =>
    (!q || `${t.sim} ${t.title}`.toLowerCase().includes(q)) &&
    (!fo || t.owner === fo) && (!fs || t.status === fs) && (!fw || t.stream === fw)
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
    tbody.innerHTML = `<tr><td colspan="11"><div class="empty-state">
      <span class="eyebrow">No tasks</span>Nothing matches the current filters.</div></td></tr>`;
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

function renderRibbon(){
  const n = s => state.tasks.filter(t => t.status === s).length;
  const stages = [
    ['Not started', n('Not Started'), ''],
    ['In progress', n('In Progress'), 'active'],
    ['In review',   n('In Review'),   'active'],
    ['Blocked',     n('Blocked'),     'risk'],
    ['Done',        n('Done'),        'done'],
  ];
  const pct = state.tasks.length
    ? Math.round(state.tasks.reduce((a,b)=>a+Number(b.prog),0)/state.tasks.length) : 0;
  const late = state.tasks.filter(t => t.eta && t.eta < TODAY && t.status !== 'Done').length;

  $('#ribbon').innerHTML =
    stages.map(([name,v,st],i) => `
      <div class="stage ${st}">
        <span class="node">${st==='done'?'&check;':i+1}</span>
        <span class="stage-tx">
          <span class="stage-name">${esc(name)}</span>
          <span class="stage-count"><b>${v}</b> ${v===1?'task':'tasks'}</span>
        </span>
      </div>`).join('') +
    `<div class="ribbon-aside">
       <span class="eyebrow">Sprint completion</span>
       <span class="big">${pct}%</span>
       <span class="note">${n('Blocked')} blocked - ${late} past ETA</span>
     </div>`;
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
    stream:m.streams, owner:m.people, reviewer:m.people, status:null,
    pri:m.pris, kind:m.kinds,
  };
  let el;
  if (f === 'status'){
    el = document.createElement('select');
    el.innerHTML = options(coll === 'milestones' ? m.msStatuses : m.statuses, row[f]);
  } else if (SELECTS[f]){
    el = document.createElement('select');
    el.innerHTML = options(SELECTS[f], row[f]);
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
      : String(row[f] ?? '') === String(val);
    if (same){ repaint(); return; }
    patchRow(entity, id, { [f]: val });
  };
  el.addEventListener('blur', commit);
  el.addEventListener('change', () => { if (el.tagName === 'SELECT' || el.type === 'date' || el.type === 'time') commit(); });
  el.addEventListener('keydown', e => {
    if (e.key === 'Enter'){ e.preventDefault(); commit(); }
    if (e.key === 'Escape'){ done = true; repaint(); }
  });
}

/* -- Gantt ------------------------------------------------- */
const GDAYS = 14;
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

  const list = visibleTasks();
  (state.meta.streams||[]).forEach(ws => {
    const rows = list.filter(t => t.stream === ws)
      .sort((a,b) => String(a.start_date).localeCompare(String(b.start_date)));
    if (!rows.length) return;
    html += `<div class="g-stream">${esc(ws)} - ${rows.length}</div>`;
    rows.forEach(t => {
      html += `<div class="g-label"><div class="nm">${esc(t.title)}</div><div class="mt">${esc(t.owner)} - ${t.prog}%</div></div>`;
      const s = dates.indexOf(t.start_date), e = dates.indexOf(t.eta);
      const from = s>=0 ? s : (t.start_date && t.start_date < dates[0] ? 0 : GDAYS);
      const to   = e>=0 ? e : (t.eta && t.eta > dates[GDAYS-1] ? GDAYS-1 : -1);
      let bar = '';
      if (to >= 0 && from < GDAYS){
        const a = Math.max(0,from), b = Math.min(GDAYS-1,to);
        const left = a/GDAYS*100, width = Math.max(2.4,(b-a+1)/GDAYS*100-0.5);
        const cls = t.status==='Blocked' ? ' blocked' : t.status==='Done' ? ' done' : '';
        bar = `<div class="g-bar${cls}" data-open="${t.id}" style="left:${left}%;width:${width}%"
                title="${esc(t.title)} - ${esc(t.start_date)} → ${esc(t.eta)}">${t.prog}%</div>`;
      }
      html += `<div class="g-track">${bands}${bar}</div>`;
    });
  });

  /* Milestones get their own group, rendered as diamonds */
  const ms = state.milestones.filter(x => dates.includes(x.due_date));
  if (ms.length){
    html += `<div class="g-stream ms">Milestones - ${ms.length}</div>`;
    ms.forEach(x => {
      const i = dates.indexOf(x.due_date);
      html += `<div class="g-label"><div class="nm">${esc(x.title)}</div><div class="mt">${esc(x.status)}</div></div>`;
      html += `<div class="g-track">${bands}<div class="g-dia${x.status==='Done'?' done':''}"
                 style="left:${(i+0.5)/GDAYS*100}%" title="${esc(x.title)} - ${esc(x.due_date)}"></div></div>`;
    });
  }

  grid.innerHTML = html;

  const ti = dates.indexOf(TODAY);
  if (ti >= 0){
    const pos = `calc(190px + (100% - 190px) * ${(ti+0.5)/GDAYS})`;
    const line = document.createElement('div'); line.className='g-today'; line.style.left=pos;
    const tag  = document.createElement('div'); tag.className='g-today-tag'; tag.style.left=pos; tag.textContent='TODAY';
    grid.append(line, tag);
  }
}

/* -- Calendar ---------------------------------------------- */
function renderCalendar(){
  const anchor = state.calMonth;
  const y = anchor.getFullYear(), mo = anchor.getMonth();
  $('#calTitle').textContent = anchor.toLocaleDateString('en-US',{month:'long',year:'numeric'});

  const first = new Date(y, mo, 1);
  const startOffset = first.getDay();              // week starts Sunday
  const gridStart = addDays(first, -startOffset);

  /* Bucket the three event types by date */
  const byDay = {};
  const push = (d,ev) => { if(!d) return; (byDay[d] = byDay[d] || []).push(ev); };
  state.meetings.forEach(m => push(m.meeting_date, {
    type:'meet', sort:m.start_time || '',
    html:`<div class="cal-ev meet" title="${esc(m.title)} - ${esc(m.start_time)}-${esc(m.end_time)} - ${esc((m.attendees||[]).join(', '))}"><span class="tm">${esc((m.start_time||'').slice(0,5))}</span>${esc(m.title)}</div>`
  }));
  state.milestones.forEach(x => push(x.due_date, {
    type:'ms', sort:'!',
    html:`<div class="cal-ev ms" title="${esc(x.title)} - ${esc(x.status)}">◆ ${esc(x.title)}</div>`
  }));
  state.tasks.forEach(t => { if (t.status !== 'Done') push(t.eta, {
    type:'eta', sort:'zz',
    html:`<div class="cal-ev eta" data-open="${t.id}" title="ETA - ${esc(t.title)} - ${esc(t.owner)}">ETA ${esc(t.title)}</div>`
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
async function openDrawer(id){
  const t = state.tasks.find(x => x.id === id);
  if (!t) return;
  state.openId = id;
  const m = state.meta;
  $('#dSim').textContent = t.sim;
  $('#dTitleH').textContent = t.title;
  $('#dTitle').value = t.title;
  $('#dStream').innerHTML   = options(m.streams, t.stream);
  $('#dPri').innerHTML      = options(m.pris, t.pri);
  $('#dOwner').innerHTML    = options(m.people, t.owner);
  $('#dReviewer').innerHTML = options(m.people, t.reviewer);
  $('#dStatus').innerHTML   = options(m.statuses, t.status);
  $('#dStart').value = t.start_date || '';
  $('#dEta').value   = t.eta || '';
  const pr = $('#dProg');
  pr.value = t.prog; pr.style.setProperty('--pct', t.prog + '%');
  $('#dProgVal').textContent = t.prog + '%';
  $('#dNotes').value = t.notes || '';
  $('#dHistory').innerHTML = '<div class="hist-row"><div style="color:var(--slate-mid)">Loading&hellip;</div></div>';

  $('#drawer').classList.add('open');
  $('#scrim').classList.add('open');
  $('#dTitle').focus();

  try {
    const rows = await req('GET', `/api/activity?entity=task&id=${id}&limit=30`);
    $('#dHistory').innerHTML = rows.length ? rows.map(a => {
      const when = new Date(a.at).toLocaleString('en-US',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});
      const what = a.action === 'create' ? 'created this task'
        : a.action === 'delete' ? 'deleted this task'
        : `changed <b>${esc(a.field)}</b> from ${esc(a.old_value ?? 'empty')} to <b>${esc(a.new_value ?? 'empty')}</b>`;
      return `<div class="hist-row"><time>${esc(when)}</time><div><b>${esc(a.actor)}</b> ${what}</div></div>`;
    }).join('') : '<div class="hist-row"><div style="color:var(--slate-mid)">No changes recorded yet.</div></div>';
  } catch (e){
    $('#dHistory').innerHTML = `<div class="hist-row"><div style="color:var(--amber)">Could not load activity.</div></div>`;
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
    status: $('#dStatus').value,
    start_date: $('#dStart').value, eta: $('#dEta').value,
    prog: Number($('#dProg').value), notes: $('#dNotes').value,
  };
  closeDrawer();
  await patchRow('task', id, patch);
}

/* -- Event wiring -------------------------------------------------------- */
$$('.nav-item').forEach(b => b.addEventListener('click', () => setView(b.dataset.view)));
['#q','#fOwner','#fStatus','#fStream'].forEach(s => {
  $(s).addEventListener('input', () => { renderBoard(); renderRibbon(); });
  $(s).addEventListener('change', () => { renderBoard(); renderRibbon(); });
});
$('#clearF').addEventListener('click', () => {
  $('#q').value=''; $('#fOwner').value=''; $('#fStatus').value=''; $('#fStream').value='';
  renderBoard(); renderRibbon();
});

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
  if (op){ setView('board'); openDrawer(+op.dataset.open); }
});
$('#ganttGrid').addEventListener('click', e => {
  const op = e.target.closest('[data-open]');
  if (op) openDrawer(+op.dataset.open);
});

/* Top-bar buttons are rendered dynamically, so delegate */
$('#viewActions').addEventListener('click', async e => {
  const id = e.target.id;
  if (id === 'addTask'){
    const seq = state.tasks.length + 1;
    try {
      const row = await req('POST','/api/tasks', {
        sim:`SIM-${Date.now().toString().slice(-5)}`, title:'New task', stream:'PMO',
        owner:state.actor, reviewer:'', status:'Not Started', pri:'P2',
        start_date:TODAY, eta:iso(addDays(new Date(TODAY+'T00:00:00'),5)), prog:0, notes:'',
      });
      replaceRow('tasks', row); renderCurrent(); openDrawer(row.id);
    } catch (err){ toast(`Create failed: ${esc(err.message)}`, true); }
  }
  if (id === 'addMeet'){
    try {
      const row = await req('POST','/api/meetings', {
        title:'New meeting', meeting_date:TODAY, start_time:'09:00', end_time:'10:00',
        kind:'Internal', attendees:[state.actor], agenda:'',
      });
      replaceRow('meetings', row); renderCurrent();
    } catch (err){ toast(`Create failed: ${esc(err.message)}`, true); }
  }
  if (id === 'addMs'){
    try {
      const row = await req('POST','/api/milestones', {
        title:'New milestone', due_date:TODAY, status:'On Track', owner:state.actor, notes:'',
      });
      replaceRow('milestones', row); renderCurrent();
    } catch (err){ toast(`Create failed: ${esc(err.message)}`, true); }
  }
  if (id === 'exportBtn'){
    const cols = ['sim','title','stream','owner','reviewer','status','pri','start_date','eta','prog','notes'];
    const qv = v => `"${String(v ?? '').replace(/"/g,'""')}"`;
    const csv = [cols.join(',')].concat(visibleTasks().map(t => cols.map(c=>qv(t[c])).join(','))).join('\n');
    const url = URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8'}));
    const a = document.createElement('a'); a.href = url; a.download = 'sprint-24-board.csv'; a.click();
    URL.revokeObjectURL(url);
  }
});

$('#dSave').addEventListener('click', saveDrawer);
$('#dClose').addEventListener('click', closeDrawer);
$('#scrim').addEventListener('click', closeDrawer);
document.addEventListener('keydown', e => { if (e.key === 'Escape' && state.openId !== null) closeDrawer(); });
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

$('#expandAll').addEventListener('click', () => {
  const w = $('#tableWrap');
  const full = w.style.maxHeight === 'none';
  w.style.maxHeight = full ? '' : 'none';
  $('#expandAll').textContent = full ? 'Fit to content' : 'Collapse';
});

initGate();
