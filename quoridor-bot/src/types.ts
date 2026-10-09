export type Player = 0 | 1;
export type Move = { t: 'm'; to: number; pv?: number } | { t: 'w'; c: number } | { t: 'p' };
export type GameStatus = 'pending' | 'active' | 'finished' | 'resigned' | 'forfeit';

export interface State {
  blocked: number[];
  pos: [number, number];
  walls: [number, number];
  turn: Player;
  over: -1 | 0 | 1;
  ply: number;
  lastMove?: { from?: number; to?: number; wall?: number };
  modeByPlayer?: { [id: string]: 'move' | 'wall' | 'resign_confirm' };
  p1_name?: string;
  p2_name?: string;
  eloUpdate?: {
    p1Before: number;
    p1After: number;
    p1Delta: number;
    p2Before: number;
    p2After: number;
    p2Delta: number;
    p1Streak?: number;
    p2Streak?: number;
  };
}

export interface UserRow {
  tg_id: string;
  name: string;
  username: string | null;
  elo: number;
  peak_elo: number;
  wins: number;
  losses: number;
  current_streak: number;
  best_streak: number;
  is_registered: boolean;
  created_at: string;
}

export interface GameRow {
  id: string;
  inline_message_id: string | null;
  chat_type: string;
  p1_id: string;
  p2_id: string | null;
  vs_bot: boolean;
  difficulty: string | null;
  state: State;
  status: GameStatus;
  winner: string | null;
  version: number;
  started_at: string | null;
  ended_at: string | null;
  last_move_at: string | null;
  replay_file_id: string | null;
  p1_elo_before?: number | null;
  p1_elo_after?: number | null;
  p2_elo_before?: number | null;
  p2_elo_after?: number | null;
  rating_applied?: boolean;
}
