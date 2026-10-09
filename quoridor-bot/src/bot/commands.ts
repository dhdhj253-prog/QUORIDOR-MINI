import type { Bot, Context } from 'grammy';
import { InlineKeyboard, InputFile } from 'grammy';
import {
  recentGames,
  createPracticeGame,
  upsertUser,
  getUser,
  getUserRank,
  countUserGames,
  getLeaderboard
} from '../db/index.js';
import {
  boardKeyboard,
  gameText,
  profileText,
  formatHistoryMessage,
  formatLeaderboardMessage
} from './ui.js';
import { renderProfileCard } from '../render/profile.js';
import { registerReplayHandlers, handleReplay, handleReview } from './replay-handlers.js';

export function registerCommands(bot: Bot) {
  bot.command('start', async ctx => {
    if (ctx.from) {
      await upsertUser({
        id: ctx.from.id,
        name: ctx.from.first_name,
        username: ctx.from.username,
        is_registered: true
      });
    }

    const rawPayload = (ctx.match || ctx.msg?.text?.split(/\s+/)[1] || '').trim();
    if (rawPayload.startsWith('replay_') || rawPayload.startsWith('replay-')) {
      const id = rawPayload.replace(/^replay[_-]/, '');
      await handleReplay(ctx, id, bot);
      return;
    }
    if (rawPayload.startsWith('review_') || rawPayload.startsWith('review-')) {
      const id = rawPayload.replace(/^review[_-]/, '');
      await handleReview(ctx, id, bot);
      return;
    }
    if (rawPayload.startsWith('game_') || rawPayload.startsWith('game-') || rawPayload.startsWith('room_')) {
      const id = rawPayload.replace(/^(game|room)[_-]/, '');
      const webAppUrl = process.env.WEBAPP_URL || '';
      const kb = new InlineKeyboard();
      if (webAppUrl.startsWith('https://')) {
        kb.webApp('🎮 Enter 1v1 Quoridor Match', `${webAppUrl}?gameId=${id}`);
      } else {
        kb.url('🎮 Enter 1v1 Quoridor Match', `https://t.me/${process.env.PUBLIC_BOT_USERNAME || 'panel4wordseekbot'}/app?startapp=${id}`);
      }
      await ctx.reply(`🏰 <b>Quoridor Match #${id}</b>\n\nTap below to enter the live match:`, {
        parse_mode: 'HTML',
        reply_markup: kb
      });
      return;
    }

    const name = ctx.from?.first_name || 'Player';
    const webAppUrl = process.env.WEBAPP_URL || '';
    const kb = new InlineKeyboard();
    if (webAppUrl.startsWith('https://')) {
      kb.webApp('🤖 Play with Bot (Mini App)', `${webAppUrl}?mode=bot`).row();
      kb.webApp('✨ Launch Mini App Arena', webAppUrl).row();
    }
    kb.text('👤 My Profile', 'nav_profile')
      .text('🏆 Leaderboard', 'nav_leaderboard');

    await ctx.reply(
      `🏰 <b>Welcome to Quoridor, ${name}!</b> ♟️\n\n` +
      `Quoridor is an intense strategy game where you race to the opposite end of the board while placing walls to trap and outwit your opponent.\n\n` +
      `⭐ <b>Starting Rating:</b> 1000 ELO\n` +
      `🏆 <b>Ranked Ladder:</b> Win matches to climb the rating tiers (Yellow, Blue, Brown, Green, Red, Violet)!\n\n` +
      `🎮 <b>Choose how to play below:</b>`,
      {
        parse_mode: 'HTML',
        reply_markup: kb,
      }
    );
  });

  bot.command(['newgame', 'play', 'bot'], async ctx => {
    if (ctx.from) {
      await upsertUser({ id: ctx.from.id, name: ctx.from.first_name, username: ctx.from.username, is_registered: true });
    }
    const webAppUrl = process.env.WEBAPP_URL || '';
    const kb = new InlineKeyboard();
    if (webAppUrl.startsWith('https://')) {
      kb.webApp('🤖 Play with Bot (Mini App)', `${webAppUrl}?mode=bot`).row();
      kb.webApp('✨ Launch Mini App Arena', webAppUrl).row();
    }
    kb.text('👤 My Profile', 'nav_profile')
      .text('🏆 Leaderboard', 'nav_leaderboard');

    await ctx.reply('⚔️ <b>Quoridor Game Lobby</b>\n\nChoose your game mode:', {
      parse_mode: 'HTML',
      reply_markup: kb,
    });
  });

  bot.command(['profile', 'me', 'stats'], async ctx => {
    if (!ctx.from) return;
    await sendUserProfile(ctx, ctx.from.id);
  });

  bot.command(['history', 'games'], async ctx => {
    if (!ctx.from) return;
    await sendUserHistory(ctx, ctx.from.id, 0);
  });

  bot.command(['leaderboard', 'top'], async ctx => {
    if (!ctx.from) return;
    await sendLeaderboard(ctx, ctx.from.id);
  });

  bot.command('play', async ctx => {
    if (ctx.chat.type !== 'private') return ctx.reply('Open the bot in a DM and use /play.');
    if (!ctx.from) return;
    await upsertUser({ id: ctx.from.id, name: ctx.from.first_name, username: ctx.from.username, is_registered: true });
    const g = await createPracticeGame(ctx.from.id);
    await ctx.reply(gameText(g), {
      parse_mode: 'HTML',
      reply_markup: boardKeyboard(g, 'move', ctx.from.id),
    });
  });

  bot.command(
    'rules',
    ctx =>
      ctx.reply(
        `♟ <b>Quoridor Rules</b>\n\n` +
        `• 8×8 Grid: 🚀 starts at row 1 (bottom), 🤖 starts at row 8 (top).\n` +
        `• Each player has <b>8 walls</b>.\n\n` +
        `🚶 <b>Move:</b> 1 step orthogonally (⬆️ ⬇️ ⬅️ ➡️).\n` +
        `🦘 <b>Straight Jump:</b> Jump over opponent if space behind is free.\n` +
        `↔️ <b>Bypass:</b> If a wall blocks the straight jump, jump diagonally to their sides.\n` +
        `🧱 <b>Wall:</b> Blocks paths. You can never completely seal off any player from reaching their goal.\n` +
        `🏁 <b>Win:</b> First pawn to reach the opposite row wins!`,
        { parse_mode: 'HTML' }
      )
  );

  bot.command(
    'help',
    ctx =>
      ctx.reply(
        `📖 <b>How to Play & Commands</b>\n\n` +
        `1. <b>/profile:</b> View your gradient ELO card & statistics.\n` +
        `2. <b>/leaderboard:</b> View global top rated players.\n` +
        `3. <b>/history:</b> View your recent match history with +/- ELO changes.\n` +
        `4. <b>/play:</b> Start a practice match against the Bot.\n` +
        `5. <b>Challenge Friends:</b> Type @${process.env.PUBLIC_BOT_USERNAME || 'quoridorplay_bot'} in any chat and send the card!`,
        { parse_mode: 'HTML' }
      )
  );

  registerReplayHandlers(bot);

  // Navigation Callback Queries
  bot.callbackQuery('nav_newgame', async ctx => {
    if (!ctx.from) return;
    await ctx.answerCallbackQuery();
    const kb = new InlineKeyboard()
      .switchInline('👥 Play with friends', '')
      .row()
      .text('🤖 Practice vs Bot', 'practice');

    await ctx.reply('⚔️ <b>Quoridor Game Lobby</b>\n\nChoose your game mode:', {
      parse_mode: 'HTML',
      reply_markup: kb,
    });
  });

  bot.callbackQuery('nav_profile', async ctx => {
    if (!ctx.from) return;
    await ctx.answerCallbackQuery();
    await sendUserProfile(ctx, ctx.from.id);
  });

  bot.callbackQuery(/^nav_history:(\d+)$/, async ctx => {
    if (!ctx.from) return;
    const page = Number(ctx.match[1] || 0);
    await ctx.answerCallbackQuery();
    await sendUserHistory(ctx, ctx.from.id, page, true);
  });

  bot.callbackQuery('nav_leaderboard', async ctx => {
    if (!ctx.from) return;
    await ctx.answerCallbackQuery();
    await sendLeaderboard(ctx, ctx.from.id, true);
  });
}

