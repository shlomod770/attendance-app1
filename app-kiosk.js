const root = document.getElementById('root');
let kioskEmployees = [];
let stream = null;
let idleTimer = null;

function toast(msg){
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(()=>t.remove(), 2500);
}

function fmtTime(d){ return d.toLocaleTimeString('bg-BG', {hour:'2-digit', minute:'2-digit'}); }

// ---- inactivity auto-reset: any tap anywhere resets the 15s timer ----
// This only ever calls our own renderMain() function — never location.reload()
// or a real page refresh — so no camera permission prompts or flicker.
function armIdleTimer(){
  clearTimeout(idleTimer);
  idleTimer = setTimeout(()=>{
    stopCamera();
    renderMain();
  }, 15000);
}
document.addEventListener('click', armIdleTimer, true);
document.addEventListener('touchstart', armIdleTimer, true);

function stopCamera(){
  if(stream){
    stream.getTracks().forEach(t=>t.stop());
    stream = null;
  }
}

// Shrinks whatever we captured down to a small, storage-friendly JPEG.
function downscaleToJpeg(sourceCanvas, maxWidth){
  const scale = Math.min(1, maxWidth / sourceCanvas.width);
  const w = Math.round(sourceCanvas.width * scale);
  const h = Math.round(sourceCanvas.height * scale);
  const out = document.createElement('canvas');
  out.width = w; out.height = h;
  out.getContext('2d').drawImage(sourceCanvas, 0, 0, w, h);
  return out.toDataURL('image/jpeg', 0.55);
}

async function loadKioskEmployees(){
  const snap = await db.collection('employees').where('workType','==','kiosk').get();
  kioskEmployees = snap.docs
    .map(d=>({id:d.id, ...d.data()}))
    .filter(e=>e.active !== false)
    .sort((a,b)=>a.name.localeCompare(b.name,'bg'));
}

// ---- Main screen: same look as the phone app's scan button ----
function renderMain(){
  armIdleTimer();
  root.classList.add('center-content');
  root.innerHTML = `
    <button class="stamp" id="btn-shift">
      <div class="lbl">НАЧАЛО / КРАЙ</div>
      <div class="clock-digits">на смяна</div>
    </button>
    <p class="muted" style="text-align:center;margin-top:20px;line-height:1.7;">
      Натиснете тук, изберете името си, снимайте се — и часовете ви ще се запишат автоматично.
      Не забравяйте да отбележите и края на смяната, за да изчислим часовете ви правилно.
    </p>
    <div style="text-align:center;margin-top:auto;padding-top:30px;">
      <button class="btn btn-ghost btn-sm" id="btn-new">Нов служител? Натиснете тук</button>
    </div>
  `;
  document.getElementById('btn-shift').onclick = renderPicker;
  document.getElementById('btn-new').onclick = renderNewEmployeeForm;
}

// ---- Employee picker grid: fetched fresh only when opened, not on every idle reset ----
async function renderPicker(){
  armIdleTimer();
  root.classList.remove('center-content');
  root.innerHTML = `<div class="card center"><p class="muted">Зареждане...</p></div>`;
  await loadKioskEmployees();
  if(!kioskEmployees.length){
    root.innerHTML = `<div class="card center"><p class="muted">Все още няма служители тук.</p><button class="btn btn-ghost" id="btn-back" style="margin-top:10px;">Назад</button></div>`;
    document.getElementById('btn-back').onclick = renderMain;
    return;
  }
  root.innerHTML = `
    <div style="margin-bottom:10px;">
      <button class="btn btn-ghost btn-sm" id="btn-back">← Назад</button>
    </div>
    <div id="grid" style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;"></div>
  `;
  document.getElementById('btn-back').onclick = renderMain;
  const grid = document.getElementById('grid');
  grid.innerHTML = kioskEmployees.map(e=>`
    <button class="picker-tile" data-emp="${e.id}">
      ${e.profilePhoto?`<img src="${e.profilePhoto}">`:'<div style="width:100%;aspect-ratio:1;background:var(--paper-2);border-radius:8px;margin-bottom:6px;"></div>'}
      <div class="pname">${e.name}</div>
    </button>
  `).join('');
  grid.querySelectorAll('[data-emp]').forEach(b=>b.onclick=()=>{
    const emp = kioskEmployees.find(x=>x.id===b.dataset.emp);
    renderConfirm(emp);
  });
}

function renderConfirm(emp){
  armIdleTimer();
  root.innerHTML = `
    <div class="card center">
      ${emp.profilePhoto?`<img src="${emp.profilePhoto}" style="width:90px;height:90px;object-fit:cover;border-radius:14px;margin-bottom:10px;">`:''}
      <h2 style="font-size:26px;">Вие ли сте ${emp.name}?</h2>
      <div class="row" style="margin-top:16px;">
        <button class="btn btn-primary" id="btn-yes" style="font-size:18px;padding:18px;">Да, аз съм</button>
        <button class="btn btn-ghost" id="btn-no" style="font-size:18px;padding:18px;">Не</button>
      </div>
    </div>
  `;
  document.getElementById('btn-yes').onclick = ()=>{
    capturePhotoFlow(emp.name, emp.profilePhoto, async (photo)=>{
      await processScanKiosk(emp, photo);
    });
  };
  document.getElementById('btn-no').onclick = renderPicker;
}

