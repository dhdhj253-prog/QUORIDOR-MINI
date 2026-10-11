# Telegram Quoridor Bot

Production-oriented Telegram Quoridor bot using grammY, PostgreSQL, worker-thread engine search, inline multiplayer, practice-vs-bot, replay rendering hooks, migrations, tests, and Docker.

## Rule source
`src/engine/engine.js` is the `engineFactory` copied from the supplied `Quoridor vs Bot (8).html` between `ENGINE_START` and `ENGINE_END`, unchanged. The Telegram game layer calls its `pawnMoves`, `wallLegal`, `apply`, `bfs`, and `think` APIs instead of implementing a second rules engine.

The source HTML describes the same 8x8 layout, one-cell blocked walls, jump and bypass behavior, and edge behavior in its UI text. See the supplied file lines 70-93.

## Run
1. Create a bot with BotFather.
2. Enable inline mode and set inline feedback to 100%.
3. Copy `.env.example` to `.env` and set `BOT_TOKEN`, `DATABASE_URL`, and `PUBLIC_BOT_USERNAME`.
4. `npm ci && npm run build && npm start`.
5. For Docker: `docker compose up -d --build`.

Without `WEBHOOK_URL`, the bot uses long polling. With `WEBHOOK_URL`, it exposes the configured HTTP port and registers a webhook.

## Inline multiplayer
In a group, type `@YourBot` and choose **Start Quoridor game**. The selected inline message gets a Join button. The first non-creator who presses Join becomes player 2. Only the two player IDs can act.

## Practice
The database/schema supports `vs_bot`; the current minimal Telegram wiring can be extended with a DM `/play` conversation. The engine worker pool is already shared by multiplayer bot moves.

## Replay
`src/render/queue.ts` creates 720x720 PNG frames. Installations include ffmpeg in Docker; the remaining Telegram upload/cache step can be attached to `replay_file_id` in the DB. This separation keeps rendering off the update/event loop.

## Tests
`npm test` covers initial setup, straight jump, bypass cases, edge behavior, wall-on-pawn rejection, wall-sealing, and pass representation.

## Important engine behavior
The supplied engine's `gen()` is a search move generator, not an exhaustive wall-placement enumerator. The Telegram legality checks use `wallLegal()` directly, so human wall placement is not restricted by the engine's search heuristics. The bot has a fallback when its search returns a pass while a legal wall exists.
