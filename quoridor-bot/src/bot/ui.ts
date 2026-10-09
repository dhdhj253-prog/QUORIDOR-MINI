import { InlineKeyboard } from 'grammy';
import { THEME, type Mode } from '../theme.js';
import type { GameRow, State, Player, UserRow } from '../types.js';
import { Engine, toEngineState } from '../engine/index.js';
import { getProgressToNextTier, renderProgressBar } from '../engine/elo.js';

export function blueId(g: GameRow) {
  return (g.state as any).blue_id ?? Number(g.p1_id);
}

export function blueRedFor(g: GameRow) {
  const b = blueId(g);
  return { blue: b, red: b === Number(g.p1_id) ? Number(g.p2_id) : Number(g.p1_id) };
}

export function gameText(g: GameRow, mode: Mode = 'move') {
  const s = g.state;
  const isVsBot = g.vs_bot;

  const p1Name = s.p1_name || (isVsBot ? 'You' : 'Player 1');
  const p2Name = isVsBot ? 'Bot' : (s.p2_name || 'Player 2');

  const p1 = `${THEME.blue} ${p1Name}`;
  const p2 = isVsBot ? `${THEME.bot} Bot` : `${THEME.red} ${p2Name}`;

  if (s.over >= 0) {
    const isP1Winner = s.over === 0;
    const winnerName = isP1Winner ? p1Name : p2Name;
    const loserName = isP1Winner ? p2Name : p1Name;

    let eloBlock = '';
    if (s.eloUpdate) {
      const u = s.eloUpdate;
      const wBefore = isP1Winner ? u.p1Before : u.p2Before;
      const wAfter = isP1Winner ? u.p1After : u.p2After;
      const wDelta = isP1Winner ? u.p1Delta : u.p2Delta;
      const wStreak = (isP1Winner ? u.p1Streak : u.p2Streak) || 0;

      const lBefore = isP1Winner ? u.p2Before : u.p1Before;
      const lAfter = isP1Winner ? u.p2After : u.p1After;
      const lDelta = isP1Winner ? u.p2Delta : u.p1Delta;

      const streakTxt = wStreak > 1 ? ` 🔥 ${wStreak}-Streak` : '';
      eloBlock = `\n\n📊 <b>Rating Changes:</b>\n` +
        `👑 <b>${winnerName}:</b> ${wBefore} ➔ <b>${wAfter}</b> (<code>+${wDelta}</code>)${streakTxt}\n` +
        `⚔️ <b>${loserName}:</b> ${lBefore} ➔ <b>${lAfter}</b> (<code>${lDelta}</code>)`;
    }

    return `🏆 <b>${isP1Winner ? p1 : p2} wins!</b>\n<pre>${p1Name} (${s.walls[0]}⬛) · ${p2Name} (${s.walls[1]}⬛)</pre>${eloBlock}`;
  }

  const active = s.turn === 0 ? p1 : p2;
  return `▶️ <b>Turn: ${active}</b> · <pre>${p1Name}:${s.walls[0]}⬛ | ${p2Name}:${s.walls[1]}⬛</pre>`;
}

function cellLabel(c: number, s: State, isVsBot = false) {
  if (s.pos[0] === c) return THEME.blue;
  if (s.pos[1] === c) return isVsBot ? THEME.bot : THEME.red;
  if (s.blocked[c]) return THEME.wall;
  return THEME.empty;
}

