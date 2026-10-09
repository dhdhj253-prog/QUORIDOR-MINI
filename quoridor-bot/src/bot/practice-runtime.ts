import type { Context } from 'grammy';
import { Engine, toEngineState } from '../engine/index.js';
import { enginePool } from '../index.js';
import { getGame, commitMove, userNames } from '../db/index.js';
import { boardKeyboard, gameText } from './ui.js';
import type { Player, State, Move } from '../types.js';

export const PRACTICE_DIFFICULTY = { thinkMs: 120, depthCap: 8 } as const;

export async function botMovePractice(g: any, ctx: Context) {
  const who = 1 as Player;
  await new Promise(r => setTimeout(r, 380));
  const r = await enginePool.think(toEngineState(g.state), who, PRACTICE_DIFFICULTY.thinkMs, []);
  let m = r.m as Move;

  const e = toEngineState(g.state);
  if (!m || m.t === 'p') {
    const pm = Engine.pawnMoves(e, who);
    if (pm.length) m = { t: 'm', to: pm[0], pv: g.state.pos[who] };
    else {
      for (let c = 0; c < 64; c++) {
        if (Engine.wallLegal(e, c, who)) {
          m = { t: 'w', c };
          break;
        }
      }
    }
  }

  if (!m) return;
  const s = g.state;
  const ns: State = {
    ...s,
    blocked: [...s.blocked],
    pos: [...s.pos] as [number, number],
    walls: [...s.walls] as [number, number],
    ply: s.ply + 1,
    turn: 0,
    lastMove: m.t === 'm' ? { from: m.pv, to: m.to } : { wall: (m as any).c }
  };
  const ee = toEngineState(ns);
  Engine.apply(ee, who, m as any);
  ns.blocked = Array.from(ee.blocked);
  ns.pos = [ee.pos[0], ee.pos[1]];
  ns.walls = [ee.walls[0], ee.walls[1]];
  if (m.t === 'm' && (m.to >> 3) === 7) ns.over = 1;

  const ng = await commitMove(g.id, -1, g.version, ns, m, ns.over >= 0 ? 'finished' : 'active', ns.over >= 0 ? 1 : null);
  if (ctx.chat && ctx.msg) {
    await ctx.api.editMessageText(ctx.chat.id, ctx.msg.message_id, gameText(ng), {
      parse_mode: 'HTML',
      reply_markup: boardKeyboard(ng, 'move', Number(ng.p1_id))
    }).catch(() => {});
  }
}