async function sendUserProfile(ctx: Context, userId: number) {
  let user = await getUser(userId);
  if (!user && ctx.from) {
    await upsertUser({ id: ctx.from.id, name: ctx.from.first_name, username: ctx.from.username, is_registered: true });
    user = await getUser(userId);
  }
  if (!user) return ctx.reply('Profile not found. Please type /start to create your profile.');

  const rank = await getUserRank(userId);
  const caption = profileText(user, rank);
  const kb = new InlineKeyboard()
    .text('📜 Match History', 'nav_history:0')
    .text('🏆 Leaderboard', 'nav_leaderboard')
    .row()
    .switchInline('👥 Challenge a Friend', '');

  try {
    const pngBuffer = await renderProfileCard({
      name: user.name,
      username: user.username,
      elo: user.elo,
      peakElo: user.peak_elo,
      wins: user.wins,
      losses: user.losses,
      currentStreak: user.current_streak,
      bestStreak: user.best_streak
    });

    await ctx.replyWithPhoto(new InputFile(pngBuffer, 'profile.png'), {
      caption,
      parse_mode: 'HTML',
      reply_markup: kb
    });
  } catch (err) {
    // Fallback to text profile if image rendering encounters an environment issue
    await ctx.reply(caption, {
      parse_mode: 'HTML',
      reply_markup: kb
    });
  }
}

async function sendUserHistory(ctx: Context, userId: number, page: number = 0, isEdit: boolean = false) {
  let user = await getUser(userId);
  if (!user && ctx.from) {
    await upsertUser({ id: ctx.from.id, name: ctx.from.first_name, username: ctx.from.username, is_registered: true });
    user = await getUser(userId);
  }
  if (!user) return ctx.reply('Please /start the bot first.');

  const pageSize = 5;
  const totalGames = await countUserGames(userId);
  const totalPages = Math.ceil(totalGames / pageSize) || 1;
  const safePage = Math.max(0, Math.min(page, totalPages - 1));

  const games = await recentGames(userId, pageSize, safePage * pageSize);
  const { text, kb } = formatHistoryMessage(user, games, safePage, totalPages);

  if (isEdit && ctx.callbackQuery?.message) {
    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: kb }).catch(async () => {
      await ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb });
    });
  } else {
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb });
  }
}

async function sendLeaderboard(ctx: Context, userId: number, isEdit: boolean = false) {
  const topUsers = await getLeaderboard(10);
  const { text, kb } = formatLeaderboardMessage(topUsers, userId);

  if (isEdit && ctx.callbackQuery?.message) {
    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: kb }).catch(async () => {
      await ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb });
    });
  } else {
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb });
  }
}
