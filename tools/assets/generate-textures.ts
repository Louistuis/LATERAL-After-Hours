import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const SIZE = 256;
const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const crcTable = new Uint32Array(256);
for (let n=0;n<256;n++) {
  let c=n;
  for(let k=0;k<8;k++) c=(c&1)?0xedb88320^(c>>>1):c>>>1;
  crcTable[n]=c>>>0;
}
function crc32(data:Uint8Array):number {
  let crc=0xffffffff;
  for(const value of data) crc=crcTable[(crc^value)&0xff]!^(crc>>>8);
  return (crc^0xffffffff)>>>0;
}
function chunk(type:string,data:Uint8Array):Uint8Array {
  const name=Buffer.from(type,'ascii'), length=Buffer.alloc(4), checksum=Buffer.alloc(4);
  length.writeUInt32BE(data.length); checksum.writeUInt32BE(crc32(Buffer.concat([name,data])));
  return Buffer.concat([length,name,data,checksum]);
}
function hash(x:number,y:number,seed:number):number {
  let n=Math.imul(x^seed,0x45d9f3b); n=Math.imul(n^(n>>>16),0x45d9f3b); n=Math.imul(n^(n>>>16),0x45d9f3b);
  n^=Math.imul(y+seed,0x27d4eb2d);
  return (n>>>0)/0xffffffff*2-1;
}
function noise(x:number,y:number,cells:number,seed:number):number {
  const fx=x/SIZE*cells, fy=y/SIZE*cells, ix=Math.floor(fx), iy=Math.floor(fy);
  const sx=fx-ix, sy=fy-iy, ux=sx*sx*(3-2*sx), uy=sy*sy*(3-2*sy), mod=(v:number)=>((v%cells)+cells)%cells;
  const a=hash(mod(ix),mod(iy),seed), b=hash(mod(ix+1),mod(iy),seed);
  const c=hash(mod(ix),mod(iy+1),seed), d=hash(mod(ix+1),mod(iy+1),seed);
  const top=a+(b-a)*ux, bottom=c+(d-c)*ux;
  return top+(bottom-top)*uy;
}
interface TextureSpec { readonly name:string; readonly color:readonly [number,number,number]; readonly seed:number; readonly chips?:boolean; readonly warmOxide?:boolean; readonly kind?:'asphalt'|'concrete'|'curb'; }

