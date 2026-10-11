import type { IncomingMessage, ServerResponse } from 'node:http';
import crypto from 'node:crypto';
import { calculateServerElo } from './engine/elo.js';
import { chooseBotMove } from './engine/bot.js';

export interface RoomPlayer {
  id: string;
  tgId?: number;
  name: string;
  elo: number;
  photoUrl?: string;
  side: 'top' | 'bottom';
  firstName?: string;
  lastName?: string;
  username?: string;
}

export interface VerifiedTgUser {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  photo_url?: string;
}

export function verifyTelegramInitData(initData: string, botToken: string): VerifiedTgUser | null {
  if (!initData) {
    console.warn('[AUTH] verifyTelegramInitData: missing initData');
    return null;
  }
  if (!botToken) {
    console.warn('[AUTH] verifyTelegramInitData: missing botToken');
    return null;
  }
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) {
      console.warn('[AUTH] verifyTelegramInitData: missing hash in initData');
      return null;
    }

    params.delete('hash');
    const keys = Array.from(new Set(params.keys())).sort();
    const dataCheckString = keys.map(k => `${k}=${params.get(k)}`).join('\n');

    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
    const calculatedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

    if (calculatedHash.toLowerCase() !== hash.toLowerCase()) {
      console.warn('[AUTH] verifyTelegramInitData: hash mismatch!');
      console.warn(`[AUTH] Expected: ${calculatedHash}, Received: ${hash}`);
      console.warn(`[AUTH] dataCheckString:\n${dataCheckString}`);
      return null;
    }

    const authDateStr = params.get('auth_date');
    if (authDateStr) {
      const authDate = Number(authDateStr);
      const now = Math.floor(Date.now() / 1000);
      if (isNaN(authDate)) {
        console.warn(`[AUTH] verifyTelegramInitData: invalid auth_date "${authDateStr}"`);
      } else if (now - authDate > 86400 * 7) {
        console.warn(`[AUTH] verifyTelegramInitData: auth_date is older than 7 days (${now - authDate}s ago)`);
      }
    }

    const userStr = params.get('user');
    if (!userStr) {
      console.warn('[AUTH] verifyTelegramInitData: user parameter missing in initData');
      return null;
    }

    const user = JSON.parse(userStr);
    if (!user || !user.id) {
      console.warn('[AUTH] verifyTelegramInitData: parsed user has no id:', userStr);
      return null;
    }

    console.log(`[AUTH] verifyTelegramInitData SUCCESS for tg_${user.id} (${user.first_name} ${user.last_name || ''})`);
    return {
      id: Number(user.id),
      first_name: String(user.first_name || ''),
      last_name: user.last_name ? String(user.last_name) : undefined,
      username: user.username ? String(user.username) : undefined,
      photo_url: user.photo_url ? String(user.photo_url) : undefined
    };
  } catch (err: any) {
    console.warn(`[AUTH] verifyTelegramInitData error: ${err.message}`);
    return null;
  }
}

export function formatTelegramName(user: { first_name: string; last_name?: string; username?: string }): string {
  const parts = [user.first_name, user.last_name].filter(Boolean).map(s => String(s).trim()).filter(Boolean);
  if (parts.length > 0) {
    return parts.join(' ');
  }
  if (user.username) {
    return user.username.startsWith('@') ? user.username : `@${user.username}`;
  }
  return 'Player';
}

export const CANCEL_MAX_MOVES = 6;

export interface NotationRow {
  num: number;
  p1: string;
  p2?: string;
}

export function formatNotation(move: any): string {
  if (!move) return '';
  if (move.type === 'move' && typeof move.to === 'number') {
    const r = Math.floor(move.to / 8) + 1;
    const c = String.fromCharCode('a'.charCodeAt(0) + (move.to % 8));
    return `${c}${r}`;
  }
  if (move.type === 'wall' && typeof move.cell === 'number') {
    const r = Math.floor(move.cell / 8) + 1;
    const c = String.fromCharCode('a'.charCodeAt(0) + (move.cell % 8));
    return `W ${c}${r}`;
  }
  return '';
}

export function getRoomPositionKey(state: {
  pos: [number, number];
  blocked: number[] | Uint8Array;
  walls: [number, number];
  turn: number;
}): string {
  if (!state || !state.pos || !state.walls) return '';
  const p0 = state.pos[0];
  const p1 = state.pos[1];
  const blockedList: number[] = [];
  if (state.blocked) {
    for (let i = 0; i < 64; i++) {
      if (state.blocked[i]) {
        blockedList.push(i);
      }
    }
  }
  const blockedKey = blockedList.join(',');
  const wallsKey = `${state.walls[0]},${state.walls[1]}`;
  const turnKey = state.turn;
  return `${p0},${p1}|${blockedKey}|${wallsKey}|${turnKey}`;
}

export interface RoomState {
  id: string;
  version: number;
  rated: boolean;
  vs_bot?: boolean;
  canceled?: boolean;
  endReason?: 'goal' | 'resigned' | 'draw' | 'canceled' | 'repetition';
  resignedBy?: string;
  creatorSide?: 'top' | 'bottom';
  creator?: { id: string; name: string; username?: string; photoUrl?: string };
  topPlayer?: RoomPlayer;
  bottomPlayer?: RoomPlayer;
  gameState?: any;
  positionCounts?: Record<string, number>;
  moves: any[];
  notation?: NotationRow[];
  chat: any[];
  lastActive: number;
  rating_applied?: boolean;
  eloResult?: {
    topDelta: number;
    bottomDelta: number;
    topNewElo: number;
    bottomNewElo: number;
    rated: boolean;
  };
  drawOfferedBy?: string | null;
  drawRejectedMoveCount?: Record<string, number>;
  rematchOfferedBy?: string | null;
  presence?: RoomPresence;
}

export type PlayerPresenceStatus = 'waiting' | 'joined' | 'playing' | 'disconnected';

export interface RoomPresence {
  top: PlayerPresenceStatus;
  bottom: PlayerPresenceStatus;
  topDisconnectedAt?: number | null;
  bottomDisconnectedAt?: number | null;
}

interface PresenceTracker {
  lastHeartbeat: number;
  graceTimer: NodeJS.Timeout | null;
  disconnectedAt: number | null;
}

interface RoomConnectionInfo {
  connId: string;
  playerId?: string;
  tgId?: number;
  res: ServerResponse;
}

const rooms = new Map<string, RoomState>();
const sseClients = new Map<string, Set<ServerResponse>>();
const roomConnections = new Map<string, Map<string, RoomConnectionInfo>>();
const roomPresenceTrackers = new Map<string, {
  top: PresenceTracker;
  bottom: PresenceTracker;
}>();

export function countActiveConnectionsForPlayer(roomId: string, playerId?: string, tgId?: number): number {
  const conns = roomConnections.get(roomId);
  if (!conns) return 0;
  let count = 0;
  for (const c of conns.values()) {
    if (tgId && c.tgId === tgId) count++;
    else if (playerId && (c.playerId === playerId || (tgId && c.playerId === `tg_${tgId}`))) count++;
  }
  return count;
}

export function getRoomTrackers(roomId: string) {
  let trackers = roomPresenceTrackers.get(roomId);
  if (!trackers) {
    trackers = {
      top: { lastHeartbeat: 0, graceTimer: null, disconnectedAt: null },
      bottom: { lastHeartbeat: 0, graceTimer: null, disconnectedAt: null }
    };
    roomPresenceTrackers.set(roomId, trackers);
  }
  return trackers;
}

export function getPlayerSideInRoom(room: RoomState, playerId?: string, tgId?: number): 'top' | 'bottom' | null {
  const cleanPId = (playerId && playerId !== 'undefined' && playerId !== 'null') ? playerId : null;
  const cleanTg = (tgId && !isNaN(Number(tgId)) && Number(tgId) > 0 && Number(tgId) !== 12345678) ? Number(tgId) : null;

  if (room.topPlayer) {
    if (cleanTg && Number(room.topPlayer.tgId) === cleanTg) return 'top';
    if (cleanPId && (room.topPlayer.id === cleanPId || (cleanTg && room.topPlayer.id === `tg_${cleanTg}`))) return 'top';
    if (cleanPId && room.topPlayer.tgId && (cleanPId === `tg_${room.topPlayer.tgId}` || cleanPId === String(room.topPlayer.tgId))) return 'top';
  }
  if (room.bottomPlayer) {
    if (cleanTg && Number(room.bottomPlayer.tgId) === cleanTg) return 'bottom';
    if (cleanPId && (room.bottomPlayer.id === cleanPId || (cleanTg && room.bottomPlayer.id === `tg_${cleanTg}`))) return 'bottom';
    if (cleanPId && room.bottomPlayer.tgId && (cleanPId === `tg_${room.bottomPlayer.tgId}` || cleanPId === String(room.bottomPlayer.tgId))) return 'bottom';
  }
  return null;
}

