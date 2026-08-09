const root = document.getElementById('root');
const tabsEl = document.getElementById('tabs');
const LS_ADMIN_OK = 'twm_admin_ok';

// ---------- state ----------
let state = {
  employees: [],
  shifts: [],
  payments: [],
  config: { qrToken:'', adminCode:'1234', periodStartDay:5 },
  periodOffset: 0,
  tab: 'dashboard',
  detailEmployeeId: null,
  reportMode: 'week', // week | month | year
  reportOffset: 0
};

function toast(msg){
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(()=>t.remove(), 2600);
}

// ---------- date helpers ----------
function addDays(d, n){ const r = new Date(d); r.setDate(r.getDate()+n); return r; }
function addMonths(d, n){ const r = new Date(d); r.setMonth(r.getMonth()+n); return r; }
function startOfDay(d){ const r = new Date(d); r.setHours(0,0,0,0); return r; }
function dateKey(d){ return startOfDay(d).toISOString().slice(0,10); }
function fmtDateHe(d){ return d.toLocaleDateString('he-IL', {day:'2-digit', month:'2-digit', year:'numeric'}); }
function fmtTimeHe(d){ return d.toLocaleTimeString('he-IL', {hour:'2-digit', minute:'2-digit'}); }
function fmtHours(h){
  const hh = Math.floor(h);
  const mm = Math.round((h-hh)*60);
  return `${hh}:${String(mm).padStart(2,'0')}`;
}
function money(n){ return (Math.round((n||0)*100)/100).toFixed(2) + ' €'; }

function periodStartFor(date, startDay){
  const d = startOfDay(date);
  const diff = (d.getDay() - startDay + 7) % 7;
  return addDays(d, -diff);
}
function currentPeriodStart(){ return periodStartFor(new Date(), state.config.periodStartDay); }
function periodStartAtOffset(offset){ return addDays(currentPeriodStart(), -7*offset); }
function periodKeyOf(startDate){ return dateKey(startDate); }
function startOfMonth(d){ return new Date(d.getFullYear(), d.getMonth(), 1); }
function startOfYear(d){ return new Date(d.getFullYear(), 0, 1); }

// ---------- data loading ----------
async function loadAll(){
  const [empSnap, shiftSnap, paySnap, cfgDoc] = await Promise.all([
    db.collection('employees').get(),
    db.collection('shifts').get(),
    db.collection('payments').get(),
    db.collection('config').doc('main').get()
  ]);
  state.employees = empSnap.docs.map(d=>({id:d.id, ...d.data()}));
  state.shifts = shiftSnap.docs.map(d=>({id:d.id, ...d.data()}));
  state.payments = paySnap.docs.map(d=>({id:d.id, ...d.data()}));
  if(cfgDoc.exists){
    state.config = { qrToken:'', adminCode:'1234', periodStartDay:5, ...cfgDoc.data() };
  } else {
    state.config = { qrToken: genToken(), adminCode:'1234', periodStartDay:5 };
    await db.collection('config').doc('main').set(state.config);
  }
}
function genToken(){ return 'shop-' + Math.random().toString(36).slice(2) + Date.now().toString(36); }

// ---------- shift helpers ----------
function shiftDurationHours(s){
  if(s.manualTotalHours != null) return s.manualTotalHours;
  if(!s.checkIn || !s.checkOut) return 0;
  const inD = s.checkIn.toDate ? s.checkIn.toDate() : new Date(s.checkIn);
  const outD = s.checkOut.toDate ? s.checkOut.toDate() : new Date(s.checkOut);
  return Math.max(0, (outD - inD) / 3600000);
}
function shiftEffectiveDate(s){
  if(s.manualTotalHours != null) return new Date(s.periodKey + 'T00:00:00');
  if(!s.checkIn) return null;
  return s.checkIn.toDate ? s.checkIn.toDate() : new Date(s.checkIn);
}
function isCountable(s){ return s.manualTotalHours != null || !!s.checkOut; }

// ---------- lifetime (global) balance — the single clear "how much do I owe now" number ----------
function employeeLifetimeStats(empId){
  const rate = (state.employees.find(e=>e.id===empId)||{}).hourlyRate || 0;
  const hours = state.shifts
    .filter(s=>s.employeeId===empId && isCountable(s))
    .reduce((sum,s)=>sum+shiftDurationHours(s), 0);
  const paid = state.payments.filter(p=>p.employeeId===empId).reduce((s,p)=>s+(p.amount||0),0);
  const earned = hours*rate;
  return { hours, earned, paid, remaining: earned-paid };
}

