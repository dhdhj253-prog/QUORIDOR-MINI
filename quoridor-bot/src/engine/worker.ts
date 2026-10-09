import { parentPort } from 'node:worker_threads';
import { Engine } from './index.js';
parentPort!.on('message', ({id,g,who,ms,seen})=>{
  try { const r=Engine.think({blocked:Uint8Array.from(g.blocked),pos:[...g.pos],walls:[...g.walls]},who,ms,undefined,seen); parentPort!.postMessage({id,ok:true,result:r}); }
  catch(e){ parentPort!.postMessage({id,ok:false,error:String(e)}); }
});