export function boardKeyboard(g: GameRow, mode: Mode = 'move', viewer?: number) {
  const kb = new InlineKeyboard();
  const s = g.state;
  const isVsBot = g.vs_bot;

  const moveMap = new Map<string, number>();

  if (g.status === 'active' && s.over < 0) {
    if (!isVsBot || s.turn === 0) {
      const e = toEngineState(s);
      const moves = Engine.pawnMoves(e, s.turn);
      const pr = s.pos[s.turn] >> 3;
      const pc = s.pos[s.turn] & 7;

      for (const c of moves) {
        const tr = c >> 3;
        const tc = c & 7;

        if (tr > pr && tc === pc) moveMap.set('up', c);
        else if (tr < pr && tc === pc) moveMap.set('down', c);
        else if (tr === pr && tc < pc) moveMap.set('left', c);
        else if (tr === pr && tc > pc) moveMap.set('right', c);
        else if (tr > pr && tc < pc) moveMap.set('upleft', c);
        else if (tr > pr && tc > pc) moveMap.set('upright', c);
        else if (tr < pr && tc < pc) moveMap.set('downleft', c);
        else if (tr < pr && tc > pc) moveMap.set('downright', c);
      }
    }
  }

  // 8 rows of 8 board buttons
  for (let r = 7; r >= 0; r--) {
    for (let c = 0; c < 8; c++) {
      const x = r * 8 + c;
      kb.text(cellLabel(x, s, isVsBot), `g:${g.id}:${x}:wall`);
    }
    kb.row();
  }

  if (s.over >= 0) {
    return resultKeyboard(process.env.PUBLIC_BOT_USERNAME || 'quoridorplay_bot', g.id);
  }

  // Directional Controller
  kb.text('⬆️', `dir:${g.id}:up`).row();
  kb.text('⬅️', `dir:${g.id}:left`)
    .text('➡️', `dir:${g.id}:right`)
    .row();
  kb.text('⬇️', `dir:${g.id}:down`).row();

  if (moveMap.has('upleft') || moveMap.has('upright')) {
    if (moveMap.has('upleft')) kb.text('↖️ Jump Left', `dir:${g.id}:upleft`);
    if (moveMap.has('upright')) kb.text('↗️ Jump Right', `dir:${g.id}:upright`);
    kb.row();
  }
  if (moveMap.has('downleft') || moveMap.has('downright')) {
    if (moveMap.has('downleft')) kb.text('↙️ Jump Left', `dir:${g.id}:downleft`);
    if (moveMap.has('downright')) kb.text('↘️ Jump Right', `dir:${g.id}:downright`);
    kb.row();
  }

  kb.text('🏳 Resign', `do_resign:${g.id}`);
  return kb;
}

export function joinKeyboard(tokenOrId: string, step: 'open' | 'p2' = 'open') {
  const kb = new InlineKeyboard();
  if (step === 'open') {
    kb.text('🤝 Join Game (0/2)', `join_open:${tokenOrId}`);
  } else {
    kb.text('🤝 Join as Player 2 (1/2)', `join_p2:${tokenOrId}`);
  }
  return kb;
}

export function resultKeyboard(botUsername: string, id: string) {
  return new InlineKeyboard()
    .text(`${THEME.replay} 720p Replay`, `replay:${id}`)
    .text(`${THEME.review} Review`, `review:${id}`)
    .row()
    .text('👤 Profile', 'nav_profile')
    .text('📜 History', 'nav_history:0')
    .row()
    .text('🤖 Practice vs Bot', 'practice')
    .switchInline('👥 Play with Friends', '');
}

export function profileText(user: UserRow, rank: number): string {
  const total = user.wins + user.losses;
  const winRate = total > 0 ? ((user.wins / total) * 100).toFixed(1) : '0.0';
  const streakText = user.current_streak > 0 ? `🔥 ${user.current_streak} Wins` : '0';

  return `👤 <b>${user.name || user.username || 'Player'}</b> · 🎖️ <b>Rank #${rank}</b>\n\n` +
    `⭐ <b>Rating: ${user.elo} ELO</b> (Peak: ${user.peak_elo})\n\n` +
    `📊 <b>Statistics:</b>\n` +
    `• ⚔️ Total Games: <b>${total}</b>\n` +
    `• 🏆 Wins: <b>${user.wins}</b> | 🛡️ Losses: <b>${user.losses}</b> (<b>${winRate}%</b> WR)\n` +
    `• 🔥 Current Streak: <b>${streakText}</b>\n` +
    `• 👑 Best Streak: <b>${user.best_streak}</b> Wins`;
}

