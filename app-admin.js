const root = document.getElementById('root');
const tabsEl = document.getElementById('tabs');
const LS_ADMIN_OK = 'twm_admin_ok';

// ---------- state ----------
let state = {
  employees: [],
  shifts: [],
  payments: [],
  config: { qrToken:'', adminCode:'1234', periodStartDay:5 },
  periodOffset: 0, // 0 = current period, 1 = one period back, ...
  tab: 'dashboard'
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
function currentPeriodStart(){
  return periodStartFor(new Date(), state.config.periodStartDay);
}
function periodStartAtOffset(offset){
  return addDays(currentPeriodStart(), -7*offset);
}
function periodKeyOf(startDate){ return dateKey(startDate); }

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

function genToken(){
  return 'shop-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

// ---------- computed aggregates ----------
function shiftDurationHours(s){
  if(s.manualTotalHours != null) return s.manualTotalHours;
  if(!s.checkIn || !s.checkOut) return 0;
  const inD = s.checkIn.toDate ? s.checkIn.toDate() : new Date(s.checkIn);
  const outD = s.checkOut.toDate ? s.checkOut.toDate() : new Date(s.checkOut);
  return Math.max(0, (outD - inD) / 3600000);
}

function employeeLifetimeStats(empId){
  const rate = (state.employees.find(e=>e.id===empId)||{}).hourlyRate || 0;
  const hours = state.shifts
    .filter(s=>s.employeeId===empId && (s.manualTotalHours!=null || s.checkOut))
    .reduce((sum,s)=>sum+shiftDurationHours(s), 0);
  const paid = state.payments.filter(p=>p.employeeId===empId).reduce((s,p)=>s+(p.amount||0),0);
  const earned = hours*rate;
  return { hours, earned, paid, remaining: earned-paid };
}

function shiftsForPeriod(empId, periodStart){
  const key = periodKeyOf(periodStart);
  const periodEnd = addDays(periodStart,7);
  return state.shifts.filter(s=>{
    if(s.employeeId !== empId) return false;
    if(s.manualTotalHours != null) return s.periodKey === key;
    if(!s.checkIn) return false;
    const inD = s.checkIn.toDate ? s.checkIn.toDate() : new Date(s.checkIn);
    return inD >= periodStart && inD < periodEnd;
  });
}
function paymentsForPeriod(empId, periodStart){
  const key = periodKeyOf(periodStart);
  return state.payments.filter(p=>p.employeeId===empId && p.periodKey===key);
}
function periodStatsForEmployee(empId, periodStart){
  const rate = (state.employees.find(e=>e.id===empId)||{}).hourlyRate || 0;
  const shifts = shiftsForPeriod(empId, periodStart);
  const hours = shifts.reduce((s,sh)=>s+shiftDurationHours(sh),0);
  const paid = paymentsForPeriod(empId, periodStart).reduce((s,p)=>s+(p.amount||0),0);
  const earned = hours*rate;
  return { hours, earned, paid, remaining: earned-paid, shifts };
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
  if(localStorage.getItem(LS_ADMIN_OK) === '1'){
    renderApp();
  } else {
    renderGate();
  }
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
  ['periods','תקופות שכר'],
  ['reports','דוחות'],
  ['qr','QR'],
  ['settings','הגדרות']
];

function renderApp(){
  tabsEl.innerHTML = TABS.map(([id,label])=>
    `<button class="tab ${state.tab===id?'active':''}" data-tab="${id}">${label}</button>`
  ).join('');
  tabsEl.querySelectorAll('.tab').forEach(btn=>{
    btn.onclick = ()=>{ state.tab = btn.dataset.tab; renderApp(); };
  });
  if(state.tab==='dashboard') renderDashboard();
  else if(state.tab==='employees') renderEmployees();
  else if(state.tab==='periods') renderPeriods();
  else if(state.tab==='reports') renderReports();
  else if(state.tab==='qr') renderQr();
  else if(state.tab==='settings') renderSettings();
}

// ---------- dashboard ----------
function renderDashboard(){
  const periodStart = currentPeriodStart();
  const periodEnd = addDays(periodStart,6);
  const active = state.employees.filter(e=>e.active!==false);
  let totalEarned=0, totalPaid=0;
  active.forEach(e=>{
    const st = periodStatsForEmployee(e.id, periodStart);
    totalEarned += st.earned; totalPaid += st.paid;
  });
  const alerts = active.filter(e=>hasOpenShift(e.id) || hasReviewShift(e.id));

  root.innerHTML = `
    <div class="card">
      <p class="muted">תקופה נוכחית</p>
      <h2>${fmtDateHe(periodStart)} – ${fmtDateHe(periodEnd)}</h2>
      <div class="divider"></div>
      <div class="row between"><span>סה"כ לתשלום לכולם</span><b class="mono">${money(totalEarned)}</b></div>
      <div class="row between"><span>כבר שולם</span><b class="mono">${money(totalPaid)}</b></div>
      <div class="row between"><span>נותר לתשלום</span><b class="mono">${money(totalEarned-totalPaid)}</b></div>
      <div class="row between"><span>עובדים פעילים</span><b class="mono">${active.length}</b></div>
    </div>
    ${alerts.length ? `<div class="card">
      <h3>דורש תשומת לב</h3>
      ${alerts.map(e=>`
        <div class="row between" style="margin-top:8px;">
          <span>${e.name}</span>
          <span>
            ${hasOpenShift(e.id)?'<span class="tag tag-open">משמרת פתוחה</span> ':''}
            ${hasReviewShift(e.id)?'<span class="tag tag-review">דורש בדיקה</span>':''}
          </span>
        </div>`).join('')}
    </div>` : ''}
  `;
}

// ---------- employees ----------
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
      <div class="row between">
        <div>
          <b>${e.name}</b> ${e.active===false?'<span class="tag tag-off">מושבת</span>':''}
          ${hasOpenShift(e.id)?'<span class="tag tag-open">משמרת פתוחה</span>':''}
          ${hasReviewShift(e.id)?'<span class="tag tag-review">דורש בדיקה</span>':''}
          <div class="muted">משתמש: ${e.username} · ${money(e.hourlyRate)}/שעה</div>
        </div>
        <div class="mono" style="text-align:left;">
          <div class="muted" style="font-size:12px;">יתרה כוללת</div>
          <b>${money(stats.remaining)}</b>
        </div>
      </div>
      <div class="row" style="margin-top:10px;">
        <button class="btn btn-ghost btn-sm" data-edit="${e.id}">עריכה</button>
        <button class="btn btn-ghost btn-sm" data-reset="${e.id}">איפוס מכשיר</button>
        <button class="btn btn-ghost btn-sm" data-toggle="${e.id}">${e.active===false?'הפעלה':'השבתה'}</button>
      </div>
    `;
    list.appendChild(card);
  });
  list.querySelectorAll('[data-edit]').forEach(b=>b.onclick=()=>openEmployeeForm(b.dataset.edit));
  list.querySelectorAll('[data-reset]').forEach(b=>b.onclick=async()=>{
    if(!confirm('לאפס את שיוך המכשיר של העובד?')) return;
    await db.collection('employees').doc(b.dataset.reset).update({deviceId: firebase.firestore.FieldValue.delete()});
    await loadAll(); renderEmployees(); toast('המכשיר אופס');
  });
  list.querySelectorAll('[data-toggle]').forEach(b=>b.onclick=async()=>{
    const emp = state.employees.find(x=>x.id===b.dataset.toggle);
    await db.collection('employees').doc(emp.id).update({active: emp.active===false ? true : false});
    await loadAll(); renderEmployees();
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
  document.getElementById('btn-cancel-emp').onclick = renderEmployees;
  document.getElementById('btn-save-emp').onclick = async ()=>{
    const data = {
      name: document.getElementById('f-name').value.trim(),
      username: document.getElementById('f-username').value.trim(),
      pin: document.getElementById('f-pin').value.trim(),
      hourlyRate: parseFloat(document.getElementById('f-rate').value) || 0,
      active: emp ? (emp.active!==false) : true
    };
    if(!data.name || !data.username || !data.pin){ toast('נא למלא את כל השדות'); return; }
    if(emp){
      await db.collection('employees').doc(emp.id).update(data);
    } else {
      data.deviceId = null;
      await db.collection('employees').add(data);
    }
    await loadAll(); renderEmployees(); toast('נשמר');
  };
}

// ---------- periods ----------
function renderPeriods(){
  const periodStart = periodStartAtOffset(state.periodOffset);
  const periodEnd = addDays(periodStart,6);
  const key = periodKeyOf(periodStart);
  const active = state.employees.filter(e=>e.active!==false);

  root.innerHTML = `
    <div class="card">
      <div class="nav-period">
        <button id="btn-prev">›</button>
        <div class="period-label">
          <b>${fmtDateHe(periodStart)} – ${fmtDateHe(periodEnd)}</b><br>
          <span class="muted">${state.periodOffset===0?'התקופה הנוכחית':state.periodOffset+' תקופות אחורה'}</span>
        </div>
        <button id="btn-next" ${state.periodOffset===0?'disabled style="opacity:.3"':''}>‹</button>
      </div>
    </div>
    <div id="period-emps"></div>
    <div class="card">
      <button class="btn btn-ghost" id="btn-quick">הזנה מהירה של סך שעות</button>
      <button class="btn btn-ghost" style="margin-top:8px;" id="btn-detail">הזנת משמרת מפורטת</button>
    </div>
  `;
  document.getElementById('btn-prev').onclick = ()=>{ state.periodOffset++; renderPeriods(); };
  document.getElementById('btn-next').onclick = ()=>{ if(state.periodOffset>0){ state.periodOffset--; renderPeriods(); } };
  document.getElementById('btn-quick').onclick = ()=>openQuickEntry(periodStart);
  document.getElementById('btn-detail').onclick = ()=>openDetailEntry();

  const cont = document.getElementById('period-emps');
  active.forEach(e=>{
    const st = periodStatsForEmployee(e.id, periodStart);
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `
      <div class="row between">
        <b>${e.name}</b>
        <span class="mono">${fmtHours(st.hours)} ש'</span>
      </div>
      <div class="row between muted"><span>הגיע לו</span><span class="mono">${money(st.earned)}</span></div>
      <div class="row between muted"><span>שולם</span><span class="mono">${money(st.paid)}</span></div>
      <div class="row between"><b>נותר לתקופה זו</b><b class="mono">${money(st.remaining)}</b></div>
      <div class="row" style="margin-top:10px;">
        <button class="btn btn-ghost btn-sm" data-pay="${e.id}">רישום תשלום</button>
        <button class="btn btn-ghost btn-sm" data-details="${e.id}">פרטי משמרות (${st.shifts.length})</button>
      </div>
      <div class="shift-details hidden" id="det-${e.id}"></div>
    `;
    cont.appendChild(card);
  });
  cont.querySelectorAll('[data-pay]').forEach(b=>b.onclick=()=>openPaymentForm(b.dataset.pay, periodStart));
  cont.querySelectorAll('[data-details]').forEach(b=>b.onclick=()=>{
    const el = document.getElementById('det-'+b.dataset.details);
    if(el.classList.contains('hidden')){
      el.classList.remove('hidden');
      renderShiftDetails(el, b.dataset.details, periodStart);
    } else { el.classList.add('hidden'); el.innerHTML=''; }
  });
}

function renderShiftDetails(el, empId, periodStart){
  const shifts = shiftsForPeriod(empId, periodStart);
  if(!shifts.length){ el.innerHTML = '<p class="muted">אין רישומים בתקופה זו.</p>'; return; }
  el.innerHTML = '<div class="divider"></div>' + shifts.map(s=>{
    let desc;
    if(s.manualTotalHours!=null){
      desc = `הזנה כוללת: ${fmtHours(s.manualTotalHours)} ש'`;
    } else {
      const inD = s.checkIn.toDate ? s.checkIn.toDate() : new Date(s.checkIn);
      const outD = s.checkOut ? (s.checkOut.toDate ? s.checkOut.toDate() : new Date(s.checkOut)) : null;
      desc = `${fmtDateHe(inD)} · ${fmtTimeHe(inD)} - ${outD?fmtTimeHe(outD):'—'} ${s.needsReview?'<span class="tag tag-review">דורש בדיקה</span>':''}`;
    }
    return `<div class="row between" style="padding:6px 0;">
      <span style="font-size:13px;">${desc}</span>
      <span>
        <button class="btn btn-ghost btn-sm" data-del-shift="${s.id}">מחיקה</button>
      </span>
    </div>`;
  }).join('');
  el.querySelectorAll('[data-del-shift]').forEach(b=>b.onclick=async()=>{
    if(!confirm('למחוק רישום זה?')) return;
    await db.collection('shifts').doc(b.dataset.delShift).delete();
    await loadAll(); renderPeriods();
  });
}