// ---------- range stats (for week/month/year "how much for this range" info panels) ----------
function statsForRange(empId, startDate, endDateExcl){
  const rate = (state.employees.find(e=>e.id===empId)||{}).hourlyRate || 0;
  const shifts = state.shifts.filter(s=>{
    if(s.employeeId !== empId || !isCountable(s)) return false;
    const d = shiftEffectiveDate(s);
    return d && d >= startDate && d < endDateExcl;
  });
  const hours = shifts.reduce((s,sh)=>s+shiftDurationHours(sh),0);
  const pays = state.payments.filter(p=>{
    if(p.employeeId !== empId || !p.date) return false;
    const d = p.date.toDate ? p.date.toDate() : new Date(p.date);
    return d >= startDate && d < endDateExcl;
  });
  const paid = pays.reduce((s,p)=>s+(p.amount||0),0);
  const earned = hours*rate;
  return { hours, earned, paid, shifts, payments: pays };
}
function weekStats(empId, offset){
  const start = periodStartAtOffset(offset);
  return { start, end: addDays(start,7), ...statsForRange(empId, start, addDays(start,7)) };
}
function monthStats(empId, offset){
  const base = addMonths(startOfMonth(new Date()), -offset);
  const end = addMonths(base,1);
  return { start: base, end, ...statsForRange(empId, base, end) };
}
function yearStats(empId, offset){
  const base = new Date(new Date().getFullYear()-offset, 0, 1);
  const end = new Date(base.getFullYear()+1,0,1);
  return { start: base, end, ...statsForRange(empId, base, end) };
}

function hasOpenShift(empId){
  return state.shifts.some(s=>s.employeeId===empId && s.manualTotalHours==null && s.checkIn && !s.checkOut && !s.needsReview);
}
function hasReviewShift(empId){
  return state.shifts.some(s=>s.employeeId===empId && s.needsReview);
}

// ---------- gate ----------
async function boot(){
  await loadAll();
  if(localStorage.getItem(LS_ADMIN_OK) === '1') renderApp();
  else renderGate();
}
function renderGate(){
  tabsEl.innerHTML = '';
  root.innerHTML = `
    <div class="card" style="margin-top:40px;">
      <h2>קוד גישה</h2>
      <p class="muted">הזינו את קוד הגישה של המנהל.</p>
      <input id="f-code" type="password" inputmode="numeric" placeholder="קוד גישה">
      <button class="btn btn-primary" style="margin-top:14px;" id="btn-enter">כניסה</button>
      <p class="muted" id="gate-err" style="margin-top:8px;"></p>
    </div>
  `;
  document.getElementById('btn-enter').onclick = ()=>{
    const v = document.getElementById('f-code').value.trim();
    if(v === String(state.config.adminCode)){
      localStorage.setItem(LS_ADMIN_OK,'1');
      renderApp();
    } else {
      document.getElementById('gate-err').textContent = 'קוד שגוי.';
    }
  };
}

// ---------- app shell ----------
const TABS = [
  ['dashboard','דשבורד'],
  ['employees','עובדים'],
  ['reports','דוחות'],
  ['qr','QR'],
  ['settings','הגדרות']
];
function renderApp(){
  tabsEl.innerHTML = TABS.map(([id,label])=>
    `<button class="tab ${state.tab===id?'active':''}" data-tab="${id}">${label}</button>`
  ).join('');
  tabsEl.querySelectorAll('.tab').forEach(btn=>{
    btn.onclick = ()=>{ state.tab = btn.dataset.tab; state.detailEmployeeId=null; renderApp(); };
  });
  if(state.tab==='dashboard') renderDashboard();
  else if(state.tab==='employees'){
    if(state.detailEmployeeId) renderEmployeeDetail(state.detailEmployeeId);
    else renderEmployees();
  }
  else if(state.tab==='reports') renderReports();
  else if(state.tab==='qr') renderQr();
  else if(state.tab==='settings') renderSettings();
}

// ---------- dashboard ----------
function renderDashboard(){
  const active = state.employees.filter(e=>e.active!==false);
  const wStart = currentPeriodStart(), wEnd = addDays(wStart,6);
  const mStart = startOfMonth(new Date()), mEnd = addMonths(mStart,1);

  let wEarn=0,wPaid=0,mEarn=0,mPaid=0,totalOwed=0;
  active.forEach(e=>{
    const w = statsForRange(e.id, wStart, addDays(wStart,7));
    const m = statsForRange(e.id, mStart, mEnd);
    wEarn+=w.earned; wPaid+=w.paid; mEarn+=m.earned; mPaid+=m.paid;
    totalOwed += employeeLifetimeStats(e.id).remaining;
  });
  const alerts = active.filter(e=>hasOpenShift(e.id) || hasReviewShift(e.id));

  root.innerHTML = `
    <div class="card">
      <p class="muted">סה"כ חוב כולל לכל העובדים כרגע</p>
      <div class="big-num">${money(totalOwed)}</div>
    </div>
    <div class="card">
      <div class="row between"><h3>השבוע</h3><span class="muted">${fmtDateHe(wStart)} - ${fmtDateHe(wEnd)}</span></div>
      <div class="row between"><span>הגיע לעובדים</span><b class="mono">${money(wEarn)}</b></div>
      <div class="row between"><span>שולם</span><b class="mono">${money(wPaid)}</b></div>
    </div>
    <div class="card">
      <div class="row between"><h3>החודש</h3><span class="muted">${mStart.toLocaleDateString('he-IL',{month:'long',year:'numeric'})}</span></div>
      <div class="row between"><span>הגיע לעובדים</span><b class="mono">${money(mEarn)}</b></div>
      <div class="row between"><span>שולם</span><b class="mono">${money(mPaid)}</b></div>
    </div>
    <div class="card">
      <div class="row between"><span>עובדים פעילים</span><b class="mono">${active.length}</b></div>
    </div>
    ${alerts.length ? `<div class="card">
      <h3>דורש תשומת לב</h3>
      ${alerts.map(e=>`
        <div class="row between" style="margin-top:8px;cursor:pointer;" data-goto="${e.id}">
          <span>${e.name}</span>
          <span>
            ${hasOpenShift(e.id)?'<span class="tag tag-open">משמרת פתוחה</span> ':''}
            ${hasReviewShift(e.id)?'<span class="tag tag-review">דורש בדיקה</span>':''}
          </span>
        </div>`).join('')}
    </div>` : ''}
  `;
  root.querySelectorAll('[data-goto]').forEach(el=>el.onclick=()=>{
    state.tab='employees'; state.detailEmployeeId = el.dataset.goto; renderApp();
  });
}