export function computeRoomPresence(room: RoomState): RoomPresence {
  const trackers = getRoomTrackers(room.id);

  let topStatus: PlayerPresenceStatus;
  if (!room.topPlayer) {
    topStatus = 'waiting';
  } else if (trackers.top.disconnectedAt) {
    topStatus = 'disconnected';
  } else {
    topStatus = 'playing';
  }

  let bottomStatus: PlayerPresenceStatus;
  if (room.vs_bot) {
    bottomStatus = 'playing';
  } else if (!room.bottomPlayer) {
    bottomStatus = 'waiting';
  } else if (trackers.bottom.disconnectedAt) {
    bottomStatus = 'disconnected';
  } else {
    bottomStatus = 'playing';
  }

  return {
    top: topStatus,
    bottom: bottomStatus,
    topDisconnectedAt: trackers.top.disconnectedAt,
    bottomDisconnectedAt: trackers.bottom.disconnectedAt
  };
}

export function updateAndBroadcastPresence(roomId: string, force = false) {
  const room = rooms.get(roomId);
  if (!room) return;
  const nextPresence = computeRoomPresence(room);
  const prevPresence = room.presence;

  const changed = !prevPresence ||
    prevPresence.top !== nextPresence.top ||
    prevPresence.bottom !== nextPresence.bottom ||
    prevPresence.topDisconnectedAt !== nextPresence.topDisconnectedAt ||
    prevPresence.bottomDisconnectedAt !== nextPresence.bottomDisconnectedAt;

  room.presence = nextPresence;

  if (changed || force) {
    room.version++;
    console.log(`[PRESENCE] Room ${roomId} presence changed to v${room.version}: top=${nextPresence.top}, bottom=${nextPresence.bottom}`);
    broadcastToRoom(roomId, 'ROOM_SYNC', room);
    broadcastToRoom(roomId, 'PRESENCE', nextPresence);
  }
}

export function markPlayerOnline(roomId: string, side: 'top' | 'bottom') {
  const trackers = getRoomTrackers(roomId);
  const t = trackers[side];
  if (t.graceTimer) {
    clearTimeout(t.graceTimer);
    t.graceTimer = null;
  }
  const wasDisconnected = !!t.disconnectedAt;
  t.disconnectedAt = null;
  t.lastHeartbeat = Date.now();
  updateAndBroadcastPresence(roomId, wasDisconnected);
}

export function sweepRoomPresence() {
  const now = Date.now();
  for (const [roomId, room] of rooms.entries()) {
    const trackers = roomPresenceTrackers.get(roomId);
    if (!trackers) continue;

    let changed = false;
    if (room.topPlayer && !trackers.top.disconnectedAt) {
      if (trackers.top.lastHeartbeat > 0 && (now - trackers.top.lastHeartbeat > 15000)) {
        trackers.top.disconnectedAt = now;
        changed = true;
        console.log(`[SWEEPER] Top player in room ${roomId} timed out (>15s without heartbeat) -> Disconnected`);
      }
    }

    if (room.bottomPlayer && !room.vs_bot && !trackers.bottom.disconnectedAt) {
      if (trackers.bottom.lastHeartbeat > 0 && (now - trackers.bottom.lastHeartbeat > 15000)) {
        trackers.bottom.disconnectedAt = now;
        changed = true;
        console.log(`[SWEEPER] Bottom player in room ${roomId} timed out (>15s without heartbeat) -> Disconnected`);
      }
    }

    if (changed) {
      updateAndBroadcastPresence(roomId);
    }
  }
}

let presenceSweeperInterval: NodeJS.Timeout | null = null;
export function startPresenceSweeper(intervalMs = 5000) {
  if (presenceSweeperInterval) return;
  presenceSweeperInterval = setInterval(sweepRoomPresence, intervalMs);
  if (presenceSweeperInterval && typeof presenceSweeperInterval.unref === 'function') {
    presenceSweeperInterval.unref();
  }
}

startPresenceSweeper(5000);

export function handleConnectionClosed(roomId: string, connId: string) {
  const room = rooms.get(roomId);
  const conns = roomConnections.get(roomId);
  const connInfo = conns?.get(connId);
  if (!conns || !connInfo || !room) {
    conns?.delete(connId);
    return;
  }
  conns.delete(connId);

  const remaining = countActiveConnectionsForPlayer(roomId, connInfo.playerId, connInfo.tgId);
  const side = getPlayerSideInRoom(room, connInfo.playerId, connInfo.tgId);

  if (side && remaining === 0) {
    const trackers = getRoomTrackers(roomId);
    const t = trackers[side];
    if (!t.graceTimer && !t.disconnectedAt) {
      t.graceTimer = setTimeout(() => {
        t.graceTimer = null;
        const currentActive = countActiveConnectionsForPlayer(roomId, connInfo.playerId, connInfo.tgId);
        if (currentActive === 0) {
          t.disconnectedAt = Date.now();
          console.log(`[PRESENCE] 15s grace expired for ${side} in room ${roomId} -> Disconnected`);
          updateAndBroadcastPresence(roomId);
        }
      }, 15000);
    }
  }
}

export function createBotRoom(id: string): RoomState {
  const r = getOrCreateRoom(id);
  r.vs_bot = true;
  r.rated = false;
  return r;
}

export function getOrCreateRoom(id: string): RoomState {
  let r = rooms.get(id);
  if (!r) {
    const isBot = id.startsWith('bot_') || id.includes('bot');
    r = {
      id,
      version: 1,
      rated: !isBot,
      vs_bot: isBot,
      positionCounts: {},
      moves: [],
      notation: [],
      chat: [],
      lastActive: Date.now()
    };
    r.presence = computeRoomPresence(r);
    rooms.set(id, r);
  }
  if (!r.presence) {
    r.presence = computeRoomPresence(r);
  }
  r.lastActive = Date.now();
  return r;
}

export function broadcastToRoom(roomId: string, event: string, data: any) {
  const clients = sseClients.get(roomId);
  if (!clients) return;
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    try {
      res.write(payload);
    } catch {}
  }
}

export function scheduleBotTurn(roomId: string) {
  const room = rooms.get(roomId);
  if (!room || !room.vs_bot || !room.gameState || room.gameState.over !== -1 || room.canceled) {
    return;
  }
  const botSide = room.topPlayer?.id === 'tg_bot' ? 'top' : room.bottomPlayer?.id === 'tg_bot' ? 'bottom' : null;
  if (!botSide) return;
  const botWho = botSide === 'top' ? 0 : 1;
  if (room.gameState.turn !== botWho) return;

  const delayMs = 700 + Math.floor(Math.random() * 800);
  setTimeout(async () => {
    const r = rooms.get(roomId);
    if (!r || !r.vs_bot || !r.gameState || r.gameState.over !== -1 || r.canceled) return;
    if (r.gameState.turn !== botWho) return;

    const move = chooseBotMove(r.gameState as any, botWho);
    if (!move) return;

    if (move.type === 'move') {
      r.gameState.pos[botWho] = move.to;
      const targetRow = move.to >> 3;
      if ((botWho === 0 && targetRow === 0) || (botWho === 1 && targetRow === 7)) {
        r.gameState.over = botWho;
        r.endReason = 'goal';
      } else {
        r.gameState.turn = (1 - botWho) as any;
      }
    } else if (move.type === 'wall') {
      r.gameState.blocked[move.cell] = 1;
      r.gameState.walls[botWho] = Math.max(0, r.gameState.walls[botWho] - 1);
      r.gameState.turn = (1 - botWho) as any;
    }

    if (r.gameState.over === -1) {
      const posKey = getRoomPositionKey(r.gameState);
      if (!r.positionCounts) r.positionCounts = {};
      const count = (r.positionCounts[posKey] || 0) + 1;
      r.positionCounts[posKey] = count;

      if (count >= 3) {
        r.gameState.over = 2;
        r.endReason = 'repetition';
      }
    }

    r.gameState.ply = (r.gameState.ply || 0) + 1;
    const notStr = formatNotation(move);
    r.moves.push({ who: botWho, move, notation: notStr });
    if (!Array.isArray(r.notation)) r.notation = [];
    if (botWho === 0) {
      r.notation.push({ num: r.notation.length + 1, p1: notStr });
    } else {
      if (r.notation.length === 0 || r.notation[r.notation.length - 1].p2) {
        r.notation.push({ num: r.notation.length + 1, p1: '...', p2: notStr });
      } else {
        r.notation[r.notation.length - 1].p2 = notStr;
      }
    }

    r.version++;
    if (r.gameState.over !== -1) {
      r.drawOfferedBy = null;
      if (r.gameState.over === 2 && r.endReason === 'repetition') {
        await applyRoomEloRating(r, 0.5);
      } else {
        await applyRoomEloRating(r, r.gameState.over === 0 ? 1 : 0);
      }
    }
    broadcastToRoom(roomId, 'ROOM_SYNC', r);
    broadcastToRoom(roomId, 'MOVE', { move, who: botWho, version: r.version });
    if (r.gameState.over !== -1) {
      broadcastToRoom(roomId, 'GAME_OVER', {
        winner: r.gameState.over,
        draw: r.gameState.over === 2,
        endReason: r.endReason,
        resultText: r.endReason === 'repetition' ? 'Draw - repeated position' : undefined,
        eloResult: r.eloResult,
        version: r.version
      });
    }
  }, delayMs);
}