/** Tileable hairline cracks as a 0..1 mask: seeded random walks that wrap at the tile edge. */
function crackMask(seed:number,walkers:number,minLength:number,maxLength:number):Float32Array {
  const mask=new Float32Array(SIZE*SIZE);
  let state=(seed*2654435761)>>>0;
  const rand=():number=>{ state=(Math.imul(state,1664525)+1013904223)>>>0; return state/0x100000000; };
  const mark=(x:number,y:number,value:number):void=>{
    const ix=((Math.round(x)%SIZE)+SIZE)%SIZE, iy=((Math.round(y)%SIZE)+SIZE)%SIZE;
    const k=iy*SIZE+ix; if(mask[k]!<value) mask[k]=value;
  };
  const walk=(x:number,y:number,heading:number,length:number,depth:number):void=>{
    for(let step=0;step<length;step++) {
      heading+=(rand()-.5)*.55;
      x+=Math.cos(heading); y+=Math.sin(heading);
      mark(x,y,1); mark(x+1,y,.45); mark(x,y+1,.45);
      if(depth<2&&rand()<.012) walk(x,y,heading+(rand()<.5?-1:1)*(.6+rand()*.7),Math.round(length*.45),depth+1);
    }
  };
  for(let i=0;i<walkers;i++) walk(rand()*SIZE,rand()*SIZE,rand()*Math.PI*2,Math.round(minLength+rand()*(maxLength-minLength)),0);
  return mask;
}
const specs:readonly TextureSpec[]=[
  {name:'harbor-asphalt',color:[60,65,68],seed:17,kind:'asphalt'},
  {name:'harbor-concrete',color:[96,103,104],seed:41,kind:'concrete'},
  {name:'harbor-curb',color:[165,161,149],seed:73,chips:true,kind:'curb'},
  {name:'harbor-steel',color:[82,101,99],seed:109,warmOxide:true},
  {name:'harbor-shed-paint',color:[49,83,88],seed:151},
];
function makePng(spec:TextureSpec):Buffer {
  const cracks=spec.kind==='asphalt'?crackMask(spec.seed,4,50,130):spec.kind==='concrete'?crackMask(spec.seed,3,50,110):undefined;
  const raw=Buffer.alloc((SIZE*4+1)*SIZE);
  for(let y=0;y<SIZE;y++) {
    const row=y*(SIZE*4+1); raw[row]=0;
    for(let x=0;x<SIZE;x++) {
      const i=row+1+x*4;
      const grain=spec.name==='harbor-shed-paint'
        ? noise(x,y,18,spec.seed)*.55+noise(x,y,6,spec.seed+2)*.45
        : noise(x,y,64,spec.seed)*.34+noise(x,y,22,spec.seed+1)*.45+noise(x,y,6,spec.seed+2)*.21;
      const saltStreak=spec.name==='harbor-shed-paint'
        ? Math.pow(Math.max(0,Math.sin(2*Math.PI*17*x/SIZE+.22*Math.sin(2*Math.PI*2*y/SIZE))),8)
        : 0;
      const broadWeather=spec.name==='harbor-shed-paint'?noise(x,y,3,spec.seed+3):0;
      const fleck=hash(x,y,spec.seed+29);
      const chips=spec.chips&&fleck>.986?((x+y)%2?1.75:.72):1;
      const oxide=spec.warmOxide&&fleck>.955?Math.max(0,(fleck-.955)/.045):0;
      const contrast = spec.name === 'harbor-shed-paint' ? .055 : .105;
      const shedPaint=spec.name==='harbor-shed-paint';
      const weather=shedPaint?1+grain*contrast+broadWeather*.035-saltStreak*.055:1+grain*contrast;
      const greenWeather=shedPaint?weather:1+grain*.085,blueWeather=shedPaint?weather:1+grain*.075;
      let r=spec.color[0]*weather*chips+oxide*23, g=spec.color[1]*greenWeather*chips-oxide*4, b=spec.color[2]*blueWeather*chips-oxide*13;
      if(spec.kind==='asphalt') {
        // Chip-seal aggregate, oil bleed, hairline cracks and a lighter sun-bleached patch.
        const agg=fleck>.93?1.42+(fleck-.93)*3:fleck<-.93?.62:1;
        const oil=Math.max(0,noise(x,y,5,spec.seed+7)-.12)*1.6, bleach=Math.max(0,noise(x,y,3,spec.seed+11)-.25);
        const crack=cracks![y*SIZE+x]!;
        const shade=agg*(1-.38*Math.min(1,oil))*(1+.25*bleach)*(1-.4*crack);
        r*=shade; g*=shade; b*=shade*(1+.05*Math.min(1,oil));
      } else if(spec.kind==='concrete') {
        // Slab joints every tile edge, rain-streaked stains and cracks.
        const joint=Math.min(x,y)<2?1-Math.min(x,y)*.4:0, jointEdge=(x===2||y===2)?.12:0;
        const stain=Math.max(0,noise(x,y,4,spec.seed+5)-.05)*1.3+Math.max(0,noise(x,y,14,spec.seed+9)-.3)*.4;
        const crack=cracks![y*SIZE+x]!;
        const shade=(1-.42*Math.min(1,stain))*(1-.38*crack)*(1-.5*joint)*(1+jointEdge);
        r*=shade; g*=shade*(1-.03*Math.min(1,stain)); b*=shade*(1-.07*Math.min(1,stain));
      } else if(spec.kind==='curb') {
        // Faded safety paint: rust-red and cream blocks, scuffed at the edges.
        const block=y<SIZE/2?0:1, scuff=.75+.25*noise(x,y,9,spec.seed+5)+.15*Math.max(0,fleck);
        if(block===0) { r=176*scuff*(chips>1?1.1:1); g=62*scuff; b=46*scuff; }
        else { r=214*scuff*chips; g=204*scuff*chips; b=182*scuff*chips; }
        if(y<2||Math.abs(y-SIZE/2)<2) { r*=.55; g*=.55; b*=.55; }
      }
      raw[i]=Math.max(0,Math.min(255,Math.round(r)));
      raw[i+1]=Math.max(0,Math.min(255,Math.round(g)));
      raw[i+2]=Math.max(0,Math.min(255,Math.round(b)));
      raw[i+3]=255;
    }
  }
  const ihdr=Buffer.alloc(13); ihdr.writeUInt32BE(SIZE,0); ihdr.writeUInt32BE(SIZE,4); ihdr[8]=8; ihdr[9]=6;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ihdr),chunk('IDAT',deflateSync(raw,{level:9})),chunk('IEND',new Uint8Array())]);
}

/** Byte-for-byte reproducible, tileable original texture maps for the Harbor Works source. */
export async function writeProceduralTextures():Promise<readonly string[]> {
  const sourceDir=resolve(ROOT,'assets-source/textures'),runtimeDir=resolve(ROOT,'public/assets/materials');
  await Promise.all([mkdir(sourceDir,{recursive:true}),mkdir(runtimeDir,{recursive:true})]);
  const paths:string[]=[];
  for(const spec of specs) {
    const bytes=makePng(spec),name=`${spec.name}.png`;
    await writeFile(resolve(sourceDir,name),bytes); await writeFile(resolve(runtimeDir,name),bytes);
    paths.push(`public/assets/materials/${name}`);
  }
  return paths;
}