// ---------- employees list ----------
function renderEmployees(){
  root.innerHTML = `
    <div class="card">
      <button class="btn btn-brass" id="btn-add-emp">+ הוספת עובד</button>
    </div>
    <div id="emp-list"></div>
  `;
  document.getElementById('btn-add-emp').onclick = ()=>openEmployeeForm(null);
  const list = document.getElementById('emp-list');
  state.employees.forEach(e=>{
    const stats = employeeLifetimeStats(e.id);
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `
      <div class="row between" style="cursor:pointer;" data-open="${e.id}">
        <div>
          <b>${e.name}</b> ${e.active===false?'<span class="tag tag-off">מושבת</span>':''}
          ${hasOpenShift(e.id)?'<span class="tag tag-open">משמרת פתוחה</span>':''}
          ${hasReviewShift(e.id)?'<span class="tag tag-review">דורש בדיקה</span>':''}
          <div class="muted">משתמש: ${e.username} · ${money(e.hourlyRate)}/שעה</div>
        </div>
        <div class="mono" style="text-align:left;">
          <div class="muted" style="font-size:12px;">חוב כרגע</div>
          <b>${money(stats.remaining)}</b>
        </div>
      </div>
    `;
    list.appendChild(card);
  });
  list.querySelectorAll('[data-open]').forEach(b=>b.onclick=()=>{
    state.detailEmployeeId = b.dataset.open; renderApp();
  });
}

function openEmployeeForm(empId){
  const emp = empId ? state.employees.find(e=>e.id===empId) : null;
  root.innerHTML = `
    <div class="card">
      <h2>${emp?'עריכת עובד':'עובד חדש'}</h2>
      <label>שם</label><input id="f-name" value="${emp?emp.name:''}">
      <label>שם משתמש (לכניסה)</label><input id="f-username" value="${emp?emp.username:''}">
      <label>קוד אישי</label><input id="f-pin" value="${emp?emp.pin:''}">
      <label>שכר לשעה (€)</label><input id="f-rate" type="number" step="0.01" value="${emp?emp.hourlyRate:''}">
      <div class="row" style="margin-top:16px;">
        <button class="btn btn-primary" id="btn-save-emp">שמירה</button>
        <button class="btn btn-ghost" id="btn-cancel-emp">ביטול</button>
      </div>
    </div>
  `;
  document.getElementById('btn-cancel-emp').onclick = ()=>{
    if(emp) renderEmployeeDetail(emp.id); else renderEmployees();
  };
  document.getElementById('btn-save-emp').onclick = async ()=>{
    const data = {
      name: document.getElementById('f-name').value.trim(),
      username: document.getElementById('f-username').value.trim(),
      pin: document.getElementById('f-pin').value.trim(),
      hourlyRate: parseFloat(document.getElementById('f-rate').value) || 0,
      active: emp ? (emp.active!==false) : true
    };
    if(!data.name || !data.username || !data.pin){ toast('נא למלא את כל השדות'); return; }
    let id = empId;
    if(emp){
      await db.collection('employees').doc(emp.id).update(data);
    } else {
      data.deviceId = null;
      const ref = await db.collection('employees').add(data);
      id = ref.id;
    }
    await loadAll();
    state.detailEmployeeId = id;
    renderApp();
    toast('נשמר');
  };
}

