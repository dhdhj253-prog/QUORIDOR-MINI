import type { IncomingMessage, ServerResponse } from 'node:http';
import crypto from 'node:crypto';
import { calculateServerElo } from './engine/elo.js';

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

export interface RoomState {
  id: string;
  version: number;
  rated: boolean;
  vs_bot?: boolean;
  creatorSide?: 'top' | 'bottom';
  creator?: { id: string; name: string; username?: string; photoUrl?: string };
  topPlayer?: RoomPlayer;
  bottomPlayer?: RoomPlayer;
  gameState?: any;
  moves: any[];
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
  const isGameRunning = !!room.gameState && room.gameState.over === -1 && Array.isArray(room.moves) && room.moves.length > 0;

  let topStatus: PlayerPresenceStatus;
  if (!room.topPlayer) {
    topStatus = 'waiting';
  } else if (trackers.top.disconnectedAt) {
    topStatus = 'disconnected';
  } else {
    topStatus = isGameRunning ? 'playing' : 'joined';
  }

  let bottomStatus: PlayerPresenceStatus;
  if (room.vs_bot) {
    bottomStatus = isGameRunning ? 'playing' : 'joined';
  } else if (!room.bottomPlayer) {
    bottomStatus = 'waiting';
  } else if (trackers.bottom.disconnectedAt) {
    bottomStatus = 'disconnected';
  } else {
    bottomStatus = isGameRunning ? 'playing' : 'joined';
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
  t.disconnectedAt = null;
  t.lastHeartbeat = Date.now();
  updateAndBroadcastPresence(roomId);
}

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

export function getOrCreateRoom(id: string): RoomState {
  let r = rooms.get(id);
  if (!r) {
    r = {
      id,
      version: 1,
      rated: true,
      moves: [],
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

export async function applyRoomEloRating(room: RoomState, scoreTop: number) {
  if (room.rating_applied) return;
  room.rating_applied = true;

  const topPlayer = room.topPlayer;
  const bottomPlayer = room.bottomPlayer;
  const topPreElo = typeof topPlayer?.elo === 'number' ? topPlayer.elo : 1000;
  const bottomPreElo = typeof bottomPlayer?.elo === 'number' ? bottomPlayer.elo : 1000;

  const hasMoves = Array.isArray(room.moves) && room.moves.length > 0;
  const isEligible = room.rated && !room.vs_bot && !!topPlayer && !!bottomPlayer && hasMoves;

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
    const { pool } = await import('./db/index.js');
    if (topPlayer.tgId) {
      await pool.query(
        `UPDATE users SET elo = $1, peak_elo = GREATEST(peak_elo, $1),
         wins = wins + $2, losses = losses + $3 WHERE tg_id = $4`,
        [topNewElo, scoreTop === 1 ? 1 : 0, scoreTop === 0 ? 1 : 0, topPlayer.tgId]
      );
    }
    if (bottomPlayer.tgId) {
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
    req.on('end', () => {
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

        let playerElo = typeof body.elo === 'number' ? body.elo : 1000;
        if (tgId) {
          try {
            const { pool } = await import('./db/index.js');
            const u = await pool.query('SELECT elo FROM users WHERE tg_id = $1', [tgId]);
            if (u.rows[0]?.elo != null) {
              playerElo = Number(u.rows[0].elo);
            }
          } catch {}
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

        if (assignedSide === 'top') {
          room.topPlayer = player;
        } else {
          room.bottomPlayer = player;
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
        }

        room.version++;
        markPlayerOnline(id, assignedSide);
        console.log(`[SERVER] Player ${playerId} (${playerName}) joined room ${id} as ${assignedSide} (rated=${room.rated})`);
        broadcastToRoom(id, 'ROOM_SYNC', room);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, room, player, seat: assignedSide }));
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
            if (!room.rating_applied) {
              await applyRoomEloRating(room, winner === 0 ? 1 : 0);
            }
            broadcastToRoom(id, 'ROOM_SYNC', room);
            broadcastToRoom(id, 'GAME_OVER', { winner, forfeit: true, eloResult: room.eloResult, version: room.version });
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

        // Spectator Protection: Only assigned players can move pawns or resign!
        if (body.type === 'MOVE' || body.type === 'RESIGN') {
          const isRealPlayer = resolvedSide !== null;
          if (!isRealPlayer) {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'SPECTATOR_READONLY', message: 'Spectators are read-only and cannot move or resign.' }));
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
              } else {
                state.turn = 1 - expectedTurn;
              }
            } else if (move.type === 'wall') {
              if (state.walls[expectedTurn] > 0) {
                state.blocked[move.cell] = 1;
                state.walls[expectedTurn] = Math.max(0, state.walls[expectedTurn] - 1);
                state.turn = 1 - expectedTurn;
              }
            }
            state.ply = (state.ply || 0) + 1;
            if (body.record) {
              room.moves.push(body.record);
            } else {
              room.moves.push({ move, who: expectedTurn });
            }
          } else if (body.state) {
            // Fallback if full state was sent
            room.gameState = body.state;
          }

          if (state.over !== -1 && !room.rating_applied) {
            await applyRoomEloRating(room, state.over === 0 ? 1 : 0);
          }

          room.version++;
          updateAndBroadcastPresence(id);
          console.log(`[SERVER] Move received from ${senderId} (side=${resolvedSide}, turn=${expectedTurn}) in room ${id}`);
          console.log(`[SERVER] Broadcasting room state v${room.version} for room ${id} (over=${state.over})`);
          broadcastToRoom(id, 'ROOM_SYNC', room);
          broadcastToRoom(id, 'MOVE', { ...body, version: room.version });
          if (state.over !== -1) {
            broadcastToRoom(id, 'GAME_OVER', { winner: state.over, eloResult: room.eloResult, version: room.version });
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, room, version: room.version }));
          return;
        } else if (body.type === 'CHAT') {
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
          if (!room.rating_applied) {
            await applyRoomEloRating(room, winner === 0 ? 1 : 0);
          }
          room.version++;
          updateAndBroadcastPresence(id);
          console.log(`[SERVER] Resign received from ${senderId} in room ${id}`);
          console.log(`[SERVER] Broadcasting room state v${room.version} for room ${id}`);
          broadcastToRoom(id, 'ROOM_SYNC', room);
          broadcastToRoom(id, 'GAME_OVER', { winner, eloResult: room.eloResult, version: room.version });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, room, version: room.version }));
          return;
        } else if (body.type === 'DRAW') {
          if (room.gameState && room.gameState.over === -1) {
            if (room.drawOfferedBy && room.drawOfferedBy !== senderId) {
              room.gameState.over = 2; // draw
              if (!room.rating_applied) {
                await applyRoomEloRating(room, 0.5);
              }
              room.version++;
              updateAndBroadcastPresence(id);
              broadcastToRoom(id, 'ROOM_SYNC', room);
              broadcastToRoom(id, 'GAME_OVER', { winner: 2, draw: true, eloResult: room.eloResult, version: room.version });
            } else {
              room.drawOfferedBy = senderId;
              const offererName = resolvedSide === 'top' ? (room.topPlayer?.name || 'Top') : (room.bottomPlayer?.name || 'Bottom');
              const drawChat = {
                id: `m_${Date.now()}_draw`,
                text: `🤝 ${offererName} offered a draw. Tap Draw to accept.`,
                senderId: 'system',
                senderName: 'System',
                timestamp: Date.now()
              };
              if (!Array.isArray(room.chat)) room.chat = [];
              room.chat.push(drawChat);
              room.version++;
              broadcastToRoom(id, 'CHAT', drawChat);
              broadcastToRoom(id, 'ROOM_SYNC', room);
            }
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, room }));
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
          room.moves = [];
          room.rating_applied = false;
          delete room.eloResult;
          room.drawOfferedBy = null;
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
