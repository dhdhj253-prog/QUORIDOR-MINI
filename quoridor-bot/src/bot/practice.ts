// Practice-vs-bot state machine hook. Kept separate so DM conversation handling
// can be expanded without mixing it with inline multiplayer callbacks.
export const PRACTICE_DIFFICULTY = { mid: { thinkMs: 600, depthCap: 8 } } as const;
