// Native codecs only; independent keyframes allow exact local cuts and remuxing.
export const videoProfiles={standard:{width:640,height:360,fps:24,bitrate:6000000},light:{width:480,height:270,fps:15,bitrate:2500000}};
// Leave room for the longest history and also keep any 30-second export <32MiB.
export function frameByteLimit(fps){return Math.floor(64*1024*1024*.98/(Math.ceil(60.8*fps)+2));}

export async function chooseCodec(profile) {
  if(typeof VideoEncoder!=='function'||typeof VideoDecoder!=='function'||typeof VideoFrame!=='function'||typeof ArrayBuffer.prototype.transfer!=='function')return null;
  try {
    const probe=new VideoFrame(new Uint8Array(6),{format:'I420',codedWidth:2,codedHeight:2,timestamp:0});
    try{await probe.copyTo(new Uint8Array(16),{format:'RGBA'});}finally{probe.close();}
    for(const [codec,quantizer] of [['avc1.64001f',true],['avc1.42001f',true],['avc1.64001f',false],['avc1.42001f',false],['vp8',false]]){
      try{
        const config={codec,width:profile.width,height:profile.height,framerate:profile.fps,...(quantizer?{bitrateMode:'quantizer'}:{bitrate:profile.bitrate}),latencyMode:'realtime',...(codec.startsWith('avc')?{avc:{format:'avc'}}:{})};
        const [encoded,decoded]=await Promise.all([VideoEncoder.isConfigSupported(config),VideoDecoder.isConfigSupported({codec})]);
        if(encoded.supported&&decoded.supported)return {config,codec,quantizer,container:codec.startsWith('avc')?'mp4':'webm',...profile};
      }catch{ /* A rejected codec must not hide the other supported codec. */ }
    }
  }catch{ /* A device without these codecs keeps the compact legacy path. */ }
  return null;
}

export class EncodedFrame {
  constructor(chunk,info) {
    this.kind='video';this.info=info;this.timestamp=chunk.timestamp;
    this.type=chunk.type;this.byteLength=chunk.byteLength;
    this.data=new Uint8Array(chunk.byteLength);chunk.copyTo(this.data);
  }
  close(){if(this.data){this.data.buffer.transfer(0);this.data=null;}}
}

export class CodecPainter {
  constructor(ctx,onError){this.ctx=ctx;this.onError=onError;this.epoch=0;this.decoder=null;this.job=null;this.copying=false;this.pixels=null;this.info=null;}
  clear(){
    this.epoch++;this.job=null;
    if(this.decoder&&this.decoder.state!=='closed')this.decoder.close();
    this.decoder=null;this.info=null;
    if(!this.copying)this.releasePixels();
  }
  releasePixels(){if(this.pixels){this.pixels.data.buffer.transfer(0);this.pixels=null;}}
  paint(frame,mirror,onPaint,isCurrent=()=>true){
    if(this.job||this.copying||!frame.image.data)return false;
    const info=frame.image.info;
    if(this.info!==info){this.clear();this.info=info;}
    const epoch=this.epoch;
    if(!this.decoder){
      this.decoder=new VideoDecoder({output:image=>this.output(image,epoch),error:error=>{if(epoch===this.epoch)this.onError(error);}});
      this.decoder.configure({...info.decoderConfig,optimizeForLatency:true});
    }
    this.job={frame,mirror,onPaint,isCurrent};
    try{this.decoder.decode(new EncodedVideoChunk({type:frame.image.type,timestamp:frame.image.timestamp,data:frame.image.data}));}
    catch(error){this.job=null;this.onError(error);}
    return true;
  }
  async output(image,epoch){
    const job=this.job;
    if(!job||epoch!==this.epoch||image.timestamp!==job.frame.image.timestamp){image.close();return;}
    this.copying=true;
    try{
      const {width,height}=job.frame.image.info;
      if(!this.pixels)this.pixels=this.ctx.createImageData(width,height);
      await image.copyTo(this.pixels.data,{format:'RGBA',rect:image.visibleRect,layout:[{offset:0,stride:width*4}]});
      if(epoch!==this.epoch||!job.isCurrent())return;
      if(job.mirror){
        const data=this.pixels.data;
        for(let y=0;y<height;y++)for(let x=0;x<width/2;x++){
          const a=(y*width+x)*4,b=(y*width+width-1-x)*4;
          for(let c=0;c<4;c++){const value=data[a+c];data[a+c]=data[b+c];data[b+c]=value;}
        }
      }
      this.ctx.putImageData(this.pixels,0,0);job.onPaint?.();
    }catch(error){if(epoch===this.epoch)this.onError(error);}
    finally{
      image.close();this.copying=false;
      if(this.job===job)this.job=null;
      if(epoch!==this.epoch)this.releasePixels();
    }
  }
}