function openQuickEntry(periodStart){
  const active = state.employees.filter(e=>e.active!==false);
  root.innerHTML = `
    <div class="card">
      <h2>הזנה מהירה — סך שעות</h2>
      <p class="muted">תקופה: ${fmtDateHe(periodStart)} – ${fmtDateHe(addDays(periodStart,6))}</p>
      <label>עובד</label>
      <select id="f-emp">${active.map(e=>`<option value="${e.id}">${e.name}</option>`).join('')}</select>
      <label>סך השעות בתקופה זו</label>
      <input id="f-hours" type="number" step="0.25" placeholder="לדוגמה 38.5">
      <div class="row" style="margin-top:16px;">
        <button class="btn btn-primary" id="btn-save-quick">שמירה</button>
        <button class="btn btn-ghost" id="btn-cancel-quick">ביטול</button>
      </div>
    </div>
  `;
  document.getElementById('btn-cancel-quick').onclick = renderPeriods;
  document.getElementById('btn-save-quick').onclick = async ()=>{
    const empId = document.getElementById('f-emp').value;
    const hours = parseFloat(document.getElementById('f-hours').value);
    if(!hours || hours<=0){ toast('נא להזין מספר שעות'); return; }
    await db.collection('shifts').add({
      employeeId: empId,
      manualTotalHours: hours,
      periodKey: periodKeyOf(periodStart),
      checkIn: null, checkOut: null, needsReview:false, note:'הזנה מהירה'
    });
    await loadAll(); renderPeriods(); toast('נשמר');
  };
}

