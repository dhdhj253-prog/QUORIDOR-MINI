export type Player = 0 | 1;

export interface GameState {
  blocked: Uint8Array;
  pos: [number, number]; // [P0 (row 7 -> 0), P1 (row 0 -> 7)]
  walls: [number, number]; // remaining walls [8, 8]
  turn: Player;
  over: -1 | Player | 2;
  ply: number;
}

const N = 8;
const S = 64;
const GOAL = [0, 7]; // P0 goal is row 0; P1 goal is row 7

// Precompute adjacency for 8x8 grid
const ADJ: number[][] = [];
const GC: [number[], number[]] = [[], []];

for (let c = 0; c < S; c++) {
  const r = c >> 3;
  const k = c & 7;
  const a: number[] = [];
  [[-1, 0], [1, 0], [0, -1], [0, 1]].forEach(([dr, dc]) => {
    const R = r + dr;
    const K = k + dc;
    if (R >= 0 && R < N && K >= 0 && K < N) a.push(R * N + K);
  });
  ADJ.push(a);
  if (r === 0) GC[0].push(c);
  if (r === 7) GC[1].push(c);
}

export function createInitialState(first: Player = 0): GameState {
  return {
    blocked: new Uint8Array(S),
    pos: [60, 3], // P0 starts at cell 60 (row 7, col 4), P1 starts at cell 3 (row 0, col 3)
    walls: [8, 8],
    turn: first,
    over: -1,
    ply: 0
  };
}

export function bfs(state: GameState, src: number[]): Int8Array {
  const d = new Int8Array(S);
  d.fill(99);
  const q = new Int8Array(S);
  let h = 0;
  let t = 0;

  for (let i = 0; i < src.length; i++) {
    const s = src[i];
    if (!state.blocked[s]) {
      d[s] = 0;
      q[t++] = s;
    }
  }

  while (h < t) {
    const c = q[h++];
    const nd = d[c] + 1;
    const a = ADJ[c];
    for (let i = 0; i < a.length; i++) {
      const n = a[i];
      if (!state.blocked[n] && d[n] === 99) {
        d[n] = nd;
        q[t++] = n;
      }
    }
  }
  return d;
}

export function getPawnMoves(state: GameState, who: Player): number[] {
  const p = state.pos[who];
  const o = state.pos[1 - who];
  const res: number[] = [];
  const pr = p >> 3;
  const pc = p & 7;

  for (const n of ADJ[p]) {
    if (state.blocked[n]) continue;
    if (n !== o) {
      res.push(n);
      continue;
    }
    // Jump opponent
    const nr = n >> 3;
    const nc = n & 7;
    const dr = nr - pr;
    const dc = nc - pc;
    const jr = nr + dr;
    const jc = nc + dc;
    const straightOnBoard = jr >= 0 && jr < N && jc >= 0 && jc < N;

    if (straightOnBoard && !state.blocked[jr * N + jc]) {
      res.push(jr * N + jc);
    } else {
      // Diagonal bypass if straight jump blocked
      const candidates: number[] = [];
      if (dr !== 0) {
        if (nc - 1 >= 0) candidates.push(nr * N + (nc - 1));
        if (nc + 1 < N) candidates.push(nr * N + (nc + 1));
      } else {
        if (nr - 1 >= 0) candidates.push((nr - 1) * N + nc);
        if (nr + 1 < N) candidates.push((nr + 1) * N + nc);
      }
      for (const t of candidates) {
        if (state.blocked[t]) continue;
        const tr = t >> 3;
        if (!straightOnBoard && tr === GOAL[who]) continue;
        res.push(t);
      }
    }
  }
  return res;
}

export function isWallLegal(state: GameState, cell: number, who: Player): boolean {
  if (state.blocked[cell] || cell === state.pos[0] || cell === state.pos[1] || state.walls[who] < 1) {
    return false;
  }
  state.blocked[cell] = 1;
  try {
    const p0CanReach = bfs(state, GC[0])[state.pos[0]] < 99;
    const p1CanReach = bfs(state, GC[1])[state.pos[1]] < 99;
    return p0CanReach && p1CanReach;
  } finally {
    state.blocked[cell] = 0;
  }
}

export type Move = 
  | { type: 'move'; to: number; from: number }
  | { type: 'wall'; cell: number };

export function applyMove(state: GameState, who: Player, move: Move): GameState {
  const next: GameState = {
    blocked: new Uint8Array(state.blocked),
    pos: [state.pos[0], state.pos[1]],
    walls: [state.walls[0], state.walls[1]],
    turn: (1 - who) as Player,
    over: -1,
    ply: state.ply + 1
  };

  if (move.type === 'move') {
    next.pos[who] = move.to;
    const row = move.to >> 3;
    if (row === GOAL[who]) {
      next.over = who;
    }
  } else {
    next.blocked[move.cell] = 1;
    next.walls[who] = state.walls[who] - 1;
  }

  return next;
}

// AI Engine Thinker
export function botThink(state: GameState, botWho: Player = 1, thinkDelayMs = 250): Promise<Move> {
  return new Promise(resolve => {
    setTimeout(() => {
      const opp = (1 - botWho) as Player;
      const pm = getPawnMoves(state, botWho);

      // Check if any pawn move reaches goal immediately
      for (const m of pm) {
        if ((m >> 3) === GOAL[botWho]) {
          return resolve({ type: 'move', to: m, from: state.pos[botWho] });
        }
      }

      const botDist = bfs(state, GC[botWho]);
      const oppDist = bfs(state, GC[opp]);
      const myCurrentD = botDist[state.pos[botWho]];
      const oppCurrentD = oppDist[state.pos[opp]];

      // If opponent is closer to goal and bot has walls, look for critical blocking wall
      if (oppCurrentD <= myCurrentD && state.walls[botWho] > 0) {
        let bestWall = -1;
        let maxOppDelay = 0;

        for (let cell = 0; cell < 64; cell++) {
          if (isWallLegal(state, cell, botWho)) {
            state.blocked[cell] = 1;
            const newOppD = bfs(state, GC[opp])[state.pos[opp]];
            const newBotD = bfs(state, GC[botWho])[state.pos[botWho]];
            state.blocked[cell] = 0;

            const oppGain = newOppD - oppCurrentD;
            const botLoss = newBotD - myCurrentD;

            if (oppGain >= 1 && oppGain > botLoss) {
              if (oppGain > maxOppDelay) {
                maxOppDelay = oppGain;
                bestWall = cell;
              }
            }
          }
        }

        if (bestWall !== -1 && maxOppDelay >= 2) {
          return resolve({ type: 'wall', cell: bestWall });
        }
      }

      // Default: choose pawn move that minimizes distance to goal
      let bestMove = pm[0];
      let minDistance = 999;

      for (const m of pm) {
        const d = botDist[m];
        if (d < minDistance) {
          minDistance = d;
          bestMove = m;
        }
      }

      resolve({ type: 'move', to: bestMove, from: state.pos[botWho] });
    }, thinkDelayMs);
  });
}
