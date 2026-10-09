import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import type { State } from '../types.js';
import { cellName } from '../engine/index.js';

export class RenderQueue {
 private active=0; private q:(()=>Promise<void>)[]=[]; constructor(private concurrency=1){}
 add(job:()=>Promise<void>){this.q.push(job);this.pump()}
 private pump(){while(this.active<this.concurrency&&this.q.length){const j=this.q.shift()!;this.active++;j().catch(()=>{}).finally(()=>{this.active--;this.pump()})}}
}

function svgFor(s:State){const size=720, pad=24, cell=84;let out=`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><rect width="100%" height="100%" fill="#f3efe6"/><rect x="${pad}" y="${pad}" width="672" height="672" rx="18" fill="#fff9ee"/>`;
 for(let c=0;c<64;c++){const x=pad+(c%8)*cell,y=pad+Math.floor(c/8)*cell;out+=`<rect x="${x+3}" y="${y+3}" width="78" height="78" rx="10" fill="${s.blocked[c]?'#1d2530':'#e6dcc6'}"/>`;if(s.pos[0]===c)out+=`<circle cx="${x+42}" cy="${y+42}" r="25" fill="#2563eb"/>`;if(s.pos[1]===c)out+=`<circle cx="${x+42}" cy="${y+42}" r="25" fill="#dc2626"/>`}
 out+='</svg>';return out}
 export async function renderReplay(states:State[],outFile:string){const dir=join(process.cwd(),'replays-tmp');await mkdir(dir,{recursive:true});const frames:string[]=[];for(let i=0;i<states.length;i++){const f=join(dir,`frame-${Date.now()}-${i}.png`);await sharp(Buffer.from(svgFor(states[i]))).png().toFile(f);frames.push(f)}
 // FFmpeg is intentionally invoked by the caller/container, because it is an OS dependency.
 // This function leaves numbered PNG frames; the render worker assembles them.
 await writeFile(outFile+'.frames.json',JSON.stringify(frames)); return frames;
 }
