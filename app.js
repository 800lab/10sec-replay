import { FrameBuffer, capturePlan } from './frame-buffer.mjs';

const $ = id => document.getElementById(id);
const ui = Object.fromEntries(['app','source','display','empty','empty-text','view-state','status','start','pause','watch','again','switch','fullscreen','end','review-controls','seek','clip-time','quality','seconds','viewer','speed','speed-setting','mirror','mode-hint','delay-name','slow-name','viewport'].map(id => [id, $(id)]));
const profiles = { standard:{width:480,height:270,fps:10}, light:{width:320,height:180,fps:8} };
const MAX_IMAGE_BYTES = 64 * 1024 * 1024;
const RETAINED_IDLE_MS = 60000, SESSION_MS = 120 * 60 * 1000;
const ctx = ui.display.getContext('2d', {alpha:false});
let mode = 'delay', phase = 'idle', generation = 0, session = null, review = null;
let rate = 0.5, selectedDevice = '', devices = [], retainedTimer = 0, reviewRaf = 0, layoutRaf = 0;

function message(text, error = false) {
  ui.status.textContent = text;
  ui.status.hidden = !text;
  ui.status.classList.toggle('error', error);
  scheduleLayout();
}
function overlay(text = '') {
  ui.empty.hidden = !text;
  if (text && ui['empty-text'].textContent !== text) ui['empty-text'].textContent = text;
}
function badge(text = '') {
  ui['view-state'].textContent = text && ui.mirror.checked ? `${text}／左右反転` : text;
  ui['view-state'].hidden = !text;
}
function seconds() { return Number(ui.seconds.value); }
function paint(image) {
  ctx.save();
  if (ui.mirror.checked) { ctx.translate(ui.display.width, 0); ctx.scale(-1, 1); }
  ctx.drawImage(image, 0, 0, ui.display.width, ui.display.height);
  ctx.restore();
}
function blank() {
  ui.display.width = 480; ui.display.height = 270;
  if (!ctx) return;
  ctx.fillStyle = '#303438'; ctx.fillRect(0,0,480,270);
}
function modeDescription() {
  return mode === 'delay' ? `${seconds()}秒後に自動再生` : `直前${seconds()}秒をスロー再生`;
}
function renderControls() {
  const active = document.activeElement;
  const live = phase === 'live', viewing = phase === 'review';
  ui.app.dataset.phase = phase; ui.app.dataset.mode = mode; ui.viewer.dataset.phase = phase;
  ui['mode-hint'].textContent = modeDescription();
  ui['delay-name'].textContent = `${seconds()}秒おくれて再生`;
  ui['slow-name'].textContent = `直前${seconds()}秒をスロー再生`;
  ui.start.hidden = live;
  ui.start.disabled = phase === 'starting';
  ui.start.textContent = viewing ? 'つぎへ' : phase === 'paused' ? '再開する' : phase === 'starting' ? 'カメラ確認中…' : 'はじめる';
  ui.watch.hidden = !(live && mode === 'slow');
  ui.watch.disabled = !session?.ready;
  ui.watch.textContent = `直前${seconds()}秒を見る`;
  ui.again.hidden = !viewing;
  ui.pause.hidden = !((live && mode === 'delay') || viewing);
  ui.pause.disabled = live && !session?.ready;
  ui.pause.textContent = viewing ? (review.playing ? 'とめる' : review.position >= review.sequence.duration ? 'はじめから' : 'つづける') : 'とめる';
  ui.end.disabled = phase === 'idle';
  ui['review-controls'].hidden = !viewing;
  ui.switch.disabled = !live || devices.length < 2;
  ui.switch.title = !live ? '撮影開始後に切替できます' : devices.length < 2 ? 'カメラが2台以上必要です' : 'カメラを切り替えます';
  for (const control of [ui.quality,ui.seconds,ui.mirror]) control.disabled = phase === 'starting';
  ui['speed-setting'].hidden = mode !== 'slow';
  document.querySelectorAll('button[data-mode]').forEach(button => button.setAttribute('aria-pressed',String(button.dataset.mode === mode)));
  ui.speed.value = String(rate);
  if (viewing) badge(`見返し ${rate}倍・カメラ停止`);
  if (ui.viewer.contains(active) && (active.disabled || active.closest('[hidden]'))) {
    const next = viewing ? ui.pause : phase==='idle' || phase==='paused' ? ui.start : ui.end;
    next.focus({preventScroll:true});
  }
  scheduleLayout();
}
function scheduleLayout() {
  if(layoutRaf)return;
  layoutRaf=requestAnimationFrame(()=>{layoutRaf=0;fitViewport();});
}
function fitViewport() {
  if(expanded()){ui.viewport.style.removeProperty('height');return;}
  const viewer=ui.viewer.getBoundingClientRect(), viewport=ui.viewport.getBoundingClientRect();
  const top=viewer.top+window.scrollY;
  const chrome=viewer.height-viewport.height;
  const essential=ui.viewer.querySelector('.controls').offsetHeight+(ui['review-controls'].hidden?0:ui['review-controls'].offsetHeight);
  // Prefer room for all guidance; on short displays keep the action row reachable first.
  const available=window.innerHeight-top-12;
  const height=Math.max(64,Math.min(Math.max(96,available-chrome),available-essential));
  const value=`${Math.floor(height)}px`;
  if(ui.viewport.style.height!==value)ui.viewport.style.height=value;
}
function clearReview() {
  clearTimeout(retainedTimer); retainedTimer = 0;
  cancelAnimationFrame(reviewRaf); reviewRaf = 0;
  review?.sequence.clear(); review = null;
  ui.seek.value = '0'; ui.seek.removeAttribute('aria-valuetext'); ui['clip-time'].textContent = '';
}
function updateReviewRetention() {
  clearTimeout(retainedTimer); retainedTimer = 0;
  // A finite playback must finish. Only a stopped review counts as idle.
  if (review && !review.playing) {
    retainedTimer = setTimeout(()=>stop('再生を止めてから60秒経過。映像を消去しました。'),RETAINED_IDLE_MS);
  }
}
function disposeSession() {
  const old = session; session = null;
  if (!old) return;
  old.disposed = true;
  cancelAnimationFrame(old.captureRaf); cancelAnimationFrame(old.renderRaf);
  if (old.videoCallback && ui.source.cancelVideoFrameCallback) ui.source.cancelVideoFrameCallback(old.videoCallback);
  clearInterval(old.watchdog); clearTimeout(old.limitTimer); clearTimeout(old.permissionTimer);
  old.stream?.getTracks().forEach(track => track.stop());
  old.buffer.clear(); old.scratch.width = old.scratch.height = 1;
  ui.source.pause(); ui.source.srcObject = null;
}
function stop(text = '', error = false) {
  generation++; disposeSession(); clearReview(); blank();
  phase = 'idle'; badge(); overlay();
  message(text,error); renderControls();
}
function fail(error) {
  if (error?.name === 'NotFoundError' || error?.name === 'OverconstrainedError') selectedDevice = '';
  const help = {
    NotAllowedError:'カメラが許可されていません。ブラウザーのカメラ設定を確認してください。',
    NotFoundError:'カメラが見つかりません。接続を確認してください。',
    NotReadableError:'カメラを起動できません。ほかのカメラアプリを閉じてください。',
    OverconstrainedError:'このカメラには対応していません。別のカメラを選んでください。',
    SecurityError:'カメラが制限されています。端末の管理担当者に確認してください。',
    NotSupportedError:'このブラウザーには対応していません。最新版のChromeを試してください。',
  };
  stop(help[error?.name] || error?.userMessage || '映像処理を終了しました。画質を「低め」にして再開してください。',true);
}
async function startCamera(deviceId = '') {
  if (!isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    stop('HTTPSのURLで開いてください。',true); return;
  }
  if (!window.createImageBitmap || !ctx) { fail({name:'NotSupportedError'}); return; }
  stop(); const ticket = generation, config = capturePlan(profiles[ui.quality.value], seconds(), MAX_IMAGE_BYTES);
  const scratch = document.createElement('canvas'); scratch.width = config.width; scratch.height = config.height;
  const s = {
    config, scratch, ctx:scratch.getContext('2d',{alpha:false}), stream:null, disposed:false,
    buffer:new FrameBuffer({maxFrames:config.maxFrames,maxBytes:MAX_IMAGE_BYTES,maxAgeMs:config.maxAgeMs}),
    pending:false, nextCapture:0, lastMedia:-1, lastVideo:performance.now(), sampleTime:performance.now(),
    sampleFrames:0, fps:0, ready:false, performanceWarned:false,lastImage:performance.now(),
  };
  session = s; phase = 'starting';
  overlay('カメラの許可を確認中');
  renderControls();
  s.permissionTimer = setTimeout(() => {
    if (session === s) stop('開始を中断しました。カメラの許可を確認してください。',true);
  },20000);
  try {
    const stream = await navigator.mediaDevices.getUserMedia({audio:false,video:{width:{ideal:640,max:640},height:{ideal:360,max:480},frameRate:{ideal:15,max:15},...(deviceId?{deviceId:{exact:deviceId}}:{facingMode:'environment'})}});
    if (ticket !== generation || s.disposed) { stream.getTracks().forEach(track=>track.stop()); return; }
    s.stream = stream; ui.source.srcObject = stream; await ui.source.play();
    if (ticket !== generation || s.disposed) return;
    clearTimeout(s.permissionTimer);
    if (!ui.source.videoWidth) throw {userMessage:'映像が届きません。カメラの接続を確認してください。'};
    selectedDevice = stream.getVideoTracks()[0]?.getSettings().deviceId || deviceId;
    stream.getVideoTracks().forEach(track=>track.addEventListener('ended',()=>{
      if (session === s) stop('カメラの接続が切れました。接続を確認してください。',true);
    }));
    ui.display.width = config.width; ui.display.height = config.height;
    s.sampleTime = s.lastVideo = s.lastImage = performance.now(); phase = 'live';
    overlay(`準備中 あと約${seconds()}秒`);
    badge(mode === 'delay' ? `${seconds()}秒あと` : '準備中');

    s.limitTimer = setTimeout(()=>{if(session===s) stop('120分経過のため終了しました。');},SESSION_MS);
    s.watchdog = setInterval(()=>{
      if (session !== s) return;
      if (performance.now()-s.lastVideo > 5000) { stop('映像が止まりました。カメラの接続を確認してください。',true); return; }
      if (performance.now()-s.lastImage > 5000) { stop('映像処理が停止しました。画質を「低め」にして再開してください。',true); return; }
      checkPerformance(s);
    },1000);
    captureLoop(s); renderLoop(s); renderControls();
    try {
      const list = await navigator.mediaDevices.enumerateDevices();
      if (session===s) {devices=list.filter(device=>device.kind==='videoinput');renderControls();}
    } catch { /* Device enumeration is optional. */ }
  } catch (error) { if (ticket===generation && !s.disposed) fail(error); }
}
function captureLoop(s) {
  const next = () => {
    if (s.disposed) return;
    if (ui.source.requestVideoFrameCallback) s.videoCallback=ui.source.requestVideoFrameCallback(step);
    else s.captureRaf=requestAnimationFrame(step);
  };
  const step = now => {
    if (s.disposed) return;
    next();
    const mediaTime=ui.source.currentTime;
    if(mediaTime===s.lastMedia || !ui.source.videoWidth) return;
    s.lastMedia=mediaTime;s.lastVideo=now;
    if(s.pending || now+3<s.nextCapture) return;
    s.nextCapture=Math.max(s.nextCapture+1000/s.config.fps,now);s.pending=true;
    try {
      const scale=Math.min(s.config.width/ui.source.videoWidth,s.config.height/ui.source.videoHeight);
      const w=ui.source.videoWidth*scale,h=ui.source.videoHeight*scale;
      s.ctx.fillStyle='#303438';s.ctx.fillRect(0,0,s.config.width,s.config.height);
      s.ctx.drawImage(ui.source,(s.config.width-w)/2,(s.config.height-h)/2,w,h);
      createImageBitmap(s.scratch).then(image=>{
        if(s.disposed || session!==s || phase!=='live'){image.close();return;}
        s.buffer.push(image,now);s.sampleFrames++;s.lastImage=performance.now();
      }).catch(error=>{if(!s.disposed)fail(error);}).finally(()=>{s.pending=false;});
    } catch(error){s.pending=false;fail(error);}
  };
  next();
}
function renderLoop(s) {
  if (s.disposed) return;
  s.renderRaf=requestAnimationFrame(()=>renderLoop(s));
  const now=performance.now();s.buffer.prune(now);
  const frame=mode==='delay'?s.buffer.atOrBefore(now-seconds()*1000):s.buffer.frames.at(-1);
  if(frame){
    if(now-frame.time>(mode==='delay'?seconds()*1000:0)+1000){stop('映像が遅れたため終了しました。画質を「低め」にして再開してください。',true);return;}
    paint(frame.image);overlay();
  }
  const span=s.buffer.frames.length>1?s.buffer.frames.at(-1).time-s.buffer.frames[0].time:0;
  const remaining=Math.max(1,Math.ceil(seconds()-span/1000));
  if(mode==='delay' && !frame)overlay(`準備中 あと約${remaining}秒`);
  const ready=mode==='delay'?!!frame:span>=seconds()*1000-150;
  if(ready && !s.ready){
    s.ready=true;badge(mode==='delay'?`${seconds()}秒あと`:'今の映像・直前を見返せます');

    renderControls();
  }
  if(mode==='slow' && !ready)badge(`準備中 あと約${remaining}秒`);
}
function checkPerformance(s) {
  const now=performance.now();
  if(now-s.sampleTime>=4000){
    s.fps=s.sampleFrames*1000/(now-s.sampleTime);s.sampleFrames=0;s.sampleTime=now;
    if(s.fps<s.config.fps*0.65 && !s.performanceWarned){s.performanceWarned=true;message('動作が遅くなっています。画質を「低め」に変更してください。',true);}
  }
}
function pauseLive() {
  generation++;disposeSession();phase='paused';badge('静止画・カメラ停止');
  message('');
  retainedTimer=setTimeout(()=>stop('一時停止から60秒経過。映像を消去しました。'),RETAINED_IDLE_MS);
  renderControls();
}
function watchRecent() {
  const s=session;
  if(phase!=='live' || mode!=='slow' || !s?.ready)return;
  if(performance.now()-s.buffer.frames.at(-1).time>1000){stop('映像が届きません。カメラの接続を確認してください。',true);return;}
  const sequence=s.buffer.takeRecent(seconds()*1000);
  if(sequence.duration<300){sequence.clear();fail({userMessage:'映像が短すぎます。撮影を再開してください。'});return;}
  generation++;disposeSession();clearReview();
  review={sequence,position:0,playing:true,lastNow:performance.now()};phase='review';
  badge('見返し・カメラ停止');overlay();
  message('');
  drawReview();renderControls();reviewLoop();
}
function advanceReview(now) {
  if(!review)return;
  if(review.playing)review.position=Math.min(review.sequence.duration,review.position+Math.max(0,now-review.lastNow)*rate);
  review.lastNow=now;
  if(review.position>=review.sequence.duration)review.playing=false;
}
function drawReview() {
  if(!review)return;
  const frame=review.sequence.at(review.position);if(frame)paint(frame.image);
  ui.seek.value=String(review.position/review.sequence.duration*1000);
  ui.seek.setAttribute('aria-valuetext',`${(review.position/1000).toFixed(1)}秒 / ${(review.sequence.duration/1000).toFixed(1)}秒`);
  ui['clip-time'].textContent=`${(review.position/1000).toFixed(1)} / ${(review.sequence.duration/1000).toFixed(1)}秒`;
}
function reviewLoop() {
  if(!review || phase!=='review')return;
  const playing=review.playing;advanceReview(performance.now());drawReview();
  if(playing!==review.playing){updateReviewRetention();renderControls();}
  reviewRaf=requestAnimationFrame(reviewLoop);
}
ui.start.addEventListener('click',()=>startCamera(selectedDevice));
ui.end.addEventListener('click',()=>stop());
ui.watch.addEventListener('click',watchRecent);
ui.again.addEventListener('click',()=>{if(review){review.position=0;review.playing=true;review.lastNow=performance.now();updateReviewRetention();drawReview();renderControls();}});
ui.pause.addEventListener('click',()=>{
  if(phase==='live')pauseLive();
  else if(review){advanceReview(performance.now());if(review.position>=review.sequence.duration)review.position=0;review.playing=!review.playing;review.lastNow=performance.now();updateReviewRetention();drawReview();renderControls();}
});
ui.seek.addEventListener('input',()=>{if(review){review.position=Number(ui.seek.value)/1000*review.sequence.duration;review.playing=false;review.lastNow=performance.now();updateReviewRetention();drawReview();renderControls();}});
ui.switch.addEventListener('click',()=>{if(devices.length>1)startCamera(devices[(devices.findIndex(device=>device.deviceId===selectedDevice)+1)%devices.length].deviceId);});
for(const button of document.querySelectorAll('button[data-mode]'))button.addEventListener('click',()=>{
  if(button.dataset.mode===mode)return;
  mode=button.dataset.mode;stop();
});
ui.speed.addEventListener('change',()=>{advanceReview(performance.now());rate=Number(ui.speed.value);if(review)updateReviewRetention();drawReview();renderControls();});
for(const control of [ui.seconds,ui.quality])control.addEventListener('change',()=>{
  if(phase==='live')startCamera(selectedDevice);
  else stop();
});
ui.mirror.addEventListener('change',()=>{
  if(review){updateReviewRetention();drawReview();}
  else if(phase==='paused'){
    const copy=document.createElement('canvas');copy.width=ui.display.width;copy.height=ui.display.height;
    const copyContext=copy.getContext('2d');
    if(!copyContext){fail({userMessage:'映像を反転できません。撮影を再開してください。'});return;}
    copyContext.drawImage(ui.display,0,0);
    ctx.save();ctx.translate(ui.display.width,0);ctx.scale(-1,1);ctx.drawImage(copy,0,0);ctx.restore();
    copy.width=copy.height=1;badge('静止画・カメラ停止');
  }else if(phase==='live')badge(mode==='delay'?`${seconds()}秒あと`:'今の映像');
});
function expanded(){return document.fullscreenElement===ui.viewer || ui.viewer.classList.contains('expanded');}
function syncExpanded(){
  const active=expanded();ui.fullscreen.textContent=active?'もとの大きさ':'映像を大きく';
  ui.fullscreen.setAttribute('aria-pressed',String(active));
  document.body.classList.toggle('view-expanded',active);
  document.querySelector('header').inert=active;
  for(const element of ui.app.children)if(element!==ui.viewer)element.inert=active;
  if(active && !ui.viewer.contains(document.activeElement))ui.fullscreen.focus({preventScroll:true});
  scheduleLayout();
}
ui.fullscreen.addEventListener('click',async()=>{
  if(document.fullscreenElement===ui.viewer){
    try{await document.exitFullscreen();}
    catch{message('全画面を終了できません。端末の全画面を閉じる操作を使ってください。',true);return;}
  }
  else if(ui.viewer.classList.contains('expanded'))ui.viewer.classList.remove('expanded');
  else{
    try{if(!ui.viewer.requestFullscreen)throw new Error('unavailable');await ui.viewer.requestFullscreen();}
    catch{ui.viewer.classList.add('expanded');}
  }
  syncExpanded();
});
document.addEventListener('fullscreenchange',syncExpanded);
document.addEventListener('keydown',event=>{
  if(event.key==='Tab' && expanded()){
    const controls=[...ui.viewer.querySelectorAll('button,select,input')].filter(element=>!element.disabled && !element.closest('[hidden]'));
    const first=controls[0],last=controls.at(-1);
    if(event.shiftKey && document.activeElement===first){event.preventDefault();last.focus();}
    else if(!event.shiftKey && document.activeElement===last){event.preventDefault();first.focus();}
  }
  if(event.key==='Escape' && ui.viewer.classList.contains('expanded')){ui.viewer.classList.remove('expanded');syncExpanded();ui.fullscreen.focus();}
});
document.addEventListener('visibilitychange',()=>{if(document.hidden && phase!=='idle')stop();});
window.addEventListener('pagehide',()=>stop());document.addEventListener('freeze',()=>stop());
window.addEventListener('resize',scheduleLayout);
if(window.ResizeObserver){
  const layoutObserver=new ResizeObserver(scheduleLayout);
  for(const element of [document.querySelector('header'),document.querySelector('.mode-choice'),document.querySelector('.settings'),ui['mode-hint'],ui.viewer.querySelector('.controls'),ui['review-controls'],ui.status])layoutObserver.observe(element);
}
blank();renderControls();