// ---------- employee detail (central hub) ----------
function renderEmployeeDetail(empId){
  const emp = state.employees.find(e=>e.id===empId);
  if(!emp){ state.detailEmployeeId=null; renderEmployees(); return; }
  const life = employeeLifetimeStats(empId);
  const w = weekStats(empId, state.periodOffset);

  root.innerHTML = `
    <div class="row between no-print" style="margin-bottom:6px;">
      <a href="#" id="back-link" class="muted" style="text-decoration:underline;">← חזרה לרשימה</a>
    </div>
    <div class="card">
      <div class="row between">
        <div>
          <h2>${emp.name}</h2>
          <span class="muted">${emp.username} · ${money(emp.hourlyRate)}/שעה</span>
          ${emp.active===false?' <span class="tag tag-off">מושבת</span>':''}
          ${hasOpenShift(emp.id)?' <span class="tag tag-open">משמרת פתוחה</span>':''}
          ${hasReviewShift(emp.id)?' <span class="tag tag-review">דורש בדיקה</span>':''}
        </div>
      </div>
      <div class="row" style="margin-top:10px;">
        <button class="btn btn-ghost btn-sm" id="btn-edit-emp">עריכת פרטים</button>
        <button class="btn btn-ghost btn-sm" id="btn-reset-dev">איפוס מכשיר</button>
        <button class="btn btn-ghost btn-sm" id="btn-toggle-active">${emp.active===false?'הפעלה':'השבתה'}</button>
      </div>
    </div>

    <div class="card center">
      <p class="muted">חוב כולל כרגע (כל הזמנים)</p>
      <div class="big-num">${money(life.remaining)}</div>
      <p class="muted mono" style="margin-top:4px;">${fmtHours(life.hours)} שעות סה"כ · ${money(life.earned)} הגיע · ${money(life.paid)} שולם</p>
      <div class="row" style="margin-top:12px;">
        <button class="btn btn-brass" id="btn-add-payment">רישום תשלום</button>
      </div>
    </div>

    <div class="card">
      <div class="nav-period">
        <button id="btn-prev-w">›</button>
        <div class="period-label">
          <b>${fmtDateHe(w.start)} – ${fmtDateHe(addDays(w.start,6))}</b><br>
          <span class="muted">שעות השבוע: ${fmtHours(w.hours)} · ${money(w.earned)}</span>
        </div>
        <button id="btn-next-w" ${state.periodOffset===0?'disabled style="opacity:.3"':''}>‹</button>
      </div>
      <div class="divider"></div>
      <div id="week-shifts"></div>
      <div class="row" style="margin-top:10px;">
        <button class="btn btn-ghost btn-sm" id="btn-quick">הזנה מהירה (סך שעות)</button>
        <button class="btn btn-ghost btn-sm" id="btn-detail">הזנת משמרת מדויקת</button>
      </div>
    </div>

    <div class="card">
      <h3>כל התשלומים</h3>
      <div id="all-payments"></div>
    </div>
  `;

  document.getElementById('back-link').onclick = (e)=>{ e.preventDefault(); state.detailEmployeeId=null; renderApp(); };
  document.getElementById('btn-edit-emp').onclick = ()=>openEmployeeForm(emp.id);
  document.getElementById('btn-reset-dev').onclick = async ()=>{
    if(!confirm('לאפס את שיוך המכשיר של העובד?')) return;
    await db.collection('employees').doc(emp.id).update({deviceId: firebase.firestore.FieldValue.delete()});
    await loadAll(); renderEmployeeDetail(empId); toast('המכשיר אופס');
  };
  document.getElementById('btn-toggle-active').onclick = async ()=>{
    await db.collection('employees').doc(emp.id).update({active: emp.active===false ? true : false});
    await loadAll(); renderEmployeeDetail(empId);
  };
  document.getElementById('btn-add-payment').onclick = ()=>openPaymentForm(emp.id, null);
  document.getElementById('btn-prev-w').onclick = ()=>{ state.periodOffset++; renderEmployeeDetail(empId); };
  document.getElementById('btn-next-w').onclick = ()=>{ if(state.periodOffset>0){ state.periodOffset--; renderEmployeeDetail(empId); } };
  document.getElementById('btn-quick').onclick = ()=>openQuickEntry(empId, w.start);
  document.getElementById('btn-detail').onclick = ()=>openDetailEntry(empId);

  const wsCont = document.getElementById('week-shifts');
  if(!w.shifts.length && !hasOpenShiftInWeek(empId, w.start)){
    wsCont.innerHTML = '<p class="muted">אין רישומים בשבוע זה.</p>';
  } else {
    const openInWeek = state.shifts.filter(s=>s.employeeId===empId && !s.checkOut && s.manualTotalHours==null);
    wsCont.innerHTML = [...w.shifts, ...openInWeek].map(s=>shiftRowHtml(s)).join('');
    wsCont.querySelectorAll('[data-edit-shift]').forEach(b=>b.onclick=()=>openEditShift(b.dataset.editShift, empId));
  }

  const payCont = document.getElementById('all-payments');
  const emPays = state.payments.filter(p=>p.employeeId===empId).sort((a,b)=>{
    const da = a.date && a.date.toDate ? a.date.toDate() : new Date(a.date||0);
    const db_ = b.date && b.date.toDate ? b.date.toDate() : new Date(b.date||0);
    return db_-da;
  });
  if(!emPays.length){
    payCont.innerHTML = '<p class="muted">אין עדיין תשלומים רשומים.</p>';
  } else {
    payCont.innerHTML = emPays.map(p=>{
      const d = p.date && p.date.toDate ? p.date.toDate() : new Date(p.date);
      return `<div class="row between" style="padding:6px 0;border-bottom:1px solid var(--line);">
        <span>${fmtDateHe(d)}</span>
        <span class="mono">${money(p.amount)}</span>
        <span>
          <button class="btn btn-ghost btn-sm" data-edit-pay="${p.id}">עריכה</button>
          <button class="btn btn-ghost btn-sm" data-del-pay="${p.id}">מחיקה</button>
        </span>
      </div>`;
    }).join('');
    payCont.querySelectorAll('[data-edit-pay]').forEach(b=>b.onclick=()=>openPaymentForm(empId, b.dataset.editPay));
    payCont.querySelectorAll('[data-del-pay]').forEach(b=>b.onclick=async()=>{
      if(!confirm('למחוק תשלום זה?')) return;
      await db.collection('payments').doc(b.dataset.delPay).delete();
      await loadAll(); renderEmployeeDetail(empId);
    });
  }
}

