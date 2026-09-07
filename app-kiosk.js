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

async function renderMain(){
  armIdleTimer();
  root.innerHTML = `<div class="card center"><p class="muted">Зареждане...</p></div>`;
  await loadKioskEmployees();
  root.innerHTML = `
    <div id="list"></div>
    <button class="kiosk-btn" id="btn-new" style="background:var(--brass);">+ Нов служител</button>
  `;
  const list = document.getElementById('list');
  list.innerHTML = kioskEmployees.map(e=>`<button class="kiosk-btn" data-emp="${e.id}">${e.name}</button>`).join('');
  list.querySelectorAll('[data-emp]').forEach(b=>b.onclick=()=>{
    const emp = kioskEmployees.find(x=>x.id===b.dataset.emp);
    renderConfirm(emp);
  });
  document.getElementById('btn-new').onclick = renderNewEmployeeForm;
}

function renderConfirm(emp){
  armIdleTimer();
  root.innerHTML = `
    <div class="card center">
      <h2 style="font-size:26px;">Вие ли сте ${emp.name}?</h2>
      <div class="row" style="margin-top:16px;">
        <button class="btn btn-primary" id="btn-yes" style="font-size:18px;padding:18px;">Да, аз съм</button>
        <button class="btn btn-ghost" id="btn-no" style="font-size:18px;padding:18px;">Не</button>
      </div>
    </div>
  `;
  document.getElementById('btn-yes').onclick = ()=>renderCapture(emp);
  document.getElementById('btn-no').onclick = renderMain;
}

function renderNewEmployeeForm(){
  armIdleTimer();
  root.innerHTML = `
    <div class="card">
      <h2 style="font-size:22px;">Нов служител</h2>
      <label>Име и фамилия</label>
      <input id="f-name" style="font-size:18px;padding:14px;">
      <div class="row" style="margin-top:16px;">
        <button class="btn btn-primary" id="btn-continue" style="font-size:18px;padding:16px;">Продължи</button>
        <button class="btn btn-ghost" id="btn-cancel" style="font-size:18px;padding:16px;">Отказ</button>
      </div>
    </div>
  `;
  document.getElementById('btn-cancel').onclick = renderMain;
  document.getElementById('btn-continue').onclick = ()=>{
    const name = document.getElementById('f-name').value.trim();
    if(!name){ toast('Моля, въведете име'); return; }
    renderCapture(null, name);
  };
}

// emp = existing employee object, or null if this is a brand-new registration (newName given)
async function renderCapture(emp, newName){
  armIdleTimer();
  root.innerHTML = `
    <div class="card center">
      <h2 style="font-size:20px;">${emp?emp.name:newName}</h2>
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
    renderPreview(emp, newName, photo);
  };
}

function renderPreview(emp, newName, photo){
  armIdleTimer();
  root.innerHTML = `
    <div class="card center">
      <h2 style="font-size:20px;">${emp?emp.name:newName}</h2>
      <img src="${photo}" style="width:100%;border-radius:16px;">
      <div class="row" style="margin-top:14px;">
        <button class="btn btn-primary" id="btn-confirm" style="font-size:18px;padding:16px;">Потвърди</button>
        <button class="btn btn-ghost" id="btn-retake" style="font-size:18px;padding:16px;">Наново</button>
      </div>
    </div>
  `;
  document.getElementById('btn-retake').onclick = ()=>renderCapture(emp, newName);
  document.getElementById('btn-confirm').onclick = async ()=>{
    root.innerHTML = `<div class="card center"><p class="muted">Записване...</p></div>`;
    try{
      if(emp){
        await processScanKiosk(emp, photo);
      } else {
        await registerAndCheckIn(newName, photo);
      }
    }catch(err){
      console.error(err);
      toast('Възникна грешка. Опитайте отново.');
      renderMain();
    }
  };
}

async function registerAndCheckIn(name, photo){
  const ref = await db.collection('employees').add({
    name, workType:'kiosk', profilePhoto: photo, active: true
  });
  await db.collection('shifts').add({
    employeeId: ref.id,
    checkIn: firebase.firestore.FieldValue.serverTimestamp(),
    checkInPhoto: photo,
    checkOut: null,
    needsReview: false,
    note: '',
    source: 'kiosk'
  });
  showResult(true, name, new Date());
}

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
    await db.collection('shifts').doc(openDoc.id).update({ needsReview:true });
    await db.collection('shifts').add({
      employeeId: emp.id,
      checkIn: firebase.firestore.FieldValue.serverTimestamp(),
      checkInPhoto: photo,
      checkOut: null, needsReview:false, note:'', source:'kiosk'
    });
    showResult(true, emp.name, now);
    return;
  }

  await db.collection('shifts').doc(openDoc.id).update({
    checkOut: firebase.firestore.FieldValue.serverTimestamp(),
    checkOutPhoto: photo
  });
  showResult(false, emp.name, now, checkIn);
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
