import pg from 'pg';
import { randomUUID } from 'node:crypto';
import type { GameRow, State, Player, Move, UserRow } from '../types.js';
import { calculateEloDelta } from '../engine/elo.js';

let PoolClass = pg.Pool;
if (!process.env.DATABASE_URL) {
  try {
    const { newDb } = await import('pg-mem');
    const memDb = newDb();
    PoolClass = memDb.adapters.createPg().Pool as any;
  } catch {}
}

export const pool = new PoolClass(process.env.DATABASE_URL ? { connectionString: process.env.DATABASE_URL } : {});

export async function migrate() {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const migrationsDir = new URL('../../migrations/', import.meta.url);
  const files = (await fs.readdir(migrationsDir)).filter(f => f.endsWith('.sql')).sort();

  for (const file of files) {
    const sql = await fs.readFile(new URL(`../../migrations/${file}`, import.meta.url), 'utf8');
    await pool.query(sql);
  }
}

export async function getUser(tgId: number): Promise<UserRow | null> {
  const q = await pool.query<UserRow>('SELECT * FROM users WHERE tg_id=$1', [tgId]);
  return q.rows[0] ?? null;
}

export async function isUserRegistered(tgId: number): Promise<boolean> {
  const q = await pool.query<{ is_registered: boolean }>('SELECT is_registered FROM users WHERE tg_id=$1', [tgId]);
  return Boolean(q.rows[0]?.is_registered);
}

export async function upsertUser(u: { id: number; name: string; username?: string; is_registered?: boolean }) {
  const isReg = u.is_registered === true;
  await pool.query(
    `INSERT INTO users(tg_id, name, username, is_registered, elo, peak_elo, wins, losses, current_streak, best_streak)
     VALUES($1, $2, $3, $4, 1000, 1000, 0, 0, 0, 0)
     ON CONFLICT(tg_id) DO UPDATE SET
       name = EXCLUDED.name,
       username = COALESCE(EXCLUDED.username, users.username),
       is_registered = CASE WHEN $4 = true THEN true ELSE users.is_registered END`,
    [u.id, u.name, u.username ?? null, isReg]
  );
}

export function initialState(first: Player = 0): State {
  return { blocked: Array(64).fill(0), pos: [60, 3], walls: [8, 8], turn: first, over: -1, ply: 0 };
}

export async function createGame(p1: number, opts: { chatType: string; inlineMessageId?: string | null; vsBot?: boolean; difficulty?: string; first?: Player }) {
  await upsertUser({ id: p1, name: 'Player' });
  const id = randomUUID();
  const state = initialState(opts.first ?? 0);
  const q = await pool.query<GameRow>(
    `INSERT INTO games(id, inline_message_id, chat_type, p1_id, vs_bot, difficulty, state, status, started_at, last_move_at)
     VALUES($1, $2, $3, $4, $5, $6, $7, 'pending', NULL, NULL) RETURNING *`,
    [id, opts.inlineMessageId ?? null, opts.chatType, p1, opts.vsBot ?? false, opts.difficulty ?? null, JSON.stringify(state)]
  );
  return q.rows[0];
}

export async function userNames(ids: number[]) {
  const q = await pool.query('SELECT tg_id, name, username, elo FROM users WHERE tg_id=ANY($1::bigint[])', [ids]);
  return new Map(q.rows.map(r => [String(r.tg_id), r.name || r.username || 'Player']));
}

export async function createPracticeGame(p1: number, p1Name: string = 'You') {
  const botId = -1;
  await upsertUser({ id: botId, name: 'Quoridor Bot' });
  await upsertUser({ id: p1, name: p1Name });
  return createGame(p1, { chatType: 'private', vsBot: true, difficulty: 'mid', first: 0 }).then(async g => {
    const c = await pool.query<GameRow>(
      `UPDATE games SET p2_id=$2, status='active', started_at=now(), last_move_at=now(), state=$3 WHERE id=$1 RETURNING *`,
      [g.id, botId, JSON.stringify({ ...g.state, blue_id: p1, first: 0, p1_name: p1Name, p2_name: 'Bot' })]
    );
    return c.rows[0];
  });
}

export async function getGame(id: string) {
  const q = await pool.query<GameRow>('SELECT * FROM games WHERE id=$1', [id]);
  return q.rows[0] ?? null;
}

