import test from 'node:test';import assert from 'node:assert/strict';import {Engine} from '../src/engine/index.js';
function g() { return { blocked: new Uint8Array(64), pos: [60, 3], walls: [8, 8] }; }
function block(x: any, ...cells: number[]) { for (const c of cells) x.blocked[c] = 1; }

test('starts e8 and d1 with eight walls',()=>{const x=g();assert.deepEqual(x.pos,[60,3]);assert.deepEqual(x.walls,[8,8])});
test('straight jump',()=>{const x=g();x.pos=[12,20];const m=Engine.pawnMoves(x,0);assert.ok(m.includes(28));});
test('bypass upward-facing direction',()=>{const x=g();x.pos=[20,28];x.blocked[36]=1;const m=Engine.pawnMoves(x,0);assert.ok(m.includes(27)||m.includes(29));});
test('bypass downward-facing direction',()=>{const x=g();x.pos=[28,20];x.blocked[12]=1;const m=Engine.pawnMoves(x,0);assert.ok(m.includes(19)||m.includes(21));});
test('bypass left-facing direction',()=>{const x=g();x.pos=[10,11];x.blocked[12]=1;const m=Engine.pawnMoves(x,0);assert.ok(m.includes(3)||m.includes(19));});
test('bypass right-facing direction',()=>{const x=g();x.pos=[11,10];x.blocked[8]=1;const m=Engine.pawnMoves(x,0);assert.ok(m.includes(3)||m.includes(19));});
test('edge bypass disallowed on winning goal edge but allowed on side edges',()=>{const x=g();x.pos=[60,52];const mBot=Engine.pawnMoves(x,1);assert.ok(!mBot.includes(59)&&!mBot.includes(61));x.pos=[25,24];const mSide=Engine.pawnMoves(x,0);assert.ok(mSide.includes(16)&&mSide.includes(32));});
test('wall on pawn is illegal',()=>{const x=g();assert.equal(Engine.wallLegal(x,60,0),false);assert.equal(Engine.wallLegal(x,3,0),false)});
test('wall-sealing check',()=>{const x=g();for(let c=0;c<8;c++)x.blocked[c]=1;assert.equal(Engine.wallLegal(x,10,0),false)});
test('pass is represented when no generated move exists',()=>{const x=g();x.walls=[0,0];for(let c=0;c<64;c++)x.blocked[c]=1;x.blocked[60]=0;x.blocked[3]=0;assert.equal(Engine.gen(x,0,8).some((m:any)=>m.t==='p'),true)});
