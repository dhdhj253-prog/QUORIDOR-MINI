import sharp from 'sharp';
import { getEloGradient } from '../engine/elo.js';

export interface UserProfileData {
  name: string;
  username?: string | null;
  elo: number;
  peakElo: number;
  wins: number;
  losses: number;
  currentStreak: number;
  bestStreak: number;
}

export function generateProfileSvg(user: UserProfileData): string {
  const gradient = getEloGradient(user.elo);
  const totalGames = user.wins + user.losses;
  const winRate = totalGames > 0 ? ((user.wins / totalGames) * 100).toFixed(1) : '0.0';

  const stops = gradient.colors.map((c, i) => {
    const offset = Math.round((i / (gradient.colors.length - 1)) * 100);
    return `<stop offset="${offset}%" stop-color="${c}" />`;
  }).join('\n      ');

  const displayName = (user.name || user.username || 'Player')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  const displayHandle = user.username ? `@${user.username}` : 'Quoridor Duelist';

  const streakText = user.currentStreak > 0
    ? `🔥 ${user.currentStreak} Wins`
    : user.bestStreak > 0
      ? `Peak ${user.bestStreak} W`
      : '0 Wins';

  const primaryColor = gradient.colors[0];
  const secondaryColor = gradient.colors[gradient.colors.length - 1];

  return `<svg width="860" height="420" viewBox="0 0 860 420" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="tierGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      ${stops}
    </linearGradient>
    <linearGradient id="glowGrad" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" stop-color="${primaryColor}" stop-opacity="0.8" />
      <stop offset="100%" stop-color="${secondaryColor}" stop-opacity="0.8" />
    </linearGradient>
    <linearGradient id="bgGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#141724" />
      <stop offset="50%" stop-color="#0e1019" />
      <stop offset="100%" stop-color="#08090f" />
    </linearGradient>
    <linearGradient id="cardGrad" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#1d2133" stop-opacity="0.9" />
      <stop offset="100%" stop-color="#111420" stop-opacity="0.95" />
    </linearGradient>
    <filter id="glow" x="-30%" y="-30%" width="160%" height="160%">
      <feGaussianBlur stdDeviation="22" result="blur" />
      <feComposite in="SourceGraphic" in2="blur" operator="over" />
    </filter>
    <filter id="dropShadow" x="-10%" y="-10%" width="120%" height="120%">
      <feDropShadow dx="0" dy="8" stdDeviation="12" flood-color="${gradient.glow}" flood-opacity="0.4" />
    </filter>
  </defs>

  <!-- Canvas Background -->
  <rect width="860" height="420" rx="30" fill="url(#bgGrad)" />
  <rect width="860" height="420" rx="30" fill="none" stroke="url(#tierGrad)" stroke-width="2.5" opacity="0.6" />

  <!-- Ambient Radiant Lights -->
  <circle cx="720" cy="90" r="160" fill="${gradient.glow}" opacity="0.22" filter="url(#glow)" />
  <circle cx="120" cy="340" r="140" fill="${gradient.glow}" opacity="0.16" filter="url(#glow)" />

  <!-- Main Card Container -->
  <rect x="25" y="25" width="810" height="370" rx="24" fill="url(#cardGrad)" stroke="rgba(255,255,255,0.08)" stroke-width="1.5" />

  <!-- Top Ambient Banner Line -->
  <rect x="25" y="25" width="810" height="4" rx="2" fill="url(#glowGrad)" />

  <!-- Header: Avatar & Name -->
  <g transform="translate(60, 65)">
    <!-- Avatar Box -->
    <rect x="0" y="0" width="76" height="76" rx="22" fill="#1b1f30" stroke="url(#tierGrad)" stroke-width="3" filter="url(#dropShadow)" />
    <text x="38" y="50" font-family="'Segoe UI', Roboto, sans-serif" font-size="34" fill="#ffffff" text-anchor="middle">♟️</text>

    <!-- Player Name & Tag -->
    <text x="96" y="34" font-family="'Segoe UI', Roboto, sans-serif" font-size="30" font-weight="800" fill="#ffffff">${displayName}</text>
    <text x="96" y="62" font-family="'Segoe UI', Roboto, sans-serif" font-size="17" font-weight="500" fill="#8e9bb0">${displayHandle}</text>
  </g>

  <!-- Big Colorful ELO Rating Banner -->
  <g transform="translate(530, 65)">
    <rect x="0" y="0" width="240" height="76" rx="20" fill="${gradient.badgeBg}" stroke="url(#tierGrad)" stroke-width="2.5" filter="url(#dropShadow)" />
    <text x="120" y="52" font-family="'Segoe UI', Roboto, sans-serif" font-size="40" font-weight="900" fill="url(#tierGrad)" text-anchor="middle">${user.elo} <tspan font-size="20" font-weight="700" fill="#ffffff" opacity="0.85">ELO</tspan></text>
  </g>

  <!-- 4 Vivid Stats Cards -->
  <g transform="translate(55, 185)">
    <!-- Card 1: Matches -->
    <g transform="translate(0, 0)">
      <rect width="170" height="175" rx="18" fill="#141724" stroke="#252b40" stroke-width="1.5" />
      <rect width="170" height="4" rx="2" fill="#4299e1" />
      <text x="22" y="42" font-family="'Segoe UI', Roboto, sans-serif" font-size="14" font-weight="700" fill="#718096" letter-spacing="1">GAMES</text>
      <text x="22" y="92" font-family="'Segoe UI', Roboto, sans-serif" font-size="36" font-weight="800" fill="#ffffff">${totalGames}</text>
      <text x="22" y="138" font-family="'Segoe UI', Roboto, sans-serif" font-size="16" font-weight="700" fill="#48bb78">${user.wins}W <tspan fill="#718096">·</tspan> <tspan fill="#f56565">${user.losses}L</tspan></text>
    </g>

    <!-- Card 2: Winrate -->
    <g transform="translate(193, 0)">
      <rect width="170" height="175" rx="18" fill="#141724" stroke="#252b40" stroke-width="1.5" />
      <rect width="170" height="4" rx="2" fill="url(#tierGrad)" />
      <text x="22" y="42" font-family="'Segoe UI', Roboto, sans-serif" font-size="14" font-weight="700" fill="#718096" letter-spacing="1">WIN RATE</text>
      <text x="22" y="92" font-family="'Segoe UI', Roboto, sans-serif" font-size="36" font-weight="800" fill="url(#tierGrad)">${winRate}%</text>
      <text x="22" y="138" font-family="'Segoe UI', Roboto, sans-serif" font-size="14" font-weight="600" fill="#a0aec0">Rated Arena</text>
    </g>

    <!-- Card 3: Form Streak -->
    <g transform="translate(386, 0)">
      <rect width="170" height="175" rx="18" fill="#141724" stroke="#252b40" stroke-width="1.5" />
      <rect width="170" height="4" rx="2" fill="#ed8936" />
      <text x="22" y="42" font-family="'Segoe UI', Roboto, sans-serif" font-size="14" font-weight="700" fill="#718096" letter-spacing="1">STREAK</text>
      <text x="22" y="92" font-family="'Segoe UI', Roboto, sans-serif" font-size="28" font-weight="800" fill="#ffffff">${streakText}</text>
      <text x="22" y="138" font-family="'Segoe UI', Roboto, sans-serif" font-size="14" font-weight="600" fill="#ed8936">Best: ${user.bestStreak} Wins</text>
    </g>

    <!-- Card 4: Peak ELO -->
    <g transform="translate(579, 0)">
      <rect width="170" height="175" rx="18" fill="#141724" stroke="#252b40" stroke-width="1.5" />
      <rect width="170" height="4" rx="2" fill="#ffd700" />
      <text x="22" y="42" font-family="'Segoe UI', Roboto, sans-serif" font-size="14" font-weight="700" fill="#718096" letter-spacing="1">PEAK ELO</text>
      <text x="22" y="92" font-family="'Segoe UI', Roboto, sans-serif" font-size="36" font-weight="800" fill="#ffffff">${user.peakElo}</text>
      <text x="22" y="138" font-family="'Segoe UI', Roboto, sans-serif" font-size="14" font-weight="600" fill="#ffd700">⭐ Top Rating</text>
    </g>
  </g>
</svg>`;
}

export async function renderProfileCard(user: UserProfileData): Promise<Buffer> {
  const svg = generateProfileSvg(user);
  return sharp(Buffer.from(svg)).png().toBuffer();
}