export async function getGameByInlineMessage(inlineId: string) {
  const q = await pool.query<GameRow>('SELECT * FROM games WHERE inline_message_id=$1', [inlineId]);
  return q.rows[0] ?? null;
}

export async function setInlineMessage(id: string, inlineId: string) {
  await pool.query('UPDATE games SET inline_message_id=$2 WHERE id=$1', [id, inlineId]);
}

export async function claimPlayer1(id: string, player1Id: number, player1Name: string) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const q = await c.query<GameRow>('SELECT * FROM games WHERE id=$1 FOR UPDATE', [id]);
    let g = q.rows[0];
    if (!g) {
      const state = { ...initialState(0), p1_name: player1Name };
      const q2 = await c.query<GameRow>(
        `INSERT INTO games(id, chat_type, status, vs_bot, p1_id, state)
         VALUES($1, 'inline', 'pending', false, $2, $3)
         RETURNING *`,
        [id, player1Id, JSON.stringify(state)]
      );
      await c.query('COMMIT');
      return q2.rows[0];
    }
    if (g.status !== 'pending') throw new Error('GAME_STARTED');
    if (g.p1_id && Number(g.p1_id) === player1Id) {
      await c.query('COMMIT');
      return g;
    }
    if (g.p1_id && Number(g.p1_id) !== player1Id) {
      throw new Error('P1_ALREADY_CLAIMED');
    }
    const state = { ...(g.state || initialState(0)), p1_name: player1Name };
    const r = await c.query<GameRow>(
      `UPDATE games SET p1_id=$2, state=$3 WHERE id=$1 RETURNING *`,
      [id, player1Id, JSON.stringify(state)]
    );
    await c.query('COMMIT');
    return r.rows[0];
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}

export async function joinGame(id: string, opponent: number, opponentName: string = 'Player 2') {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const q = await c.query<GameRow>('SELECT * FROM games WHERE id=$1 FOR UPDATE', [id]);
    const g = q.rows[0];
    if (!g) throw new Error('GAME_NOT_FOUND');
    if (g.status !== 'pending' || g.p2_id) throw new Error('GAME_STARTED');
    if (Number(g.p1_id) === opponent) throw new Error('CREATOR_CANNOT_JOIN');
    const state = { ...(g.state || initialState(0)), p2_name: opponentName };
    const r = await c.query<GameRow>(
      `UPDATE games SET p2_id=$2, status='active', started_at=now(), last_move_at=now(), state=$3, version=version+1 WHERE id=$1 AND p2_id IS NULL RETURNING *`,
      [id, opponent, JSON.stringify(state)]
    );
    if (!r.rows[0]) throw new Error('ALREADY_JOINED');
    await c.query('COMMIT');
    return r.rows[0];
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}

export async function setFirst(id: string, requester: number, blueId: number, first: Player) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const q = await c.query<GameRow>('SELECT * FROM games WHERE id=$1 FOR UPDATE', [id]);
    const g = q.rows[0];
    if (!g || Number(g.p1_id) !== requester || !g.p2_id) throw new Error('NOT_CREATOR');
    if (g.status !== 'active') throw new Error('NOT_ACTIVE');
    const st = { ...g.state, pos: [60, 3] as [number, number], turn: first, over: -1, ply: 0, blocked: Array(64).fill(0), walls: [8, 8] as [number, number] };
    const r = await c.query<GameRow>(`UPDATE games SET state=$2, version=version+1, last_move_at=now() WHERE id=$1 RETURNING *`, [id, JSON.stringify(st)]);
    await c.query('COMMIT');
    return r.rows[0];
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}

