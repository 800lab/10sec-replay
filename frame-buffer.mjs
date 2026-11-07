// Fit the selected interval, plus capture margin, inside the pixel-buffer limit.
export function capturePlan(profile, seconds, maxBytes) {
  const maxAgeMs = (seconds + 0.8) * 1000;
  const capacity = Math.floor(maxBytes / (profile.width * profile.height * 4));
  const fps = Math.min(profile.fps, Math.floor((capacity - 2) / (maxAgeMs / 1000)));
  if (fps < 1) throw new Error('Image budget too small');
  return {...profile, fps, maxAgeMs, maxFrames:Math.ceil(maxAgeMs / 1000 * fps) + 2};
}

// Owns ImageBitmaps. Every removed image is explicitly closed.
export class FrameBuffer {
  constructor({ maxFrames, maxBytes, maxAgeMs }) {
    this.maxFrames = maxFrames;
    this.maxBytes = maxBytes;
    this.maxAgeMs = maxAgeMs;
    this.frames = [];
    this.bytes = 0;
  }
  push(image, time) {
    const bytes = image.width * image.height * 4;
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
    const frames = this.frames;
    this.frames = []; this.bytes = 0;
    if (!frames.length) return new FrameSequence([],0,0);
    const end = frames.at(-1).time;
    const start = Math.max(frames[0].time,end-durationMs);
    let first = 0;
    for (let i=0;i<frames.length;i++) if (frames[i].time<=start) first=i;
    for (let i=0;i<first;i++) frames[i].image.close();
    return new FrameSequence(frames.slice(first),start,end-start);
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