function toInputDate(d){ return d.toISOString().slice(0,10); }

function openDetailEntry(){
  const active = state.employees.filter(e=>e.active!==false);
  const today = toInputDate(new Date());
  root.innerHTML = `
    <div class="card">
      <h2>הזנת משמרת מפורטת</h2>
      <label>עובד</label>
      <select id="f-emp">${active.map(e=>`<option value="${e.id}">${e.name}</option>`).join('')}</select>
      <label>תאריך כניסה</label>
      <input id="f-date" type="date" value="${today}">
      <label>שעת כניסה</label>
      <input id="f-in" type="time" value="09:00">
      <label>שעת יציאה</label>
      <input id="f-out" type="time" value="17:00">
      <p class="muted">אם היציאה מוקדמת יותר מהכניסה, המערכת תניח שהיציאה הייתה למחרת (משמרת לילה).</p>
      <div class="row" style="margin-top:16px;">
        <button class="btn btn-primary" id="btn-save-detail">שמירה</button>
        <button class="btn btn-ghost" id="btn-cancel-detail">ביטול</button>
      </div>
    </div>
  `;
  document.getElementById('btn-cancel-detail').onclick = renderPeriods;
  document.getElementById('btn-save-detail').onclick = async ()=>{
    const empId = document.getElementById('f-emp').value;
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
    await loadAll(); renderPeriods(); toast('נשמר');
  };
}