async function processEloUpdateInternal(c: pg.PoolClient, gameId: string, g: GameRow, winnerTgId: number, state: State) {
  if (g.vs_bot || !g.p1_id || !g.p2_id) return { eloP1Before: null, eloP1After: null, eloP2Before: null, eloP2After: null };

  const p1Id = Number(g.p1_id);
  const p2Id = Number(g.p2_id);
  if (p1Id <= 0 || p2Id <= 0) return { eloP1Before: null, eloP1After: null, eloP2Before: null, eloP2After: null };

  const isP1Winner = winnerTgId === p1Id;
  const winnerId = isP1Winner ? p1Id : p2Id;
  const loserId = isP1Winner ? p2Id : p1Id;

  const wUserQ = await c.query<UserRow>('SELECT * FROM users WHERE tg_id=$1 FOR UPDATE', [winnerId]);
  const lUserQ = await c.query<UserRow>('SELECT * FROM users WHERE tg_id=$1 FOR UPDATE', [loserId]);

  const wUser = wUserQ.rows[0] || { elo: 1200, peak_elo: 1200, wins: 0, losses: 0, current_streak: 0, best_streak: 0 };
  const lUser = lUserQ.rows[0] || { elo: 1200, peak_elo: 1200, wins: 0, losses: 0, current_streak: 0, best_streak: 0 };

  const { winnerGain, loserLoss } = calculateEloDelta(
    wUser.elo,
    lUser.elo,
    (wUser.wins || 0) + (wUser.losses || 0),
    (lUser.wins || 0) + (lUser.losses || 0)
  );

  const newWinnerElo = wUser.elo + winnerGain;
  const newWinnerPeak = Math.max(wUser.peak_elo || 1200, newWinnerElo);
  const newWinnerStreak = (wUser.current_streak || 0) + 1;
  const newWinnerBestStreak = Math.max(wUser.best_streak || 0, newWinnerStreak);

  const newLoserElo = Math.max(400, lUser.elo - loserLoss);

  await c.query(
    `UPDATE users SET elo=$2, peak_elo=$3, wins=wins+1, current_streak=$4, best_streak=$5 WHERE tg_id=$1`,
    [winnerId, newWinnerElo, newWinnerPeak, newWinnerStreak, newWinnerBestStreak]
  );

  await c.query(
    `UPDATE users SET elo=$2, losses=losses+1, current_streak=0 WHERE tg_id=$1`,
    [loserId, newLoserElo]
  );

  const p1Before = isP1Winner ? wUser.elo : lUser.elo;
  const p1After = isP1Winner ? newWinnerElo : newLoserElo;
  const p1Delta = isP1Winner ? winnerGain : -loserLoss;

  const p2Before = isP1Winner ? lUser.elo : wUser.elo;
  const p2After = isP1Winner ? newLoserElo : newWinnerElo;
  const p2Delta = isP1Winner ? -loserLoss : winnerGain;

  state.eloUpdate = {
    p1Before,
    p1After,
    p1Delta,
    p2Before,
    p2After,
    p2Delta,
    p1Streak: isP1Winner ? newWinnerStreak : 0,
    p2Streak: isP1Winner ? 0 : newWinnerStreak
  };

  return { eloP1Before: p1Before, eloP1After: p1After, eloP2Before: p2Before, eloP2After: p2After };
}

export type MoveIntent = 
  | { type: 'move'; dir?: string; targetCell?: number }
  | { type: 'wall'; cell: number };

export type ExecuteMoveResult =
  | { ok: true; game: GameRow; move: Move; message: string }
  | { ok: false; error: string; alert?: boolean };