function hasOpenShiftInWeek(empId, weekStart){
  return state.shifts.some(s=>s.employeeId===empId && !s.checkOut && s.manualTotalHours==null && s.checkIn &&
    (s.checkIn.toDate?s.checkIn.toDate():new Date(s.checkIn)) >= weekStart);
}

function shiftRowHtml(s){
  let desc;
  if(s.manualTotalHours!=null){
    desc = `הזנה כוללת: ${fmtHours(s.manualTotalHours)} שעות`;
  } else {
    const inD = s.checkIn.toDate ? s.checkIn.toDate() : new Date(s.checkIn);
    const outD = s.checkOut ? (s.checkOut.toDate ? s.checkOut.toDate() : new Date(s.checkOut)) : null;
    desc = `${fmtDateHe(inD)} · ${fmtTimeHe(inD)} → ${outD?fmtTimeHe(outD):'פתוחה'} ${s.needsReview?'<span class="tag tag-review">דורש בדיקה</span>':''}`;
  }
  return `<div class="row between" style="padding:6px 0;border-bottom:1px solid var(--line);">
    <span style="font-size:13px;">${desc}</span>
    <button class="btn btn-ghost btn-sm" data-edit-shift="${s.id}">עריכה</button>
  </div>`;
}

function openEditShift(shiftId, empId){
  const s = state.shifts.find(x=>x.id===shiftId);
  if(!s) return;
  if(s.manualTotalHours != null){
    root.innerHTML = `
      <div class="card">
        <h2>עריכת הזנה כוללת</h2>
        <label>סך השעות</label>
        <input id="f-hours" type="number" step="0.25" value="${s.manualTotalHours}">
        <div class="row" style="margin-top:16px;">
          <button class="btn btn-primary" id="btn-save">שמירה</button>
          <button class="btn btn-danger" id="btn-del">מחיקה</button>
          <button class="btn btn-ghost" id="btn-cancel">ביטול</button>
        </div>
      </div>
    `;
    document.getElementById('btn-cancel').onclick = ()=>renderEmployeeDetail(empId);
    document.getElementById('btn-save').onclick = async ()=>{
      const hours = parseFloat(document.getElementById('f-hours').value);
      if(!hours || hours<=0){ toast('נא להזין שעות'); return; }
      await db.collection('shifts').doc(shiftId).update({manualTotalHours: hours});
      await loadAll(); renderEmployeeDetail(empId); toast('נשמר');
    };
    document.getElementById('btn-del').onclick = async ()=>{
      if(!confirm('למחוק רישום זה?')) return;
      await db.collection('shifts').doc(shiftId).delete();
      await loadAll(); renderEmployeeDetail(empId);
    };
    return;
  }
  const inD = s.checkIn.toDate ? s.checkIn.toDate() : new Date(s.checkIn);
  const outD = s.checkOut ? (s.checkOut.toDate ? s.checkOut.toDate() : new Date(s.checkOut)) : null;
  root.innerHTML = `
    <div class="card">
      <h2>עריכת משמרת</h2>
      <label>תאריך כניסה</label>
      <input id="f-date" type="date" value="${toInputDate(inD)}">
      <label>שעת כניסה</label>
      <input id="f-in" type="time" value="${toInputTime(inD)}">
      <label>שעת יציאה (השאירו ריק כדי להשאיר משמרת פתוחה)</label>
      <input id="f-out" type="time" value="${outD?toInputTime(outD):''}">
      <label>תאריך יציאה</label>
      <input id="f-outdate" type="date" value="${outD?toInputDate(outD):toInputDate(inD)}">
      <div class="row" style="margin-top:16px;">
        <button class="btn btn-primary" id="btn-save">שמירה</button>
        <button class="btn btn-ghost btn-sm" id="btn-clear-out">נקה שעת יציאה בלבד</button>
      </div>
      <div class="row" style="margin-top:10px;">
        <button class="btn btn-danger" id="btn-del">מחיקת המשמרת כולה</button>
        <button class="btn btn-ghost" id="btn-cancel">ביטול</button>
      </div>
    </div>
  `;
  document.getElementById('btn-cancel').onclick = ()=>renderEmployeeDetail(empId);
  document.getElementById('btn-clear-out').onclick = async ()=>{
    await db.collection('shifts').doc(shiftId).update({checkOut:null, needsReview:false});
    await loadAll(); renderEmployeeDetail(empId); toast('שעת היציאה נוקתה — המשמרת פתוחה כעת');
  };
  document.getElementById('btn-del').onclick = async ()=>{
    if(!confirm('למחוק את המשמרת הזו לגמרי?')) return;
    await db.collection('shifts').doc(shiftId).delete();
    await loadAll(); renderEmployeeDetail(empId);
  };
  document.getElementById('btn-save').onclick = async ()=>{
    const dateStr = document.getElementById('f-date').value;
    const inTime = document.getElementById('f-in').value;
    const outTime = document.getElementById('f-out').value;
    const outDateStr = document.getElementById('f-outdate').value;
    if(!dateStr || !inTime){ toast('נא למלא תאריך ושעת כניסה'); return; }
    const newIn = new Date(`${dateStr}T${inTime}:00`);
    let update = { checkIn: firebase.firestore.Timestamp.fromDate(newIn), needsReview:false };
    if(outTime){
      const newOut = new Date(`${outDateStr||dateStr}T${outTime}:00`);
      update.checkOut = firebase.firestore.Timestamp.fromDate(newOut);
    } else {
      update.checkOut = null;
    }
    await db.collection('shifts').doc(shiftId).update(update);
    await loadAll(); renderEmployeeDetail(empId); toast('נשמר');
  };
}

