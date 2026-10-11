import fs from 'node:fs/promises';
import path from 'node:path';
import { renderProfileCard } from '../src/render/profile.js';

async function main() {
  const previewDir = path.resolve('assets/preview');
  await fs.mkdir(previewDir, { recursive: true });

  const samples = [
    { name: 'Rookie_Player', username: 'rookie', elo: 720, peakElo: 790, wins: 4, losses: 12, currentStreak: 0, bestStreak: 2 },
    { name: 'Classic_Duelist', username: 'duelist12', elo: 1240, peakElo: 1280, wins: 22, losses: 18, currentStreak: 2, bestStreak: 4 },
    { name: 'Cyber_Master', username: 'cyber_q', elo: 1680, peakElo: 1715, wins: 85, losses: 40, currentStreak: 5, bestStreak: 9 },
    { name: 'Inferno_Champion', username: 'inferno', elo: 2060, peakElo: 2110, wins: 140, losses: 52, currentStreak: 3, bestStreak: 14 },
    { name: 'Prismatic_Legend', username: 'legend_god', elo: 2450, peakElo: 2480, wins: 310, losses: 70, currentStreak: 12, bestStreak: 21 }
  ];

  for (const s of samples) {
    const buf = await renderProfileCard(s);
    const file = path.join(previewDir, `profile_${s.elo}.png`);
    await fs.writeFile(file, buf);
    console.log(`Generated preview: ${file}`);
  }
}

main().catch(console.error);
