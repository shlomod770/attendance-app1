const root = document.getElementById('root');
const LS_DEVICE = 'twm_device_id';
const LS_SESSION = 'twm_employee_id';

function getDeviceId(){
  let id = localStorage.getItem(LS_DEVICE);
  if(!id){
    id = 'dev-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    localStorage.setItem(LS_DEVICE, id);
  }
  return id;
}

function toast(msg){
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(()=>t.remove(), 3000);
}

function fmtTime(d){
  return d.toLocaleTimeString('bg-BG', {hour:'2-digit', minute:'2-digit'});
}
function fmtDate(d){
  return d.toLocaleDateString('bg-BG', {day:'2-digit', month:'2-digit', year:'numeric'});
}
function sameDay(a,b){
  return a.getFullYear()===b.getFullYear() && a.getMonth()===b.getMonth() && a.getDate()===b.getDate();
}

let currentEmployee = null;

async function init(){
  const savedId = localStorage.getItem(LS_SESSION);
  if(savedId){
    try{
      const doc = await db.collection('employees').doc(savedId).get();
      if(doc.exists && doc.data().active !== false && doc.data().deviceId === getDeviceId()){
        currentEmployee = {id: doc.id, ...doc.data()};
        renderScan();
        return;
      }
    }catch(e){ /* fall through to login */ }
    localStorage.removeItem(LS_SESSION);
  }
  renderLogin();
}

function renderLogin(){
  root.innerHTML = `
    <div class="card">
      <label>Потребителско име</label>
      <input id="f-user" autocomplete="username">
      <label>Личен код</label>
      <input id="f-pin" type="password" inputmode="numeric" autocomplete="current-password">
      <div style="margin-top:18px;">
        <button class="btn btn-primary" id="btn-login">Вход</button>
      </div>
      <p class="muted" id="login-err" style="margin-top:10px;"></p>
    </div>
  `;
  document.getElementById('btn-login').onclick = doLogin;
}

async function doLogin(){
  const username = document.getElementById('f-user').value.trim();
  const pin = document.getElementById('f-pin').value.trim();
  const errEl = document.getElementById('login-err');
  errEl.textContent = '';
  if(!username || !pin){ errEl.textContent = 'Моля, попълнете всички полета.'; return; }

  const snap = await db.collection('employees').where('username','==',username).limit(1).get();
  if(snap.empty){ errEl.textContent = 'Грешно потребителско име или код.'; return; }
  const doc = snap.docs[0];
  const data = doc.data();
  if(data.active === false){ errEl.textContent = 'Профилът е деактивиран. Обърнете се към управителя.'; return; }
  if(String(data.pin) !== String(pin)){ errEl.textContent = 'Грешно потребителско име или код.'; return; }

  const deviceId = getDeviceId();
  if(data.deviceId && data.deviceId !== deviceId){
    errEl.textContent = 'Този акаунт вече е свързан с друг телефон. Обърнете се към управителя.';
    return;
  }
  if(!data.deviceId){
    await db.collection('employees').doc(doc.id).update({deviceId});
  }
  currentEmployee = {id: doc.id, ...data, deviceId};
  localStorage.setItem(LS_SESSION, doc.id);
  renderScan();
}

// Single "stage" area: shows either the big scan button, the live camera, or a result message.
function renderScan(){
  root.innerHTML = `
    <div class="card center">
      <p class="muted">Здравейте, <b>${currentEmployee.name || currentEmployee.username}</b></p>
    </div>
    <div id="stage"></div>
    <div class="row between" style="margin-top:22px;">
      <a href="#" id="link-note" class="muted" style="font-size:12px;text-decoration:underline;">Съобщение до управителя</a>
      <a href="#" id="btn-logout" class="muted" style="font-size:12px;text-decoration:underline;">Изход от акаунта</a>
    </div>
    <div id="note-box" class="hidden" style="margin-top:10px;">
      <textarea id="f-note" rows="2" placeholder="напр. проблем по време на смяната..." style="font-size:13px;"></textarea>
      <button class="btn btn-ghost btn-sm" id="btn-send-note" style="margin-top:6px;">Изпрати</button>
    </div>
  `;
  renderStageButton();
  document.getElementById('btn-logout').onclick = (e)=>{
    e.preventDefault();
    localStorage.removeItem(LS_SESSION);
    currentEmployee = null;
    renderLogin();
  };
  document.getElementById('link-note').onclick = (e)=>{
    e.preventDefault();
    document.getElementById('note-box').classList.toggle('hidden');
  };
  document.getElementById('btn-send-note').onclick = async ()=>{
    const txt = document.getElementById('f-note').value.trim();
    if(!txt) return;
    await db.collection('notes').add({
      employeeId: currentEmployee.id,
      employeeName: currentEmployee.name || currentEmployee.username,
      text: txt,
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    });
    document.getElementById('f-note').value = '';
    document.getElementById('note-box').classList.add('hidden');
    toast('Съобщението е изпратено');
  };
}