function toInputDate(d){ return d.toISOString().slice(0,10); }
function toInputTime(d){ return String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0'); }

function openQuickEntry(empId, weekStart){
  root.innerHTML = `
    <div class="card">
      <h2>הזנה מהירה — סך שעות</h2>
      <p class="muted">שבוע: ${fmtDateHe(weekStart)} – ${fmtDateHe(addDays(weekStart,6))}</p>
      <label>סך השעות בשבוע זה</label>
      <input id="f-hours" type="number" step="0.25" placeholder="לדוגמה 38.5">
      <div class="row" style="margin-top:16px;">
        <button class="btn btn-primary" id="btn-save">שמירה</button>
        <button class="btn btn-ghost" id="btn-cancel">ביטול</button>
      </div>
    </div>
  `;
  document.getElementById('btn-cancel').onclick = ()=>renderEmployeeDetail(empId);
  document.getElementById('btn-save').onclick = async ()=>{
    const hours = parseFloat(document.getElementById('f-hours').value);
    if(!hours || hours<=0){ toast('נא להזין מספר שעות'); return; }
    await db.collection('shifts').add({
      employeeId: empId, manualTotalHours: hours, periodKey: periodKeyOf(weekStart),
      checkIn: null, checkOut: null, needsReview:false, note:'הזנה מהירה'
    });
    await loadAll(); renderEmployeeDetail(empId); toast('נשמר');
  };
}

function openDetailEntry(empId){
  const today = toInputDate(new Date());
  root.innerHTML = `
    <div class="card">
      <h2>הזנת משמרת מדויקת</h2>
      <label>תאריך כניסה</label>
      <input id="f-date" type="date" value="${today}">
      <label>שעת כניסה</label>
      <input id="f-in" type="time" value="09:00">
      <label>שעת יציאה</label>
      <input id="f-out" type="time" value="17:00">
      <p class="muted">אם היציאה מוקדמת מהכניסה, המערכת תניח שהיציאה הייתה למחרת (משמרת לילה).</p>
      <div class="row" style="margin-top:16px;">
        <button class="btn btn-primary" id="btn-save">שמירה</button>
        <button class="btn btn-ghost" id="btn-cancel">ביטול</button>
      </div>
    </div>
  `;
  document.getElementById('btn-cancel').onclick = ()=>renderEmployeeDetail(empId);
  document.getElementById('btn-save').onclick = async ()=>{
    const dateStr = document.getElementById('f-date').value;
    const inTime = document.getElementById('f-in').value;
    const outTime = document.getElementById('f-out').value;
    if(!dateStr || !inTime || !outTime){ toast('נא למלא את כל השדות'); return; }
    const inD = new Date(`${dateStr}T${inTime}:00`);
    let outD = new Date(`${dateStr}T${outTime}:00`);
    if(outD <= inD) outD = addDays(outD, 1);
    await db.collection('shifts').add({
      employeeId: empId,
      checkIn: firebase.firestore.Timestamp.fromDate(inD),
      checkOut: firebase.firestore.Timestamp.fromDate(outD),
      needsReview: false, note:'הזנה ידנית'
    });
    await loadAll(); renderEmployeeDetail(empId); toast('נשמר');
  };
}

function openPaymentForm(empId, paymentId){
  const emp = state.employees.find(e=>e.id===empId);
  const life = employeeLifetimeStats(empId);
  const existing = paymentId ? state.payments.find(p=>p.id===paymentId) : null;
  const today = toInputDate(new Date());
  const existDate = existing ? (existing.date.toDate?existing.date.toDate():new Date(existing.date)) : null;
  root.innerHTML = `
    <div class="card">
      <h2>${existing?'עריכת תשלום':'רישום תשלום'} — ${emp.name}</h2>
      <p class="muted">חוב כולל כרגע: ${money(life.remaining)}</p>
      <label>סכום (€)</label>
      <input id="f-amount" type="number" step="0.01" value="${existing?existing.amount:(life.remaining>0?life.remaining.toFixed(2):'')}">
      <label>תאריך</label>
      <input id="f-date" type="date" value="${existing?toInputDate(existDate):today}">
      ${!existing?`<div class="row" style="margin-top:10px;">
        <button class="btn btn-ghost btn-sm" id="btn-full">סמן כשולם במלואו</button>
      </div>`:''}
      <div class="row" style="margin-top:16px;">
        <button class="btn btn-primary" id="btn-save">שמירה</button>
        ${existing?'<button class="btn btn-danger" id="btn-del">מחיקה</button>':''}
        <button class="btn btn-ghost" id="btn-cancel">ביטול</button>
      </div>
    </div>
  `;
  if(!existing){
    document.getElementById('btn-full').onclick = ()=>{
      document.getElementById('f-amount').value = life.remaining>0?life.remaining.toFixed(2):0;
    };
  } else {
    document.getElementById('btn-del').onclick = async ()=>{
      if(!confirm('למחוק תשלום זה?')) return;
      await db.collection('payments').doc(existing.id).delete();
      await loadAll(); renderEmployeeDetail(empId);
    };
  }
  document.getElementById('btn-cancel').onclick = ()=>renderEmployeeDetail(empId);
  document.getElementById('btn-save').onclick = async ()=>{
    const amount = parseFloat(document.getElementById('f-amount').value);
    const dateStr = document.getElementById('f-date').value;
    if(!amount || amount<=0 || !dateStr){ toast('נא למלא סכום ותאריך'); return; }
    const payload = { employeeId: empId, amount, date: firebase.firestore.Timestamp.fromDate(new Date(dateStr+'T12:00:00')) };
    if(existing){
      await db.collection('payments').doc(existing.id).update(payload);
    } else {
      await db.collection('payments').add(payload);
    }
    await loadAll(); renderEmployeeDetail(empId); toast('נשמר');
  };
}

// ---------- reports ----------
function renderReports(){
  const active = state.employees.filter(e=>e.active!==false);
  let range, label;
  if(state.reportMode==='week'){
    const s = periodStartAtOffset(state.reportOffset);
    range = {start:s, end:addDays(s,7)};
    label = `${fmtDateHe(range.start)} – ${fmtDateHe(addDays(range.start,6))}`;
  } else if(state.reportMode==='month'){
    const s = addMonths(startOfMonth(new Date()), -state.reportOffset);
    range = {start:s, end:addMonths(s,1)};
    label = s.toLocaleDateString('he-IL',{month:'long',year:'numeric'});
  } else {
    const s = new Date(new Date().getFullYear()-state.reportOffset,0,1);
    range = {start:s, end:new Date(s.getFullYear()+1,0,1)};
    label = String(s.getFullYear());
  }

  root.innerHTML = `
    <div class="card no-print">
      <div class="row" style="margin-bottom:10px;">
        <button class="tab ${state.reportMode==='week'?'active':''}" data-mode="week">שבועי</button>
        <button class="tab ${state.reportMode==='month'?'active':''}" data-mode="month">חודשי</button>
        <button class="tab ${state.reportMode==='year'?'active':''}" data-mode="year">שנתי</button>
      </div>
      <div class="nav-period">
        <button id="btn-prev">›</button>
        <div class="period-label"><b>${label}</b></div>
        <button id="btn-next" ${state.reportOffset===0?'disabled style="opacity:.3"':''}>‹</button>
      </div>
      <div class="row" style="margin-top:12px;">
        <button class="btn btn-ghost btn-sm" id="btn-print">הדפסה</button>
        <button class="btn btn-ghost btn-sm" id="btn-csv">ייצוא לאקסל (CSV)</button>
      </div>
    </div>
    <div class="card">
      <h2>דוח שכר — ${label}</h2>
      <table>
        <tr><th>עובד</th><th>שעות</th><th>הגיע לו</th><th>שולם</th></tr>
        ${active.map(e=>{
          const st = statsForRange(e.id, range.start, range.end);
          return `<tr><td>${e.name}</td><td class="mono">${fmtHours(st.hours)}</td><td class="mono">${money(st.earned)}</td><td class="mono">${money(st.paid)}</td></tr>`;
        }).join('')}
      </table>
    </div>
  `;
  root.querySelectorAll('[data-mode]').forEach(b=>b.onclick=()=>{ state.reportMode=b.dataset.mode; state.reportOffset=0; renderReports(); });
  document.getElementById('btn-prev').onclick = ()=>{ state.reportOffset++; renderReports(); };
  document.getElementById('btn-next').onclick = ()=>{ if(state.reportOffset>0){ state.reportOffset--; renderReports(); } };
  document.getElementById('btn-print').onclick = ()=>window.print();
  document.getElementById('btn-csv').onclick = ()=>{
    let csv = 'עובד,שעות,הגיע לו,שולם\n';
    active.forEach(e=>{
      const st = statsForRange(e.id, range.start, range.end);
      csv += `${e.name},${fmtHours(st.hours)},${st.earned.toFixed(2)},${st.paid.toFixed(2)}\n`;
    });
    const blob = new Blob(['\uFEFF'+csv], {type:'text/csv;charset=utf-8;'});
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `דוח-שכר-${state.reportMode}-${dateKey(range.start)}.csv`;
    a.click();
  };
}

// ---------- QR ----------
function renderQr(){
  root.innerHTML = `
    <div class="card center">
      <h2>קוד QR לכניסה</h2>
      <p class="muted">מדפיסים ותולים בכניסה לעסק. הפקת קוד חדש מבטלת אוטומטית את הקוד הישן.</p>
      <div id="qr-canvas" style="display:flex;justify-content:center;margin:16px 0;"></div>
      <button class="btn btn-brass no-print" id="btn-new-qr">הפקת קוד חדש (מבטל את הישן)</button>
      <button class="btn btn-ghost no-print" style="margin-top:8px;" id="btn-print-qr">הדפסה</button>
    </div>
  `;
  new QRCode(document.getElementById('qr-canvas'), { text: state.config.qrToken, width:220, height:220 });
  document.getElementById('btn-new-qr').onclick = async ()=>{
    if(!confirm('להפיק קוד חדש? הקוד הישן יפסיק לעבוד מיידית.')) return;
    const token = genToken();
    await db.collection('config').doc('main').update({qrToken: token});
    state.config.qrToken = token;
    renderQr();
    toast('קוד חדש הופק');
  };
  document.getElementById('btn-print-qr').onclick = ()=>window.print();
}

// ---------- settings ----------
function renderSettings(){
  root.innerHTML = `
    <div class="card">
      <h2>שינוי קוד גישה</h2>
      <label>קוד גישה חדש</label>
      <input id="f-newcode" value="${state.config.adminCode}">
      <button class="btn btn-primary btn-sm" style="margin-top:10px;" id="btn-save-code">שמירה</button>
    </div>
    <div class="card">
      <h2>יום תחילת שבוע שכר</h2>
      <select id="f-startday">
        ${['ראשון','שני','שלישי','רביעי','חמישי','שישי','שבת'].map((d,i)=>`<option value="${i}" ${i===state.config.periodStartDay?'selected':''}>${d}</option>`).join('')}
      </select>
      <button class="btn btn-primary btn-sm" style="margin-top:10px;" id="btn-save-day">שמירה</button>
    </div>
    <div class="card">
      <h2>גיבוי נתונים</h2>
      <p class="muted">מוריד קובץ עם כל הנתונים הגולמיים (עובדים, משמרות, תשלומים).</p>
      <button class="btn btn-ghost" id="btn-backup">הורדת גיבוי (JSON)</button>
    </div>
    <div class="card">
      <button class="btn btn-ghost" id="btn-logout-admin">יציאה מהמסך המנהל</button>
    </div>
  `;
  document.getElementById('btn-save-code').onclick = async ()=>{
    const v = document.getElementById('f-newcode').value.trim();
    if(!v){ toast('נא להזין קוד'); return; }
    await db.collection('config').doc('main').update({adminCode:v});
    state.config.adminCode = v;
    toast('הקוד עודכן');
  };
  document.getElementById('btn-save-day').onclick = async ()=>{
    const v = parseInt(document.getElementById('f-startday').value,10);
    await db.collection('config').doc('main').update({periodStartDay:v});
    state.config.periodStartDay = v;
    toast('נשמר');
  };
  document.getElementById('btn-backup').onclick = ()=>{
    const data = { employees: state.employees, shifts: state.shifts, payments: state.payments, config: state.config, exportedAt: new Date().toISOString() };
    const blob = new Blob([JSON.stringify(data,null,2)], {type:'application/json'});
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `גיבוי-${dateKey(new Date())}.json`;
    a.click();
  };
  document.getElementById('btn-logout-admin').onclick = ()=>{
    localStorage.removeItem(LS_ADMIN_OK);
    renderGate();
  };
}

boot();