// ---------------- new employee registration ----------------

function renderNewEmployeeForm(){
  armIdleTimer();
  root.classList.remove('center-content');
  root.innerHTML = `
    <div class="card">
      <h2 style="font-size:22px;">Нов служител</h2>
      <div class="row">
        <div style="flex:1;">
          <label>Име</label>
          <input id="f-first" style="font-size:18px;padding:14px;">
        </div>
        <div style="flex:1;">
          <label>Фамилия</label>
          <input id="f-last" style="font-size:18px;padding:14px;">
        </div>
      </div>
      <label>Вид заетост</label>
      <select id="f-emptype" style="font-size:18px;padding:14px;">
        <option value="permanent">Постоянен служител</option>
        <option value="oneoff">Еднократен служител</option>
      </select>
      <div class="row" style="margin-top:16px;">
        <button class="btn btn-primary" id="btn-continue" style="font-size:18px;padding:16px;">Продължи към снимка</button>
        <button class="btn btn-ghost" id="btn-cancel" style="font-size:18px;padding:16px;">Отказ</button>
      </div>
    </div>
  `;
  document.getElementById('btn-cancel').onclick = renderMain;
  document.getElementById('btn-continue').onclick = ()=>{
    const first = document.getElementById('f-first').value.trim();
    const last = document.getElementById('f-last').value.trim();
    const employmentType = document.getElementById('f-emptype').value;
    if(!first || !last){ toast('Моля, въведете име и фамилия'); return; }
    const name = `${first} ${last}`;
    capturePhotoFlow(name, null, async (photo)=>{
      await registerEmployee(name, employmentType, photo);
    });
  };
}

async function registerEmployee(name, employmentType, photo){
  const ref = await db.collection('employees').add({
    name, workType:'kiosk', employmentType, profilePhoto: photo,
    hourlyRate: 0, active: true, pendingApproval: true
  });
  renderStartShiftPrompt({ id: ref.id, name, profilePhoto: photo });
}

// Registration never auto-starts a shift — we ask explicitly.
function renderStartShiftPrompt(emp){
  armIdleTimer();
  root.innerHTML = `
    <div class="card center">
      <h2 style="font-size:22px;">${emp.name} е записан(а) успешно ✓</h2>
      <p class="muted">Искате ли да започнете смяна сега?</p>
      <div class="row" style="margin-top:16px;">
        <button class="btn btn-primary" id="btn-yes" style="font-size:18px;padding:18px;">Да, начало на смяна</button>
        <button class="btn btn-ghost" id="btn-no" style="font-size:18px;padding:18px;">Не, само запис</button>
      </div>
    </div>
  `;
  document.getElementById('btn-yes').onclick = ()=>{
    capturePhotoFlow(emp.name, emp.profilePhoto, async (photo)=>{
      await processScanKiosk(emp, photo);
    });
  };
  document.getElementById('btn-no').onclick = ()=>{
    root.innerHTML = `<div class="card center"><h2 style="font-size:22px;">Данните са запазени</h2></div>`;
    setTimeout(renderMain, 2500);
  };
}

// ---------------- shared camera capture component ----------------
// subjectLabel: name shown while shooting. onPhoto: async fn(photoDataUrl) called after confirm.
function capturePhotoFlow(subjectLabel, refPhoto, onPhoto){
  renderCaptureScreen(subjectLabel, onPhoto);
}

async function renderCaptureScreen(subjectLabel, onPhoto){
  armIdleTimer();
  root.innerHTML = `
    <div class="card center">
      <h2 style="font-size:20px;">${subjectLabel}</h2>
      <video id="video" autoplay playsinline muted></video>
      <button class="btn btn-brass" id="btn-shoot" style="margin-top:14px;font-size:18px;padding:16px;">📷 Заснемане</button>
      <button class="btn btn-ghost" id="btn-cancel" style="margin-top:8px;">Отказ</button>
    </div>
  `;
  document.getElementById('btn-cancel').onclick = ()=>{ stopCamera(); renderMain(); };

  const video = document.getElementById('video');
  try{
    stream = await navigator.mediaDevices.getUserMedia({ video: { width:{ideal:480}, height:{ideal:360} }, audio:false });
    video.srcObject = stream;
  }catch(err){
    root.innerHTML = `<div class="card center"><p class="muted">Няма достъп до камерата на компютъра.</p><button class="btn btn-ghost" id="btn-back-err" style="margin-top:10px;">Назад</button></div>`;
    document.getElementById('btn-back-err').onclick = renderMain;
    return;
  }

  document.getElementById('btn-shoot').onclick = ()=>{
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth; canvas.height = video.videoHeight;
    canvas.getContext('2d').drawImage(video, 0, 0);
    const photo = downscaleToJpeg(canvas, 480);
    stopCamera();
    renderPreviewScreen(subjectLabel, photo, onPhoto);
  };
}

