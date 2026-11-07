// Fit the selected interval, plus capture margin, inside the pixel-buffer limit.
export function capturePlan(profile, seconds, maxBytes, historySeconds = seconds) {
  const maxAgeMs = (historySeconds + 0.8) * 1000;
  const planar=profile.format==='I420';
  const bytes=profile.width*profile.height*(planar?1.5:4);
  const capacity = Math.floor(maxBytes / bytes);
  const fps = Math.min(profile.fps, Math.floor((capacity - (planar?7:2)) / (maxAgeMs / 1000)));
  if (fps < 1) throw new Error('Image budget too small');
  return {...profile, fps, maxAgeMs, maxFrames:Math.ceil(maxAgeMs / 1000 * fps) + 2};
}

// 8-bit luma at full resolution; chroma at half width/height, standard I420.
// Own exact-sized byte arrays, with no codec or decoded-image cache behind them.
export class PlanarFrame {
  constructor(data,width,height) { this.data=data;this.width=width;this.height=height;this.byteLength=data.byteLength; }
  static fromRGBA(rgba,width,height) {
    if(width%2 || height%2 || rgba.length!==width*height*4)throw new Error('Invalid frame dimensions');
    const pixels=width*height,data=new Uint8Array(pixels*1.5);
    for(let p=0,i=0;p<rgba.length;p+=4,i++)data[i]=((47*rgba[p]+157*rgba[p+1]+16*rgba[p+2]+128)>>8)+16;
    for(let y=0;y<height;y+=2)for(let x=0;x<width;x+=2){
      const p=(y*width+x)*4,q=p+width*4;
      const r=rgba[p]+rgba[p+4]+rgba[q]+rgba[q+4],g=rgba[p+1]+rgba[p+5]+rgba[q+1]+rgba[q+5],b=rgba[p+2]+rgba[p+6]+rgba[q+2]+rgba[q+6];
      const c=(y/2)*(width/2)+x/2;
      data[pixels+c]=((-26*r-87*g+113*b+512)>>10)+128;
      data[pixels+pixels/4+c]=((112*r-102*g-10*b+512)>>10)+128;
    }
    return new PlanarFrame(data,width,height);
  }
  copyRGBA(rgba,mirror=false) {
    const {width,height,data}=this,pixels=width*height;
    if(!data || rgba.length!==pixels*4)throw new Error('Invalid render buffer');
    for(let y=0;y<height;y++)for(let x=0;x<width;x++){
      const i=y*width+x,c=(y>>1)*(width>>1)+(x>>1);
      const l=298*(data[i]-16),u=data[pixels+c]-128,v=data[pixels+pixels/4+c]-128;
      const p=(y*width+(mirror?width-1-x:x))*4;
      rgba[p]=(l+459*v+128)>>8;rgba[p+1]=(l-55*u-136*v+128)>>8;rgba[p+2]=(l+541*u+128)>>8;rgba[p+3]=255;
    }
  }
  close() {
    if(this.data){this.data.buffer.transfer?.(0);this.data=null;}
  }
}

// Owns frame payloads. Every removed byte array or bitmap is released.
export class FrameBuffer {
  constructor({ maxFrames, maxBytes, maxAgeMs }) {
    this.maxFrames = maxFrames;
    this.maxBytes = maxBytes;
    this.maxAgeMs = maxAgeMs;
    this.frames = [];
    this.bytes = 0;
  }
  push(image, time) {
    const bytes = image.byteLength ?? image.width * image.height * 4;
    if (bytes > this.maxBytes) { image.close(); return; }
    this.frames.push({ image, time, bytes });
    this.bytes += bytes;
    this.prune(time);
  }
  prune(now) {
    while (this.frames.length && (this.frames.length > this.maxFrames || this.bytes > this.maxBytes || now - this.frames[0].time > this.maxAgeMs)) {
      const frame = this.frames.shift();
      this.bytes -= frame.bytes;
      frame.image.close();
    }
  }
  atOrBefore(target) {
    for (let i = this.frames.length - 1; i >= 0; i--) if (this.frames[i].time <= target) return this.frames[i];
    return null;
  }
  takeRecent(durationMs) {
    return this.takeEndingAt(this.frames.at(-1)?.time ?? 0,durationMs);
  }
  takeEndingAt(endTime,durationMs) {
    const frames = this.frames;
    this.frames = []; this.bytes = 0;
    if (!frames.length) return new FrameSequence([],0,0);
    const end = Math.min(endTime,frames.at(-1).time);
    if(end<frames[0].time){for(const frame of frames)frame.image.close();return new FrameSequence([],0,0);}
    const start = Math.max(frames[0].time,end-durationMs);
    let first = 0;
    for (let i=0;i<frames.length;i++) if (frames[i].time<=start) first=i;
    for (let i=0;i<first;i++) frames[i].image.close();
    const kept=[];
    for(let i=first;i<frames.length;i++){
      if(frames[i].time<=end)kept.push(frames[i]);else frames[i].image.close();
    }
    return new FrameSequence(kept,start,end-start);
  }
  clear() {
    for (const frame of this.frames) frame.image.close();
    this.frames = [];
    this.bytes = 0;
  }
}

// Takes ownership from FrameBuffer without duplicating pixel buffers or codecs.
export class FrameSequence {
  constructor(frames,start,duration) {
    this.frames=frames;this.start=start;this.duration=duration;
    this.bytes=frames.reduce((total,frame)=>total+frame.bytes,0);
  }
  at(position) {
    const target=this.start+Math.max(0,Math.min(this.duration,position));
    for(let i=this.frames.length-1;i>=0;i--) if(this.frames[i].time<=target)return this.frames[i];
    return this.frames[0] || null;
  }
  clear() {
    for(const frame of this.frames)frame.image.close();
    this.frames=[];this.bytes=0;
  }
}
