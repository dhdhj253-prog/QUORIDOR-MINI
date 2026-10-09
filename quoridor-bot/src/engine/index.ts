import { engineFactory } from './engine.js';
export const Engine = engineFactory(70);
export type EngineGame = {blocked: Uint8Array; pos: number[]; walls: number[]; turn?: number; fl?: number; fh?: number; h1?: number; h2?: number};
export function toEngineState(s:{blocked:number[];pos:[number,number];walls:[number,number];turn:number}):EngineGame { return {blocked:Uint8Array.from(s.blocked),pos:[...s.pos],walls:[...s.walls],turn:s.turn}; }
export function fromEngineState(g:EngineGame){return {blocked:Array.from(g.blocked),pos:[g.pos[0],g.pos[1]] as [number,number],walls:[g.walls[0],g.walls[1]] as [number,number]};}
export function cellName(c:number){return 'abcdefgh'[c&7]+String((c>>3)+1)}
