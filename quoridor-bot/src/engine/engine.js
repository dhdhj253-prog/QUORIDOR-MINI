function engineFactory(WW0){
const WW=WW0||40;
const N=8,S=64,WIN=100000,GOAL=[0,7],TO={};
const ADJ=[],GC=[[],[]];
for(let c=0;c<S;c++){const r=c>>3,k=c&7,a=[];[[-1,0],[1,0],[0,-1],[0,1]].forEach(([dr,dc])=>{const R=r+dr,K=k+dc;if(R>=0&&R<N&&K>=0&&K<N)a.push(R*N+K)});ADJ.push(a);if(r===0)GC[0].push(c);if(r===7)GC[1].push(c)}
function bfs(g,src,d){
  d = d || new Int8Array(S);
  d.fill(99);
  const q = new Int8Array(S);
  let h=0,t=0;
  for(let i=0;i<src.length;i++){const s=src[i];if(!g.blocked[s]){d[s]=0;q[t++]=s}}
  while(h<t){const c=q[h++],nd=d[c]+1,a=ADJ[c];for(let i=0;i<a.length;i++){const n=a[i];if(!g.blocked[n]&&d[n]===99){d[n]=nd;q[t++]=n}}}
  return d;
}
function pawnMoves(g,who){
  const p=g.pos[who],o=g.pos[1-who],res=[];
  const pr=p>>3,pc=p&7;
  for(const n of ADJ[p]){
    if(g.blocked[n])continue;
    if(n!==o){res.push(n);continue;}
    const nr=n>>3,nc=n&7;
    const dr=nr-pr,dc=nc-pc;
    const jr=nr+dr,jc=nc+dc;
    const straightOnBoard=jr>=0&&jr<N&&jc>=0&&jc<N;
    if(straightOnBoard&&!g.blocked[jr*N+jc]){
      res.push(jr*N+jc);
    } else {
      // Straight jump is blocked by a wall OR the board edge.
      const candidates=[];
      if(dr!==0){
        if(nc-1>=0) candidates.push(nr*N+(nc-1));
        if(nc+1<N) candidates.push(nr*N+(nc+1));
      } else {
        if(nr-1>=0) candidates.push((nr-1)*N+nc);
        if(nr+1<N) candidates.push((nr+1)*N+nc);
      }
      for(const t of candidates){
        if(g.blocked[t]) continue;
        const tr=t>>3;
        // Edge bypass is disallowed ONLY if straight jump is off board AND destination is the winning goal baseline:
        if(!straightOnBoard && tr===GOAL[who]) continue;
        res.push(t);
      }
    }
  }
  return res;
}
function wallLegal(g,c,who){
  if(g.blocked[c]||c===g.pos[0]||c===g.pos[1]||g.walls[who]<1)return false;
  g.blocked[c]=1;
  try {
    const ok=bfs(g,GC[0])[g.pos[0]]<99&&bfs(g,GC[1])[g.pos[1]]<99;
    return ok;
  } finally {
    g.blocked[c]=0;
  }
}
/* fast bitboard distance: board is two 32-bit halves (rows 0-3 / rows 4-7); fl/fh = free-cell masks */
const CL=0x01010101,CH=0x80808080;
function dbit(row,from,fl,fh){let l=row===0?0xFF:0,h=row===7?0xFF000000:0;l&=fl;h&=fh;
const fb=from<32?1<<from:1<<(from-32),lo=from<32;
for(let d=0;d<64;d++){if(((lo?l:h)&fb)!==0)return d;
let nl=l|((l<<1)&~CL)|((l>>>1)&~CH)|(l<<8)|(l>>>8)|(h<<24),nh=h|((h<<1)&~CL)|((h>>>1)&~CH)|(h<<8)|(h>>>8)|(l>>>24);
nl&=fl;nh&=fh;if(nl===l&&nh===h)return 99;l=nl;h=nh}return 99}
/* zobrist hashing + transposition table */
let seed=123456789;
function rnd(){seed=seed+0x6D2B79F5|0;let t=Math.imul(seed^seed>>>15,1|seed);t=t+Math.imul(t^t>>>7,61|t)^t;return(t^t>>>14)>>>0}
const M21=0x1FFFFF,ZB1=[],ZB2=[],ZP1=[[],[]],ZP2=[[],[]],ZW1=[[],[]],ZW2=[[],[]];
for(let c=0;c<S;c++){ZB1[c]=rnd();ZB2[c]=rnd()&M21;for(let w=0;w<2;w++){ZP1[w][c]=rnd();ZP2[w][c]=rnd()&M21}}
for(let w=0;w<2;w++)for(let k=0;k<=10;k++){ZW1[w][k]=rnd();ZW2[w][k]=rnd()&M21}
const ZT1=rnd(),ZT2=rnd()&M21;
function hashOf(g){let h1=0,h2=0,fl=-1,fh=-1;for(let c=0;c<S;c++)if(g.blocked[c]){h1^=ZB1[c];h2^=ZB2[c];if(c<32)fl&=~(1<<c);else fh&=~(1<<(c-32))}g.fl=fl;g.fh=fh;
for(let w=0;w<2;w++){h1^=ZP1[w][g.pos[w]]^ZW1[w][g.walls[w]];h2^=ZP2[w][g.pos[w]]^ZW2[w][g.walls[w]]}g.h1=h1;g.h2=h2}
const TB=1<<20,TM=TB-1;let tChk,tDep,tFlag,tVal,tMov;
function ttInit(){if(tChk)return;tChk=new Int32Array(TB);tDep=new Int8Array(TB).fill(-1);tFlag=new Int8Array(TB);tVal=new Int32Array(TB);tMov=new Int16Array(TB)}
function apply(g,who,m){
if(m.t==='m'){m.pv=g.pos[who];g.h1^=ZP1[who][m.pv]^ZP1[who][m.to];g.h2^=ZP2[who][m.pv]^ZP2[who][m.to];g.pos[who]=m.to}
else if(m.t==='w'){const w=g.walls[who];g.h1^=ZB1[m.c]^ZW1[who][w]^ZW1[who][w-1];g.h2^=ZB2[m.c]^ZW2[who][w]^ZW2[who][w-1];g.blocked[m.c]=1;if(m.c<32)g.fl&=~(1<<m.c);else g.fh&=~(1<<(m.c-32));g.walls[who]=w-1}}
function undo(g,who,m){
if(m.t==='m'){g.h1^=ZP1[who][m.pv]^ZP1[who][m.to];g.h2^=ZP2[who][m.pv]^ZP2[who][m.to];g.pos[who]=m.pv}
else if(m.t==='w'){const w=g.walls[who];g.h1^=ZB1[m.c]^ZW1[who][w]^ZW1[who][w+1];g.h2^=ZB2[m.c]^ZW2[who][w]^ZW2[who][w+1];g.blocked[m.c]=0;if(m.c<32)g.fl|=1<<m.c;else g.fh|=1<<(m.c-32);g.walls[who]=w+1}}
function keyOf(g){const t={blocked:g.blocked,pos:g.pos,walls:g.walls};hashOf(t);return(t.h1^(g.turn===1?ZT1:0))>>>0}
const enc=m=>m.t==='m'?m.to:m.t==='w'?64+m.c:128;
/* move generation: pawn steps + walls that really lengthen the opponent's route without hurting us more */
function gen(g,who,K,pm){
  const o=1-who;pm=pm||pawnMoves(g,who);const fw=bfs(g,GC[who]),myD=fw[g.pos[who]],ms=[];
  for(const t of pm){
    const tr=t>>3,pr=g.pos[who]>>3;
    const rowProgress=who===1?(tr-pr):(pr-tr);
    const distDelta=myD-fw[t];
    ms.push({t:'m',to:t,s:25*distDelta+6*rowProgress});
  }
  if(g.walls[who]>0){
    const fo=bfs(g,GC[o]),D=fo[g.pos[o]],ds=bfs(g,[g.pos[o]]),dm=bfs(g,[g.pos[who]]),ws=[];
    for(let c=0;c<S;c++){
      if(g.blocked[c]||c===g.pos[0]||c===g.pos[1]||ds[c]+fo[c]!==D)continue;
      const fl=c<32?g.fl&~(1<<c):g.fl,fh=c>=32?g.fh&~(1<<(c-32)):g.fh;
      const a=dbit(GOAL[o],g.pos[o],fl,fh);let b=myD;
      if(a<99&&fw[c]+dm[c]===myD)b=dbit(GOAL[who],g.pos[who],fl,fh);
      if(a>=99||b>=99)continue;
      const gain=a-D,self=b-myD;if(gain>=1&&gain>self)ws.push({t:'w',c,s:10*(gain-self)+5});
    }
    ws.sort((x,y)=>y.s-x.s);for(let i=0;i<ws.length&&i<K;i++)ms.push(ws[i]);
  }
  ms.sort((x,y)=>y.s-x.s);if(!ms.length)ms.push({t:'p',s:0});return ms;
}
function ev(g,who){
  const o=1-who;
  const myD=dbit(GOAL[who],g.pos[who],g.fl,g.fh);
  const oppD=dbit(GOAL[o],g.pos[o],g.fl,g.fh);
  if(myD===0)return WIN-50;
  if(oppD===0)return -WIN+50;
  let val=100*(oppD-myD)+WW*(g.walls[who]-g.walls[o]);
  const myRow=g.pos[who]>>3;
  const advance=who===1?myRow:(7-myRow);
  val+=8*advance;
  return val+12;
}
let nodes=0;
function ab(g,who,d,a,b,ply,T){
  if((++nodes&255)===0&&Date.now()>T)throw TO;
  const pm=pawnMoves(g,who);for(let i=0;i<pm.length;i++)if((pm[i]>>3)===GOAL[who])return WIN-ply;
  if(d<=0)return ev(g,who);
  const k1=g.h1^(who?ZT1:0),k2=(g.h2^(who?ZT2:0))&M21,ix=(k1>>>0)&TM;let ttm=-1;
  if(tDep[ix]>=0&&tChk[ix]===k2){
    ttm=tMov[ix];
    if(tDep[ix]>=d){
      let v=tVal[ix];if(v>WIN-300)v-=ply;else if(v<-WIN+300)v+=ply;const f=tFlag[ix];
      if(f===0||(f===1&&v>=b)||(f===2&&v<=a))return v;
    }
  }
  const ms=gen(g,who,d>=3?10:d===2?6:4,pm);
  if(ttm>=0){const i=ms.findIndex(x=>enc(x)===ttm);if(i>0)ms.unshift(ms.splice(i,1)[0]);}
  const a0=a;let best=-Infinity,bm=ms[0];
  for(let i=0;i<ms.length;i++){
    const m=ms[i];apply(g,who,m);let v;
    if(i===0)v=-ab(g,1-who,d-1,-b,-a,ply+1,T);
    else{
      const r=(i>=4&&d>=3)?1:0;v=-ab(g,1-who,d-1-r,-a-1,-a,ply+1,T);
      if(v>a&&r)v=-ab(g,1-who,d-1,-a-1,-a,ply+1,T);
      if(v>a&&v<b)v=-ab(g,1-who,d-1,-b,-a,ply+1,T);
    }
    undo(g,who,m);
    if(v>best){best=v;bm=m;}if(v>a)a=v;if(a>=b)break;
  }
  let sv=best;if(sv>WIN-300)sv+=ply;else if(sv<-WIN+300)sv-=ply;
  if(tDep[ix]<0||tDep[ix]<=d||tChk[ix]!==k2){tChk[ix]=k2;tDep[ix]=d;tFlag[ix]=best<=a0?2:best>=b?1:0;tVal[ix]=sv;tMov[ix]=enc(bm);}
  return best;
}
function root(g,who,d,T,prev,seen){
  const ms=gen(g,who,20);
  if(prev){const i=ms.findIndex(x=>x.t===prev.t&&x.to===prev.to&&x.c===prev.c);if(i>0)ms.unshift(ms.splice(i,1)[0]);}
  let a=-Infinity,bm=ms[0];
  for(const m of ms){
    if(m.t==='m'&&(m.to>>3)===GOAL[who])return{m,v:WIN,completed:true};
    apply(g,who,m);let v=-ab(g,1-who,d-1,-Infinity,-a,1,T);
    if(seen&&Math.abs(v)<WIN-100){const n=seen.get((g.h1^(who===0?ZT1:0))>>>0);if(n)v-=50*n;}
    undo(g,who,m);
    if(v>a){a=v;bm=m;}
  }
  return{m:bm,v:a,completed:true};
}
function think(g0,who,ms,onDepth,seenArr,maxDepth){
  ttInit();const seen=new Map();if(seenArr)for(const k of seenArr)seen.set(k,(seen.get(k)||0)+1);
  const g={blocked:Uint8Array.from(g0.blocked),pos:g0.pos.slice(),walls:g0.walls.slice(),h1:0,h2:0};hashOf(g);
  const T=Date.now()+ms;let best=null,dd=0,v=0;nodes=0;
  const limitDepth = maxDepth || 3;
  for(let d=1;d<=limitDepth;d++){
    try{
      const r=root(g,who,d,T,best,seen);
      if(r.completed){best=r.m;v=r.v;dd=d;if(onDepth)onDepth(d);if(Math.abs(v)>WIN-100)break;}
    }
    catch(e){if(e!==TO)throw e;break;}
  }
  if(!best){const fallback=gen(g,who,10);best=fallback[0];}
  return { m: best, d: dd, n: nodes, v };
}
return { think, pawnMoves, wallLegal, apply, undo, bfs, gen, hashOf, keyOf, GC, GOAL };
}

export { engineFactory };


