import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateEloDelta, getEloGradient, getProgressToNextTier, renderProgressBar, ELO_TIERS } from '../src/engine/elo.js';
import { generateProfileSvg, renderProfileCard } from '../src/render/profile.js';
import { migrate, pool, upsertUser, getUser, isUserRegistered, commitMove, createGame, joinGame } from '../src/db/index.js';

test('ELO Calculation - Equal Ratings (1200 vs 1200)', () => {
  const { winnerGain, loserLoss } = calculateEloDelta(1200, 1200, 20, 20);
  assert.equal(winnerGain, 10);
  assert.equal(loserLoss, 10);
});

test('ELO Calculation - Provisional Higher Multiplier for New Players', () => {
  const { winnerGain, loserLoss } = calculateEloDelta(1200, 1200, 5, 5);
  assert.equal(winnerGain, 16);
  assert.equal(loserLoss, 16);
});

test('ELO Calculation - Upset (Lower beats Higher)', () => {
  const { winnerGain, loserLoss } = calculateEloDelta(1200, 1600, 20, 20);
  // Expected win is ~0.09, so gain should be ~18
  assert.ok(winnerGain >= 18);
});

test('200-ELO Gradient Mapping for All Ranges', () => {
  const tierUnder800 = getEloGradient(750);
  assert.deepEqual(tierUnder800.colors, ['#616161', '#9E9E9E']);

  const tier800 = getEloGradient(900);
  assert.deepEqual(tier800.colors, ['#8D6E63', '#D7CCC8']);

  const tier1000 = getEloGradient(1100);
  assert.deepEqual(tier1000.colors, ['#78909C', '#ECEFF1']);

  const tier1200 = getEloGradient(1250);
  assert.deepEqual(tier1200.colors, ['#FFB300', '#FFE082']);

  const tier1400 = getEloGradient(1450);
  assert.deepEqual(tier1400.colors, ['#00E676', '#B9F6CA']);

  const tier1600 = getEloGradient(1700);
  assert.deepEqual(tier1600.colors, ['#00B0FF', '#80D8FF']);

  const tier1800 = getEloGradient(1900);
  assert.deepEqual(tier1800.colors, ['#D500F9', '#FF80AB']);

  const tier2000 = getEloGradient(2100);
  assert.deepEqual(tier2000.colors, ['#FF3D00', '#FFAB40']);

  const tier2200 = getEloGradient(2300);
  assert.deepEqual(tier2200.colors, ['#FF1744', '#FF8A80']);

  const tier2400Plus = getEloGradient(2500);
  assert.deepEqual(tier2400Plus.colors, ['#00F260', '#0575E6', '#E040FB']);
});

test('Progress calculation to next 200 ELO bracket', () => {
  const p = getProgressToNextTier(1260);
  assert.equal(p.currentInTier, 60);
  assert.equal(p.neededInTier, 200);
  assert.equal(p.percent, 30);
  assert.equal(p.nextTarget, 1400);

  const bar = renderProgressBar(p.percent, 10);
  assert.equal(bar, '███░░░░░░░');
});

test('Profile Card SVG & Sharp PNG rendering', async () => {
  const svg = generateProfileSvg({
    name: 'Alex',
    username: 'alex_quoridor',
    elo: 1660,
    peakElo: 1710,
    wins: 78,
    losses: 46,
    currentStreak: 3,
    bestStreak: 8
  });

  assert.ok(svg.includes('1660'));
  assert.ok(svg.includes('Alex'));
  assert.ok(svg.includes('GAMES'));

  const pngBuf = await renderProfileCard({
    name: 'Alex',
    username: 'alex_quoridor',
    elo: 1660,
    peakElo: 1710,
    wins: 78,
    losses: 46,
    currentStreak: 3,
    bestStreak: 8
  });

  assert.ok(pngBuf.length > 1000);
});