export async function applyRoomEloRating(room: RoomState, scoreTop: number) {
  if (room.rating_applied) return;
  room.rating_applied = true;

  const topPlayer = room.topPlayer;
  const bottomPlayer = room.bottomPlayer;
  const topPreElo = typeof topPlayer?.elo === 'number' ? topPlayer.elo : 1000;
  const bottomPreElo = typeof bottomPlayer?.elo === 'number' ? bottomPlayer.elo : 1000;

  const hasMoves = Array.isArray(room.moves) && room.moves.length > 0;
  const isEligible = room.rated && !room.vs_bot && !!topPlayer && !!bottomPlayer && hasMoves && !room.canceled;

  if (!isEligible || !topPlayer || !bottomPlayer) {
    room.eloResult = {
      topDelta: 0,
      bottomDelta: 0,
      topNewElo: topPreElo,
      bottomNewElo: bottomPreElo,
      rated: false
    };
    return;
  }

  const { deltaA: deltaTop, deltaB: deltaBottom, newRA: topNewElo, newRB: bottomNewElo } = calculateServerElo(
    topPreElo,
    bottomPreElo,
    scoreTop
  );

  topPlayer.elo = topNewElo;
  bottomPlayer.elo = bottomNewElo;

  room.eloResult = {
    topDelta: deltaTop,
    bottomDelta: deltaBottom,
    topNewElo,
    bottomNewElo,
    rated: true
  };

  try {
    const { pool, upsertUser } = await import('./db/index.js');
    if (topPlayer.tgId) {
      await upsertUser({ id: topPlayer.tgId, name: topPlayer.name, username: topPlayer.username });
      await pool.query(
        `UPDATE users SET elo = $1, peak_elo = GREATEST(peak_elo, $1),
         wins = wins + $2, losses = losses + $3 WHERE tg_id = $4`,
        [topNewElo, scoreTop === 1 ? 1 : 0, scoreTop === 0 ? 1 : 0, topPlayer.tgId]
      );
    }
    if (bottomPlayer.tgId) {
      await upsertUser({ id: bottomPlayer.tgId, name: bottomPlayer.name, username: bottomPlayer.username });
      await pool.query(
        `UPDATE users SET elo = $1, peak_elo = GREATEST(peak_elo, $1),
         wins = wins + $2, losses = losses + $3 WHERE tg_id = $4`,
        [bottomNewElo, scoreTop === 0 ? 1 : 0, scoreTop === 1 ? 1 : 0, bottomPlayer.tgId]
      );
    }
    await pool.query(
      `UPDATE games SET rating_applied = true, p1_elo_before = $1, p1_elo_after = $2,
       p2_elo_before = $3, p2_elo_after = $4 WHERE id::text = $5`,
      [topPreElo, topNewElo, bottomPreElo, bottomNewElo, room.id]
    ).catch(() => {});
  } catch (err) {
    console.warn('[SERVER] Could not persist Elo update to DB:', err);
  }
}

import * as fs from 'node:fs';
import * as path from 'node:path';

const CANDIDATE_DIRS = [
  path.resolve(process.cwd(), '../quoridor-miniapp/dist'),
  path.resolve(process.cwd(), 'quoridor-miniapp/dist'),
  path.resolve(process.cwd(), 'dist')
];
const DIST_DIR = CANDIDATE_DIRS.find(d => fs.existsSync(d)) || CANDIDATE_DIRS[0];

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp'
};