export function formatHistoryMessage(user: UserRow, games: GameRow[], page: number, totalPages: number): { text: string; kb: InlineKeyboard } {
  if (!games.length) {
    const kb = new InlineKeyboard().text('🤖 Practice vs Bot', 'practice').switchInline('👥 Play with Friends', '');
    return {
      text: `📜 <b>Match History — ${user.name || 'Player'}</b>\n\nNo games played yet! Use /play to start a game.`,
      kb
    };
  }

  let text = `📜 <b>Match History — ${user.name || 'Player'} (${user.elo} ELO)</b>\n\n`;

  for (let i = 0; i < games.length; i++) {
    const g = games[i];
    const isP1 = Number(g.p1_id) === Number(user.tg_id);
    const opponentName = isP1 ? (g.vs_bot ? 'Bot 🤖' : g.state.p2_name || 'Player 2') : (g.state.p1_name || 'Player 1');
    const isWinner = g.winner && Number(g.winner) === Number(user.tg_id);
    const statusIcon = isWinner ? '🟢 WIN' : g.winner ? '🔴 LOSS' : '⏳ ACTIVE';

    const before = isP1 ? g.p1_elo_before : g.p2_elo_before;
    const after = isP1 ? g.p1_elo_after : g.p2_elo_after;

    let deltaStr = '';
    if (before != null && after != null) {
      const delta = after - before;
      deltaStr = ` · ${delta >= 0 ? '+' + delta : delta} (${before}➔${after})`;
    }

    const plyCount = g.state?.ply ? `${g.state.ply} moves` : 'In progress';
    const dateStr = g.ended_at ? new Date(g.ended_at).toLocaleDateString() : 'Recent';

    text += `${i + 1 + page * 5}. ${statusIcon} vs <b>${opponentName}</b>${deltaStr}\n   <pre>♟️ ${plyCount} · ${dateStr} · #${g.id.slice(0, 6)}</pre>\n\n`;
  }

  const kb = new InlineKeyboard();
  if (page > 0) {
    kb.text('⬅️ Prev', `nav_history:${page - 1}`);
  }
  kb.text(`📄 ${page + 1}/${totalPages || 1}`, 'noop');
  if (page + 1 < totalPages) {
    kb.text('Next ➡️', `nav_history:${page + 1}`);
  }
  kb.row().text('👤 My Profile', 'nav_profile').text('🏆 Leaderboard', 'nav_leaderboard');

  return { text, kb };
}

export function formatLeaderboardMessage(users: UserRow[], viewerId?: number): { text: string; kb: InlineKeyboard } {
  let text = `🏆 <b>TOP QUORIDOR DUELISTS</b>\n\n`;

  if (!users.length) {
    text += `<i>No rated matches yet. Play a game to claim #1!</i>`;
  } else {
    for (let i = 0; i < users.length; i++) {
      const u = users[i];
      const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `<b>#${i + 1}</b>`;
      const isViewer = viewerId && Number(u.tg_id) === viewerId;
      const total = u.wins + u.losses;
      const wr = total > 0 ? ((u.wins / total) * 100).toFixed(0) : '0';
      const name = (u.name || u.username || 'Player').slice(0, 15);
      const youTag = isViewer ? ' 👈 (You)' : '';

      text += `${medal} <b>${name}</b>: <b>${u.elo} ELO</b> (${u.wins}W/${u.losses}L · ${wr}%)${youTag}\n`;
    }
  }

  const kb = new InlineKeyboard()
    .text('👤 My Profile', 'nav_profile')
    .text('📜 My History', 'nav_history:0')
    .row()
    .switchInline('👥 Challenge a Friend', '');

  return { text, kb };
}