test('Database - Migrations, Gatekeeping & ELO Match Updates', async () => {
  await migrate();

  // Test Gatekeeping
  const isReg1 = await isUserRegistered(999999);
  assert.equal(isReg1, false);

  // Register users
  await upsertUser({ id: 101, name: 'Alice', username: 'alice_q', is_registered: true });
  await upsertUser({ id: 102, name: 'Bob', username: 'bob_q', is_registered: true });

  const isRegAlice = await isUserRegistered(101);
  assert.equal(isRegAlice, true);

  const u1 = await getUser(101);
  assert.equal(u1?.elo, 1200);
  assert.equal(u1?.wins, 0);

  // Create match
  const g = await createGame(101, { chatType: 'inline' });
  const activeG = await joinGame(g.id, 102, 'Bob');

  // Finish match with Alice winning
  const finalState = { ...activeG.state, over: 0 as const };
  const finishedGame = await commitMove(
    activeG.id,
    101,
    activeG.version,
    finalState,
    { t: 'm', to: 0, pv: 8 },
    'finished',
    0
  );

  const updatedAlice = await getUser(101);
  const updatedBob = await getUser(102);

  assert.ok(updatedAlice!.elo > 1200);
  assert.equal(updatedAlice!.wins, 1);
  assert.equal(updatedAlice!.current_streak, 1);

  assert.ok(updatedBob!.elo < 1200);
  assert.equal(updatedBob!.losses, 1);
  assert.equal(updatedBob!.current_streak, 0);
});

test('History Pruning - Keeps only recent matches per user to prevent DB bloat', async () => {
  const { pruneOldGames, recentGames } = await import('../src/db/index.js');
  const userId = 555;
  await upsertUser({ id: userId, name: 'Tester', username: 'tester' });
  await upsertUser({ id: 999, name: 'Opponent', username: 'opponent' });

  // Create 15 games
  for (let i = 0; i < 15; i++) {
    const g = await createGame(userId, { chatType: 'inline' });
    const ag = await joinGame(g.id, 999, 'Opponent');
    const finalState = { ...ag.state, over: 0 as const };
    await commitMove(ag.id, userId, ag.version, finalState, { t: 'm', to: 0, pv: 8 }, 'finished', 0);
  }

  await pruneOldGames([userId], 10);
  const games = await recentGames(userId, 20);
  assert.ok(games.length <= 10);
});

test('Atomic executeMove - Turn switching, wall placement, and out-of-turn rejection', async () => {
  const { executeMove, claimPlayer1 } = await import('../src/db/index.js');
  const p1 = 701;
  const p2 = 702;
  await upsertUser({ id: p1, name: 'Ziprya', is_registered: true });
  await upsertUser({ id: p2, name: 'Priyansh', is_registered: true });

  const gameId = (await import('node:crypto')).randomUUID();
  await claimPlayer1(gameId, p1, 'Ziprya');
  const activeG = await joinGame(gameId, p2, 'Priyansh');

  // Match started: Player 1 (Ziprya)'s turn (turn: 0)
  // If Priyansh tries to move before Ziprya, it should be rejected with clear message
  const p2EarlyRes = await executeMove(activeG.id, p2, { type: 'move', dir: 'up' });
  assert.equal(p2EarlyRes.ok, false);
  assert.ok(p2EarlyRes.error.includes("Ziprya's turn"));

  // Ziprya makes a move downwards
  const p1MoveRes = await executeMove(activeG.id, p1, { type: 'move', dir: 'down' });
  assert.equal(p1MoveRes.ok, true);
  assert.equal(p1MoveRes.game.state.turn, 1);

  // Now it's Priyansh's turn: Ziprya cannot move
  const p1EarlyRes = await executeMove(activeG.id, p1, { type: 'move', dir: 'down' });
  assert.equal(p1EarlyRes.ok, false);
  assert.ok(p1EarlyRes.error.includes("Priyansh's turn"));

  // Priyansh places a wall on cell 18
  const p2WallRes = await executeMove(activeG.id, p2, { type: 'wall', cell: 18 });
  assert.equal(p2WallRes.ok, true);
  assert.equal(p2WallRes.game.state.blocked[18], 1);
  assert.equal(p2WallRes.game.state.walls[1], 7);
  assert.equal(p2WallRes.game.state.turn, 0);

  // Trying to place a wall on the same cell should report it's already placed
  const p1SameWallRes = await executeMove(activeG.id, p1, { type: 'wall', cell: 18 });
  assert.equal(p1SameWallRes.ok, false);
  assert.ok(p1SameWallRes.error.includes("already placed"));
});

