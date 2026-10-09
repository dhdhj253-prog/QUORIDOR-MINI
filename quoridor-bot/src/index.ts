import 'dotenv/config';
import { Bot, webhookCallback } from 'grammy';
import pino from 'pino';
import { migrate, pool, forfeitExpiredGames, pruneAllOldGames } from './db/index.js';
import { registerCommands } from './bot/commands.js';
import { registerInline } from './bot/inline.js';
import { EnginePool } from './workers/pool.js';

export const logger=pino({level:process.env.LOG_LEVEL||'info'});
export const enginePool=new EnginePool(Number(process.env.WORKER_POOL_SIZE||3));
const token=process.env.BOT_TOKEN; if(!token)throw new Error('BOT_TOKEN is required');
const bot=new Bot(token);
registerCommands(bot);registerInline(bot);
bot.catch(err=>logger.error({err},'bot error'));

await migrate();
await bot.api.setMyCommands([
  { command: 'start', description: 'Welcome & Main Menu' },
  { command: 'newgame', description: 'Start game / Challenge' },
  { command: 'profile', description: 'View ELO Profile Card' },
  { command: 'leaderboard', description: 'Global Top Duelists' },
  { command: 'history', description: 'Recent match history' },
  { command: 'rules', description: 'Game rules' },
  { command: 'help', description: 'How to play' }
]);
setInterval(() => {
  void forfeitExpiredGames().catch(e => logger.error({ err: e }, 'forfeit sweep'));
  void pruneAllOldGames(7).catch(e => logger.error({ err: e }, 'prune sweep'));
}, 60_000);

import { handleRoomHttp } from './rooms.js';

const port = Number(process.env.PORT || 3000);
if (process.env.WEBHOOK_URL) {
  const server = await import('node:http');
  const handler = webhookCallback(bot, 'http');
  const s = server.createServer((req, res) => {
    if (handleRoomHttp(req, res)) return;
    handler(req, res);
  });
  s.listen(port, () => logger.info({ port }, 'webhook server listening'));
  await bot.api.setWebhook(process.env.WEBHOOK_URL, { secret_token: process.env.WEBHOOK_SECRET });
} else {
  const http = await import('node:http');
  const server = http.createServer((req, res) => {
    if (handleRoomHttp(req, res)) return;
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Quoridor Bot & Room Server is Running 24/7');
  });
  server.listen(port, () => {
    logger.info({ port }, 'Quoridor bot & room server listening');
    const configuredBotUser = (process.env.BOT_USERNAME || process.env.PUBLIC_BOT_USERNAME || 'panel4wordseekbot').replace(/^@/, '').trim();
    const shortName = (process.env.MINIAPP_SHORT_NAME || '').trim();
    if (shortName) {
      logger.info(`[LINK FORMAT] Short-name Mini App: https://t.me/${configuredBotUser}/${shortName}?startapp=<gameId>`);
    } else {
      logger.info(`[LINK FORMAT] Main Mini App: https://t.me/${configuredBotUser}?startapp=<gameId>`);
    }
  });
  await bot.start({
    onStart: (botInfo) => {
      const activeUser = botInfo.username || process.env.BOT_USERNAME || 'panel4wordseekbot';
      const shortName = (process.env.MINIAPP_SHORT_NAME || '').trim();
      const activeLinkFormat = shortName
        ? `https://t.me/${activeUser}/${shortName}?startapp=<gameId>`
        : `https://t.me/${activeUser}?startapp=<gameId>`;
      logger.info(`long polling started for @${activeUser}`);
      logger.info(`[LINK FORMAT] Verified active inline button link: ${activeLinkFormat}`);
      if (process.env.WEBAPP_URL) {
        bot.api.setChatMenuButton({
          menu_button: {
            type: 'web_app',
            text: 'Play Quoridor',
            web_app: { url: process.env.WEBAPP_URL }
          }
        }).catch(() => {});
      }
      if (!shortName && !botInfo.has_main_web_app) {
        logger.warn(`[BOTFATHER CONFIG REQUIRED] @${activeUser} has_main_web_app is currently FALSE.`);
        logger.warn(`Telegram shows "bot invalid" until you enable it in @BotFather: /mybots -> @${activeUser} -> Bot Settings -> Configure Mini App -> Enable Mini App -> ${process.env.WEBAPP_URL}`);
      }
    }
  });
}

const shutdown=async()=>{logger.info('shutting down');await enginePool.close();await bot.stop();await pool.end();process.exit(0)};
process.once('SIGINT',shutdown);process.once('SIGTERM',shutdown);