function openPaymentForm(empId, periodStart){
  const emp = state.employees.find(e=>e.id===empId);
  const st = periodStatsForEmployee(empId, periodStart);
  const today = toInputDate(new Date());
  root.innerHTML = `
    <div class="card">
      <h2>רישום תשלום — ${emp.name}</h2>
      <p class="muted">תקופה: ${fmtDateHe(periodStart)} – ${fmtDateHe(addDays(periodStart,6))}<br>נותר לתקופה זו: ${money(st.remaining)}</p>
      <label>סכום (€)</label>
      <input id="f-amount" type="number" step="0.01" value="${st.remaining>0?st.remaining.toFixed(2):''}">
      <label>תאריך</label>
      <input id="f-date" type="date" value="${today}">
      <div class="row" style="margin-top:10px;">
        <button class="btn btn-ghost btn-sm" id="btn-full">סמן כשולם במלואו</button>
      </div>
      <div class="row" style="margin-top:16px;">
        <button class="btn btn-primary" id="btn-save-pay">שמירה</button>
        <button class="btn btn-ghost" id="btn-cancel-pay">ביטול</button>
      </div>
    </div>
  `;
  document.getElementById('btn-full').onclick = ()=>{
    document.getElementById('f-amount').value = st.remaining>0?st.remaining.toFixed(2):0;
  };
  document.getElementById('btn-cancel-pay').onclick = renderPeriods;
  document.getElementById('btn-save-pay').onclick = async ()=>{
    const amount = parseFloat(document.getElementById('f-amount').value);
    const dateStr = document.getElementById('f-date').value;
    if(!amount || amount<=0 || !dateStr){ toast('נא למלא סכום ותאריך'); return; }
    await db.collection('payments').add({
      employeeId: empId,
      amount,
      date: firebase.firestore.Timestamp.fromDate(new Date(dateStr+'T12:00:00')),
      periodKey: periodKeyOf(periodStart)
    });
    await loadAll(); renderPeriods(); toast('התשלום נשמר');
  };
}

