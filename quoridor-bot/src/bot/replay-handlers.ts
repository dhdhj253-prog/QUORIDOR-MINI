import type { Bot, Context } from 'grammy';
import { InlineKeyboard, InputFile } from 'grammy';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { gameMoves, getGame, userNames, cacheReplay } from '../db/index.js';
import { initialReplayState, replayStates, buildReplay } from '../render/replay.js';
import { cellName } from '../engine/index.js';
import { gameText } from './ui.js';
import { RenderQueue } from '../render/queue.js';
import { THEME } from '../theme.js';

const queue = new RenderQueue(Number(process.env.RENDER_CONCURRENCY || 1));

export async function handleReplay(ctx: Context, id: string, bot: Bot) {
  const userId = ctx.from?.id;
  if (!userId) return;

  const g = await getGame(id);
  if (!g) {
    if (ctx.callbackQuery) {
      await ctx.answerCallbackQuery({ text: '⚠️ Game record not found.', show_alert: true }).catch(() => {});
    } else {
      await bot.api.sendMessage(userId, '⚠️ Game record not found.').catch(() => {});
    }
    return;
  }

  // 1. Check if Telegram file_id is already cached in database
  if (g.replay_file_id) {
    try {
      await bot.api.sendVideo(userId, g.replay_file_id, {
        caption: `🎞 <b>Quoridor Match Replay (720p)</b>\n🎮 Match: <code>#${id.slice(0, 8)}</code>`,
        parse_mode: 'HTML',
        width: 720,
        height: 720,
        supports_streaming: true,
      });
      return;
    } catch {
      // Re-render if cached file_id expired
    }
  }

  // 2. Send status progress notification to user
  let statusMsg: any = null;
  try {
    statusMsg = await bot.api.sendMessage(userId, '🎬 <i>Rendering 720p match replay video with FFmpeg...</i>', {
      parse_mode: 'HTML',
    });
  } catch {
    if (ctx.callbackQuery) {
      await ctx.answerCallbackQuery({
        text: `Please open @${process.env.PUBLIC_BOT_USERNAME || 'quoridorplay_bot'} in DM first so the bot can send your video!`,
        show_alert: true,
      }).catch(() => {});
    }
    return;
  }

  const moves = await gameMoves(id);
  const initial = (g.state as any)?.blue_id !== undefined ? { ...initialReplayState(), turn: (g.state as any).first ?? 0 } : initialReplayState();
  const states = replayStates(moves, initial);

  const replaysDir = join(process.cwd(), 'replays');
  await mkdir(replaysDir, { recursive: true });
  const out = join(replaysDir, `quoridor-${id}.mp4`);

  queue.add(async () => {
    try {
      await buildReplay(states, out);
      const msg = await bot.api.sendVideo(userId, new InputFile(out), {
        caption: `🎞 <b>Quoridor Match Replay (720p)</b>\n🎮 Match: <code>#${id.slice(0, 8)}</code>\n🔄 Total Moves: ${moves.length}`,
        parse_mode: 'HTML',
        width: 720,
        height: 720,
        supports_streaming: true,
      });

      if (msg.video?.file_id) {
        await cacheReplay(id, msg.video.file_id);
      }

      if (statusMsg?.message_id) {
        await bot.api.deleteMessage(userId, statusMsg.message_id).catch(() => {});
      }
    } catch (err: any) {
      console.error('Replay render error:', err);
      if (statusMsg?.message_id) {
        await bot.api.editMessageText(userId, statusMsg.message_id, `❌ Failed to generate replay video: ${err.message || 'Unknown error'}`).catch(() => {});
      }
    }
  });
}

export async function handleReview(ctx: Context, id: string, bot: Bot) {
  const userId = ctx.from?.id;
  if (!userId) return;

  const g = await getGame(id);
  if (!g) {
    if (ctx.callbackQuery) {
      await ctx.answerCallbackQuery({ text: '⚠️ Game record not found.', show_alert: true }).catch(() => {});
    } else {
      await bot.api.sendMessage(userId, '⚠️ Game record not found.').catch(() => {});
    }
    return;
  }

  const moves = await gameMoves(id);
  const rows = moves.map(
    (m: any) =>
      `${m.ply}. ${m.type === 'w' ? '🧱 wall ' + cellName(m.wall_cell) : m.type === 'm' ? '🚶 ' + cellName(m.to_cell) : '⏭ pass'}`
  );

  const kb = new InlineKeyboard()
    .text('◀', `rv:${id}:0:-1`)
    .text('▶', `rv:${id}:0:1`)
    .row()
    .text('📋 Copy Game Record', `copy:${id}`)
    .text('🎞 Replay', `replay:${id}`);

  await bot.api
    .sendMessage(
      userId,
      `📖 <b>Step-by-Step Game Review</b>\n\n${rows.slice(0, 25).join('\n') || 'Starting position.'}`,
      {
        parse_mode: 'HTML',
        reply_markup: kb,
      }
    )
    .catch(() => {});
}

export function registerReplayHandlers(bot: Bot) {
  bot.callbackQuery(/^review:(.+)$/, async ctx => {
    await ctx.answerCallbackQuery({ text: 'Opening review…' });
    const id = ctx.match[1];
    await handleReview(ctx, id, bot);
  });

  bot.callbackQuery(/^rv:(.+):(\d+):(-?1)$/, async ctx => {
    await ctx.answerCallbackQuery({ text: 'Reviewing' });
    const id = ctx.match[1],
      idx = Number(ctx.match[2]),
      dir = Number(ctx.match[3]);
    const moves = await gameMoves(id);
    const i = Math.max(0, Math.min(moves.length, idx + dir));
    const m = moves[i - 1];
    await ctx
      .editMessageText(
        `📖 <b>Move ${i}/${moves.length}</b>\n${m ? `${m.ply}. ${m.type === 'w' ? '🧱 wall ' + cellName(m.wall_cell) : m.type === 'm' ? '🚶 ' + cellName(m.to_cell) : '⏭ pass'}` : '🏁 Starting position'}`,
        {
          parse_mode: 'HTML',
          reply_markup: new InlineKeyboard()
            .text('◀', `rv:${id}:${i}:-1`)
            .text('▶', `rv:${id}:${i}:1`)
            .row()
            .text('📋 Copy Game Record', `copy:${id}`)
            .text('🎞 Replay', `replay:${id}`),
        }
      )
      .catch(() => {});
  });

  bot.callbackQuery(/^copy:(.+)$/, async ctx => {
    await ctx.answerCallbackQuery({ text: 'Sending record…' });
    const id = ctx.match[1];
    const moves = await gameMoves(id);
    const lines = ['Quoridor 8x8 Notation:'];
    for (const m of moves) {
      lines.push(`${m.ply}. ${m.type === 'w' ? 'wall ' + cellName(m.wall_cell) : m.type === 'm' ? cellName(m.from_cell) + '-' + cellName(m.to_cell) : 'pass'}`);
    }
    await ctx.api.sendMessage(ctx.from.id, `<pre>${lines.join('\n')}</pre>`, { parse_mode: 'HTML' }).catch(() => {});
  });

  bot.callbackQuery(/^replay:(.+)$/, async ctx => {
    await ctx.answerCallbackQuery({ text: 'Rendering 720p replay…' });
    const id = ctx.match[1];
    await handleReplay(ctx, id, bot);
  });
}

