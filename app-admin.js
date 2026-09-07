const root = document.getElementById('root');
const tabsEl = document.getElementById('tabs');
const LS_ADMIN_OK = 'twm_admin_ok';

// ---------- state ----------
let state = {
  employees: [],
  shifts: [],
  payments: [],
  notes: [],
  config: { qrToken:'', adminCode:'1234', periodStartDay:5 },
  periodOffset: 0,
  tab: 'dashboard',
  detailEmployeeId: null,
  reportMode: 'week', // week | month | year | monthweeks
  reportOffset: 0,
  logEmployeeId: 'all',
  logRange: 'week', // week | month
  logOffset: 0
};

function toast(msg){
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(()=>t.remove(), 2600);
}

async function sha256(str){
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b=>b.toString(16).padStart(2,'0')).join('');
}

// ---------- date helpers ----------
function addDays(d, n){ const r = new Date(d); r.setDate(r.getDate()+n); return r; }
function addMonths(d, n){ const r = new Date(d); r.setMonth(r.getMonth()+n); return r; }
function startOfDay(d){ const r = new Date(d); r.setHours(0,0,0,0); return r; }
function dateKey(d){
  const x = startOfDay(d);
  const y = x.getFullYear();
  const m = String(x.getMonth()+1).padStart(2,'0');
  const day = String(x.getDate()).padStart(2,'0');
  return `${y}-${m}-${day}`;
}
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
  const [empSnap, shiftSnap, paySnap, cfgDoc, notesSnap] = await Promise.all([
    db.collection('employees').get(),
    db.collection('shifts').get(),
    db.collection('payments').get(),
    db.collection('config').doc('main').get(),
    db.collection('notes').get()
  ]);
  state.employees = empSnap.docs.map(d=>({id:d.id, ...d.data()}));
  state.shifts = shiftSnap.docs.map(d=>({id:d.id, ...d.data()}));
  state.payments = paySnap.docs.map(d=>({id:d.id, ...d.data()}));
  state.notes = notesSnap.docs.map(d=>({id:d.id, ...d.data()}));
  if(cfgDoc.exists){
    state.config = { qrToken:'', periodStartDay:5, businessRadius:150, ...cfgDoc.data() };
  } else {
    state.config = { qrToken: genToken(), adminCodeHash: await sha256('1234'), periodStartDay:5, businessRadius:150 };
    await db.collection('config').doc('main').set(state.config);
  }
}
function genToken(){ return 'shop-' + Math.random().toString(36).slice(2) + Date.now().toString(36); }
function displayName(e){
  if(!e) return '';
  return e.nameHe ? `${e.name} (${e.nameHe})` : e.name;
}
function locLink(loc, label){
  if(!loc || loc.lat==null) return '';
  return ` <a href="https://www.google.com/maps?q=${loc.lat},${loc.lng}" target="_blank" style="font-size:12px;">📍${label||'מיקום'}</a>`;
}

// distance in meters between two lat/lng points
function distMeters(a, b){
  if(!a || !b || a.lat==null || b.lat==null) return null;
  const R = 6371000;
  const toRad = x => x*Math.PI/180;
  const dLat = toRad(b.lat-a.lat), dLng = toRad(b.lng-a.lng);
  const h = Math.sin(dLat/2)**2 + Math.cos(toRad(a.lat))*Math.cos(toRad(b.lat))*Math.sin(dLng/2)**2;
  return R * 2*Math.atan2(Math.sqrt(h), Math.sqrt(1-h));
}

const LONG_SHIFT_HOURS = 14;

// Returns a list of human-readable reasons this shift looks unusual, or [] if it's fine.
function shiftExceptionReasons(s){
  if(s.exceptionDismissed) return [];
  const reasons = [];
  if(s.manualTotalHours != null) return reasons; // manual entries have no location/time to flag

  if(s.needsReview) reasons.push('משמרת ישנה שלא נסגרה (מעל 17 שעות) — נפתחה משמרת חדשה');

  if(s.checkIn && !s.checkOut){
    const inD = s.checkIn.toDate ? s.checkIn.toDate() : new Date(s.checkIn);
    const hrs = (new Date() - inD) / 3600000;
    if(hrs > LONG_SHIFT_HOURS && !s.needsReview) reasons.push(`משמרת פתוחה כבר ${fmtHours(hrs)} שעות`);
  }
  if(s.checkIn && s.checkOut){
    const hrs = shiftDurationHours(s);
    if(hrs > LONG_SHIFT_HOURS) reasons.push(`משמרת ארוכה מהרגיל — ${fmtHours(hrs)} שעות`);
  }
  if(!s.checkIn && s.checkOut) reasons.push('קיימת שעת יציאה בלי שעת כניסה');

  const biz = state.config.businessLocation;
  const radius = state.config.businessRadius || 150;
  if(biz && biz.lat != null){
    if(s.checkInLoc){
      const d = distMeters(biz, s.checkInLoc);
      if(d != null && d > radius) reasons.push(`מיקום הכניסה רחוק מהעסק (כ-${Math.round(d)} מ')`);
    }
    if(s.checkOutLoc){
      const d = distMeters(biz, s.checkOutLoc);
      if(d != null && d > radius) reasons.push(`מיקום היציאה רחוק מהעסק (כ-${Math.round(d)} מ')`);
    }
  }
  return reasons;
}

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
function paymentEffectiveDate(p){
  if(p.periodKey) return new Date(p.periodKey + 'T00:00:00');
  return p.date && p.date.toDate ? p.date.toDate() : new Date(p.date);
}

// ---------- lifetime (global) balance — the single clear "how much do I owe now" number ----------
function employeeLifetimeStats(empId){
  const rate = (state.employees.find(e=>e.id===empId)||{}).hourlyRate || 0;
  const hours = state.shifts
    .filter(s=>s.employeeId===empId && isCountable(s))
    .reduce((sum,s)=>sum+shiftDurationHours(s), 0);
  const paid = state.payments.filter(p=>p.employeeId===empId && !p.isTip).reduce((s,p)=>s+(p.amount||0),0);
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
    if(p.employeeId !== empId || p.isTip || p.isAdjustment) return false;
    const d = paymentEffectiveDate(p);
    return d && d >= startDate && d < endDateExcl;
  });
  const paid = pays.reduce((s,p)=>s+(p.amount||0),0);
  const earned = hours*rate;
  return { hours, earned, paid, shifts, payments: pays };
}