export async function executeMove(
  gameId: string,
  actorId: number,
  intent: MoveIntent,
  botThinkFn?: (state: any, who: number, ms: number) => Promise<any>
): Promise<ExecuteMoveResult> {
  const { Engine, toEngineState } = await import('../engine/index.js');
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const q = await c.query<GameRow>('SELECT * FROM games WHERE id=$1 FOR UPDATE', [gameId]);
    const g = q.rows[0];
    if (!g) {
      await c.query('ROLLBACK');
      return { ok: false, error: 'Match not found or expired.' };
    }
    if (g.status !== 'active') {
      await c.query('ROLLBACK');
      return { ok: false, error: 'Match is no longer active.' };
    }

    const p1Id = Number(g.p1_id);
    const p2Id = Number(g.p2_id);
    if (actorId !== p1Id && actorId !== p2Id) {
      await c.query('ROLLBACK');
      return { ok: false, error: '👁 You are spectating this match.', alert: true };
    }

    const s = g.state;
    const who: Player = actorId === p1Id ? 0 : 1;
    if (s.turn !== who) {
      const activeName = s.turn === 0 ? (s.p1_name || 'Player 1') : (s.p2_name || (g.vs_bot ? 'Bot' : 'Player 2'));
      await c.query('ROLLBACK');
      return { ok: false, error: `⏳ It's ${activeName}'s turn! Please wait for them to move.`, alert: true };
    }

    const e = toEngineState(s);
    let m: Move;

    if (intent.type === 'move') {
      let targetCell = intent.targetCell;
      if (targetCell == null && intent.dir) {
        const validMoves = Engine.pawnMoves(e, who);
        const pr = s.pos[who] >> 3;
        const pc = s.pos[who] & 7;
        const dir = intent.dir;

        for (const cell of validMoves) {
          const tr = cell >> 3;
          const tc = cell & 7;
          if (dir === 'up' && tr > pr && tc === pc) targetCell = cell;
          else if (dir === 'down' && tr < pr && tc === pc) targetCell = cell;
          else if (dir === 'left' && tr === pr && tc < pc) targetCell = cell;
          else if (dir === 'right' && tr === pr && tc > pc) targetCell = cell;
          else if (dir === 'upleft' && tr > pr && tc < pc) targetCell = cell;
          else if (dir === 'upright' && tr > pr && tc > pc) targetCell = cell;
          else if (dir === 'downleft' && tr < pr && tc < pc) targetCell = cell;
          else if (dir === 'downright' && tr < pr && tc > pc) targetCell = cell;
        }
      }

      if (targetCell == null) {
        await c.query('ROLLBACK');
        return { ok: false, error: '🚫 Blocked! You cannot move in that direction.' };
      }

      const validMoves = Engine.pawnMoves(e, who);
      if (!validMoves.includes(targetCell)) {
        await c.query('ROLLBACK');
        return { ok: false, error: 'Illegal move direction.' };
      }

      m = { t: 'm', to: targetCell, pv: s.pos[who] };
    } else {
      const cell = intent.cell;
      if (s.blocked[cell]) {
        await c.query('ROLLBACK');
        return { ok: false, error: '🧱 A wall is already placed here.' };
      }
      if (cell === s.pos[0] || cell === s.pos[1]) {
        await c.query('ROLLBACK');
        return { ok: false, error: '⚠️ Cannot place wall on a pawn. Move using the arrow buttons below.' };
      }
      if (s.walls[who] <= 0) {
        await c.query('ROLLBACK');
        return { ok: false, error: '🧱 You have 0 walls remaining!', alert: true };
      }
      if (!Engine.wallLegal(e, cell, who)) {
        await c.query('ROLLBACK');
        return { ok: false, error: '⚠️ Cannot place wall here: path would be completely blocked!' };
      }

      m = { t: 'w', c: cell };
    }

    const ns: State = {
      ...s,
      blocked: [...s.blocked],
      pos: [...s.pos] as [number, number],
      walls: [...s.walls] as [number, number],
      ply: s.ply + 1,
      turn: (1 - who) as Player,
      lastMove: m.t === 'm' ? { from: m.pv, to: m.to } : { wall: m.c },
      modeByPlayer: { ...s.modeByPlayer, [String(actorId)]: 'move' }
    };
    const eg = toEngineState(ns);
    Engine.apply(eg, who, m as any);
    ns.blocked = Array.from(eg.blocked);
    ns.pos = [eg.pos[0], eg.pos[1]];
    ns.walls = [eg.walls[0], eg.walls[1]];

    if (m.t === 'm' && (m.to >> 3) === (who === 0 ? 0 : 7)) ns.over = who;
    if (ns.over < 0 && Engine.pawnMoves(eg, (1 - who) as Player).length === 0 && ns.walls[1 - who] === 0) ns.turn = who;

    let botMoveObj: Move | null = null;
    if (g.vs_bot && ns.over < 0) {
      let bm: Move | null = null;
      if (botThinkFn) {
        const thinkMs = Number(process.env.BOT_THINK_MS || 60);
        const result = await botThinkFn(toEngineState(ns), 1, thinkMs);
        bm = result?.m ?? null;
      }
      if (!bm || bm.t === 'p') {
        const e2 = toEngineState(ns);
        const pm = Engine.pawnMoves(e2, 1);
        if (pm.length) bm = { t: 'm', to: pm[0], pv: ns.pos[1] };
        else {
          for (let c = 0; c < 64; c++) {
            if (Engine.wallLegal(e2, c, 1)) {
              bm = { t: 'w', c };
              break;
            }
          }
        }
      }

      if (bm) {
        botMoveObj = bm;
        ns.ply += 1;
        ns.turn = 0;
        ns.lastMove = bm.t === 'm' ? { from: bm.pv, to: bm.to } : { wall: (bm as any).c };
        const e2 = toEngineState(ns);
        Engine.apply(e2, 1, bm as any);
        ns.blocked = Array.from(e2.blocked);
        ns.pos = [e2.pos[0], e2.pos[1]];
        ns.walls = [e2.walls[0], e2.walls[1]];
        if (bm.t === 'm' && (bm.to >> 3) === 7) ns.over = 1;
      }
    }

    const status = ns.over >= 0 ? 'finished' : 'active';
    const from = m.t === 'm' ? (m.pv ?? null) : null;
    const to = m.t === 'm' ? m.to : null;
    const wall = m.t === 'w' ? m.c : null;
    const humanPly = botMoveObj ? ns.ply - 1 : ns.ply;

    await c.query(`INSERT INTO moves(game_id,ply,who,type,from_cell,to_cell,wall_cell) VALUES($1,$2,$3,$4,$5,$6,$7)`, [gameId, humanPly, actorId, m.t, from, to, wall]);

    if (botMoveObj) {
      const bFrom = botMoveObj.t === 'm' ? (botMoveObj.pv ?? null) : null;
      const bTo = botMoveObj.t === 'm' ? botMoveObj.to : null;
      const bWall = botMoveObj.t === 'w' ? botMoveObj.c : null;
      const botId = Number(g.p2_id || -1);
      await c.query(`INSERT INTO moves(game_id,ply,who,type,from_cell,to_cell,wall_cell) VALUES($1,$2,$3,$4,$5,$6,$7)`, [gameId, ns.ply, botId, botMoveObj.t, bFrom, bTo, bWall]);
    }

    const winnerDb = ns.over === -1 ? null : (ns.over === 0 ? p1Id : p2Id);

    let eloInfo = { eloP1Before: null as number | null, eloP1After: null as number | null, eloP2Before: null as number | null, eloP2After: null as number | null };
    if (status === 'finished' && winnerDb !== null) {
      eloInfo = await processEloUpdateInternal(c, gameId, g, winnerDb, ns);
    }

    const r = await c.query<GameRow>(
      `UPDATE games SET
         state=$2, status=$3, winner=$4, version=version+1, last_move_at=now(),
         ended_at=CASE WHEN $3 IN ('finished','resigned','forfeit') THEN now() ELSE ended_at END,
         p1_elo_before=COALESCE($5, p1_elo_before),
         p1_elo_after=COALESCE($6, p1_elo_after),
         p2_elo_before=COALESCE($7, p2_elo_before),
         p2_elo_after=COALESCE($8, p2_elo_after)
       WHERE id=$1 RETURNING *`,
      [gameId, JSON.stringify(ns), status, winnerDb, eloInfo.eloP1Before, eloInfo.eloP1After, eloInfo.eloP2Before, eloInfo.eloP2After]
    );

    await c.query('COMMIT');
    if (status === 'finished' && p1Id && p2Id) {
      void pruneOldGames([p1Id, p2Id]).catch(() => {});
    }
    return {
      ok: true,
      game: r.rows[0],
      move: m,
      message: m.t === 'm' ? '🚶 Moved pawn' : '🧱 Placed wall'
    };
  } catch (e: any) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}

