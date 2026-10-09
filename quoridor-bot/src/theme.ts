export const THEME = {
  empty: '▫',
  wall: '⬛',
  blue: '🚀',
  red: '👾',
  bot: '🤖',
  hint: '🔹',
  last: '🔶',
  move: '🚶',
  wallMode: '🧱',
  resign: '🏳',
  replay: '🎞',
  review: '📖'
} as const;

export const MODE = { MOVE: 'move', WALL: 'wall', RESIGN_CONFIRM: 'resign_confirm' } as const;
export type Mode = 'move' | 'wall' | 'resign_confirm';