// Cumulative totals from the beginning of time up to (but not including) a fixed
// cutoff date. Unlike the lifetime total, this number is "frozen" at the cutoff —
// it won't keep growing just because more days have passed in an in-progress week.
// Use this to answer "what did I owe as of the end of last week", separate from
// "what do I owe right now including the days that have happened since".
function statsUpTo(empId, cutoff){
  const rate = (state.employees.find(e=>e.id===empId)||{}).hourlyRate || 0;
  const hours = state.shifts
    .filter(s=>s.employeeId===empId && isCountable(s))
    .filter(s=>{ const d = shiftEffectiveDate(s); return d && d < cutoff; })
    .reduce((sum,s)=>sum+shiftDurationHours(s), 0);
  const paid = state.payments
    .filter(p=>p.employeeId===empId && !p.isTip)
    .filter(p=>{ const d = paymentEffectiveDate(p); return d && d < cutoff; })
    .reduce((s,p)=>s+(p.amount||0),0);
  const earned = hours*rate;
  return { hours, earned, paid, remaining: earned-paid };
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

  // Live-ish updates: quietly reload data every 20 seconds and re-render
  // only while looking at read-only screens (so we never wipe out a form
  // the manager is in the middle of filling in).
  setInterval(async ()=>{
    if(localStorage.getItem(LS_ADMIN_OK) !== '1') return;
    if(state.tab === 'dashboard' || state.tab === 'log' || state.tab === 'payments' || state.tab === 'exceptions'){
      try{
        await loadAll();
        renderApp();
      }catch(e){ /* ignore transient network errors */ }
    }
  }, 20000);
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
  document.getElementById('btn-enter').onclick = async ()=>{
    const v = document.getElementById('f-code').value.trim();
    let ok = false;
    if(state.config.adminCodeHash){
      ok = (await sha256(v)) === state.config.adminCodeHash;
    } else if(state.config.adminCode != null){
      ok = v === String(state.config.adminCode);
      if(ok){
        const hash = await sha256(v);
        await db.collection('config').doc('main').update({ adminCodeHash: hash, adminCode: firebase.firestore.FieldValue.delete() });
        state.config.adminCodeHash = hash;
        delete state.config.adminCode;
      }
    }
    if(ok){
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
  ['payroll','סגירת שבוע'],
  ['log','כניסות ויציאות'],
  ['exceptions','חריגים'],
  ['employees','עובדים'],
  ['payments','תשלומים'],
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
  else if(state.tab==='payroll') renderPayroll();
  else if(state.tab==='log') renderLog();
  else if(state.tab==='employees'){
    if(state.detailEmployeeId) renderEmployeeDetail(state.detailEmployeeId);
    else renderEmployees();
  }
  else if(state.tab==='exceptions') renderExceptions();
  else if(state.tab==='payments') renderPayments();
  else if(state.tab==='reports') renderReports();
  else if(state.tab==='qr') renderQr();
  else if(state.tab==='settings') renderSettings();
}

// ---------- dashboard ----------
function renderDashboard(){
  const active = state.employees.filter(e=>e.active!==false);
  // "Last completed week" is always one full period before the in-progress one —
  // this is what you actually owe people right now, regardless of what day you check.
  const lastWeekStart = periodStartAtOffset(1);
  const lastWeekEnd = addDays(lastWeekStart,7);
  const upcomingStart = periodStartAtOffset(0);
  const upcomingEnd = addDays(upcomingStart,7);
  const mStart = startOfMonth(new Date()), mEnd = addMonths(mStart,1);

  let lastEarn=0,lastPaid=0,upEarn=0,mEarn=0,mPaid=0,totalOwed=0;
  active.forEach(e=>{
    const lw = statsForRange(e.id, lastWeekStart, lastWeekEnd);
    const uw = statsForRange(e.id, upcomingStart, upcomingEnd);
    const m = statsForRange(e.id, mStart, mEnd);
    lastEarn+=lw.earned; lastPaid+=lw.paid; upEarn+=uw.earned; mEarn+=m.earned; mPaid+=m.paid;
    totalOwed += employeeLifetimeStats(e.id).remaining;
  });
  const alerts = active.filter(e=>hasOpenShift(e.id) || hasReviewShift(e.id));
  const excCount = state.shifts.filter(s=>shiftExceptionReasons(s).length).length;

  root.innerHTML = `
    <div class="card">
      <p class="muted">סה"כ חוב כולל לכל העובדים כרגע</p>
      <div class="big-num">${money(totalOwed)}</div>
    </div>
    <div class="card" style="cursor:pointer;" id="goto-payroll">
      <div class="row between"><h3>השבוע האחרון (לתשלום עכשיו)</h3><span class="muted">${fmtDateHe(lastWeekStart)} - ${fmtDateHe(addDays(lastWeekStart,6))}</span></div>
      <div class="row between"><span>הגיע לעובדים</span><b class="mono">${money(lastEarn)}</b></div>
      <div class="row between"><span>שולם</span><b class="mono">${money(lastPaid)}</b></div>
      <div class="row between"><b>נותר לשלם עבור השבוע הזה</b><b class="mono">${money(lastEarn-lastPaid)}</b></div>
      <p class="muted" style="margin-top:6px;font-size:12px;">לחצו כדי לעבור למסך "סגירת שבוע" ולשלם לכולם</p>
    </div>
    <div class="card">
      <div class="row between"><h3>השבוע הקרוב (מתקדם)</h3><span class="muted">${fmtDateHe(upcomingStart)} - ${fmtDateHe(addDays(upcomingStart,6))}</span></div>
      <div class="row between"><span>צפוי עד כה</span><b class="mono">${money(upEarn)}</b></div>
    </div>
    <div class="card">
      <div class="row between"><h3>החודש</h3><span class="muted">${mStart.toLocaleDateString('he-IL',{month:'long',year:'numeric'})}</span></div>
      <div class="row between"><span>הגיע לעובדים</span><b class="mono">${money(mEarn)}</b></div>
      <div class="row between"><span>שולם</span><b class="mono">${money(mPaid)}</b></div>
    </div>
    <div class="card">
      <div class="row between"><span>עובדים פעילים</span><b class="mono">${active.length}</b></div>
    </div>
    <div class="card">
      <div class="row between" style="cursor:pointer;" id="goto-exceptions">
        <span>חריגים לבדיקה</span>
        <b class="mono">${excCount}</b>
      </div>
    </div>
    ${alerts.length ? `<div class="card">
      <h3>דורש תשומת לב</h3>
      ${alerts.map(e=>`
        <div class="row between" style="margin-top:8px;cursor:pointer;" data-goto="${e.id}">
          <span>${displayName(e)}</span>
          <span>
            ${hasOpenShift(e.id)?'<span class="tag tag-open">משמרת פתוחה</span> ':''}
            ${hasReviewShift(e.id)?'<span class="tag tag-review">דורש בדיקה</span>':''}
          </span>
        </div>`).join('')}
    </div>` : ''}
  `;
  document.getElementById('goto-payroll').onclick = ()=>{ state.tab='payroll'; renderApp(); };
  document.getElementById('goto-exceptions').onclick = ()=>{ state.tab='exceptions'; renderApp(); };
  root.querySelectorAll('[data-goto]').forEach(el=>el.onclick=()=>{
    state.tab='employees'; state.detailEmployeeId = el.dataset.goto; renderApp();
  });
}

// ---------- quick payroll (close the week) ----------
function renderPayroll(){
  if(state.payrollOffset === undefined) state.payrollOffset = 1; // default: last completed week
  const weekStart = periodStartAtOffset(state.payrollOffset);
  const weekEnd = addDays(weekStart,7);
  const active = state.employees.filter(e=>e.active!==false);

  const rows = active.map(e=>{
    const st = statsForRange(e.id, weekStart, weekEnd);
    const remaining = Math.max(0, st.earned - st.paid);
    // Cumulative debt frozen at the END of this specific week — includes any older
    // unpaid weeks, but never includes anything from after this week, so it doesn't
    // shift around just because more days passed since.
    const cumulative = Math.max(0, statsUpTo(e.id, weekEnd).remaining);
    return { emp:e, ...st, remaining, cumulative };
  });
  const totalThisWeek = rows.reduce((s,r)=>s+r.remaining,0);
  const totalCumulative = rows.reduce((s,r)=>s+r.cumulative,0);

  root.innerHTML = `
    <div class="card no-print">
      <h2>סגירת שבוע</h2>
      <div class="nav-period">
        <button id="btn-prev">›</button>
        <div class="period-label">
          <b>${fmtDateHe(weekStart)} – ${fmtDateHe(addDays(weekStart,6))}</b><br>
          <span class="muted">${state.payrollOffset===0?'השבוע הנוכחי (בעיצומו)':state.payrollOffset===1?'השבוע האחרון שהסתיים':state.payrollOffset+' שבועות אחורה'}</span>
        </div>
        <button id="btn-next" ${state.payrollOffset===0?'disabled style="opacity:.3"':''}>‹</button>
      </div>
    </div>
    <div class="card">
      <div class="row between"><span class="muted">רק השבוע הזה</span><b class="mono">${money(totalThisWeek)}</b></div>
      <div class="row between"><span class="muted">סה"כ כולל חובות ישנים (עד סוף השבוע הזה)</span><b class="mono">${money(totalCumulative)}</b></div>
      <button class="btn btn-brass" id="btn-pay-all" style="margin-top:10px;">שלם לכולם לפי "סכום לתשלום" למטה</button>
    </div>
    <div id="payroll-rows"></div>
  `;
  document.getElementById('btn-prev').onclick = ()=>{ state.payrollOffset++; renderPayroll(); };
  document.getElementById('btn-next').onclick = ()=>{ if(state.payrollOffset>0){ state.payrollOffset--; renderPayroll(); } };

  const cont = document.getElementById('payroll-rows');
  cont.innerHTML = rows.map(r=>`
    <div class="card">
      <div class="row between"><b>${displayName(r.emp)}</b><span class="mono">${fmtHours(r.hours)} ש'</span></div>
      <div class="row between muted"><span>הגיע השבוע (${money(r.emp.hourlyRate)}/שעה)</span><span class="mono">${money(r.earned)}</span></div>
      <div class="row between muted"><span>כבר שולם השבוע</span><span class="mono">${money(r.paid)}</span></div>
      <div class="row between"><b>נותר רק לשבוע הזה</b><b class="mono">${money(r.remaining)}</b></div>
      <div class="row between muted" style="font-size:12px;"><span>סה"כ כולל חובות ישנים</span><span class="mono">${money(r.cumulative)}</span></div>
      <div class="divider"></div>
      <div class="row between" style="margin-top:6px;">
        <label style="margin:0;">סכום לתשלום עכשיו</label>
        <input data-amt="${r.emp.id}" type="number" step="0.01" value="${r.remaining>0?r.remaining.toFixed(2):0}" style="width:110px;text-align:left;">
      </div>
      <div class="row between" style="margin-top:6px;">
        <label style="margin:0;">+ טיפ (לא נכנס לחוב)</label>
        <input data-tip="${r.emp.id}" type="number" step="0.01" value="0" style="width:110px;text-align:left;">
      </div>
      <div class="row" style="margin-top:10px;">
        <button class="btn btn-primary btn-sm" data-pay="${r.emp.id}">שלם</button>
        <button class="btn btn-ghost btn-sm" data-fill-cumulative="${r.emp.id}">מלא לפי הסכום הכולל</button>
        <button class="btn btn-ghost btn-sm" data-open="${r.emp.id}">פתח כרטיס עובד</button>
      </div>
    </div>
  `).join('');

  async function payOne(empId, amt, tip){
    if(amt > 0){
      await db.collection('payments').add({
        employeeId: empId, amount: amt,
        date: firebase.firestore.Timestamp.fromDate(new Date()),
        periodKey: periodKeyOf(weekStart)
      });
    }
    if(tip > 0){
      await db.collection('payments').add({
        employeeId: empId, amount: tip, isTip: true,
        date: firebase.firestore.Timestamp.fromDate(new Date())
      });
    }
  }

  cont.querySelectorAll('[data-fill-cumulative]').forEach(b=>b.onclick=()=>{
    const r = rows.find(x=>x.emp.id===b.dataset.fillCumulative);
    document.querySelector(`[data-amt="${r.emp.id}"]`).value = r.cumulative>0?r.cumulative.toFixed(2):0;
  });
  cont.querySelectorAll('[data-pay]').forEach(b=>b.onclick=async()=>{
    const empId = b.dataset.pay;
    const amt = parseFloat(document.querySelector(`[data-amt="${empId}"]`).value) || 0;
    const tip = parseFloat(document.querySelector(`[data-tip="${empId}"]`).value) || 0;
    if(amt<=0 && tip<=0){ toast('נא להזין סכום'); return; }
    await payOne(empId, amt, tip);
    await loadAll(); renderPayroll(); toast('התשלום נשמר');
  });
  cont.querySelectorAll('[data-open]').forEach(b=>b.onclick=()=>{
    state.tab='employees'; state.detailEmployeeId = b.dataset.open; renderApp();
  });

  document.getElementById('btn-pay-all').onclick = async ()=>{
    const toPay = rows.filter(r=>{
      const amt = parseFloat(document.querySelector(`[data-amt="${r.emp.id}"]`).value) || 0;
      const tip = parseFloat(document.querySelector(`[data-tip="${r.emp.id}"]`).value) || 0;
      return amt > 0 || tip > 0;
    });
    if(!toPay.length){ toast('אין למי לשלם'); return; }
    if(!confirm(`לשלם ל-${toPay.length} עובדים לפי הסכומים שמופיעים למטה?`)) return;
    for(const r of toPay){
      const amt = parseFloat(document.querySelector(`[data-amt="${r.emp.id}"]`).value) || 0;
      const tip = parseFloat(document.querySelector(`[data-tip="${r.emp.id}"]`).value) || 0;
      await payOne(r.emp.id, amt, tip);
    }
    await loadAll(); renderPayroll(); toast('כל התשלומים נשמרו');
  };
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
          <b>${displayName(e)}</b> ${e.active===false?'<span class="tag tag-off">מושבת</span>':''}
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
      <label>שם (כפי שנרשם/מוצג לעובד — בולגרית/אנגלית וכו')</label><input id="f-name" value="${emp?emp.name:''}">
      <label>שם בעברית (לשימוש שלך בלבד, לא מוצג לעובד)</label><input id="f-namehe" value="${emp?(emp.nameHe||''):''}">
      <label>שם משתמש (לכניסה)</label><input id="f-username" value="${emp?emp.username:''}">
      <label>קוד אישי${emp?' (השאירו ריק כדי לא לשנות)':''}</label><input id="f-pin" placeholder="${emp?'••••':''}">
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
    const newPin = document.getElementById('f-pin').value.trim();
    const data = {
      name: document.getElementById('f-name').value.trim(),
      nameHe: document.getElementById('f-namehe').value.trim(),
      username: document.getElementById('f-username').value.trim(),
      hourlyRate: parseFloat(document.getElementById('f-rate').value) || 0,
      active: emp ? (emp.active!==false) : true
    };
    if(!data.name || !data.username || (!emp && !newPin)){ toast('נא למלא את כל השדות'); return; }
    if(newPin){
      data.pinHash = await sha256(newPin);
      data.pin = firebase.firestore.FieldValue.delete();
    }
    let id = empId;
    if(emp){
      await db.collection('employees').doc(emp.id).update(data);
    } else {
      data.deviceId = null;
      delete data.pin; // brand new doc — nothing to delete
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
  const lastWeek = statsForRange(empId, periodStartAtOffset(1), periodStartAtOffset(0));
  const debtNotIncludingCurrent = statsUpTo(empId, periodStartAtOffset(0)).remaining;

  root.innerHTML = `
    <div class="row between no-print" style="margin-bottom:6px;">
      <a href="#" id="back-link" class="muted" style="text-decoration:underline;">← חזרה לרשימה</a>
    </div>
    <div class="card">
      <div class="row between">
        <div>
          <h2>${displayName(emp)}</h2>
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
      <p class="muted">חוב לא כולל השבוע הנוכחי (עד סוף השבוע שהסתיים)</p>
      <div class="big-num">${money(debtNotIncludingCurrent)}</div>
      <div class="divider"></div>
      <p class="muted">כולל השבוע הנוכחי, עד עכשיו (חלקי)</p>
      <div class="big-num" style="font-size:24px;">${money(life.remaining)}</div>
      <p class="muted mono" style="margin-top:4px;">${fmtHours(life.hours)} שעות סה"כ · ${money(life.earned)} הגיע · ${money(life.paid)} שולם</p>
      <p class="muted" style="margin-top:6px;font-size:12px;">שבוע אחרון: ${fmtHours(lastWeek.hours)} שעות · ${money(lastWeek.earned)}</p>
      <div class="row" style="margin-top:12px;">
        <button class="btn btn-brass" id="btn-add-payment">רישום תשלום / טיפ</button>
      </div>
    </div>

    <div class="card">
      <h3>ציר זמן — הכל, לפי תאריך</h3>
      <p class="muted" style="font-size:12px;">כניסות, יציאות, תשלומים, טיפים והערות — מהחדש לישן</p>
      <div id="timeline"></div>
    </div>

    <div class="card">
      <h3 style="font-size:15px;">פעולות נוספות</h3>
      <div class="row" style="flex-wrap:wrap;">
        <button class="btn btn-ghost btn-sm" id="btn-quick">הזנה מהירה (סך שעות)</button>
        <button class="btn btn-ghost btn-sm" id="btn-detail">הזנת משמרת מדויקת</button>
        <button class="btn btn-ghost btn-sm" id="btn-slip">הפק פירוט שבועי לעובד</button>
      </div>
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
  document.getElementById('btn-quick').onclick = ()=>openQuickEntry(empId);
  document.getElementById('btn-detail').onclick = ()=>openDetailEntry(empId);
  document.getElementById('btn-slip').onclick = ()=>renderEmployeeSlip(empId, 1);

  renderEmployeeTimeline(empId);
}

// Merges shifts + payments + notes into one chronological, easy-to-scan feed —
// "when did they come in, when did I pay them, when did they get a tip".
function employeeTimelineItems(empId){
  const items = [];
  state.shifts.filter(s=>s.employeeId===empId).forEach(s=>{
    const d = shiftEffectiveDate(s) || new Date(0);
    let label, sub;
    if(s.manualTotalHours != null){
      label = 'הזנה ידנית'; sub = `${fmtHours(s.manualTotalHours)} שעות`;
    } else {
      const inD = s.checkIn ? (s.checkIn.toDate?s.checkIn.toDate():new Date(s.checkIn)) : null;
      const outD = s.checkOut ? (s.checkOut.toDate?s.checkOut.toDate():new Date(s.checkOut)) : null;
      label = outD ? 'משמרת' : 'כניסה — משמרת פתוחה';
      sub = inD ? `כניסה ${fmtTimeHe(inD)}${locLink(s.checkInLoc,'מיקום')}` : '';
      if(outD) sub += ` ← יציאה ${fmtTimeHe(outD)}${locLink(s.checkOutLoc,'מיקום')} · ${fmtHours(shiftDurationHours(s))} שעות`;
      if(s.needsReview) sub += ' <span class="tag tag-review">דורש בדיקה</span>';
    }
    items.push({ date:d, type:'shift', icon:'🕒', label, sub, id:s.id });
  });
  state.payments.filter(p=>p.employeeId===empId).forEach(p=>{
    const d = p.date ? (p.date.toDate?p.date.toDate():new Date(p.date)) : new Date(0);
    let sub = money(p.amount);
    if(!p.isTip && !p.isAdjustment) sub += ` · ${paymentPeriodLabel(p)}`;
    if(p.note) sub += ` · ${p.note}`;
    items.push({
      date:d, type:'payment', icon: p.isTip?'🎁':p.isAdjustment?'⚖️':'💶',
      label: p.isTip ? 'טיפ / מתנה' : p.isAdjustment ? 'התאמת יתרה' : 'תשלום',
      sub, id:p.id
    });
  });
  state.notes.filter(n=>n.employeeId===empId).forEach(n=>{
    const d = n.createdAt && n.createdAt.toDate ? n.createdAt.toDate() : new Date(0);
    items.push({ date:d, type:'note', icon:'💬', label:'הערה מהעובד', sub: n.text + locLink(n.location,'מיקום'), id:n.id });
  });
  items.sort((a,b)=>b.date-a.date);
  return items;
}

function renderEmployeeTimeline(empId){
  const items = employeeTimelineItems(empId);
  const cont = document.getElementById('timeline');
  if(!items.length){ cont.innerHTML = '<p class="muted">אין עדיין נתונים.</p>'; return; }

  const groups = [];
  let curKey=null, curGroup=null;
  items.forEach(it=>{
    const key = dateKey(it.date);
    if(key !== curKey){ curKey = key; curGroup = { date: it.date, items: [] }; groups.push(curGroup); }
    curGroup.items.push(it);
  });

  cont.innerHTML = groups.map(g => `
    <div style="margin-top:12px;">
      <div class="muted" style="font-size:12px;font-weight:700;">${fmtDateHe(g.date)}</div>
      ${g.items.map(it => `
        <div class="row between" style="padding:8px 0;border-bottom:1px solid var(--line);align-items:flex-start;">
          <div>
            <div>${it.icon} <b>${it.label}</b> <span class="muted" style="font-size:12px;">${fmtTimeHe(it.date)}</span></div>
            <div class="muted" style="font-size:13px;margin-top:2px;">${it.sub}</div>
          </div>
          <span>
            ${it.type==='shift' ? `<button class="btn btn-ghost btn-sm" data-edit-shift="${it.id}">עריכה</button>` : ''}
            ${it.type==='payment' ? `<button class="btn btn-ghost btn-sm" data-edit-pay="${it.id}">עריכה</button>` : ''}
          </span>
        </div>
      `).join('')}
    </div>
  `).join('');

  cont.querySelectorAll('[data-edit-shift]').forEach(b=>b.onclick=()=>openEditShift(b.dataset.editShift, empId));
  cont.querySelectorAll('[data-edit-pay]').forEach(b=>b.onclick=()=>openPaymentForm(empId, b.dataset.editPay));
}

// Printable weekly slip for an employee, in Bulgarian, so they can check their own hours/pay.
function renderEmployeeSlip(empId, offset){
  const emp = state.employees.find(e=>e.id===empId);
  const weekStart = periodStartAtOffset(offset);
  const weekEnd = addDays(weekStart,7);
  const st = statsForRange(empId, weekStart, weekEnd);
  const shifts = [...st.shifts].sort((a,b)=>{
    const da = shiftEffectiveDate(a) || new Date(0);
    const db_ = shiftEffectiveDate(b) || new Date(0);
    return da - db_;
  });

  root.innerHTML = `
    <div class="card no-print">
      <button class="btn btn-ghost btn-sm" id="btn-back">← חזרה</button>
      <button class="btn btn-brass btn-sm" id="btn-print" style="margin-right:8px;">הדפסה / שמירה כ-PDF</button>
    </div>
    <div class="card" dir="ltr" style="text-align:left;">
      <h2 style="font-family:'Heebo',sans-serif;">Седмичен отчет за работа</h2>
      <p class="muted">Employee weekly work report</p>
      <div class="divider"></div>
      <p><b>Име / Name:</b> ${emp.name}</p>
      <p><b>Седмица / Week:</b> ${toInputDate(weekStart)} – ${toInputDate(addDays(weekStart,6))}</p>
      <div class="divider"></div>
      <table style="width:100%;">
        <tr><th style="text-align:left;">Дата / Date</th><th style="text-align:left;">Вход / In</th><th style="text-align:left;">Изход / Out</th><th style="text-align:left;">Часове / Hours</th></tr>
        ${shifts.map(s=>{
          if(s.manualTotalHours!=null){
            return `<tr><td colspan="3">Ръчно въведено / Manual entry</td><td class="mono">${fmtHours(s.manualTotalHours)}</td></tr>`;
          }
          const inD = s.checkIn.toDate?s.checkIn.toDate():new Date(s.checkIn);
          const outD = s.checkOut ? (s.checkOut.toDate?s.checkOut.toDate():new Date(s.checkOut)) : null;
          return `<tr>
            <td>${toInputDate(inD)}</td>
            <td>${toInputTime(inD)}</td>
            <td>${outD?toInputTime(outD):'—'}</td>
            <td class="mono">${fmtHours(shiftDurationHours(s))}</td>
          </tr>`;
        }).join('')}
      </table>
      <div class="divider"></div>
      <div class="row between"><span>Общо часове / Total hours</span><b class="mono">${fmtHours(st.hours)}</b></div>
      <div class="row between"><span>Ставка / Rate</span><b class="mono">${money(emp.hourlyRate)}/ч.</b></div>
      <div class="row between"><span>Общо заработено / Total earned</span><b class="mono">${money(st.earned)}</b></div>
      <div class="row between"><span>Платено тази седмица / Paid this week</span><b class="mono">${money(st.paid)}</b></div>
      <div class="row between"><b>Остатък / Remaining</b><b class="mono">${money(st.earned-st.paid)}</b></div>
    </div>
  `;
  document.getElementById('btn-back').onclick = ()=>renderEmployeeDetail(empId);
  document.getElementById('btn-print').onclick = ()=>window.print();
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
    desc += locLink(s.checkInLoc, 'כניסה');
    if(outD) desc += locLink(s.checkOutLoc, 'יציאה');
  }
  return `<div class="row between" style="padding:6px 0;border-bottom:1px solid var(--line);">
    <span style="font-size:13px;">${desc}</span>
    <button class="btn btn-ghost btn-sm" data-edit-shift="${s.id}">עריכה</button>
  </div>`;
}

function openEditShift(shiftId, empId, returnTo){
  const goBack = returnTo || (()=>renderEmployeeDetail(empId));
  const s = state.shifts.find(x=>x.id===shiftId);
  if(!s) return;
  if(s.manualTotalHours != null){
    const hh = Math.floor(s.manualTotalHours);
    const mm = Math.round((s.manualTotalHours - hh) * 60);
    root.innerHTML = `
      <div class="card">
        <h2>עריכת הזנה כוללת</h2>
        <div class="row">
          <div style="flex:1;"><label>שעות</label><input id="f-h" type="number" step="1" min="0" value="${hh}"></div>
          <div style="flex:1;"><label>דקות</label><input id="f-m" type="number" step="1" min="0" max="59" value="${mm}"></div>
        </div>
        <div class="row" style="margin-top:16px;">
          <button class="btn btn-primary" id="btn-save">שמירה</button>
          <button class="btn btn-danger" id="btn-del">מחיקה</button>
          <button class="btn btn-ghost" id="btn-cancel">ביטול</button>
        </div>
      </div>
    `;
    document.getElementById('btn-cancel').onclick = goBack;
    document.getElementById('btn-save').onclick = async ()=>{
      const h = parseFloat(document.getElementById('f-h').value) || 0;
      const m = parseFloat(document.getElementById('f-m').value) || 0;
      const hours = h + (m/60);
      if(hours<=0){ toast('נא להזין שעות ו/או דקות'); return; }
      await db.collection('shifts').doc(shiftId).update({manualTotalHours: hours});
      await loadAll(); goBack(); toast('נשמר');
    };
    document.getElementById('btn-del').onclick = async ()=>{
      if(!confirm('למחוק רישום זה?')) return;
      await db.collection('shifts').doc(shiftId).delete();
      await loadAll(); goBack();
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
  document.getElementById('btn-cancel').onclick = goBack;
  document.getElementById('btn-clear-out').onclick = async ()=>{
    await db.collection('shifts').doc(shiftId).update({checkOut:null, needsReview:false});
    await loadAll(); goBack(); toast('שעת היציאה נוקתה — המשמרת פתוחה כעת');
  };
  document.getElementById('btn-del').onclick = async ()=>{
    if(!confirm('למחוק את המשמרת הזו לגמרי?')) return;
    await db.collection('shifts').doc(shiftId).delete();
    await loadAll(); goBack();
  };
  document.getElementById('btn-save').onclick = async ()=>{
    const dateStr = document.getElementById('f-date').value;
    const inTime = document.getElementById('f-in').value;
    const outTime = document.getElementById('f-out').value;
    const outDateStr = document.getElementById('f-outdate').value;
    if(!dateStr || !inTime){ toast('נא למלא תאריך ושעת כניסה'); return; }
    const newIn = new Date(`${dateStr}T${inTime}:00`);
    let update = { checkIn: firebase.firestore.Timestamp.fromDate(newIn), needsReview:false, exceptionDismissed:false };
    if(outTime){
      const newOut = new Date(`${outDateStr||dateStr}T${outTime}:00`);
      update.checkOut = firebase.firestore.Timestamp.fromDate(newOut);
    } else {
      update.checkOut = null;
    }
    await db.collection('shifts').doc(shiftId).update(update);
    await loadAll(); goBack(); toast('נשמר');
  };
}

function toInputDate(d){
  const y = d.getFullYear(), m = String(d.getMonth()+1).padStart(2,'0'), day = String(d.getDate()).padStart(2,'0');
  return `${y}-${m}-${day}`;
}
function toInputTime(d){ return String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0'); }

function openQuickEntry(empId){
  const weekStart = periodStartAtOffset(state.periodOffset);
  root.innerHTML = `
    <div class="card">
      <h2>הזנה מהירה — סך שעות</h2>
      <div class="nav-period">
        <button id="btn-prev-w">›</button>
        <div class="period-label">
          <b>${fmtDateHe(weekStart)} – ${fmtDateHe(addDays(weekStart,6))}</b><br>
          <span class="muted">${state.periodOffset===0?'השבוע הנוכחי':state.periodOffset+' שבועות אחורה'}</span>
        </div>
        <button id="btn-next-w" ${state.periodOffset===0?'disabled style="opacity:.3"':''}>‹</button>
      </div>
      <div class="divider"></div>
      <div class="row">
        <div style="flex:1;">
          <label>שעות</label>
          <input id="f-h" type="number" step="1" min="0" placeholder="0">
        </div>
        <div style="flex:1;">
          <label>דקות</label>
          <input id="f-m" type="number" step="1" min="0" max="59" placeholder="0">
        </div>
      </div>
      <p class="muted">לדוגמה: 3 שעות ו-30 דקות — יש להזין 3 בשדה שעות ו-30 בשדה דקות. חשוב לוודא שהשבוע המוצג למעלה הוא השבוע הנכון לפני השמירה.</p>
      <div class="row" style="margin-top:16px;">
        <button class="btn btn-primary" id="btn-save">שמירה</button>
        <button class="btn btn-ghost" id="btn-cancel">ביטול</button>
      </div>
    </div>
  `;
  document.getElementById('btn-prev-w').onclick = ()=>{ state.periodOffset++; openQuickEntry(empId); };
  document.getElementById('btn-next-w').onclick = ()=>{ if(state.periodOffset>0){ state.periodOffset--; openQuickEntry(empId); } };
  document.getElementById('btn-cancel').onclick = ()=>renderEmployeeDetail(empId);
  document.getElementById('btn-save').onclick = async ()=>{
    const h = parseFloat(document.getElementById('f-h').value) || 0;
    const m = parseFloat(document.getElementById('f-m').value) || 0;
    const hours = h + (m/60);
    if(hours <= 0){ toast('נא להזין שעות ו/או דקות'); return; }
    const targetWeek = periodStartAtOffset(state.periodOffset);
    await db.collection('shifts').add({
      employeeId: empId, manualTotalHours: hours, periodKey: periodKeyOf(targetWeek),
      checkIn: null, checkOut: null, needsReview:false, note:'הזנה מהירה'
    });
    await loadAll(); renderEmployeeDetail(empId); toast('נשמר על השבוע: ' + fmtDateHe(targetWeek) + ' – ' + fmtDateHe(addDays(targetWeek,6)));
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

function openPaymentForm(empId, paymentId, isNav){
  const emp = state.employees.find(e=>e.id===empId);
  const life = employeeLifetimeStats(empId);
  const existing = paymentId ? state.payments.find(p=>p.id===paymentId) : null;
  const today = toInputDate(new Date());
  const existDate = existing ? (existing.date.toDate?existing.date.toDate():new Date(existing.date)) : null;

  // Only set the default "which week" once, when the form is first opened —
  // navigating with the arrows must never get overridden by this again.
  if(!isNav){
    if(!existing){
      const todayIsPeriodStart = new Date().getDay() === state.config.periodStartDay;
      state.periodOffset = todayIsPeriodStart ? 1 : 0;
    } else if(existing.periodKey){
      const wStart = new Date(existing.periodKey + 'T00:00:00');
      state.periodOffset = Math.round((currentPeriodStart() - wStart) / (7*86400000));
    } else {
      state.periodOffset = 0;
    }
  }
  const weekStart = periodStartAtOffset(state.periodOffset);

  const existingType = existing ? (existing.isTip ? 'tip' : existing.isAdjustment ? 'adjustment' : 'normal') : 'normal';

  root.innerHTML = `
    <div class="card">
      <h2>${existing?'עריכת תשלום':'רישום תשלום'} — ${displayName(emp)}</h2>
      <p class="muted">חוב כולל כרגע: ${money(life.remaining)}</p>
      <label>סכום (€)</label>
      <input id="f-amount" type="number" step="0.01" value="${existing?existing.amount:(life.remaining>0?life.remaining.toFixed(2):'')}">
      <label>תאריך שבו שולם בפועל</label>
      <input id="f-date" type="date" value="${existing?toInputDate(existDate):today}">
      <label>סוג</label>
      <select id="f-type">
        <option value="normal" ${existingType==='normal'?'selected':''}>תשלום רגיל (מקטין חוב, משויך לשבוע)</option>
        <option value="tip" ${existingType==='tip'?'selected':''}>טיפ / מתנה (לא נכנס לחוב, לא משויך לשבוע)</option>
        <option value="adjustment" ${existingType==='adjustment'?'selected':''}>התאמת יתרה (מקטין חוב ישן, לא משויך לשבוע מסוים)</option>
      </select>
      <label>הערה (אופציונלי)</label>
      <textarea id="f-note" rows="2" placeholder="לדוגמה: סגירת הפרש ישן">${existing&&existing.note?existing.note:''}</textarea>
      <div id="week-section">
        <label>עבור איזה שבוע התשלום הזה</label>
        <div class="nav-period">
          <button id="btn-prev-w">›</button>
          <div class="period-label">
            <b>${fmtDateHe(weekStart)} – ${fmtDateHe(addDays(weekStart,6))}</b><br>
            <span class="muted">${state.periodOffset===0?'השבוע הנוכחי':state.periodOffset+' שבועות אחורה'}</span>
          </div>
          <button id="btn-next-w" ${state.periodOffset===0?'disabled style="opacity:.3"':''}>‹</button>
        </div>
      </div>
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
  const typeSel = document.getElementById('f-type');
  const weekSection = document.getElementById('week-section');
  const syncTypeUi = ()=>{ weekSection.style.display = typeSel.value==='normal' ? '' : 'none'; };
  typeSel.onchange = syncTypeUi;
  syncTypeUi();
  document.getElementById('btn-prev-w').onclick = ()=>{ state.periodOffset++; openPaymentForm(empId, paymentId, true); };
  document.getElementById('btn-next-w').onclick = ()=>{ if(state.periodOffset>0){ state.periodOffset--; openPaymentForm(empId, paymentId, true); } };
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
    const type = document.getElementById('f-type').value;
    const note = document.getElementById('f-note').value.trim();
    if(!amount || amount<=0 || !dateStr){ toast('נא למלא סכום ותאריך'); return; }
    const targetWeek = periodStartAtOffset(state.periodOffset);
    const payload = {
      employeeId: empId,
      amount,
      date: firebase.firestore.Timestamp.fromDate(new Date(dateStr+'T12:00:00')),
      isTip: type==='tip',
      isAdjustment: type==='adjustment',
      note: note || firebase.firestore.FieldValue.delete()
    };
    if(type==='normal'){
      payload.periodKey = periodKeyOf(targetWeek);
    } else {
      payload.periodKey = firebase.firestore.FieldValue.delete();
    }
    if(existing){
      await db.collection('payments').doc(existing.id).update(payload);
    } else {
      if(type!=='normal') delete payload.periodKey; // brand new doc — nothing to delete, just omit
      if(!note) delete payload.note;
      await db.collection('payments').add(payload);
    }
    await loadAll(); renderEmployeeDetail(empId);
    toast(type==='tip' ? 'הטיפ נשמר' : type==='adjustment' ? 'התאמת היתרה נשמרה' : 'נשמר');
  };
}

// ---------- log (all check-ins / check-outs) ----------
function logRangeInfo(){
  if(state.logRange === 'week'){
    const s = periodStartAtOffset(state.logOffset);
    return { start:s, end:addDays(s,7), label: `${fmtDateHe(s)} – ${fmtDateHe(addDays(s,6))}` };
  }
  const s = addMonths(startOfMonth(new Date()), -state.logOffset);
  return { start:s, end:addMonths(s,1), label: s.toLocaleDateString('he-IL',{month:'long',year:'numeric'}) };
}

function renderLog(){
  const range = logRangeInfo();
  const empOptions = ['<option value="all">כל העובדים</option>']
    .concat(state.employees.map(e=>`<option value="${e.id}" ${state.logEmployeeId===e.id?'selected':''}>${displayName(e)}</option>`));

  root.innerHTML = `
    <div class="card no-print">
      <label>עובד</label>
      <select id="f-log-emp">${empOptions.join('')}</select>
      <div class="row" style="margin-top:10px;">
        <button class="tab ${state.logRange==='week'?'active':''}" data-range="week">שבוע</button>
        <button class="tab ${state.logRange==='month'?'active':''}" data-range="month">חודש</button>
        <button class="btn btn-ghost btn-sm" id="btn-refresh-log" style="margin-right:auto;">רענון עכשיו</button>
      </div>
      <div class="nav-period" style="margin-top:10px;">
        <button id="btn-prev">›</button>
        <div class="period-label"><b>${range.label}</b></div>
        <button id="btn-next" ${state.logOffset===0?'disabled style="opacity:.3"':''}>‹</button>
      </div>
    </div>
    <div id="log-rows"></div>
  `;
  document.getElementById('f-log-emp').value = state.logEmployeeId;
  document.getElementById('f-log-emp').onchange = (e)=>{ state.logEmployeeId = e.target.value; renderLog(); };
  root.querySelectorAll('[data-range]').forEach(b=>b.onclick=()=>{ state.logRange=b.dataset.range; state.logOffset=0; renderLog(); });
  document.getElementById('btn-prev').onclick = ()=>{ state.logOffset++; renderLog(); };
  document.getElementById('btn-next').onclick = ()=>{ if(state.logOffset>0){ state.logOffset--; renderLog(); } };
  document.getElementById('btn-refresh-log').onclick = async ()=>{ await loadAll(); renderLog(); toast('עודכן'); };

  let rows = state.shifts.filter(s=>{
    if(state.logEmployeeId !== 'all' && s.employeeId !== state.logEmployeeId) return false;
    const d = shiftEffectiveDate(s);
    if(!d) return false;
    return d >= range.start && d < range.end;
  });
  rows.sort((a,b)=>{
    const da = shiftEffectiveDate(a), db_ = shiftEffectiveDate(b);
    return db_ - da;
  });

  const cont = document.getElementById('log-rows');
  if(!rows.length){
    cont.innerHTML = '<div class="card"><p class="muted">אין רישומים בטווח זה.</p></div>';
    return;
  }
  cont.innerHTML = rows.map(s=>{
    const emp = state.employees.find(e=>e.id===s.employeeId);
    const name = emp ? displayName(emp) : '(עובד לא ידוע)';
    let mid;
    if(s.manualTotalHours != null){
      mid = `הזנה כוללת · ${fmtHours(s.manualTotalHours)} שעות`;
    } else {
      const inD = s.checkIn.toDate ? s.checkIn.toDate() : new Date(s.checkIn);
      const outD = s.checkOut ? (s.checkOut.toDate ? s.checkOut.toDate() : new Date(s.checkOut)) : null;
      mid = `${fmtDateHe(inD)} · כניסה ${fmtTimeHe(inD)} → יציאה ${outD?fmtTimeHe(outD):'—'}`;
    }
    return `<div class="card" style="padding:12px 16px;cursor:pointer;" data-goto="${s.employeeId}">
      <div class="row between">
        <b>${name}</b>
        <span>
          ${(!s.checkOut && s.manualTotalHours==null)?'<span class="tag tag-open">משמרת פתוחה</span> ':''}
          ${s.needsReview?'<span class="tag tag-review">דורש בדיקה</span>':''}
        </span>
      </div>
      <div class="muted" style="font-size:13px;margin-top:4px;">${mid}</div>
    </div>`;
  }).join('');
  cont.querySelectorAll('[data-goto]').forEach(el=>el.onclick=()=>{
    state.tab='employees'; state.detailEmployeeId = el.dataset.goto; renderApp();
  });
}

// ---------- exceptions ----------
function renderExceptions(){
  const items = state.shifts
    .map(s=>({ s, reasons: shiftExceptionReasons(s) }))
    .filter(x=>x.reasons.length);

  const biz = state.config.businessLocation;

  root.innerHTML = `
    <div class="card no-print">
      <h2>חריגים לבדיקה</h2>
      <p class="muted">משמרות שכדאי להעיף בהן מבט — מיקום רחוק מהעסק, משמרת ארוכה מהרגיל, או רישום חסר.</p>
      ${!biz ? `<p class="muted" style="color:var(--bad);">לא הוגדר מיקום עסק, כך שבדיקת המיקום מושבתת. אפשר להגדיר בטאב "הגדרות".</p>` : ''}
      <button class="btn btn-ghost btn-sm" id="btn-refresh">רענון עכשיו</button>
    </div>
    <div id="exc-list"></div>
  `;
  document.getElementById('btn-refresh').onclick = async ()=>{ await loadAll(); renderExceptions(); toast('עודכן'); };

  const cont = document.getElementById('exc-list');
  if(!items.length){
    cont.innerHTML = '<div class="card"><p class="muted">אין כרגע חריגים לבדיקה 🎉</p></div>';
    return;
  }

  items.sort((a,b)=>{
    const da = shiftEffectiveDate(a.s) || new Date(0);
    const db_ = shiftEffectiveDate(b.s) || new Date(0);
    return db_ - da;
  });

  cont.innerHTML = items.map(({s,reasons})=>{
    const emp = state.employees.find(e=>e.id===s.employeeId);
    const inD = s.checkIn ? (s.checkIn.toDate?s.checkIn.toDate():new Date(s.checkIn)) : null;
    const outD = s.checkOut ? (s.checkOut.toDate?s.checkOut.toDate():new Date(s.checkOut)) : null;
    return `<div class="card">
      <div class="row between">
        <b>${emp?displayName(emp):'(עובד לא ידוע)'}</b>
        <span class="muted" style="font-size:12px;">${inD?fmtDateHe(inD):''}</span>
      </div>
      <div class="muted" style="font-size:13px;margin:4px 0;">
        ${inD?`כניסה: ${fmtTimeHe(inD)}${locLink(s.checkInLoc,'מיקום כניסה')}`:''}
        ${outD?`<br>יציאה: ${fmtTimeHe(outD)}${locLink(s.checkOutLoc,'מיקום יציאה')}`:''}
      </div>
      <div>
        ${reasons.map(r=>`<span class="tag tag-review" style="display:inline-block;margin:2px 4px 2px 0;">${r}</span>`).join('')}
      </div>
      <div class="row" style="margin-top:10px;">
        <button class="btn btn-brass btn-sm" data-approve="${s.id}">אישור — תקין</button>
        <button class="btn btn-ghost btn-sm" data-edit="${s.id}" data-emp="${s.employeeId}">עריכה</button>
        <button class="btn btn-danger btn-sm" data-del="${s.id}">מחיקה</button>
      </div>
    </div>`;
  }).join('');

  cont.querySelectorAll('[data-approve]').forEach(b=>b.onclick=async()=>{
    await db.collection('shifts').doc(b.dataset.approve).update({ exceptionDismissed:true, needsReview:false });
    await loadAll(); renderExceptions(); toast('אושר');
  });
  cont.querySelectorAll('[data-edit]').forEach(b=>b.onclick=()=>{
    openEditShift(b.dataset.edit, b.dataset.emp, renderExceptions);
  });
  cont.querySelectorAll('[data-del]').forEach(b=>b.onclick=async()=>{
    if(!confirm('למחוק את המשמרת הזו?')) return;
    await db.collection('shifts').doc(b.dataset.del).delete();
    await loadAll(); renderExceptions();
  });
}

// ---------- global payments log ----------
function paymentPeriodLabel(p){
  if(p.isTip) return 'טיפ / מתנה';
  if(p.isAdjustment) return 'התאמת יתרה';
  if(!p.periodKey) return '—';
  const s = new Date(p.periodKey + 'T00:00:00');
  return `עבור שבוע: ${fmtDateHe(s)} – ${fmtDateHe(addDays(s,6))}`;
}
function renderPayments(){
  const sorted = [...state.payments].sort((a,b)=>{
    const da = a.date && a.date.toDate ? a.date.toDate() : new Date(a.date||0);
    const db_ = b.date && b.date.toDate ? b.date.toDate() : new Date(b.date||0);
    return db_-da;
  });

  root.innerHTML = `
    <div class="card no-print">
      <h2>ריכוז תשלומים</h2>
      <p class="muted">כל התשלומים שנרשמו אי-פעם, לפי תאריך תשלום בפועל.</p>
      <button class="btn btn-ghost btn-sm" id="btn-refresh">רענון עכשיו</button>
    </div>
    <div id="pay-groups"></div>
  `;
  document.getElementById('btn-refresh').onclick = async ()=>{ await loadAll(); renderPayments(); toast('עודכן'); };

  const cont = document.getElementById('pay-groups');
  if(!sorted.length){
    cont.innerHTML = '<div class="card"><p class="muted">אין עדיין תשלומים רשומים.</p></div>';
    return;
  }

  // group by date (day)
  const groups = [];
  let currentKey = null, currentGroup = null;
  sorted.forEach(p=>{
    const d = p.date && p.date.toDate ? p.date.toDate() : new Date(p.date||0);
    const key = dateKey(d);
    if(key !== currentKey){
      currentKey = key;
      currentGroup = { date: d, items: [] };
      groups.push(currentGroup);
    }
    currentGroup.items.push(p);
  });

  cont.innerHTML = groups.map(g=>{
    const dayTotal = g.items.reduce((s,p)=>s+(p.amount||0),0);
    return `<div class="card">
      <div class="row between"><h3>${fmtDateHe(g.date)}</h3><span class="mono">${money(dayTotal)}</span></div>
      <div class="divider"></div>
      ${g.items.map(p=>{
        const emp = state.employees.find(e=>e.id===p.employeeId);
        return `<div class="row between" style="padding:6px 0;border-bottom:1px solid var(--line);">
          <div>
            <div>${emp?displayName(emp):'(עובד לא ידוע)'} ${p.isTip?'<span class="tag tag-open">טיפ</span>':''}${p.isAdjustment?'<span class="tag tag-off">התאמה</span>':''}</div>
            <div class="muted" style="font-size:12px;">${paymentPeriodLabel(p)}${p.note?' · '+p.note:''}</div>
          </div>
          <b class="mono">${money(p.amount)}</b>
        </div>`;
      }).join('')}
    </div>`;
  }).join('');
}
function renderReports(){
  const active = state.employees.filter(e=>e.active!==false);

  if(state.reportMode === 'monthweeks'){
    renderMonthWeeksReport();
    return;
  }

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
      ${reportModeTabsHtml()}
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
          return `<tr><td>${displayName(e)}</td><td class="mono">${fmtHours(st.hours)}</td><td class="mono">${money(st.earned)}</td><td class="mono">${money(st.paid)}</td></tr>`;
        }).join('')}
      </table>
    </div>
  `;
  bindReportModeTabs();
  document.getElementById('btn-prev').onclick = ()=>{ state.reportOffset++; renderReports(); };
  document.getElementById('btn-next').onclick = ()=>{ if(state.reportOffset>0){ state.reportOffset--; renderReports(); } };
  document.getElementById('btn-print').onclick = ()=>window.print();
  document.getElementById('btn-csv').onclick = ()=>{
    let csv = 'עובד,שעות,הגיע לו,שולם\n';
    active.forEach(e=>{
      const st = statsForRange(e.id, range.start, range.end);
      csv += `${displayName(e)},${fmtHours(st.hours)},${st.earned.toFixed(2)},${st.paid.toFixed(2)}\n`;
    });
    const blob = new Blob(['\uFEFF'+csv], {type:'text/csv;charset=utf-8;'});
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `דוח-שכר-${state.reportMode}-${dateKey(range.start)}.csv`;
    a.click();
  };
}

function reportModeTabsHtml(){
  return `<div class="row" style="margin-bottom:10px;flex-wrap:wrap;">
    <button class="tab ${state.reportMode==='week'?'active':''}" data-mode="week">שבועי</button>
    <button class="tab ${state.reportMode==='month'?'active':''}" data-mode="month">חודשי</button>
    <button class="tab ${state.reportMode==='monthweeks'?'active':''}" data-mode="monthweeks">חודשי לפי שבועות</button>
    <button class="tab ${state.reportMode==='year'?'active':''}" data-mode="year">שנתי</button>
  </div>`;
}
function bindReportModeTabs(){
  root.querySelectorAll('[data-mode]').forEach(b=>b.onclick=()=>{ state.reportMode=b.dataset.mode; state.reportOffset=0; renderReports(); });
}

// A month, broken down week by week: each week's date range, hours, earned, paid, remaining.
function renderMonthWeeksReport(){
  const monthStart = addMonths(startOfMonth(new Date()), -state.reportOffset);
  const monthEnd = addMonths(monthStart, 1);
  const monthLabel = monthStart.toLocaleDateString('he-IL',{month:'long',year:'numeric'});
  const active = state.employees.filter(e=>e.active!==false);

  const empOptions = ['<option value="all">כל העובדים (סה"כ)</option>']
    .concat(active.map(e=>`<option value="${e.id}" ${state.reportEmployeeId===e.id?'selected':''}>${displayName(e)}</option>`));

  // every week whose start falls before month end and whose end falls after month start
  let weeks = [];
  let w = periodStartFor(monthStart, state.config.periodStartDay);
  while(w < monthEnd){
    if(addDays(w,7) > monthStart) weeks.push(w);
    w = addDays(w,7);
  }

  root.innerHTML = `
    <div class="card no-print">
      ${reportModeTabsHtml()}
      <label>עובד</label>
      <select id="f-report-emp">${empOptions.join('')}</select>
      <div class="nav-period" style="margin-top:10px;">
        <button id="btn-prev">›</button>
        <div class="period-label"><b>${monthLabel}</b></div>
        <button id="btn-next" ${state.reportOffset===0?'disabled style="opacity:.3"':''}>‹</button>
      </div>
      <div class="row" style="margin-top:12px;">
        <button class="btn btn-ghost btn-sm" id="btn-print">הדפסה</button>
        <button class="btn btn-ghost btn-sm" id="btn-csv">ייצוא לאקסל (CSV)</button>
      </div>
    </div>
    <div class="card">
      <h2>${monthLabel} — לפי שבועות</h2>
      <div id="weeks-cont"></div>
    </div>
  `;
  bindReportModeTabs();
  document.getElementById('f-report-emp').value = state.reportEmployeeId || 'all';
  document.getElementById('f-report-emp').onchange = (e)=>{ state.reportEmployeeId = e.target.value; renderMonthWeeksReport(); };
  document.getElementById('btn-prev').onclick = ()=>{ state.reportOffset++; renderMonthWeeksReport(); };
  document.getElementById('btn-next').onclick = ()=>{ if(state.reportOffset>0){ state.reportOffset--; renderMonthWeeksReport(); } };

  const empId = state.reportEmployeeId || 'all';
  function statsFor(start,end){
    if(empId === 'all'){
      let hours=0, earned=0, paid=0;
      active.forEach(e=>{ const s = statsForRange(e.id, start, end); hours+=s.hours; earned+=s.earned; paid+=s.paid; });
      return {hours,earned,paid};
    }
    return statsForRange(empId, start, end);
  }

  const cont = document.getElementById('weeks-cont');
  cont.innerHTML = weeks.map(ws=>{
    const we = addDays(ws,6);
    const st = statsFor(ws, addDays(ws,7));
    return `<div class="card" style="margin:10px 0;">
      <div class="row between"><b>${fmtDateHe(ws)} – ${fmtDateHe(we)}</b><span class="mono">${fmtHours(st.hours)} ש'</span></div>
      <div class="row between muted"><span>הגיע</span><span class="mono">${money(st.earned)}</span></div>
      <div class="row between muted"><span>שולם</span><span class="mono">${money(st.paid)}</span></div>
      <div class="row between"><b>נותר</b><b class="mono">${money(st.earned-st.paid)}</b></div>
    </div>`;
  }).join('');

  document.getElementById('btn-print').onclick = ()=>window.print();
  document.getElementById('btn-csv').onclick = ()=>{
    let csv = 'שבוע (התחלה),שבוע (סוף),שעות,הגיע,שולם,נותר\n';
    weeks.forEach(ws=>{
      const we = addDays(ws,6);
      const st = statsFor(ws, addDays(ws,7));
      csv += `${fmtDateHe(ws)},${fmtDateHe(we)},${fmtHours(st.hours)},${st.earned.toFixed(2)},${st.paid.toFixed(2)},${(st.earned-st.paid).toFixed(2)}\n`;
    });
    const blob = new Blob(['\uFEFF'+csv], {type:'text/csv;charset=utf-8;'});
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `דוח-שבועי-${dateKey(monthStart)}.csv`;
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
  const biz = state.config.businessLocation;
  root.innerHTML = `
    <div class="card">
      <h2>שינוי קוד גישה</h2>
      <label>קוד גישה חדש</label>
      <input id="f-newcode" placeholder="הזינו קוד חדש כדי לשנות" type="password">
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
      <h2>מיקום העסק (לבדיקת חריגים)</h2>
      <p class="muted">אם מגדירים כאן את מיקום העסק, המערכת תסמן אוטומטית בטאב "חריגים" כל כניסה/יציאה שנסרקה רחוק מדי משם.</p>
      <p class="muted">${biz ? `מיקום נוכחי: ${biz.lat.toFixed(5)}, ${biz.lng.toFixed(5)}` : 'עדיין לא הוגדר מיקום.'}</p>
      <label>רדיוס מותר (במטרים)</label>
      <input id="f-radius" type="number" value="${state.config.businessRadius || 150}">
      <div class="row" style="margin-top:10px;">
        <button class="btn btn-brass btn-sm" id="btn-use-here">השתמש במיקום הנוכחי שלי כעת</button>
      </div>
      <button class="btn btn-primary btn-sm" style="margin-top:10px;" id="btn-save-biz">שמירה</button>
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
    if(!v){ toast('נא להזין קוד חדש'); return; }
    const hash = await sha256(v);
    await db.collection('config').doc('main').update({adminCodeHash:hash, adminCode: firebase.firestore.FieldValue.delete()});
    state.config.adminCodeHash = hash;
    delete state.config.adminCode;
    document.getElementById('f-newcode').value='';
    toast('הקוד עודכן');
  };
  document.getElementById('btn-save-day').onclick = async ()=>{
    const v = parseInt(document.getElementById('f-startday').value,10);
    await db.collection('config').doc('main').update({periodStartDay:v});
    state.config.periodStartDay = v;
    toast('נשמר');
  };
  let pendingLoc = biz || null;
  document.getElementById('btn-use-here').onclick = ()=>{
    if(!navigator.geolocation){ toast('הדפדפן לא תומך במיקום'); return; }
    toast('מאתר מיקום...');
    navigator.geolocation.getCurrentPosition(
      pos=>{ pendingLoc = { lat: pos.coords.latitude, lng: pos.coords.longitude }; toast('המיקום נקלט — לחצו שמירה כדי לאשר'); },
      ()=>{ toast('לא ניתן היה לאתר מיקום'); }
    );
  };
  document.getElementById('btn-save-biz').onclick = async ()=>{
    const radius = parseInt(document.getElementById('f-radius').value,10) || 150;
    if(!pendingLoc){ toast('יש קודם ללחוץ על "השתמש במיקום הנוכחי שלי"'); return; }
    await db.collection('config').doc('main').update({businessLocation: pendingLoc, businessRadius: radius});
    state.config.businessLocation = pendingLoc;
    state.config.businessRadius = radius;
    renderSettings();
    toast('מיקום העסק נשמר');
  };
  document.getElementById('btn-backup').onclick = ()=>{
    const data = { employees: state.employees, shifts: state.shifts, payments: state.payments, notes: state.notes, config: state.config, exportedAt: new Date().toISOString() };
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
