export type Player = 0 | 1;

const N = 8;
const S = 64;
export const GOAL = [0, 7]; // P0 goal is row 0; P1 goal is row 7

// Precompute adjacency for 8x8 grid
const ADJ: number[][] = [];
export const GC: [number[], number[]] = [[], []];

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

export function bfs(state: { blocked: number[] | Uint8Array }, src: number[]): Int8Array {
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

export function getPawnMoves(state: { pos: [number, number]; blocked: number[] | Uint8Array }, who: Player): number[] {
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

export function isWallLegal(
  state: { pos: [number, number]; blocked: number[] | Uint8Array; walls: [number, number] },
  cell: number,
  who: Player
): boolean {
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

export type BotMove =
  | { type: 'move'; from: number; to: number }
  | { type: 'wall'; cell: number };

export function chooseBotMove(
  state: { pos: [number, number]; blocked: number[] | Uint8Array; walls: [number, number] },
  botWho: Player
): BotMove {
  const humanWho = (1 - botWho) as Player;
  const pm = getPawnMoves(state, botWho);

  if (pm.length === 0) {
    return { type: 'move', from: state.pos[botWho], to: state.pos[botWho] };
  }

  // 1. If any pawn move reaches goal immediately, take it
  for (const m of pm) {
    if ((m >> 3) === GOAL[botWho]) {
      return { type: 'move', from: state.pos[botWho], to: m };
    }
  }

  // 2. Compute shortest path lengths for both pawns
  const botDist = bfs(state, GC[botWho]);
  const humanDist = bfs(state, GC[humanWho]);
  const botPathLen = botDist[state.pos[botWho]];
  const humanPathLen = humanDist[state.pos[humanWho]];

  // 3. About 20% of turns pick a random legal pawn move so it can be beaten
  if (Math.random() < 0.20) {
    const randomMove = pm[Math.floor(Math.random() * pm.length)];
    return { type: 'move', from: state.pos[botWho], to: randomMove };
  }

  // 4. Place a legal wall when human's shortest path is shorter than the bot's by 2 or more,
  // choosing the wall that increases the human's path the most
  if (humanPathLen <= botPathLen - 2 && state.walls[botWho] > 0) {
    let bestWall = -1;
    let maxIncrease = 0;

    for (let cell = 0; cell < 64; cell++) {
      if (isWallLegal(state, cell, botWho)) {
        state.blocked[cell] = 1;
        const newHumanD = bfs(state, GC[humanWho])[state.pos[humanWho]];
        state.blocked[cell] = 0;

        const increase = newHumanD - humanPathLen;
        if (increase > maxIncrease) {
          maxIncrease = increase;
          bestWall = cell;
        }
      }
    }

    if (bestWall !== -1 && maxIncrease > 0) {
      return { type: 'wall', cell: bestWall };
    }
  }

  // 5. Normally move along the shortest path
  let bestMove = pm[0];
  let minDistance = 999;
  for (const m of pm) {
    const d = botDist[m];
    if (d < minDistance) {
      minDistance = d;
      bestMove = m;
    }
  }

  return { type: 'move', from: state.pos[botWho], to: bestMove };
}