function renderStageButton(){
  const stage = document.getElementById('stage');
  stage.innerHTML = `
    <button class="stamp" id="btn-scan">
      <div class="lbl">СКАНИРАЙ QR</div>
      <div class="clock-digits">за вход / изход</div>
    </button>
  `;
  document.getElementById('btn-scan').onclick = openScanner;
}

let qrScanner = null;

function openScanner(){
  const stage = document.getElementById('stage');
  stage.innerHTML = `
    <div class="card" style="padding:8px;">
      <div id="qr-reader"></div>
      <button class="btn btn-ghost" id="btn-cancel-scan" style="margin-top:10px;">Отказ</button>
    </div>
  `;
  document.getElementById('btn-cancel-scan').onclick = ()=>{ stopScanner(); renderStageButton(); };
  qrScanner = new Html5Qrcode('qr-reader');
  qrScanner.start(
    { facingMode: 'environment' },
    { fps: 10, qrbox: 240 },
    onScanSuccess,
    ()=>{}
  ).catch(err=>{
    stage.innerHTML = `<div class="card center"><p class="muted">Няма достъп до камерата. Проверете разрешенията на телефона.</p><button class="btn btn-ghost" id="btn-back-err" style="margin-top:10px;">Назад</button></div>`;
    document.getElementById('btn-back-err').onclick = renderStageButton;
  });
}

function stopScanner(){
  if(qrScanner){
    qrScanner.stop().then(()=>qrScanner.clear()).catch(()=>{});
    qrScanner = null;
  }
}

async function onScanSuccess(decodedText){
  if(!qrScanner) return;
  await qrScanner.pause(true);
  const cfgDoc = await db.collection('config').doc('main').get();
  const validToken = cfgDoc.exists ? cfgDoc.data().qrToken : null;
  if(!validToken || decodedText !== validToken){
    toast('Невалиден QR код');
    qrScanner.resume();
    return;
  }
  stopScanner();
  await processScan();
}

async function processScan(){
  const now = new Date();
  const openSnap = await db.collection('shifts')
    .where('employeeId','==', currentEmployee.id)
    .where('checkOut','==', null)
    .orderBy('checkIn','desc')
    .limit(1)
    .get();

  if(openSnap.empty){
    await db.collection('shifts').add({
      employeeId: currentEmployee.id,
      checkIn: firebase.firestore.Timestamp.fromDate(now),
      checkOut: null,
      needsReview: false,
      note: ''
    });
    showResult(true, `Час: ${fmtTime(now)}`);
    return;
  }

  const openDoc = openSnap.docs[0];
  const openData = openDoc.data();
  const checkIn = openData.checkIn.toDate();
  const hoursSince = (now - checkIn) / 3600000;

  if(hoursSince > 17){
    await db.collection('shifts').doc(openDoc.id).update({ needsReview: true });
    await db.collection('shifts').add({
      employeeId: currentEmployee.id,
      checkIn: firebase.firestore.Timestamp.fromDate(now),
      checkOut: null,
      needsReview: false,
      note: ''
    });
    showResult(true, `Час: ${fmtTime(now)}`);
    return;
  }

  await db.collection('shifts').doc(openDoc.id).update({
    checkOut: firebase.firestore.Timestamp.fromDate(now)
  });
  const durationH = hoursSince;
  const h = Math.floor(durationH);
  const m = Math.round((durationH - h) * 60);
  const dayNote = sameDay(checkIn, now) ? '' : ` (${fmtDate(now)})`;
  showResult(false, `
    Вход: ${fmtTime(checkIn)}<br>
    Изход: ${fmtTime(now)}${dayNote}<br>
    <b>Общо часове: ${h} ч ${m} мин</b>
  `);
}

function showResult(isCheckIn, bodyHtml){
  const stage = document.getElementById('stage');
  const title = isCheckIn ? 'Вашето влизане е регистрирано ✓' : 'Вашето излизане е регистрирано ✓';
  stage.innerHTML = `
    <div class="card center">
      <h2 style="font-size:24px;">${title}</h2>
      <p class="mono" style="line-height:1.9;">${bodyHtml}</p>
      <button class="btn btn-primary" id="btn-ok" style="margin-top:10px;">Готово</button>
    </div>
  `;
  document.getElementById('btn-ok').onclick = renderStageButton;
}

init();
