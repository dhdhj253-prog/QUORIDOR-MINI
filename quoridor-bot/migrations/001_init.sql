CREATE TABLE IF NOT EXISTS users (
  tg_id BIGINT PRIMARY KEY,
  name TEXT NOT NULL,
  username TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS games (
  id UUID PRIMARY KEY,
  inline_message_id TEXT UNIQUE,
  chat_type TEXT NOT NULL,
  p1_id BIGINT NOT NULL REFERENCES users(tg_id),
  p2_id BIGINT REFERENCES users(tg_id),
  vs_bot BOOLEAN NOT NULL DEFAULT false,
  difficulty TEXT,
  state JSONB NOT NULL,
  status TEXT NOT NULL,
  winner BIGINT,
  version BIGINT NOT NULL DEFAULT 0,
  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  last_move_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  replay_file_id TEXT
);

CREATE TABLE IF NOT EXISTS moves (
  game_id UUID NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  ply INT NOT NULL,
  who BIGINT NOT NULL,
  type TEXT NOT NULL,
  from_cell INT,
  to_cell INT,
  wall_cell INT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (game_id, ply)
);

CREATE INDEX IF NOT EXISTS idx_games_p1 ON games(p1_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_games_p2 ON games(p2_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_games_status ON games(status);
CREATE INDEX IF NOT EXISTS idx_moves_game ON moves(game_id, ply);
