import { Worker } from 'node:worker_threads';
import { cpus } from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

type Job={id:string,g:any,who:number,ms:number,seen:number[],resolve:(x:any)=>void,reject:(e:any)=>void};
export class EnginePool {
  private workers: {w:Worker,busy:boolean}[]=[]; private queue:Job[]=[]; private pending=new Map<string,Job>();
  constructor(n=Math.min(4,Math.max(2,Number(process.env.WORKER_POOL_SIZE)||cpus().length>4?3:2))){
    const here=dirname(fileURLToPath(import.meta.url)); const file=join(here,'../engine/worker.js');
    for(let i=0;i<n;i++){const w=new Worker(file);const slot={w,busy:false};w.on('message',(m: any)=>{const j=this.pending.get(m.id);if(!j)return;this.pending.delete(m.id);slot.busy=false;m.ok?j.resolve(m.result):j.reject(new Error(m.error));this.pump()});w.on('error',(e: any)=>{for(const [id,j] of this.pending){if(this.workers.find(x=>x.w===w)){this.pending.delete(id);slot.busy=false;j.reject(e)}}this.pump()});this.workers.push(slot)}
  }
  private pump(){for(const s of this.workers){if(s.busy)continue;const j=this.queue.shift();if(!j)break;s.busy=true;this.pending.set(j.id,j);s.w.postMessage({id:j.id,g:j.g,who:j.who,ms:j.ms,seen:j.seen})}}
  think(g:any,who:number,ms:number,seen:number[]=[]){return new Promise<any>((resolve,reject)=>{this.queue.push({id:randomUUID(),g,who,ms,seen,resolve,reject});this.pump()})}
  async close(){await Promise.all(this.workers.map(x=>x.w.terminate()))}
}