export async function commitMove(
  id: string,
  actor: number,
  expectedVersion: number | string,
  state: State,
  move: Move,
  status: string,
  winner: number | null,
  botMove?: Move | null
) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const q = await c.query<GameRow>('SELECT * FROM games WHERE id=$1 FOR UPDATE', [id]);
    const g = q.rows[0];
    if (!g || BigInt(g.version) !== BigInt(expectedVersion)) throw new Error('STALE');
    if (Number(g.p1_id) !== actor && Number(g.p2_id) !== actor) throw new Error('NOT_PLAYER');

    const from = move.t === 'm' ? (move.pv ?? null) : null;
    const to = move.t === 'm' ? move.to : null;
    const wall = move.t === 'w' ? move.c : null;
    const humanPly = botMove ? state.ply - 1 : state.ply;
    await c.query(`INSERT INTO moves(game_id,ply,who,type,from_cell,to_cell,wall_cell) VALUES($1,$2,$3,$4,$5,$6,$7)`, [id, humanPly, actor, move.t, from, to, wall]);

    if (botMove) {
      const bFrom = botMove.t === 'm' ? (botMove.pv ?? null) : null;
      const bTo = botMove.t === 'm' ? botMove.to : null;
      const bWall = botMove.t === 'w' ? botMove.c : null;
      const botId = Number(g.p2_id || -1);
      await c.query(`INSERT INTO moves(game_id,ply,who,type,from_cell,to_cell,wall_cell) VALUES($1,$2,$3,$4,$5,$6,$7)`, [id, state.ply, botId, botMove.t, bFrom, bTo, bWall]);
    }

    const winnerDb = winner === null ? null : (winner === 0 ? Number(g.p1_id) : Number(g.p2_id));

    let eloInfo = { eloP1Before: null as number | null, eloP1After: null as number | null, eloP2Before: null as number | null, eloP2After: null as number | null };
    if (status === 'finished' && winnerDb !== null) {
      eloInfo = await processEloUpdateInternal(c, id, g, winnerDb, state);
    }

    const r = await c.query<GameRow>(
      `UPDATE games SET
         state=$2, status=$3, winner=$4, version=version+1, last_move_at=now(),
         ended_at=CASE WHEN $3 IN ('finished','resigned','forfeit') THEN now() ELSE ended_at END,
         p1_elo_before=COALESCE($5, p1_elo_before),
         p1_elo_after=COALESCE($6, p1_elo_after),
         p2_elo_before=COALESCE($7, p2_elo_before),
         p2_elo_after=COALESCE($8, p2_elo_after)
       WHERE id=$1 RETURNING *`,
      [id, JSON.stringify(state), status, winnerDb, eloInfo.eloP1Before, eloInfo.eloP1After, eloInfo.eloP2Before, eloInfo.eloP2After]
    );

    if (!r.rows[0]) throw new Error('STALE');
    await c.query('COMMIT');
    if (status === 'finished' && g.p1_id && g.p2_id) {
      void pruneOldGames([Number(g.p1_id), Number(g.p2_id)]).catch(() => {});
    }
    return r.rows[0];
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}