function renderPreviewScreen(subjectLabel, photo, onPhoto){
  armIdleTimer();
  root.innerHTML = `
    <div class="card center">
      <h2 style="font-size:20px;">${subjectLabel}</h2>
      <img src="${photo}" style="width:100%;border-radius:16px;">
      <div class="row" style="margin-top:14px;">
        <button class="btn btn-primary" id="btn-confirm" style="font-size:18px;padding:16px;">Потвърди</button>
        <button class="btn btn-ghost" id="btn-retake" style="font-size:18px;padding:16px;">Наново</button>
      </div>
    </div>
  `;
  document.getElementById('btn-retake').onclick = ()=>renderCaptureScreen(subjectLabel, onPhoto);
  document.getElementById('btn-confirm').onclick = async ()=>{
    root.innerHTML = `<div class="card center"><p class="muted">Записване...</p></div>`;
    try{
      await onPhoto(photo);
    }catch(err){
      console.error(err);
      toast('Възникна грешка. Опитайте отново.');
      renderMain();
    }
  };
}

// ---------------- clock in/out ----------------

async function processScanKiosk(emp, photo){
  const now = new Date();
  const allSnap = await db.collection('shifts').where('employeeId','==', emp.id).get();
  const openDocs = allSnap.docs
    .filter(d => !d.data().checkOut && d.data().checkIn && d.data().manualTotalHours == null)
    .sort((a,b) => b.data().checkIn.toMillis() - a.data().checkIn.toMillis());

  if(openDocs.length === 0){
    await db.collection('shifts').add({
      employeeId: emp.id,
      checkIn: firebase.firestore.FieldValue.serverTimestamp(),
      checkInPhoto: photo,
      checkOut: null, needsReview:false, note:'', source:'kiosk'
    });
    showResult(true, emp.name, now);
    return;
  }
  const openDoc = openDocs[0];
  const checkIn = openDoc.data().checkIn.toDate();
  const hoursSince = (now - checkIn) / 3600000;

  if(hoursSince > 17){
    showLongShiftChoiceKiosk(emp, openDoc, checkIn, now, photo);
    return;
  }

  await db.collection('shifts').doc(openDoc.id).update({
    checkOut: firebase.firestore.FieldValue.serverTimestamp(),
    checkOutPhoto: photo
  });
  showResult(false, emp.name, now, checkIn);
}

// Same idea as the phone app: don't guess, ask the person directly.
function showLongShiftChoiceKiosk(emp, openDoc, checkIn, now, photo){
  armIdleTimer();
  const hrs = Math.floor((now - checkIn) / 3600000);
  root.innerHTML = `
    <div class="card center">
      <h2 style="font-size:20px;">Мина много време</h2>
      <p class="muted">${emp.name} влезе на ${checkIn.toLocaleDateString('bg-BG')} в ${fmtTime(checkIn)} (преди около ${hrs} часа).</p>
      <p>Това ли е изходът от онази смяна, или започвате нова смяна сега?</p>
      <button class="btn btn-primary" id="btn-choice-checkout" style="margin-top:10px;font-size:17px;padding:16px;">Това е изход от онази смяна</button>
      <button class="btn btn-ghost" id="btn-choice-newshift" style="margin-top:8px;font-size:17px;padding:16px;">Започвам нова смяна сега</button>
    </div>
  `;
  document.getElementById('btn-choice-checkout').onclick = async ()=>{
    root.innerHTML = `<div class="card center"><p class="muted">Записване...</p></div>`;
    await db.collection('shifts').doc(openDoc.id).update({
      checkOut: firebase.firestore.FieldValue.serverTimestamp(),
      checkOutPhoto: photo,
      needsReview: true
    });
    showResult(false, emp.name, now, checkIn);
  };
  document.getElementById('btn-choice-newshift').onclick = async ()=>{
    root.innerHTML = `<div class="card center"><p class="muted">Записване...</p></div>`;
    await db.collection('shifts').doc(openDoc.id).update({ needsReview: true });
    await db.collection('shifts').add({
      employeeId: emp.id,
      checkIn: firebase.firestore.FieldValue.serverTimestamp(),
      checkInPhoto: photo,
      checkOut: null, needsReview:false, note:'', source:'kiosk'
    });
    showResult(true, emp.name, now);
  };
}

function showResult(isCheckIn, name, now, checkIn){
  const title = isCheckIn ? 'Влизането е регистрирано ✓' : 'Излизането е регистрирано ✓';
  let body = `${name}<br>Час: ${fmtTime(now)}`;
  if(!isCheckIn && checkIn){
    const h = Math.floor((now-checkIn)/3600000);
    const m = Math.round(((now-checkIn)/3600000 - h)*60);
    body += `<br><b>Общо часове: ${h} ч ${m} мин</b>`;
  }
  root.innerHTML = `
    <div class="card center">
      <h2 style="font-size:24px;">${title}</h2>
      <p class="mono" style="line-height:1.9;font-size:16px;">${body}</p>
      <p class="muted">Връщане към началния екран...</p>
    </div>
  `;
  setTimeout(renderMain, 4000);
}

renderMain();