export function handleRoomHttp(req: IncomingMessage, res: ServerResponse): boolean {
  const urlObj = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const pathname = urlObj.pathname;

  // Enable CORS for mini app
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return true;
  }

  // GET /api/user/photo?id=XYZ or ?username=XYZ
  if (pathname === '/api/user/photo' && req.method === 'GET') {
    let rawId = urlObj.searchParams.get('id');
    const username = urlObj.searchParams.get('username')?.replace(/^@/, '');
    const token = process.env.BOT_TOKEN;

    void (async () => {
      try {
        if (!rawId && username) {
          try {
            const { pool } = await import('./db/index.js');
            const q = await pool.query('SELECT tg_id FROM users WHERE LOWER(username) = LOWER($1)', [username]);
            if (q.rows[0]?.tg_id) {
              rawId = String(q.rows[0].tg_id);
            }
          } catch {}
        }

        if (rawId && token) {
          const cleanId = rawId.replace(/^tg_/, '');
          if (/^\d+$/.test(cleanId)) {
            const tgRes = await fetch(`https://api.telegram.org/bot${token}/getUserProfilePhotos?user_id=${cleanId}&limit=1`);
            const data = (await tgRes.json()) as any;
            if (data.ok && data.result.total_count > 0 && data.result.photos?.[0]?.length) {
              const fileId = data.result.photos[0][data.result.photos[0].length - 1].file_id;
              const fileRes = await fetch(`https://api.telegram.org/bot${token}/getFile?file_id=${fileId}`);
              const fileData = (await fileRes.json()) as any;
              if (fileData.ok && fileData.result?.file_path) {
                const photoUrl = `https://api.telegram.org/file/bot${token}/${fileData.result.file_path}`;
                res.writeHead(302, { 'Location': photoUrl, 'Cache-Control': 'public, max-age=86400' });
                res.end();
                return;
              }
            }
          }
        }
      } catch {}

      // Fallback: return 404 so client displays SVG/letter monogram
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'PHOTO_NOT_FOUND' }));
    })();
    return true;
  }

  // SSE stream: /api/room/events?id=XYZ&playerId=ABC&tgId=123
  if (pathname === '/api/room/events' && req.method === 'GET') {
    const id = urlObj.searchParams.get('id') || 'default';
    const playerId = urlObj.searchParams.get('playerId') || undefined;
    const rawTgId = urlObj.searchParams.get('tgId');
    const tgId = rawTgId ? Number(rawTgId) : undefined;

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.flushHeaders?.();
    res.write(': ping\n\n');

    if (!sseClients.has(id)) {
      sseClients.set(id, new Set());
    }
    sseClients.get(id)!.add(res);

    const room = getOrCreateRoom(id);
    const connId = `conn_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    if (!roomConnections.has(id)) {
      roomConnections.set(id, new Map());
    }
    roomConnections.get(id)!.set(connId, {
      connId,
      playerId,
      tgId,
      res
    });

    const side = getPlayerSideInRoom(room, playerId, tgId);
    if (side) {
      markPlayerOnline(id, side);
    }

    // Send current room state immediately
    res.write(`event: ROOM_SYNC\ndata: ${JSON.stringify(room)}\n\n`);

    const pingTimer = setInterval(() => {
      try { res.write(': ping\n\n'); } catch {}
    }, 4000);

    req.on('close', () => {
      clearInterval(pingTimer);
      sseClients.get(id)?.delete(res);
      if (sseClients.get(id)?.size === 0) {
        sseClients.delete(id);
      }
      handleConnectionClosed(id, connId);
    });
    return true;
  }

  // POST /api/room/heartbeat
  if (pathname === '/api/room/heartbeat' && req.method === 'POST') {
    let bodyStr = '';
    req.on('data', chunk => { bodyStr += chunk; });
    req.on('end', () => {
      try {
        const body = JSON.parse(bodyStr || '{}');
        const id = body.id || 'default';
        const room = getOrCreateRoom(id);

        let verifiedUser: VerifiedTgUser | null = null;
        if (body.initData) {
          verifiedUser = verifyTelegramInitData(body.initData, process.env.BOT_TOKEN || '');
        }

        const tgId = verifiedUser?.id || (body.tgId ? Number(body.tgId) : undefined);
        const playerId = verifiedUser ? `tg_${verifiedUser.id}` : (body.playerId || '');

        const side = getPlayerSideInRoom(room, playerId, tgId);
        if (side) {
          markPlayerOnline(id, side);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, presence: room.presence }));
      } catch (err: any) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return true;
  }

  // POST /api/room/disconnect (beacon on pagehide and visibilitychange->hidden)
  if ((pathname === '/api/room/disconnect' || pathname === '/api/room/beacon') && req.method === 'POST') {
    let bodyStr = '';
    req.on('data', chunk => { bodyStr += chunk; });
    req.on('end', () => {
      try {
        const body = JSON.parse(bodyStr || '{}');
        const id = body.id || 'default';
        const room = rooms.get(id);
        if (room) {
          const tgId = body.tgId ? Number(body.tgId) : undefined;
          const playerId = body.playerId || '';
          const side = getPlayerSideInRoom(room, playerId, tgId);
          if (side) {
            const trackers = getRoomTrackers(id);
            if (!trackers[side].disconnectedAt) {
              trackers[side].disconnectedAt = Date.now();
              console.log(`[PRESENCE] Beacon disconnect for ${side} in room ${id}`);
              updateAndBroadcastPresence(id);
            }
          }
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      }
    });
    return true;
  }

  // GET /api/room?id=XYZ
  if (pathname === '/api/room' && req.method === 'GET') {
    const id = urlObj.searchParams.get('id') || 'default';
    const room = getOrCreateRoom(id);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(room));
    return true;
  }

  // POST /api/room/rejoin (checks seat without auto-assigning)
  if (pathname === '/api/room/rejoin' && req.method === 'POST') {
    let bodyStr = '';
    req.on('data', chunk => { bodyStr += chunk; });
    req.on('end', async () => {
      try {
        const body = JSON.parse(bodyStr || '{}');
        const id = body.id || 'default';
        const room = getOrCreateRoom(id);

        let verifiedUser: VerifiedTgUser | null = null;
        if (body.initData) {
          verifiedUser = verifyTelegramInitData(body.initData, process.env.BOT_TOKEN || '');
        }

        const tgId = verifiedUser?.id || (body.playerId?.startsWith('tg_') ? Number(body.playerId.slice(3)) : undefined);
        const playerId = verifiedUser ? `tg_${verifiedUser.id}` : (body.playerId || '');
        const playerName = verifiedUser ? formatTelegramName(verifiedUser) : body.name;
        const playerPhoto = verifiedUser?.photo_url || (tgId ? `/api/user/photo?id=${tgId}` : body.photoUrl);

        const cleanTg = (tgId && !isNaN(Number(tgId)) && Number(tgId) > 0 && Number(tgId) !== 12345678) ? Number(tgId) : null;
        const cleanPId = (playerId && playerId !== 'undefined' && playerId !== 'null') ? playerId : null;

        const isTop = room.topPlayer && (
          (cleanTg && Number(room.topPlayer.tgId) === cleanTg) ||
          (cleanPId && (room.topPlayer.id === cleanPId || (cleanTg && room.topPlayer.id === `tg_${cleanTg}`)))
        );

        const isBottom = room.bottomPlayer && (
          (cleanTg && Number(room.bottomPlayer.tgId) === cleanTg) ||
          (cleanPId && (room.bottomPlayer.id === cleanPId || (cleanTg && room.bottomPlayer.id === `tg_${cleanTg}`)))
        );

        if (isTop) {
          if (verifiedUser) {
            room.topPlayer!.name = playerName;
            room.topPlayer!.photoUrl = playerPhoto;
            room.topPlayer!.tgId = tgId;
            room.topPlayer!.firstName = verifiedUser.first_name;
            room.topPlayer!.lastName = verifiedUser.last_name;
            room.topPlayer!.username = verifiedUser.username;
          }
          if (room.topPlayer!.tgId) {
            try {
              const { getOrCreateUserElo } = await import('./db/index.js');
              room.topPlayer!.elo = await getOrCreateUserElo(room.topPlayer!.tgId, room.topPlayer!.name, room.topPlayer!.username);
            } catch {}
          }
          markPlayerOnline(id, 'top');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, hasSeat: true, seat: 'top', room, player: room.topPlayer }));
          return;
        }

        if (isBottom) {
          if (verifiedUser) {
            room.bottomPlayer!.name = playerName;
            room.bottomPlayer!.photoUrl = playerPhoto;
            room.bottomPlayer!.tgId = tgId;
            room.bottomPlayer!.firstName = verifiedUser.first_name;
            room.bottomPlayer!.lastName = verifiedUser.last_name;
            room.bottomPlayer!.username = verifiedUser.username;
          }
          if (room.bottomPlayer!.tgId) {
            try {
              const { getOrCreateUserElo } = await import('./db/index.js');
              room.bottomPlayer!.elo = await getOrCreateUserElo(room.bottomPlayer!.tgId, room.bottomPlayer!.name, room.bottomPlayer!.username);
            } catch {}
          }
          markPlayerOnline(id, 'bottom');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, hasSeat: true, seat: 'bottom', room, player: room.bottomPlayer }));
          return;
        }

        if (room.topPlayer && room.bottomPlayer) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, hasSeat: false, isSpectator: true, room }));
          return;
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, hasSeat: false, isSpectator: false, room }));
      } catch (err: any) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return true;
  }

  // POST /api/room/join
  if (pathname === '/api/room/join' && req.method === 'POST') {
    let bodyStr = '';
    req.on('data', chunk => { bodyStr += chunk; });
    req.on('end', async () => {
      try {
        const body = JSON.parse(bodyStr || '{}');
        const id = body.id || 'default';
        const room = getOrCreateRoom(id);

        let verifiedUser: VerifiedTgUser | null = null;
        if (body.initData) {
          verifiedUser = verifyTelegramInitData(body.initData, process.env.BOT_TOKEN || '');
        }

        let playerId: string;
        let tgId: number | undefined;
        let playerName: string;
        let playerPhoto: string | undefined;

        if (verifiedUser) {
          tgId = verifiedUser.id;
          playerId = `tg_${tgId}`;
          playerName = formatTelegramName(verifiedUser);
          playerPhoto = verifiedUser.photo_url || `/api/user/photo?id=${tgId}`;
        } else {
          playerId = body.playerId || ('p_' + Math.random().toString(36).substring(2, 8));
          if (playerId.startsWith('tg_')) {
            const parsed = Number(playerId.slice(3));
            if (!isNaN(parsed)) tgId = parsed;
          }
          playerName = (body.name && body.name !== 'Player' && body.name !== 'Player 1' && body.name !== 'Player 2') ? body.name : 'Player';
          playerPhoto = (body.photoUrl && !body.photoUrl.includes('unsplash.com')) ? body.photoUrl : undefined;
          if (!playerPhoto && tgId) {
            playerPhoto = `/api/user/photo?id=${tgId}`;
          }
        }

        // REQUIREMENT 1: REJOIN BY TELEGRAM USER ID / PLAYER ID
        // Look up existing seat first - one user can hold only one seat!
        const cleanTg = (tgId && !isNaN(Number(tgId)) && Number(tgId) > 0 && Number(tgId) !== 12345678) ? Number(tgId) : null;
        const cleanPId = (playerId && playerId !== 'undefined' && playerId !== 'null') ? playerId : null;

        const isTop = room.topPlayer && (
          (cleanTg && Number(room.topPlayer.tgId) === cleanTg) ||
          (cleanPId && (room.topPlayer.id === cleanPId || (cleanTg && room.topPlayer.id === `tg_${cleanTg}`)))
        );

        const isBottom = room.bottomPlayer && (
          (cleanTg && Number(room.bottomPlayer.tgId) === cleanTg) ||
          (cleanPId && (room.bottomPlayer.id === cleanPId || (cleanTg && room.bottomPlayer.id === `tg_${cleanTg}`)))
        );

        if (isTop) {
          if (verifiedUser) {
            room.topPlayer!.name = playerName;
            room.topPlayer!.photoUrl = playerPhoto;
            room.topPlayer!.tgId = tgId;
            room.topPlayer!.firstName = verifiedUser.first_name;
            room.topPlayer!.lastName = verifiedUser.last_name;
            room.topPlayer!.username = verifiedUser.username;
          }
          if (room.topPlayer!.tgId) {
            try {
              const { getOrCreateUserElo } = await import('./db/index.js');
              room.topPlayer!.elo = await getOrCreateUserElo(room.topPlayer!.tgId, room.topPlayer!.name, room.topPlayer!.username);
            } catch {}
          }
          markPlayerOnline(id, 'top');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, room, player: room.topPlayer, seat: 'top', reconnected: true }));
          return;
        }

        if (isBottom) {
          if (verifiedUser) {
            room.bottomPlayer!.name = playerName;
            room.bottomPlayer!.photoUrl = playerPhoto;
            room.bottomPlayer!.tgId = tgId;
            room.bottomPlayer!.firstName = verifiedUser.first_name;
            room.bottomPlayer!.lastName = verifiedUser.last_name;
            room.bottomPlayer!.username = verifiedUser.username;
          }
          if (room.bottomPlayer!.tgId) {
            try {
              const { getOrCreateUserElo } = await import('./db/index.js');
              room.bottomPlayer!.elo = await getOrCreateUserElo(room.bottomPlayer!.tgId, room.bottomPlayer!.name, room.bottomPlayer!.username);
            } catch {}
          }
          markPlayerOnline(id, 'bottom');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, room, player: room.bottomPlayer, seat: 'bottom', reconnected: true }));
          return;
        }

        // REQUIREMENT 3: SPECTATOR LOGIC
        // Once both seats are taken, any other Telegram user who opens joins as a read-only spectator.
        if (room.topPlayer && room.bottomPlayer) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            ok: true,
            isSpectator: true,
            error: 'ROOM_FULL',
            message: 'Match is already full with 2 players.',
            room
          }));
          return;
        }

        // Do not auto-seat if no side is chosen and neither seat is taken yet
        if (!body.side && !room.topPlayer && !room.bottomPlayer) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, hasSeat: false, room }));
          return;
        }

        // SEAT ASSIGNMENT FOR OPEN SEAT
        let assignedSide: 'top' | 'bottom';
        if (room.topPlayer && !room.bottomPlayer) {
          if (body.side === 'top') {
            res.writeHead(409, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'SEAT_TAKEN', message: 'Top seat is already taken.', room }));
            return;
          }
          assignedSide = 'bottom';
        } else if (room.bottomPlayer && !room.topPlayer) {
          if (body.side === 'bottom') {
            res.writeHead(409, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'SEAT_TAKEN', message: 'Bottom seat is already taken.', room }));
            return;
          }
          assignedSide = 'top';
        } else {
          assignedSide = (body.side === 'bottom') ? 'bottom' : 'top';
          room.creatorSide = assignedSide;
          room.rated = room.vs_bot ? false : (typeof body.rated === 'boolean' ? body.rated : true);
        }

        if (room.vs_bot) {
          room.rated = false;
        }

        let playerElo = 1000;
        if (tgId) {
          try {
            const { getOrCreateUserElo } = await import('./db/index.js');
            playerElo = await getOrCreateUserElo(tgId, playerName, verifiedUser?.username);
          } catch (err) {
            console.warn('[SERVER] Could not load Elo from DB:', err);
            if (typeof body.elo === 'number' && body.elo >= 100) {
              playerElo = body.elo;
            }
          }
        } else if (typeof body.elo === 'number' && body.elo >= 100) {
          playerElo = body.elo;
        }
        playerElo = Math.max(100, playerElo);

        const player: RoomPlayer = {
          id: playerId,
          tgId,
          name: playerName,
          elo: playerElo,
          photoUrl: playerPhoto,
          side: assignedSide,
          firstName: verifiedUser?.first_name,
          lastName: verifiedUser?.last_name,
          username: verifiedUser?.username
        };

        if (room.vs_bot) {
          room.rated = false;
          const botSide = assignedSide === 'top' ? 'bottom' : 'top';
          const botPlayer: RoomPlayer = {
            id: 'tg_bot',
            tgId: 0,
            name: 'Quoridor Bot',
            elo: 1000,
            side: botSide,
            username: 'quoridor_bot'
          };
          if (assignedSide === 'top') {
            room.topPlayer = player;
            room.bottomPlayer = botPlayer;
          } else {
            room.bottomPlayer = player;
            room.topPlayer = botPlayer;
          }
        } else {
          if (assignedSide === 'top') {
            room.topPlayer = player;
          } else {
            room.bottomPlayer = player;
          }
        }

        // When both players are present, ensure standard board state is ready
        if (room.topPlayer && room.bottomPlayer && !room.gameState) {
          room.gameState = {
            turn: 0,
            pos: [60, 3],
            walls: [8, 8],
            blocked: new Array(64).fill(0),
            over: -1,
            ply: 0
          };
          room.positionCounts = {
            [getRoomPositionKey(room.gameState)]: 1
          };
        }

        room.version++;
        markPlayerOnline(id, assignedSide);
        console.log(`[SERVER] Player ${playerId} (${playerName}) joined room ${id} as ${assignedSide} (rated=${room.rated})`);
        broadcastToRoom(id, 'ROOM_SYNC', room);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, room, player, seat: assignedSide }));

        if (room.vs_bot && room.topPlayer?.id === 'tg_bot') {
          scheduleBotTurn(id);
        }
      } catch (err: any) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return true;
  }

  // POST /api/room/leave
  if (pathname === '/api/room/leave' && req.method === 'POST') {
    let bodyStr = '';
    req.on('data', chunk => { bodyStr += chunk; });
    req.on('end', async () => {
      try {
        const body = JSON.parse(bodyStr || '{}');
        const id = body.id || 'default';
        const room = getOrCreateRoom(id);
        const playerId = String(body.playerId || '');

        const isGameActive = !!room.gameState && room.gameState.over === -1 && (!!room.topPlayer && !!room.bottomPlayer);
        if (isGameActive && room.moves && room.moves.length > 0) {
          const leaverSide = room.topPlayer?.id === playerId ? 'top' : (room.bottomPlayer?.id === playerId ? 'bottom' : null);
          if (leaverSide) {
            const winner = leaverSide === 'top' ? 1 : 0;
            room.gameState.over = winner;
            room.endReason = 'resigned';
            if (!room.rating_applied) {
              await applyRoomEloRating(room, winner === 0 ? 1 : 0);
            }
            broadcastToRoom(id, 'ROOM_SYNC', room);
            broadcastToRoom(id, 'GAME_OVER', { winner, forfeit: true, endReason: 'resigned', eloResult: room.eloResult, version: room.version });
          }
        } else if (!isGameActive) {
          if (room.topPlayer?.id === playerId) {
            delete room.topPlayer;
          }
          if (room.bottomPlayer?.id === playerId) {
            delete room.bottomPlayer;
          }
        }
        if (!room.topPlayer && !room.bottomPlayer) {
          room.gameState = null;
          room.moves = [];
        }

        room.version++;
        broadcastToRoom(id, 'ROOM_SYNC', room);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, room }));
      } catch (err: any) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return true;
  }

  // POST /api/room/action (move, chat, resign)
  if (pathname === '/api/room/action' && req.method === 'POST') {
    let bodyStr = '';
    req.on('data', chunk => { bodyStr += chunk; });
    req.on('end', async () => {
      try {
        const body = JSON.parse(bodyStr || '{}');
        const id = body.id || 'default';
        const room = getOrCreateRoom(id);
        const senderId = String(body.senderId || '');

        // Resolve authenticated player seat in the room
        let senderTgId: number | undefined;
        if (body.initData) {
          const verified = verifyTelegramInitData(body.initData, process.env.BOT_TOKEN || '');
          if (verified) senderTgId = verified.id;
        }
        if (!senderTgId && senderId.startsWith('tg_')) {
          const parsed = parseInt(senderId.slice(3), 10);
          if (!isNaN(parsed)) senderTgId = parsed;
        }
        const resolvedSide = getPlayerSideInRoom(room, senderId, senderTgId);

        // Spectator Protection: Only assigned players can move pawns, resign, cancel, or offer/respond to draws!
        if (
          body.type === 'MOVE' ||
          body.type === 'RESIGN' ||
          body.type === 'CANCEL' ||
          body.type === 'DRAW' ||
          body.type === 'DRAW_OFFER' ||
          body.type === 'DRAW_ACCEPT' ||
          body.type === 'DRAW_REJECT' ||
          body.type === 'DRAW_CANCEL'
        ) {
          const isRealPlayer = resolvedSide !== null;
          if (!isRealPlayer) {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'SPECTATOR_READONLY', message: 'Spectators are read-only and cannot move, resign, cancel, or offer/respond to draws.' }));
            return;
          }
          if (body.type === 'MOVE') {
            const expectedTurn = resolvedSide === 'top' ? 0 : 1;
            const state = room.gameState;
            if (!state || state.over !== -1) {
              res.writeHead(409, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'GAME_OVER', message: 'Game has already finished.' }));
              return;
            }
            if (state.turn !== expectedTurn) {
              res.writeHead(409, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'NOT_YOUR_TURN', message: 'It is not your turn.' }));
              return;
            }
          }
        }

        if (body.type === 'MOVE') {
          const expectedTurn = resolvedSide === 'top' ? 0 : 1;
          const state = room.gameState;
          const move = body.move;

          if (move) {
            if (move.type === 'move') {
              state.pos[expectedTurn] = move.to;
              const targetRow = move.to >> 3;
              // P0 (Top) goal is row 0; P1 (Bottom) goal is row 7
              if ((expectedTurn === 0 && targetRow === 0) || (expectedTurn === 1 && targetRow === 7)) {
                state.over = expectedTurn;
                room.endReason = 'goal';
              } else {
                state.turn = 1 - expectedTurn;
              }
            } else if (move.type === 'wall') {
              if (
                typeof move.cell !== 'number' ||
                move.cell < 0 ||
                move.cell >= 64 ||
                state.blocked[move.cell] ||
                move.cell === state.pos[0] ||
                move.cell === state.pos[1] ||
                state.walls[expectedTurn] <= 0
              ) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'INVALID_WALL', message: 'Cannot place wall: cell is blocked, occupied by a pawn, or no walls remaining.' }));
                return;
              }
              state.blocked[move.cell] = 1;
              state.walls[expectedTurn] = Math.max(0, state.walls[expectedTurn] - 1);
              state.turn = 1 - expectedTurn;
            }
            state.ply = (state.ply || 0) + 1;
            const notStr = formatNotation(move);
            const moveRecord = body.record || { move, who: expectedTurn, notation: notStr };
            room.moves.push(moveRecord);

            if (!Array.isArray(room.notation)) room.notation = [];
            if (expectedTurn === 0) {
              room.notation.push({
                num: room.notation.length + 1,
                p1: notStr
              });
            } else {
              if (room.notation.length > 0 && !room.notation[room.notation.length - 1].p2) {
                room.notation[room.notation.length - 1].p2 = notStr;
              } else {
                room.notation.push({
                  num: room.notation.length + 1,
                  p1: '...',
                  p2: notStr
                });
              }
            }
          } else if (body.state) {
            // Fallback if full state was sent
            room.gameState = body.state;
          }

          if (state.over === -1) {
            const posKey = getRoomPositionKey(state);
            if (!room.positionCounts) room.positionCounts = {};
            const count = (room.positionCounts[posKey] || 0) + 1;
            room.positionCounts[posKey] = count;

            if (count >= 3) {
              state.over = 2; // draw
              room.endReason = 'repetition';
            }
          }

          if (state.over !== -1) {
            room.drawOfferedBy = null;
            if (state.over === 2 && room.endReason === 'repetition') {
              if (!room.rating_applied) {
                await applyRoomEloRating(room, 0.5);
              }
            } else {
              room.endReason = 'goal';
              if (!room.rating_applied) {
                await applyRoomEloRating(room, state.over === 0 ? 1 : 0);
              }
            }
          }

          room.version++;
          updateAndBroadcastPresence(id);
          console.log(`[SERVER] Move received from ${senderId} (side=${resolvedSide}, turn=${expectedTurn}) in room ${id}`);
          console.log(`[SERVER] Broadcasting room state v${room.version} for room ${id} (over=${state.over})`);
          broadcastToRoom(id, 'ROOM_SYNC', room);
          broadcastToRoom(id, 'MOVE', { ...body, version: room.version });
          if (state.over !== -1) {
            broadcastToRoom(id, 'GAME_OVER', {
              winner: state.over,
              draw: state.over === 2,
              endReason: room.endReason,
              resultText: room.endReason === 'repetition' ? 'Draw - repeated position' : undefined,
              eloResult: room.eloResult,
              version: room.version
            });
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, room, version: room.version }));

          if (room.vs_bot && state.over === -1 && !room.canceled) {
            scheduleBotTurn(id);
          }
          return;
        } else if (body.type === 'CHAT') {
          if (room.vs_bot) {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'CHAT_DISABLED', message: 'Chat is disabled in bot games.' }));
            return;
          }

          let verifiedUser: VerifiedTgUser | null = null;
          if (body.initData) {
            verifiedUser = verifyTelegramInitData(body.initData, process.env.BOT_TOKEN || '');
          }

          let senderTgId = verifiedUser?.id;
          let senderId = verifiedUser ? `tg_${senderTgId}` : (body.senderId || body.playerId || '');
          if (!senderTgId && senderId.startsWith('tg_')) {
            const parsed = parseInt(senderId.slice(3), 10);
            if (!isNaN(parsed)) senderTgId = parsed;
          }

          const seatedPlayer = (room.topPlayer && (room.topPlayer.id === senderId || (senderTgId && room.topPlayer.tgId === senderTgId)))
            ? room.topPlayer
            : ((room.bottomPlayer && (room.bottomPlayer.id === senderId || (senderTgId && room.bottomPlayer.tgId === senderTgId)))
              ? room.bottomPlayer
              : null);

          if (!verifiedUser && !seatedPlayer) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'UNAUTHORIZED_CHAT', message: 'Chat requires verified Telegram identity or seated player.' }));
            return;
          }

          const rawText = typeof body.text === 'string' ? body.text : (typeof body.msg === 'string' ? body.msg : '');
          const cleanText = rawText.trim().slice(0, 300);
          if (!cleanText) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'EMPTY_MESSAGE', message: 'Message cannot be empty.' }));
            return;
          }

          let senderName = verifiedUser ? formatTelegramName(verifiedUser) : (seatedPlayer ? seatedPlayer.name : 'Player');
          let senderPhoto: string | undefined = verifiedUser ? (verifiedUser.photo_url || `/api/user/photo?id=${senderTgId}`) : seatedPlayer?.photoUrl;

          if (room.topPlayer && (room.topPlayer.tgId === senderTgId || room.topPlayer.id === senderId)) {
            senderName = room.topPlayer.name;
            senderPhoto = room.topPlayer.photoUrl;
          } else if (room.bottomPlayer && (room.bottomPlayer.tgId === senderTgId || room.bottomPlayer.id === senderId)) {
            senderName = room.bottomPlayer.name;
            senderPhoto = room.bottomPlayer.photoUrl;
          }

          const chatMsg = {
            id: `m_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            text: cleanText,
            senderId,
            senderName,
            senderPhoto,
            timestamp: Date.now()
          };

          if (!Array.isArray(room.chat)) {
            room.chat = [];
          }
          room.chat.push(chatMsg);
          if (room.chat.length > 100) {
            room.chat.splice(0, room.chat.length - 100);
          }
          room.version++;
          broadcastToRoom(id, 'CHAT', chatMsg);
          broadcastToRoom(id, 'ROOM_SYNC', room);

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, msg: chatMsg, room }));
          return;
        } else if (body.type === 'RESIGN') {
          const playerSide = resolvedSide || (room.topPlayer?.id === senderId ? 'top' : 'bottom');
          const winner = playerSide === 'top' ? 1 : 0;
          if (room.gameState) {
            room.gameState.over = winner;
          }
          room.endReason = 'resigned';
          room.resignedBy = senderId;
          room.drawOfferedBy = null;
          if (!room.rating_applied) {
            await applyRoomEloRating(room, winner === 0 ? 1 : 0);
          }
          room.version++;
          updateAndBroadcastPresence(id);
          console.log(`[SERVER] Resign received from ${senderId} in room ${id}`);
          console.log(`[SERVER] Broadcasting room state v${room.version} for room ${id}`);
          broadcastToRoom(id, 'ROOM_SYNC', room);
          broadcastToRoom(id, 'GAME_OVER', { winner, endReason: 'resigned', resignedBy: senderId, eloResult: room.eloResult, version: room.version });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, room, version: room.version }));
          return;
        } else if (body.type === 'CANCEL') {
          const totalMoves = (room.gameState?.ply ?? (room.moves?.length ?? 0));
          if (totalMoves >= CANCEL_MAX_MOVES) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'CANCEL_NOT_ALLOWED', message: 'Cancel is only allowed in the early game (fewer than 6 moves).' }));
            return;
          }
          if (room.gameState && room.gameState.over !== -1) {
            res.writeHead(409, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'GAME_OVER', message: 'Game has already finished.' }));
            return;
          }

          if (room.gameState) {
            room.gameState.over = -2; // -2 indicates canceled
          }
          room.canceled = true;
          room.endReason = 'canceled';
          room.drawOfferedBy = null;
          room.rating_applied = true; // Ensure no rating change
          const topPreElo = typeof room.topPlayer?.elo === 'number' ? room.topPlayer.elo : 1000;
          const bottomPreElo = typeof room.bottomPlayer?.elo === 'number' ? room.bottomPlayer.elo : 1000;
          room.eloResult = {
            topDelta: 0,
            bottomDelta: 0,
            topNewElo: topPreElo,
            bottomNewElo: bottomPreElo,
            rated: false
          };
          room.version++;
          updateAndBroadcastPresence(id);
          console.log(`[SERVER] Cancel received from ${senderId} in room ${id} (total moves: ${totalMoves})`);
          console.log(`[SERVER] Broadcasting room state v${room.version} for room ${id} (canceled)`);
          broadcastToRoom(id, 'ROOM_SYNC', room);
          broadcastToRoom(id, 'GAME_OVER', { winner: -2, canceled: true, endReason: 'canceled', resultText: 'No result (canceled)', eloResult: room.eloResult, version: room.version });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, room, version: room.version }));
          return;
        } else if (body.type === 'DRAW' || body.type === 'DRAW_OFFER') {
          if (!room.gameState || room.gameState.over !== -1 || room.canceled) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'GAME_OVER', message: 'Game is not active.' }));
            return;
          }
          if (room.vs_bot) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'BOT_GAME', message: 'Draw offers are not allowed in bot games.' }));
            return;
          }

          const seatedPlayerId = resolvedSide === 'top' ? room.topPlayer?.id : room.bottomPlayer?.id;
          const effectiveSender = seatedPlayerId || senderId;

          // If body.type === 'DRAW' and an offer from opponent is already pending -> accept it!
          if (room.drawOfferedBy && room.drawOfferedBy !== effectiveSender) {
            room.gameState.over = 2; // draw
            room.endReason = 'draw';
            room.drawOfferedBy = null;
            if (!room.rating_applied) {
              await applyRoomEloRating(room, 0.5);
            }
            room.version++;
            updateAndBroadcastPresence(id);
            broadcastToRoom(id, 'ROOM_SYNC', room);
            broadcastToRoom(id, 'DRAW_ACCEPTED', { version: room.version });
            broadcastToRoom(id, 'GAME_OVER', { winner: 2, draw: true, endReason: 'draw', eloResult: room.eloResult, version: room.version });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, room, version: room.version }));
            return;
          }

          // Check if already offered by this player
          if (room.drawOfferedBy === effectiveSender) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, room, pending: true }));
            return;
          }

          // Check 3-move cooldown after a rejected offer
          const currentMoves = Array.isArray(room.moves) ? room.moves.length : 0;
          if (room.drawRejectedMoveCount && typeof room.drawRejectedMoveCount[effectiveSender] === 'number') {
            const rejectedAt = room.drawRejectedMoveCount[effectiveSender];
            if (currentMoves - rejectedAt < 3) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({
                error: 'DRAW_COOLDOWN',
                message: `You must play at least 3 more moves before offering a draw again (${currentMoves - rejectedAt}/3 played).`
              }));
              return;
            }
          }

          room.drawOfferedBy = effectiveSender;
          room.version++;
          updateAndBroadcastPresence(id);
          broadcastToRoom(id, 'ROOM_SYNC', room);
          broadcastToRoom(id, 'DRAW_OFFER', { offeredBy: effectiveSender, version: room.version });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, room, version: room.version }));
          return;
        } else if (body.type === 'DRAW_ACCEPT') {
          if (!room.gameState || room.gameState.over !== -1 || room.canceled) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'GAME_OVER', message: 'Game is not active.' }));
            return;
          }
          if (room.vs_bot) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'BOT_GAME', message: 'Draw offers are not allowed in bot games.' }));
            return;
          }
          if (!room.drawOfferedBy) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'NO_DRAW_OFFER', message: 'No draw offered.' }));
            return;
          }
          const seatedPlayerId = resolvedSide === 'top' ? room.topPlayer?.id : room.bottomPlayer?.id;
          const effectiveSender = seatedPlayerId || senderId;
          if (room.drawOfferedBy === effectiveSender) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'CANNOT_ACCEPT_OWN_OFFER', message: 'Cannot accept your own draw offer.' }));
            return;
          }

          room.gameState.over = 2; // draw
          room.endReason = 'draw';
          room.drawOfferedBy = null;
          if (!room.rating_applied) {
            await applyRoomEloRating(room, 0.5);
          }
          room.version++;
          updateAndBroadcastPresence(id);
          broadcastToRoom(id, 'ROOM_SYNC', room);
          broadcastToRoom(id, 'DRAW_ACCEPTED', { version: room.version });
          broadcastToRoom(id, 'GAME_OVER', { winner: 2, draw: true, endReason: 'draw', eloResult: room.eloResult, version: room.version });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, room, version: room.version }));
          return;
        } else if (body.type === 'DRAW_REJECT') {
          if (!room.gameState || room.gameState.over !== -1 || room.canceled) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'GAME_OVER', message: 'Game is not active.' }));
            return;
          }
          if (!room.drawOfferedBy) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'NO_DRAW_OFFER', message: 'No draw offered.' }));
            return;
          }
          const seatedPlayerId = resolvedSide === 'top' ? room.topPlayer?.id : room.bottomPlayer?.id;
          const effectiveSender = seatedPlayerId || senderId;
          const proposer = room.drawOfferedBy;

          // Record 3-move cooldown on the PROPOSER
          if (!room.drawRejectedMoveCount) room.drawRejectedMoveCount = {};
          const currentMoves = Array.isArray(room.moves) ? room.moves.length : 0;
          room.drawRejectedMoveCount[proposer] = currentMoves;

          room.drawOfferedBy = null;
          room.version++;
          updateAndBroadcastPresence(id);
          broadcastToRoom(id, 'ROOM_SYNC', room);
          broadcastToRoom(id, 'DRAW_DECLINED', { declinedBy: effectiveSender, version: room.version });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, room, version: room.version }));
          return;
        } else if (body.type === 'DRAW_CANCEL') {
          if (!room.drawOfferedBy) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'NO_DRAW_OFFER', message: 'No draw offered.' }));
            return;
          }
          const seatedPlayerId = resolvedSide === 'top' ? room.topPlayer?.id : room.bottomPlayer?.id;
          const effectiveSender = seatedPlayerId || senderId;

          room.drawOfferedBy = null;
          room.version++;
          updateAndBroadcastPresence(id);
          broadcastToRoom(id, 'ROOM_SYNC', room);
          broadcastToRoom(id, 'DRAW_DECLINED', { canceledBy: effectiveSender, version: room.version });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, room, version: room.version }));
          return;
        } else if (body.type === 'REMATCH_OFFER') {
          let verifiedUser: VerifiedTgUser | null = null;
          if (body.initData) {
            verifiedUser = verifyTelegramInitData(body.initData, process.env.BOT_TOKEN || '');
          }
          let senderTgId = verifiedUser?.id;
          let senderId = verifiedUser ? `tg_${senderTgId}` : (body.senderId || body.playerId || '');
          if (!senderTgId && senderId.startsWith('tg_')) {
            const parsed = parseInt(senderId.slice(3), 10);
            if (!isNaN(parsed)) senderTgId = parsed;
          }

          const isTop = room.topPlayer && (room.topPlayer.id === senderId || (senderTgId && room.topPlayer.tgId === senderTgId));
          const isBottom = room.bottomPlayer && (room.bottomPlayer.id === senderId || (senderTgId && room.bottomPlayer.tgId === senderTgId));

          if (!isTop && !isBottom) {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'FORBIDDEN', message: 'Only seated players can offer rematch.' }));
            return;
          }

          if (room.vs_bot) {
            // Swap players and their sides
            const prevTop = room.topPlayer;
            const prevBottom = room.bottomPlayer;
            if (prevTop) prevTop.side = 'bottom';
            if (prevBottom) prevBottom.side = 'top';
            room.topPlayer = prevBottom;
            room.bottomPlayer = prevTop;

            room.gameState = {
              turn: 0,
              pos: [60, 3],
              walls: [8, 8],
              blocked: new Array(64).fill(0),
              over: -1,
              ply: 0
            };
            room.positionCounts = {
              [getRoomPositionKey(room.gameState)]: 1
            };
            room.moves = [];
            room.notation = [];
            room.rating_applied = false;
            delete room.eloResult;
            delete room.endReason;
            delete room.resignedBy;
            room.canceled = false;
            room.drawOfferedBy = null;
            delete room.drawRejectedMoveCount;
            room.rematchOfferedBy = null;
            room.version++;
            updateAndBroadcastPresence(id);
            console.log(`[SERVER] Rematch accepted by Bot in room ${id}. Sides swapped: Top=${room.topPlayer?.name}, Bottom=${room.bottomPlayer?.name}`);
            broadcastToRoom(id, 'ROOM_SYNC', room);
            broadcastToRoom(id, 'REMATCH_ACCEPTED', { version: room.version });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, room, version: room.version }));

            if (room.topPlayer?.id === 'tg_bot') {
              scheduleBotTurn(id);
            }
            return;
          }

          room.rematchOfferedBy = senderId;
          room.version++;
          updateAndBroadcastPresence(id);
          console.log(`[SERVER] Rematch offered by ${senderId} in room ${id}`);
          broadcastToRoom(id, 'ROOM_SYNC', room);
          broadcastToRoom(id, 'REMATCH_OFFER', { offeredBy: senderId, version: room.version });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, room, version: room.version }));
          return;
        } else if (body.type === 'REMATCH_CANCEL' || body.type === 'REMATCH_REJECT') {
          let verifiedUser: VerifiedTgUser | null = null;
          if (body.initData) {
            verifiedUser = verifyTelegramInitData(body.initData, process.env.BOT_TOKEN || '');
          }
          let senderTgId = verifiedUser?.id;
          let senderId = verifiedUser ? `tg_${senderTgId}` : (body.senderId || body.playerId || '');
          if (!senderTgId && senderId.startsWith('tg_')) {
            const parsed = parseInt(senderId.slice(3), 10);
            if (!isNaN(parsed)) senderTgId = parsed;
          }

          room.rematchOfferedBy = null;
          room.version++;
          updateAndBroadcastPresence(id);
          console.log(`[SERVER] Rematch ${body.type === 'REMATCH_CANCEL' ? 'cancelled' : 'rejected'} by ${senderId} in room ${id}`);
          broadcastToRoom(id, 'ROOM_SYNC', room);
          broadcastToRoom(id, 'REMATCH_DECLINED', { declinedBy: senderId, version: room.version });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, room, version: room.version }));
          return;
        } else if (body.type === 'REMATCH_ACCEPT') {
          let verifiedUser: VerifiedTgUser | null = null;
          if (body.initData) {
            verifiedUser = verifyTelegramInitData(body.initData, process.env.BOT_TOKEN || '');
          }
          let senderTgId = verifiedUser?.id;
          let senderId = verifiedUser ? `tg_${senderTgId}` : (body.senderId || body.playerId || '');
          if (!senderTgId && senderId.startsWith('tg_')) {
            const parsed = parseInt(senderId.slice(3), 10);
            if (!isNaN(parsed)) senderTgId = parsed;
          }

          if (!room.rematchOfferedBy) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'NO_REMATCH_OFFER', message: 'No rematch offered.' }));
            return;
          }

          // Swap players and their sides
          const prevTop = room.topPlayer;
          const prevBottom = room.bottomPlayer;
          if (prevTop) prevTop.side = 'bottom';
          if (prevBottom) prevBottom.side = 'top';
          room.topPlayer = prevBottom;
          room.bottomPlayer = prevTop;

          if (room.presence) {
            const prevTopPres = room.presence.top;
            const prevBottomPres = room.presence.bottom;
            room.presence = {
              top: prevBottomPres || 'playing',
              bottom: prevTopPres || 'playing'
            };
          }

          // Reset game state for new match with sides swapped
          room.gameState = {
            turn: 0,
            pos: [60, 3],
            walls: [8, 8],
            blocked: new Array(64).fill(0),
            over: -1,
            ply: 0
          };
          room.positionCounts = {
            [getRoomPositionKey(room.gameState)]: 1
          };
          room.moves = [];
          room.notation = [];
          room.rating_applied = false;
          delete room.eloResult;
          delete room.endReason;
          delete room.resignedBy;
          room.canceled = false;
          room.drawOfferedBy = null;
          delete room.drawRejectedMoveCount;
          room.rematchOfferedBy = null;

          if (room.topPlayer?.tgId) {
            try {
              const { getOrCreateUserElo } = await import('./db/index.js');
              room.topPlayer.elo = await getOrCreateUserElo(room.topPlayer.tgId, room.topPlayer.name, room.topPlayer.username);
            } catch {}
          }
          if (room.bottomPlayer?.tgId) {
            try {
              const { getOrCreateUserElo } = await import('./db/index.js');
              room.bottomPlayer.elo = await getOrCreateUserElo(room.bottomPlayer.tgId, room.bottomPlayer.name, room.bottomPlayer.username);
            } catch {}
          }

          room.version++;
          updateAndBroadcastPresence(id);
          console.log(`[SERVER] Rematch accepted in room ${id}. Sides swapped: Top=${room.topPlayer?.name}, Bottom=${room.bottomPlayer?.name}`);
          broadcastToRoom(id, 'ROOM_SYNC', room);
          broadcastToRoom(id, 'REMATCH_ACCEPTED', { version: room.version });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, room, version: room.version }));
          return;
        } else if (body.type === 'RESET') {
          room.gameState = {
            turn: 0,
            pos: [60, 3],
            walls: [8, 8],
            blocked: new Array(64).fill(0),
            over: -1,
            ply: 0
          };
          room.positionCounts = {
            [getRoomPositionKey(room.gameState)]: 1
          };
          room.moves = [];
          room.notation = [];
          room.rating_applied = false;
          delete room.eloResult;
          delete room.endReason;
          delete room.resignedBy;
          room.canceled = false;
          room.drawOfferedBy = null;
          delete room.drawRejectedMoveCount;
          room.rematchOfferedBy = null;
          room.version++;
          updateAndBroadcastPresence(id);
          console.log(`[SERVER] Reset received in room ${id}`);
          console.log(`[SERVER] Broadcasting room state v${room.version} for room ${id}`);
          broadcastToRoom(id, 'ROOM_SYNC', room);
          broadcastToRoom(id, 'RESET', { version: room.version });
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (err: any) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return true;
  }

  // Serve static assets from quoridor-miniapp/dist
  if (req.method === 'GET' && fs.existsSync(DIST_DIR)) {
    let filePath = path.join(DIST_DIR, pathname === '/' ? 'index.html' : pathname);
    if (!fs.existsSync(filePath)) {
      filePath = path.join(DIST_DIR, 'index.html');
    }

    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const ext = path.extname(filePath).toLowerCase();
      const contentType = MIME_TYPES[ext] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': contentType });
      fs.createReadStream(filePath).pipe(res);
      return true;
    }
  }

  return false;
}