export async function resign(id: string, actor: number) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const q = await c.query<GameRow>('SELECT * FROM games WHERE id=$1 FOR UPDATE', [id]);
    const g = q.rows[0];
    if (!g) throw new Error('GAME_NOT_FOUND');
    if (Number(g.p1_id) !== actor && Number(g.p2_id) !== actor) throw new Error('NOT_PLAYER');
    if (g.status !== 'active') throw new Error('NOT_ACTIVE');

    const winner = Number(g.p1_id) === actor ? Number(g.p2_id) : Number(g.p1_id);
    const state = { ...g.state, over: (winner === Number(g.p1_id) ? 0 : 1) as Player };

    const eloInfo = await processEloUpdateInternal(c, id, g, winner, state);

    const r = await c.query<GameRow>(
      `UPDATE games SET
         status='resigned', winner=$2, ended_at=now(), version=version+1, state=$3,
         p1_elo_before=COALESCE($4, p1_elo_before),
         p1_elo_after=COALESCE($5, p1_elo_after),
         p2_elo_before=COALESCE($6, p2_elo_before),
         p2_elo_after=COALESCE($7, p2_elo_after)
       WHERE id=$1 RETURNING *`,
      [id, winner, JSON.stringify(state), eloInfo.eloP1Before, eloInfo.eloP1After, eloInfo.eloP2Before, eloInfo.eloP2After]
    );
    await c.query('COMMIT');
    if (g.p1_id && g.p2_id) {
      void pruneOldGames([Number(g.p1_id), Number(g.p2_id)]).catch(() => {});
    }
    return r.rows[0];
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}

