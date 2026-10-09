import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import sharp from 'sharp';
import ffmpegStatic from 'ffmpeg-static';
import type { State, Move, Player } from '../types.js';
import { Engine, toEngineState, cellName } from '../engine/index.js';

export function initialReplayState(): State {
  return { blocked: Array(64).fill(0), pos: [60, 3], walls: [8, 8], turn: 0, over: -1, ply: 0 };
}

function svg(s: State, stepIndex = 0, totalSteps = 0) {
  const pad = 64, cell = 74, size = 720;
  const boardSize = cell * 8;

  let squares = '';
  for (let r = 7; r >= 0; r--) {
    for (let c = 0; c < 8; c++) {
      const idx = r * 8 + c;
      const px = pad + c * cell;
      const py = pad + (7 - r) * cell;

      let fill = '#1E2533';
      if (s.blocked[idx]) {
        fill = '#0F131C';
      }

      squares += `<rect x="${px + 3}" y="${py + 3}" width="${cell - 6}" height="${cell - 6}" rx="10" fill="${fill}" stroke="#2B3448" stroke-width="2"/>`;

      if (s.blocked[idx]) {
        squares += `<rect x="${px + 8}" y="${py + 8}" width="${cell - 16}" height="${cell - 16}" rx="6" fill="#111827"/>`;
      }

      if (s.pos[0] === idx) {
        // Rocket / Blue Pawn
        squares += `
          <circle cx="${px + cell / 2}" cy="${py + cell / 2}" r="22" fill="#3B82F6" stroke="#93C5FD" stroke-width="2.5"/>
          <text x="${px + cell / 2}" y="${py + cell / 2 + 7}" font-size="20" text-anchor="middle">🚀</text>
        `;
      } else if (s.pos[1] === idx) {
        // Bot / Red Pawn
        squares += `
          <circle cx="${px + cell / 2}" cy="${py + cell / 2}" r="22" fill="#EF4444" stroke="#FCA5A5" stroke-width="2.5"/>
          <text x="${px + cell / 2}" y="${py + cell / 2 + 7}" font-size="20" text-anchor="middle">🤖</text>
        `;
      }
    }
  }

  const p1Walls = s.walls[0];
  const p2Walls = s.walls[1];

  let footerText = `Move ${stepIndex} / ${totalSteps}`;
  if (s.over >= 0) {
    footerText = s.over === 0 ? '🏆 🚀 You Win!' : '🏆 🤖 Bot Wins!';
  }

  return `
    <svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
      <defs>
        <style>
          text {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
            font-weight: 600;
          }
        </style>
      </defs>
      <!-- Background -->
      <rect width="${size}" height="${size}" fill="#0D111A"/>
      <rect x="24" y="24" width="${size - 48}" height="${size - 48}" rx="16" fill="#141A24" stroke="#252F42" stroke-width="2.5"/>

      <!-- Board Squares & Pawns -->
      ${squares}

      <!-- Top HUD Header -->
      <rect x="${pad}" y="28" width="${boardSize}" height="22" fill="none"/>
      <text x="${pad + 10}" y="44" fill="#93C5FD" font-size="13">🚀 You: ${p1Walls} ⬛</text>
      <text x="${pad + boardSize - 10}" y="44" fill="#FCA5A5" font-size="13" text-anchor="end">🤖 Bot: ${p2Walls} ⬛</text>

      <!-- Bottom HUD Footer -->
      <text x="${size / 2}" y="${size - 32}" fill="#E5E7EB" font-size="13" text-anchor="middle">${footerText}</text>
    </svg>
  `;
}

export async function buildReplay(states: State[], outFile: string) {
  const dir = join(process.cwd(), 'replays', `temp_${randomUUID()}`);
  await mkdir(dir, { recursive: true });

  try {
    for (let i = 0; i < states.length; i++) {
      const svgStr = svg(states[i], i, states.length - 1);
      const pngBuffer = await sharp(Buffer.from(svgStr)).png().toBuffer();
      const framePath = join(dir, `frame-${String(i).padStart(4, '0')}.png`);
      await sharp(pngBuffer).toFile(framePath);
    }

    const ffmpegBin = (ffmpegStatic as any)?.default || ffmpegStatic || 'ffmpeg';

    await new Promise<void>((resolve, reject) => {
      const args = [
        '-y',
        '-framerate', '1.25',
        '-i', join(dir, 'frame-%04d.png'),
        '-vf', 'tpad=stop_mode=clone:stop_duration=2.5,fps=25,format=yuv420p',
        '-c:v', 'libx264',
        '-pix_fmt', 'yuv420p',
        '-movflags', '+faststart',
        outFile,
      ];

      const p = spawn(ffmpegBin, args, { stdio: 'ignore' });
      p.on('error', reject);
      p.on('exit', code => (code === 0 ? resolve() : reject(new Error(`FFmpeg exited with code ${code}`))));
    });
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

export function replayStates(moves: any[], initial: State) {
  const states = [structuredClone(initial) as State];
  let s = structuredClone(initial) as State;
  for (const row of moves) {
    const who = s.turn as Player;
    const m: Move =
      row.type === 'm'
        ? { t: 'm', to: row.to_cell, pv: row.from_cell }
        : row.type === 'w'
        ? { t: 'w', c: row.wall_cell }
        : { t: 'p' };
    const e = toEngineState(s);
    if (m.t !== 'p') Engine.apply(e, who, m as any);
    s = {
      ...s,
      blocked: Array.from(e.blocked),
      pos: [e.pos[0], e.pos[1]] as [number, number],
      walls: [e.walls[0], e.walls[1]] as [number, number],
      turn: (1 - who) as Player,
      ply: s.ply + 1,
      lastMove: m.t === 'm' ? { from: m.pv, to: m.to } : row.type === 'w' ? { wall: row.wall_cell } : undefined,
    };
    if (m.t === 'm' && (m.to >> 3) === (who === 0 ? 0 : 7)) {
      s.over = who;
    }
    states.push(s);
  }
  return states;
}
