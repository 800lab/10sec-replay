import { FrameBuffer, PlanarFrame, capturePlan } from './frame-buffer.mjs?v=0.5.0';
import { chooseCodec, videoProfiles, EncodedFrame, CodecPainter } from './video-codec.mjs?v=0.5.0';
import { createVideoFile } from './video-file.mjs?v=0.5.0';

const $ = id => document.getElementById(id);
const ui = Object.fromEntries(['app','source','display','empty','empty-text','view-state','status','start','pause','watch','again','switch','fullscreen','end','review-controls','seek','clip-time','quality','seconds','viewer','mirror','mode-hint','delay-name','slow-name','viewport','save-open','save-panel','mark-start','mark-end','trim-range','trim-preview','save-normal','save-slow','save-close','save-direction'].map(id => [id, $(id)]));
const profiles = { standard:{width:480,height:270,fps:15,format:'I420'}, light:{width:320,height:180,fps:12,format:'I420'} };
const MAX_IMAGE_BYTES = 64 * 1024 * 1024;
const RETAINED_IDLE_MS = 60000, SESSION_MS = 120 * 60 * 1000;
const ctx = ui.display.getContext('2d', {alpha:false,willReadFrequently:true});
const planarCapture=typeof ArrayBuffer.prototype.transfer==='function';
let mode = 'delay', phase = 'idle', generation = 0, session = null, review = null;
const PLAYBACK_RATE = 0.5;
let selectedDevice = '', devices = [], retainedTimer = 0, reviewRaf = 0, layoutRaf = 0;
let paintedFrame = null, paintedMirror = false, paintBuffer = null;
const codecPainter=new CodecPainter(ctx,fail), downloads=new Map(), codecSupport=new Map();
let editing=false;
function codecFor(quality){if(!codecSupport.has(quality))codecSupport.set(quality,chooseCodec(videoProfiles[quality]));return codecSupport.get(quality);}
async function refreshCodecOptions(){const info=await codecFor(ui.quality.value);for(const option of ui.seconds.options)if(Number(option.value)>15)option.disabled=!info;if(!info&&seconds()>15)ui.seconds.value='10';}
function clearDownloads(){for(const [url,timer]of downloads){clearTimeout(timer);URL.revokeObjectURL(url);}downloads.clear();}

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
function resetPainting() {
  codecPainter.clear();paintedFrame=null;
  if(paintBuffer){paintBuffer.data.buffer.transfer?.(0);paintBuffer=null;}
}
function showFrame(frame,onPaint) {
  const mirror=ui.mirror.checked;
  if(!frame || (paintedFrame===frame && paintedMirror===mirror))return;
  try {
    if(frame.image.kind==='video'){
      codecPainter.paint(frame,mirror,()=>{paintedFrame=frame;paintedMirror=mirror;onPaint?.();},()=>phase!=='idle'&&(review?.sequence.frames.includes(frame)||session?.buffer.frames.includes(frame)));return;
    }
    if(frame.image.data){
      if(!paintBuffer)paintBuffer=ctx.createImageData(frame.image.width,frame.image.height);
      frame.image.copyRGBA(paintBuffer.data,mirror);ctx.putImageData(paintBuffer,0,0);
    }else paint(frame.image);
    paintedFrame=frame;paintedMirror=mirror;onPaint?.();
  }catch(error){fail(error);}
}
function blank() {
  ui.display.width = 480; ui.display.height = 270;
  if (!ctx) return;
  ctx.fillStyle = '#303438'; ctx.fillRect(0,0,480,270);
}
function modeDescription() {
  if(phase==='review' && mode==='delay')return '見ていた動きをスロー再生';
  return mode === 'delay' ? `${seconds()}秒後に自動再生` : `直前${seconds()}秒をスロー再生`;
}
function renderControls() {
  const active = document.activeElement;
  const live = phase === 'live', viewing = phase === 'review';
  ui.app.dataset.phase = phase; ui.app.dataset.mode = mode; ui.viewer.dataset.phase = phase;
  ui['mode-hint'].textContent = modeDescription();
  ui['delay-name'].textContent = `${seconds()}秒おくれて再生`;
  ui['slow-name'].textContent = `直前${seconds()}秒をスロー再生`;
  ui.start.hidden = live || editing;
  ui.start.disabled = phase === 'starting';
  ui.start.textContent = viewing ? (mode==='delay'?'もどる':'つぎへ') : phase === 'paused' ? '再開する' : phase === 'starting' ? 'カメラ確認中…' : 'はじめる';
  ui.watch.hidden = !live || (mode==='delay' && !planarCapture);
  ui.watch.disabled = mode==='delay' ? !session?.reviewReady : !session?.ready;
  ui.watch.textContent = mode==='delay' ? (session?.reviewReady?'この動きをスロー':'スロー準備中') : `直前${seconds()}秒を見る`;
  ui.again.hidden = !viewing || editing;
  ui.pause.hidden = !((live && mode === 'delay') || (viewing && (review.playing || review.position < review.rangeEnd)));
  ui.pause.disabled = live && !session?.ready;
  ui.pause.textContent = viewing ? (review.playing ? 'とめる' : 'つづける') : 'とめる';
  ui['save-open'].hidden=!viewing||editing||review?.sequence.frames[0]?.image.kind!=='video';
  ui['save-panel'].hidden=!editing;ui.viewer.dataset.editing=String(editing);
  document.querySelector('.seek-label').firstChild.textContent=editing?'保存する区間 ':'見たいところへ ';
  const actions=ui.viewer.querySelector('.controls'),saveActions=ui['save-panel'].querySelector('.trim-row:last-child');
  if(ui.end.parentElement!==(editing?saveActions:actions))(editing?saveActions:actions).append(ui.end);
  actions.hidden=editing;
  ui['trim-preview'].textContent=editing&&review?.playing?'とめる':'区間を見る';
  ui['save-direction'].hidden=!editing||!ui.mirror.checked;
  ui.fullscreen.hidden=editing;
  ui.end.disabled = phase === 'idle';
  ui['review-controls'].hidden = !viewing;
  ui.switch.disabled = !live || devices.length < 2;
  ui.switch.title = !live ? '撮影開始後に切替できます' : devices.length < 2 ? 'カメラが2台以上必要です' : 'カメラを切り替えます';
  for (const control of [ui.quality,ui.seconds,ui.mirror]) control.disabled = phase === 'starting';
  document.querySelectorAll('button[data-mode]').forEach(button => button.setAttribute('aria-pressed',String(button.dataset.mode === mode)));
  if (viewing) badge('見返し 0.5倍・カメラ停止');
  if (ui.viewer.contains(active) && (active.disabled || active.closest('[hidden]'))) {
    const next = viewing ? (ui.pause.hidden?ui.again:ui.pause) : phase==='idle' || phase==='paused' ? ui.start : ui.end;
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
  resetPainting();
  editing=false;ui.viewer.dataset.editing='false';clearDownloads();
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
  resetPainting();
  const old = session; session = null;
  if (!old) return;
  old.disposed = true;
  cancelAnimationFrame(old.captureRaf); cancelAnimationFrame(old.renderRaf);
  if (old.videoCallback && ui.source.cancelVideoFrameCallback) ui.source.cancelVideoFrameCallback(old.videoCallback);
  clearInterval(old.watchdog); clearTimeout(old.limitTimer); clearTimeout(old.permissionTimer);
  old.stream?.getTracks().forEach(track => track.stop());
  if(old.encoder&&old.encoder.state!=='closed')old.encoder.close();
  old.buffer.clear(); old.scratch.width = old.scratch.height = 1;
  ui.source.pause(); ui.source.srcObject = null;
}
function stop(text = '', error = false) {
  generation++; disposeSession(); clearReview(); blank();
  phase = 'idle'; badge(); overlay();
  message(text,error); renderControls();syncExpanded();
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
  if ((!planarCapture && !window.createImageBitmap) || !ctx) { fail({name:'NotSupportedError'}); return; }
  stop(); const ticket = generation;
  phase='starting';overlay('カメラの許可を確認中');renderControls();
  const info=await codecFor(ui.quality.value);
  if(ticket!==generation)return;
  if(!info&&seconds()>15){ui.seconds.value='10';await refreshCodecOptions();}
  const profile=info?videoProfiles[ui.quality.value]:planarCapture?profiles[ui.quality.value]:{...profiles[ui.quality.value],format:'RGBA',fps:ui.quality.value==='light'?8:10};
  const history=info?(mode==='delay'?seconds()+30:30):seconds()*(mode==='delay'&&planarCapture?2:1);
  const config=info?{...profile,format:'video',maxAgeMs:(history+.8)*1000,maxFrames:Math.ceil((history+.8)*profile.fps)+2}:capturePlan(profile,seconds(),MAX_IMAGE_BYTES,history);
  const scratch = document.createElement('canvas'); scratch.width = config.width; scratch.height = config.height;
  const s = {
    config, info, encoder:null, scratch, ctx:scratch.getContext('2d',{alpha:false,willReadFrequently:true}), stream:null, disposed:false,
    buffer:new FrameBuffer({maxFrames:config.maxFrames,maxBytes:MAX_IMAGE_BYTES,maxAgeMs:config.maxAgeMs}),
    pending:false, nextCapture:0, lastMedia:-1, lastVideo:performance.now(), sampleTime:performance.now(),
    sampleFrames:0, fps:0, ready:false, reviewReady:false, lastDisplayed:null, lastPaint:performance.now(), performanceWarned:false,lastImage:performance.now(),
  };
  session = s; phase = 'starting';
  overlay('カメラの許可を確認中');
  renderControls();
  s.permissionTimer = setTimeout(() => {
    if (session === s) stop('開始を中断しました。カメラの許可を確認してください。',true);
  },20000);
  try {
    if(info){
      s.encoder=new VideoEncoder({output:(chunk,metadata)=>{
        if(s.disposed||session!==s)return;
        if(metadata.decoderConfig)info.decoderConfig=metadata.decoderConfig;
        if(chunk.type!=='key'||!info.decoderConfig){fail({userMessage:'動画を保持できません。別の画質で再開してください。'});return;}
        s.buffer.push(new EncodedFrame(chunk,info),chunk.timestamp/1000);s.sampleFrames++;s.lastImage=performance.now();s.pending=false;
      },error:error=>{if(!s.disposed&&session===s)fail(error);}});
      s.encoder.configure(info.config);
    }
    const stream = await navigator.mediaDevices.getUserMedia({audio:false,video:{width:{ideal:640,max:640},height:{ideal:360,max:480},frameRate:{ideal:config.fps,max:30},...(deviceId?{deviceId:{exact:deviceId}}:{facingMode:'environment'})}});
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
    s.displayDeadline=performance.now()+(mode==='delay'?seconds()*1000:0)+5000;
    s.bufferDeadline=performance.now()+config.maxAgeMs+5000;
    overlay(`準備中 あと約${seconds()}秒`);
    badge(mode === 'delay' ? `${seconds()}秒あと` : '準備中');

    s.limitTimer = setTimeout(()=>{if(session===s) stop('120分経過のため終了しました。');},SESSION_MS);
    s.watchdog = setInterval(()=>{
      if (session !== s) return;
      if (performance.now()-s.lastVideo > 5000) { stop('映像が止まりました。カメラの接続を確認してください。',true); return; }
      if (performance.now()-s.lastImage > 5000) { stop('映像処理が停止しました。画質を「低め」にして再開してください。',true); return; }
      if (performance.now()>s.displayDeadline) { stop('映像表示が停止しました。画質を「低め」にして再開してください。',true); return; }
      if (performance.now()>s.bufferDeadline && !(mode==='delay' && planarCapture?s.reviewReady:s.ready)) { stop('必要な映像を保持できません。画質を「低め」にして再開してください。',true); return; }
      checkPerformance(s);
    },1000);
    captureLoop(s); renderLoop(s); renderControls();
    if(!info)message('この端末では動画保存と20・30秒に対応していません。5〜15秒で使えます。');
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
      if(s.encoder){
        const frame=new VideoFrame(s.scratch,{timestamp:Math.round(now*1000)});
        try{s.encoder.encode(frame,{keyFrame:true});}finally{frame.close();}return;
      }
      if(s.config.format==='I420'){
        const pixels=s.ctx.getImageData(0,0,s.config.width,s.config.height).data;
        let image;
        try{image=PlanarFrame.fromRGBA(pixels,s.config.width,s.config.height);}finally{pixels.buffer.transfer(0);}
        s.buffer.push(image,Math.round(now*1000)/1000);s.sampleFrames++;s.lastImage=performance.now();s.pending=false;return;
      }
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
    showFrame(frame,()=>{if(session===s){s.lastDisplayed=frame;s.lastPaint=performance.now();s.displayDeadline=s.lastPaint+5000;overlay();}});
  }
  const span=s.buffer.frames.length>1?s.buffer.frames.at(-1).time-s.buffer.frames[0].time:0;
  const remaining=Math.max(1,Math.ceil(seconds()-span/1000));
  if(mode==='delay' && !frame)overlay(`準備中 あと約${remaining}秒`);
  const ready=mode==='delay'?!!s.lastDisplayed:span>=seconds()*1000-150;
  if(ready && !s.ready){
    s.ready=true;badge(mode==='delay'?`${seconds()}秒あと`:'今の映像・直前を見返せます');

    renderControls();
  }
  if(mode==='slow' && !ready)badge(`準備中 あと約${remaining}秒`);
  if(mode==='delay'){
    const reviewReady=!!s.lastDisplayed && s.lastDisplayed.time-s.buffer.frames[0]?.time>=seconds()*1000-150;
    if(reviewReady!==s.reviewReady){s.reviewReady=reviewReady;renderControls();}
  }
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
  if(phase!=='live' || !s?.ready || (mode==='delay' && !s.reviewReady))return;
  if(performance.now()-s.buffer.frames.at(-1).time>1000){stop('映像が届きません。カメラの接続を確認してください。',true);return;}
  const sequence=mode==='delay'?s.buffer.takeEndingAt(s.lastDisplayed.time,(s.info?30:seconds())*1000):s.buffer.takeRecent((s.info?30:seconds())*1000);
  if(sequence.duration<300){sequence.clear();fail({userMessage:'映像が短すぎます。撮影を再開してください。'});return;}
  generation++;disposeSession();clearReview();
  const rangeStart=Math.max(0,sequence.duration-seconds()*1000);
  review={sequence,rangeStart,rangeEnd:sequence.duration,normalStart:rangeStart,position:rangeStart,playing:true,lastNow:performance.now(),markStart:0,markEnd:sequence.duration};phase='review';
  badge('見返し・カメラ停止');overlay();
  message('');
  drawReview();renderControls();reviewLoop();
}
function advanceReview(now) {
  if(!review)return;
  if(review.playing)review.position=Math.min(review.stopAt??review.rangeEnd,review.position+Math.max(0,now-review.lastNow)*PLAYBACK_RATE);
  review.lastNow=now;
  if(review.position>=(review.stopAt??review.rangeEnd))review.playing=false;
}
function drawReview() {
  if(!review)return;
  const frame=review.sequence.at(review.position);if(frame)showFrame(frame);
  const duration=review.rangeEnd-review.rangeStart,position=review.position-review.rangeStart;
  ui.seek.value=String(position/duration*1000);
  ui.seek.setAttribute('aria-valuetext',`${(position/1000).toFixed(1)}秒 / ${(duration/1000).toFixed(1)}秒`);
  ui['clip-time'].textContent=`${(position/1000).toFixed(1)} / ${(duration/1000).toFixed(1)}秒`;
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
ui.again.addEventListener('click',()=>{if(review){review.position=review.rangeStart;review.playing=true;review.lastNow=performance.now();updateReviewRetention();drawReview();renderControls();}});
ui.pause.addEventListener('click',()=>{
  if(phase==='live')pauseLive();
  else if(review){const playing=review.playing;advanceReview(performance.now());review.playing=!playing && review.position<review.rangeEnd;review.lastNow=performance.now();updateReviewRetention();drawReview();renderControls();}
});
ui.seek.addEventListener('input',()=>{if(review){review.stopAt=null;review.position=review.rangeStart+Number(ui.seek.value)/1000*(review.rangeEnd-review.rangeStart);review.playing=false;review.lastNow=performance.now();updateReviewRetention();drawReview();renderControls();}});
ui.switch.addEventListener('click',()=>{if(devices.length>1)startCamera(devices[(devices.findIndex(device=>device.deviceId===selectedDevice)+1)%devices.length].deviceId);});
for(const button of document.querySelectorAll('button[data-mode]'))button.addEventListener('click',()=>{
  if(button.dataset.mode===mode)return;
  mode=button.dataset.mode;stop();
});
for(const control of [ui.seconds,ui.quality])control.addEventListener('change',()=>{
  if(control===ui.quality)refreshCodecOptions();
  if(phase==='live')startCamera(selectedDevice);
  else stop();
});
ui.mirror.addEventListener('change',()=>{
  if(review){updateReviewRetention();drawReview();renderControls();}
  else if(phase==='paused'){
    const copy=document.createElement('canvas');copy.width=ui.display.width;copy.height=ui.display.height;
    const copyContext=copy.getContext('2d');
    if(!copyContext){fail({userMessage:'映像を反転できません。撮影を再開してください。'});return;}
    copyContext.drawImage(ui.display,0,0);
    ctx.save();ctx.translate(ui.display.width,0);ctx.scale(-1,1);ctx.drawImage(copy,0,0);ctx.restore();
    copy.width=copy.height=1;badge('静止画・カメラ停止');
  }else if(phase==='live')badge(mode==='delay'?`${seconds()}秒あと`:'今の映像');
});
function updateTrim(){
  if(!review)return;
  ui['trim-range'].textContent=`${(review.markStart/1000).toFixed(1)}〜${(review.markEnd/1000).toFixed(1)}秒`;
  const invalid=review.markEnd-review.markStart<300;
  for(const element of[ui['save-normal'],ui['save-slow'],ui['trim-preview']])element.disabled=invalid;
}
function setEditing(value){
  if(!review)return;
  editing=value;review.playing=false;review.stopAt=null;
  review.rangeStart=value?0:review.normalStart;review.rangeEnd=review.sequence.duration;
  review.position=Math.max(review.rangeStart,Math.min(review.stopAt??review.rangeEnd,review.position));
  message('');updateTrim();updateReviewRetention();drawReview();renderControls();syncExpanded();
  (value?ui['mark-start']:ui['save-open']).focus({preventScroll:true});
}
ui['save-open'].addEventListener('click',()=>setEditing(true));
ui['save-close'].addEventListener('click',()=>setEditing(false));
for(const [id,key]of[['mark-start','markStart'],['mark-end','markEnd']])ui[id].addEventListener('click',()=>{
  // Mark the frame actually painted, not a newer pending decoder request.
  if(!review||!paintedFrame||!review.sequence.frames.includes(paintedFrame))return;
  review.playing=false;review.stopAt=null;review[key]=Math.max(0,Math.min(review.sequence.duration,paintedFrame.time-review.sequence.start));
  updateTrim();updateReviewRetention();renderControls();
});
ui['trim-preview'].addEventListener('click',()=>{
  if(!review)return;
  if(review.playing){advanceReview(performance.now());review.playing=false;}
  else{review.rangeStart=0;review.rangeEnd=review.sequence.duration;review.stopAt=review.markEnd;review.position=review.markStart;review.playing=true;review.lastNow=performance.now();}
  updateReviewRetention();drawReview();renderControls();
});
function saveVideo(rate){
  if(!review||!editing)return;
  review.playing=false;updateReviewRetention();renderControls();
  try{
    const file=createVideoFile(review.sequence,review.markStart,review.markEnd,rate);
    const url=URL.createObjectURL(file.blob),link=document.createElement('a');
    link.href=url;link.download=`10sec-replay${rate===.5?'-slow':''}-${new Date().toISOString().replace(/[:.]/g,'-')}.${file.extension}`;
    document.body.append(link);link.click();link.remove();
    downloads.set(url,setTimeout(()=>{URL.revokeObjectURL(url);downloads.delete(url);},1000));
    message('動画を作成しました。保存先を確認してください。');
  }catch(error){message(error.message.includes('32 MiB')?'動画が大きすぎます。区間を短くしてください。':'動画を作成できません。区間を選び直してください。',true);}
}
ui['save-normal'].addEventListener('click',()=>saveVideo(1));
ui['save-slow'].addEventListener('click',()=>saveVideo(.5));
function expanded(){return editing || document.fullscreenElement===ui.viewer || ui.viewer.classList.contains('expanded');}
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
  if(event.key==='Escape' && editing){event.preventDefault();setEditing(false);return;}
  if(event.key==='Escape' && ui.viewer.classList.contains('expanded')){ui.viewer.classList.remove('expanded');syncExpanded();ui.fullscreen.focus();}
});
document.addEventListener('visibilitychange',()=>{if(document.hidden && phase!=='idle')stop();});
window.addEventListener('pagehide',()=>stop());document.addEventListener('freeze',()=>stop());
window.addEventListener('resize',scheduleLayout);
if(window.ResizeObserver){
  const layoutObserver=new ResizeObserver(scheduleLayout);
  for(const element of [document.querySelector('header'),document.querySelector('.mode-choice'),document.querySelector('.settings'),ui['mode-hint'],ui.viewer.querySelector('.controls'),ui['review-controls'],ui.status])layoutObserver.observe(element);
}
blank();renderControls();refreshCodecOptions();