export async function forfeitExpiredGames() {
  const q = await pool.query<GameRow>(`SELECT * FROM games WHERE status='active' AND last_move_at < now()-interval '24 hours'`);
  for (const g of q.rows) {
    if (!g.p2_id) continue;
    const winner = Number(g.p1_id) === Number(g.state.turn === 0 ? g.p1_id : g.p2_id) ? (g.state.turn === 0 ? Number(g.p2_id) : Number(g.p1_id)) : (g.state.turn === 0 ? Number(g.p2_id) : Number(g.p1_id));
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const state = { ...g.state, over: (winner === Number(g.p1_id) ? 0 : 1) as Player };
      const eloInfo = await processEloUpdateInternal(c, g.id, g, winner, state);
      await c.query(
        `UPDATE games SET
           status='forfeit', winner=$2, ended_at=now(), version=version+1, state=$3,
           p1_elo_before=COALESCE($4, p1_elo_before),
           p1_elo_after=COALESCE($5, p1_elo_after),
           p2_elo_before=COALESCE($6, p2_elo_before),
           p2_elo_after=COALESCE($7, p2_elo_after)
         WHERE id=$1 AND status='active'`,
        [g.id, winner, JSON.stringify(state), eloInfo.eloP1Before, eloInfo.eloP1After, eloInfo.eloP2Before, eloInfo.eloP2After]
      );
      await c.query('COMMIT');
    } catch {
      await c.query('ROLLBACK');
    } finally {
      c.release();
    }
  }
}

export const MAX_RETAINED_GAMES_PER_USER = 10;

export async function pruneOldGames(userIds: number[], keepCount: number = MAX_RETAINED_GAMES_PER_USER) {
  for (const uid of userIds) {
    if (!uid || uid <= 0) continue;
    try {
      const keepQ = await pool.query<{ id: string }>(
        `SELECT id FROM games
         WHERE (p1_id=$1 OR p2_id=$1) AND status IN ('finished', 'resigned', 'forfeit')
         ORDER BY started_at DESC NULLS LAST, created_at DESC
         LIMIT $2`,
        [uid, keepCount]
      );
      const keepIds = keepQ.rows.map(r => r.id);
      if (keepIds.length > 0) {
        await pool.query(
          `DELETE FROM games
           WHERE (p1_id=$1 OR p2_id=$1)
             AND status IN ('finished', 'resigned', 'forfeit')
             AND NOT (id = ANY($2::uuid[]))`,
          [uid, keepIds]
        );
      }
    } catch {}
  }
}

export async function pruneAllOldGames(maxAgeDays: number = 7) {
  try {
    // Delete finished games older than maxAgeDays to keep DB ultra-light
    await pool.query(
      `DELETE FROM games WHERE status IN ('finished', 'resigned', 'forfeit') AND created_at < now() - make_interval(days => $1)`,
      [maxAgeDays]
    );
  } catch {}
}

export async function recentGames(userId: number, limit: number = 10, offset: number = 0) {
  const safeLimit = Math.min(limit, MAX_RETAINED_GAMES_PER_USER);
  const q = await pool.query<GameRow>(
    `SELECT * FROM games WHERE (p1_id=$1 OR p2_id=$1) AND status IN ('finished', 'resigned', 'forfeit', 'active')
     ORDER BY started_at DESC NULLS LAST, created_at DESC LIMIT $2 OFFSET $3`,
    [userId, safeLimit, offset]
  );
  return q.rows;
}

export async function countUserGames(userId: number): Promise<number> {
  const q = await pool.query<{ count: string }>(
    `SELECT COUNT(*) as count FROM games WHERE (p1_id=$1 OR p2_id=$1) AND status IN ('finished', 'resigned', 'forfeit')`,
    [userId]
  );
  return Math.min(Number(q.rows[0]?.count || 0), MAX_RETAINED_GAMES_PER_USER);
}

export async function getLeaderboard(limit: number = 10): Promise<UserRow[]> {
  const q = await pool.query<UserRow>(
    `SELECT * FROM users WHERE is_registered=true AND (wins > 0 OR losses > 0 OR elo != 1200)
     ORDER BY elo DESC, wins DESC LIMIT $1`,
    [limit]
  );
  return q.rows;
}

export async function getUserRank(userId: number): Promise<number> {
  const q = await pool.query<{ rank: string }>(
    `SELECT COUNT(*) + 1 as rank FROM users WHERE elo > (SELECT COALESCE(elo, 1200) FROM users WHERE tg_id=$1)`,
    [userId]
  );
  return Number(q.rows[0]?.rank || 1);
}

export async function gameMoves(id: string) {
  const q = await pool.query(`SELECT * FROM moves WHERE game_id=$1 ORDER BY ply`, [id]);
  return q.rows;
}

export async function cacheReplay(id: string, fileId: string) {
  await pool.query('UPDATE games SET replay_file_id=$2 WHERE id=$1', [id, fileId]);
}

