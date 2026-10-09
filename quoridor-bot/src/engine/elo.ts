export interface EloGradient {
  colors: string[];
  glow: string;
  badgeBg: string;
  minElo: number;
  maxElo: number;
}

export const ELO_TIERS: EloGradient[] = [
  { minElo: 0, maxElo: 799, colors: ['#616161', '#9E9E9E'], glow: '#757575', badgeBg: 'rgba(117,117,117,0.18)' },
  { minElo: 800, maxElo: 999, colors: ['#8D6E63', '#D7CCC8'], glow: '#A1887F', badgeBg: 'rgba(161,136,127,0.18)' },
  { minElo: 1000, maxElo: 1199, colors: ['#78909C', '#ECEFF1'], glow: '#B0BEC5', badgeBg: 'rgba(176,190,197,0.18)' },
  { minElo: 1200, maxElo: 1399, colors: ['#FFB300', '#FFE082'], glow: '#FFC107', badgeBg: 'rgba(255,193,7,0.18)' },
  { minElo: 1400, maxElo: 1599, colors: ['#00E676', '#B9F6CA'], glow: '#69F0AE', badgeBg: 'rgba(0,230,118,0.18)' },
  { minElo: 1600, maxElo: 1799, colors: ['#00B0FF', '#80D8FF'], glow: '#40C4FF', badgeBg: 'rgba(0,176,255,0.18)' },
  { minElo: 1800, maxElo: 1999, colors: ['#D500F9', '#FF80AB'], glow: '#EA80FC', badgeBg: 'rgba(213,0,249,0.18)' },
  { minElo: 2000, maxElo: 2199, colors: ['#FF3D00', '#FFAB40'], glow: '#FF6E40', badgeBg: 'rgba(255,61,0,0.18)' },
  { minElo: 2200, maxElo: 2399, colors: ['#FF1744', '#FF8A80'], glow: '#FF5252', badgeBg: 'rgba(255,23,68,0.18)' },
  { minElo: 2400, maxElo: 99999, colors: ['#00F260', '#0575E6', '#E040FB'], glow: '#7C4DFF', badgeBg: 'rgba(124,77,255,0.22)' }
];

export function getEloGradient(elo: number): EloGradient {
  const safeElo = Math.max(0, Math.floor(elo));
  for (const tier of ELO_TIERS) {
    if (safeElo >= tier.minElo && safeElo <= tier.maxElo) {
      return tier;
    }
  }
  return ELO_TIERS[ELO_TIERS.length - 1];
}

export function getProgressToNextTier(elo: number): {
  currentInTier: number;
  neededInTier: number;
  percent: number;
  nextTarget: number;
} {
  const safeElo = Math.max(0, Math.floor(elo));
  if (safeElo >= 2400) {
    return { currentInTier: 200, neededInTier: 200, percent: 100, nextTarget: 2400 };
  }
  const tierIndex = Math.floor(safeElo / 200);
  const tierBase = tierIndex * 200;
  const nextTarget = (tierIndex + 1) * 200;
  const currentInTier = safeElo - tierBase;
  const neededInTier = 200;
  const percent = Math.min(100, Math.max(0, Math.round((currentInTier / neededInTier) * 100)));
  return { currentInTier, neededInTier, percent, nextTarget };
}

export function renderProgressBar(percent: number, length: number = 10): string {
  const clamped = Math.min(100, Math.max(0, percent));
  const filled = Math.round((clamped / 100) * length);
  const empty = length - filled;
  return '█'.repeat(filled) + '░'.repeat(empty);
}

export function getKFactor(gamesPlayed: number, elo: number): number {
  if (gamesPlayed < 15) return 32; // Provisional multiplier for fast calibration
  if (elo >= 2000) return 12; // High rating stability
  return 20; // Standard matches
}

export function calculateEloDelta(
  winnerElo: number,
  loserElo: number,
  _winnerGames: number = 0,
  _loserGames: number = 0
): { winnerGain: number; loserLoss: number } {
  const res = calculateServerElo(winnerElo, loserElo, 1);
  return { winnerGain: res.deltaA, loserLoss: Math.abs(res.deltaB) };
}

export interface ServerEloResult {
  deltaA: number;
  deltaB: number;
  newRA: number;
  newRB: number;
  eA: number;
  eB: number;
}

export function calculateServerElo(
  ratingA: number,
  ratingB: number,
  scoreA: number // 1 = A wins, 0.5 = draw, 0 = A loses
): ServerEloResult {
  const rA = ratingA;
  const rB = ratingB;
  const scoreB = 1 - scoreA;

  // Expected score formula: E_A = 1 / (1 + 10^((R_B - R_A) / 400))
  const eA = 1 / (1 + Math.pow(10, (rB - rA) / 400));
  const eB = 1 / (1 + Math.pow(10, (rA - rB) / 400));

  const K = 80;
  const deltaA = Math.round(K * (scoreA - eA));
  const deltaB = Math.round(K * (scoreB - eB));

  // Minimum rating is 100
  const newRA = Math.max(100, rA + deltaA);
  const newRB = Math.max(100, rB + deltaB);

  return { deltaA, deltaB, newRA, newRB, eA, eB };
}