// ---------- reports ----------
function renderReports(){
  const periodStart = periodStartAtOffset(state.periodOffset);
  const periodEnd = addDays(periodStart,6);
  const active = state.employees.filter(e=>e.active!==false);
  root.innerHTML = `
    <div class="card no-print">
      <div class="nav-period">
        <button id="btn-prev">›</button>
        <div class="period-label"><b>${fmtDateHe(periodStart)} – ${fmtDateHe(periodEnd)}</b></div>
        <button id="btn-next" ${state.periodOffset===0?'disabled style="opacity:.3"':''}>‹</button>
      </div>
      <div class="row" style="margin-top:12px;">
        <button class="btn btn-ghost btn-sm" id="btn-print">הדפסה</button>
        <button class="btn btn-ghost btn-sm" id="btn-csv">ייצוא לאקסל (CSV)</button>
      </div>
    </div>
    <div class="card">
      <h2>דוח שכר — ${fmtDateHe(periodStart)} עד ${fmtDateHe(periodEnd)}</h2>
      <table>
        <tr><th>עובד</th><th>שעות</th><th>הגיע לו</th><th>שולם</th><th>נותר</th></tr>
        ${active.map(e=>{
          const st = periodStatsForEmployee(e.id, periodStart);
          return `<tr><td>${e.name}</td><td class="mono">${fmtHours(st.hours)}</td><td class="mono">${money(st.earned)}</td><td class="mono">${money(st.paid)}</td><td class="mono">${money(st.remaining)}</td></tr>`;
        }).join('')}
      </table>
    </div>
  `;
  document.getElementById('btn-prev').onclick = ()=>{ state.periodOffset++; renderReports(); };
  document.getElementById('btn-next').onclick = ()=>{ if(state.periodOffset>0){ state.periodOffset--; renderReports(); } };
  document.getElementById('btn-print').onclick = ()=>window.print();
  document.getElementById('btn-csv').onclick = ()=>{
    let csv = 'עובד,שעות,הגיע לו,שולם,נותר\n';
    active.forEach(e=>{
      const st = periodStatsForEmployee(e.id, periodStart);
      csv += `${e.name},${fmtHours(st.hours)},${st.earned.toFixed(2)},${st.paid.toFixed(2)},${st.remaining.toFixed(2)}\n`;
    });
    const blob = new Blob(['\uFEFF'+csv], {type:'text/csv;charset=utf-8;'});
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `דוח-שכר-${dateKey(periodStart)}.csv`;
    a.click();
  };
}

// ---------- QR ----------
function renderQr(){
  root.innerHTML = `
    <div class="card center">
      <h2>קוד QR לכניסה</h2>
      <p class="muted">מדפיסים ותולים בכניסה לעסק. כל הפקה של קוד חדש מבטלת אוטומטית את הקוד הישן.</p>
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
      <h2>יום תחילת תקופת שכר</h2>
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
