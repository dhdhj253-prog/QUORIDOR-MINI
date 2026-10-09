import {
  createInitialState,
  getPawnMoves,
  isWallLegal,
  applyMove,
  botThink,
  type GameState,
  type Player,
  type Move
} from './engine.ts';
import { sounds } from './audio.ts';
import { initTelegramWebApp, triggerHaptic, getTelegram, getRawInitData } from './telegram.ts';

interface UserProfile {
  name: string;
  photoUrl?: string;
  elo: number;
  peakElo: number;
  wins: number;
  losses: number;
  currentStreak: number;
  bestStreak: number;
}

interface ChatMessage {
  id: string;
  senderId?: string;
  sender: string;
  text: string;
  isSelf: boolean;
  time: string;
}

interface MoveRecord {
  num: number;
  p1: string;
  p2?: string;
}

const STORAGE_KEY = 'quoridor_miniapp_profile_v7';

function loadProfile(tgUser: { id?: number; first_name?: string; last_name?: string; username?: string; photo_url?: string }): UserProfile {
  const rawParts = [tgUser.first_name, tgUser.last_name].filter(Boolean).map(s => String(s).trim()).filter(Boolean);
  const telegramName = rawParts.length > 0
    ? rawParts.join(' ')
    : (tgUser.username ? (tgUser.username.startsWith('@') ? tgUser.username : `@${tgUser.username}`) : '');
  const photoUrl = (tgUser.photo_url && !tgUser.photo_url.includes('unsplash.com'))
    ? tgUser.photo_url
    : (tgUser.id && tgUser.id !== 12345678 ? `/api/user/photo?id=${tgUser.id}` : undefined);

  // If authentic Telegram user is detected, strictly use their identity and clear any stale cache
  if (telegramName && telegramName !== 'Player') {
    const freshProfile: UserProfile = {
      name: telegramName,
      photoUrl,
      elo: 1000,
      peakElo: 1000,
      wins: 0,
      losses: 0,
      currentStreak: 0,
      bestStreak: 0
    };
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        // Only keep stats if the saved profile belongs to this exact same player
        if (parsed.name === telegramName) {
          freshProfile.elo = parsed.elo || 1000;
          freshProfile.peakElo = parsed.peakElo || 1000;
          freshProfile.wins = parsed.wins || 0;
          freshProfile.losses = parsed.losses || 0;
          freshProfile.currentStreak = parsed.currentStreak || 0;
          freshProfile.bestStreak = parsed.bestStreak || 0;
        } else {
          localStorage.removeItem(STORAGE_KEY);
        }
      } catch {
        localStorage.removeItem(STORAGE_KEY);
      }
    }
    saveProfile(freshProfile);
    return freshProfile;
  }

  // If user previously set/saved their name on this phone/browser, restore it!
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved) {
    try {
      const parsed = JSON.parse(saved);
      if (parsed.name && parsed.name !== 'Player' && parsed.name !== 'Player 1' && parsed.name !== 'Player 2') {
        return {
          name: parsed.name,
          photoUrl: (parsed.photoUrl && !parsed.photoUrl.includes('unsplash.com')) ? parsed.photoUrl : undefined,
          elo: parsed.elo || 1000,
          peakElo: parsed.peakElo || 1000,
          wins: parsed.wins || 0,
          losses: parsed.losses || 0,
          currentStreak: parsed.currentStreak || 0,
          bestStreak: parsed.bestStreak || 0
        };
      }
    } catch {}
  }

  return {
    name: '',
    photoUrl: undefined,
    elo: 1000,
    peakElo: 1000,
    wins: 0,
    losses: 0,
    currentStreak: 0,
    bestStreak: 0
  };
}

function saveProfile(p: UserProfile) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(p));
}

/**
 * Dynamic ELO Badge Color:
 * 1000 - 1199: Yellow Palette (#ca8a04)
 * 1200 - 1399: Blue (#2563eb)
 * 1400 - 1599: Brown (#854d0e)
 * 1600 - 1799: Green (#16a34a)
 * 1800 - 1999: Red (#d84315)
 * 1999 onwards (2000+): Violet (#7c3aed)
 */
export function getEloBadgeColor(elo: number): string {
  if (elo >= 2000) return '#7c3aed'; // Violet (2000+)
  if (elo >= 1800) return '#d84315'; // Red (1800 - 1999)
  if (elo >= 1600) return '#16a34a'; // Green (1600 - 1799)
  if (elo >= 1400) return '#854d0e'; // Brown (1400 - 1599)
  if (elo >= 1200) return '#2563eb'; // Blue (1200 - 1399)
  if (elo >= 1000) return '#ca8a04'; // Yellow (1000 - 1199)
  return '#64748b';                  // Sub-1000 Slate Gray
}

function getTierTitle(elo: number): string {
  if (elo >= 2000) return 'Violet Tier (2000+)';
  if (elo >= 1800) return 'Red Tier (1800 - 1999)';
  if (elo >= 1600) return 'Green Tier (1600 - 1799)';
  if (elo >= 1400) return 'Brown Tier (1400 - 1599)';
  if (elo >= 1200) return 'Blue Tier (1200 - 1399)';
  if (elo >= 1000) return 'Yellow Tier (1000 - 1199)';
  return 'Novice';
}

function cellToCoord(cell: number): string {
  const r = Math.floor(cell / 8) + 1;
  const c = String.fromCharCode('a'.charCodeAt(0) + (cell % 8));
  return `${c}${r}`;
}

// Game State & Room Variables
type GameMode = 'bot' | 'pvp' | 'multiplayer';
type InputMode = 'move' | 'wall';
type UserSide = 'bottom' | 'top'; // Player side preference

let gameMode: GameMode = 'bot';
let inputMode: InputMode = 'move';
let playerSide: UserSide | null = null;
let myPlayerIndex: Player = 0; // 0 = Bottom (Rank 0), 1 = Top (Rank 7)

let currentGameId = 'match-' + Math.random().toString(36).substring(2, 8);
let channel: BroadcastChannel | null = null;

let gameState: GameState = createInitialState(0);
let userProfile: UserProfile;
let opponentName = 'Quoridor AI';
let opponentElo = 1050;
let isBotThinking = false;

// History & Chat State
const moveHistory: MoveRecord[] = [];
const chatMessages: ChatMessage[] = [];

// DOM Elements
const gridEl = document.getElementById('quoridor-grid')!;
const botSubTitleEl = document.getElementById('bot-sub-title');

const p1Bar = document.getElementById('p1-bar')!;
const p2Bar = document.getElementById('p2-bar')!;
const p1NameEl = document.getElementById('p1-name')!;
const p2NameEl = document.getElementById('p2-name')!;
const p1EloBadge = document.getElementById('p1-elo-badge')!;
const p2EloBadge = document.getElementById('p2-elo-badge')!;
const p1TurnTag = document.getElementById('p1-turn-tag')!;
const p2TurnTag = document.getElementById('p2-turn-tag')!;
const p1WallDots = document.getElementById('p1-wall-dots')!;
const p2WallDots = document.getElementById('p2-wall-dots')!;
const p1WallsCount = document.getElementById('p1-walls-count')!;
const p2WallsCount = document.getElementById('p2-walls-count')!;
const p1WallBtnCount = document.getElementById('p1-wall-btn-count')!;
const p1AvatarEl = document.getElementById('p1-avatar')!;
const p2AvatarEl = document.getElementById('p2-avatar')!;

const btnModeMove = document.getElementById('btn-mode-move')!;
const btnModeWall = document.getElementById('btn-mode-wall')!;
const btnResign = document.getElementById('btn-resign')!;
const btnSound = document.getElementById('btn-sound');
const btnShareMatch = document.getElementById('btn-share-match');

// Tab Bar & Panels
const tabBtnMenu = document.getElementById('tab-btn-menu')!;
const tabBtnNotation = document.getElementById('tab-btn-notation');
const tabBtnChat = document.getElementById('tab-btn-chat')!;
const chatUnreadDot = document.getElementById('chat-unread-dot')!;

const chatPanel = document.getElementById('chat-panel')!;
const btnChatClose = document.getElementById('btn-chat-close')!;
const chatMessagesList = document.getElementById('chat-messages-list')!;
const chatForm = document.getElementById('chat-form') as HTMLFormElement;
const chatInputField = document.getElementById('chat-input-field') as HTMLInputElement;

const notationPanel = document.getElementById('notation-panel')!;
const btnNotationClose = document.getElementById('btn-notation-close')!;
const notationList = document.getElementById('notation-list')!;

// Side Selection Modal
const sideSelectModal = document.getElementById('side-select-modal')!;
const btnChooseBottom = document.getElementById('btn-choose-bottom')!;
const btnChooseTop = document.getElementById('btn-choose-top')!;

// Side Drawer (Profile-Only)
const sideDrawer = document.getElementById('side-drawer')!;
const drawerBackdrop = document.getElementById('drawer-backdrop')!;
const btnDrawerOpen = document.getElementById('btn-drawer-open')!;
const drawerAvatar = document.getElementById('drawer-avatar')!;
const drawerName = document.getElementById('drawer-name')!;
const drawerEloBadge = document.getElementById('drawer-elo-badge')!;
const drawerRoleTag = document.getElementById('drawer-role-tag')!;
const drawerTierName = document.getElementById('drawer-tier-name')!;
const drawerStatRating = document.getElementById('drawer-stat-rating')!;
const drawerStatPeak = document.getElementById('drawer-stat-peak')!;
const drawerStatWins = document.getElementById('drawer-stat-wins')!;
const drawerStatStreak = document.getElementById('drawer-stat-streak')!;
const btnDrawerSwitchSide = document.getElementById('btn-drawer-switch-side')!;

// Victory Modal
const gameOverModal = document.getElementById('gameover-modal')!;
const modalTitle = document.getElementById('modal-title')!;
const modalDesc = document.getElementById('modal-desc')!;
const modalEloPill = document.getElementById('modal-elo-pill')!;
const modalDeltaText = document.getElementById('modal-delta-text')!;
const btnModalRematch = document.getElementById('btn-modal-rematch')!;
const btnModalShare = document.getElementById('btn-modal-share')!;

let opponentPhotoUrl: string | undefined = undefined;

let myClientId = 'c_' + Math.random().toString(36).substring(2, 10);

function renderAvatarHtml(name: string, photoUrl?: string, isBot = false): string {
  const cleanName = (name && name !== 'Player' && name !== 'Player 1' && name !== 'Player 2') ? name : (name || 'P');
  const initial = Array.from(cleanName)[0] || 'P';

  if (photoUrl && !photoUrl.includes('unsplash.com')) {
    return `<img src="${photoUrl}" class="player-avatar-img" alt="${cleanName}" onerror="this.outerHTML='<span class=\\'avatar-letter-badge\\'>${initial}</span>'" />`;
  }
  if (isBot) {
    return '🤖';
  }
  return `<span class="avatar-letter-badge">${initial}</span>`;
}

// Setup & Waiting Modals
const setupRatingToggle = document.getElementById('setup-rating-toggle') as HTMLInputElement;
const setupAvatarPreview = document.getElementById('setup-avatar-preview');
const setupNameInput = document.getElementById('setup-name-input') as HTMLInputElement | null;
const waitingModal = document.getElementById('waiting-modal')!;
const waitingSideText = document.getElementById('waiting-side-text')!;
const waitingRatingText = document.getElementById('waiting-rating-text')!;
const btnCancelWaiting = document.getElementById('btn-cancel-waiting')!;
const btnDraw = document.getElementById('btn-draw')!;
const btnCancelGame = document.getElementById('btn-cancel-game')!;

// Spectator & Rating Elements
const spectatorBanner = document.getElementById('spectator-banner');
const spectatorBar = document.getElementById('spectator-bar');
const actionToggles = document.getElementById('action-toggles');
const ratingStatusLabel = document.getElementById('rating-status-label');

let isSpectator = false;
let useTelegramIdentity = false;
let spectatorTopPlayer: { name: string; elo: number; photoUrl?: string } | null = null;
let spectatorBottomPlayer: { name: string; elo: number; photoUrl?: string } | null = null;
let isRatedMatch = true;

export type PlayerPresenceStatus = 'waiting' | 'joined' | 'playing' | 'disconnected';

export interface RoomPresence {
  top: PlayerPresenceStatus;
  bottom: PlayerPresenceStatus;
  topDisconnectedAt?: number | null;
  bottomDisconnectedAt?: number | null;
}

let currentRoomPresence: RoomPresence = {
  top: 'waiting',
  bottom: 'waiting'
};
const opponentDisconnectedBanner = document.getElementById('opponent-disconnected-banner');

function formatPresenceLabel(status: PlayerPresenceStatus, isTurn: boolean, isMyTurn: boolean): string {
  let dotHtml = '';
  let statusText = 'Waiting';
  let textClass = 'presence-text-waiting';

  switch (status) {
    case 'waiting':
      statusText = 'Waiting';
      textClass = 'presence-text-waiting';
      break;
    case 'joined':
      statusText = 'Joined';
      textClass = 'presence-text-joined';
      break;
    case 'playing':
      dotHtml = '<span class="presence-dot green"></span>';
      statusText = 'Playing';
      textClass = 'presence-text-playing';
      break;
    case 'disconnected':
      dotHtml = '<span class="presence-dot red"></span>';
      statusText = 'Disconnected';
      textClass = 'presence-text-disconnected';
      break;
    default:
      statusText = 'Waiting';
      textClass = 'presence-text-waiting';
  }

  let turnSuffix = '';
  if (isTurn) {
    turnSuffix = `<span class="presence-turn-suffix"> - ${isMyTurn ? 'Your turn' : 'Active turn'}</span>`;
  }

  return `<span class="${textClass}">${dotHtml}${statusText}</span>${turnSuffix}`;
}

function updateOpponentDisconnectBanner() {
  if (isSpectator || gameMode !== 'multiplayer') {
    opponentDisconnectedBanner?.classList.add('hidden');
    return;
  }
  const isTopPlayer = playerSide === 'top';
  const oppDisconnectedAt = isTopPlayer
    ? currentRoomPresence?.bottomDisconnectedAt
    : currentRoomPresence?.topDisconnectedAt;

  const isGameActive = gameState.over === -1 && Array.isArray(moveHistory) && moveHistory.length > 0;
  if (isGameActive && oppDisconnectedAt && (Date.now() - oppDisconnectedAt >= 60000)) {
    opponentDisconnectedBanner?.classList.remove('hidden');
  } else {
    opponentDisconnectedBanner?.classList.add('hidden');
  }
}

let heartbeatInterval: any = null;

function sendHeartbeat() {
  if (!currentGameId || gameMode !== 'multiplayer') return;
  const tgUser = initTelegramWebApp();
  const tgId = (tgUser && tgUser.id && tgUser.id !== 12345678) ? tgUser.id : undefined;

  fetch('/api/room/heartbeat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: currentGameId,
      playerId: myClientId,
      tgId,
      initData: getRawInitData()
    })
  })
    .then(r => r.json())
    .then(res => {
      if (res && res.presence) {
        currentRoomPresence = res.presence;
        updateUI();
      }
    })
    .catch(() => {});
}

function startHeartbeat() {
  if (heartbeatInterval) clearInterval(heartbeatInterval);
  sendHeartbeat();
  heartbeatInterval = setInterval(sendHeartbeat, 10000);
}

function updateRatingLabelUI(isRated: boolean, isLocked = false) {
  if (!ratingStatusLabel) return;
  if (isLocked) {
    ratingStatusLabel.innerHTML = isRated
      ? `Rating: <b>Rated (ELO Active · Host Config)</b>`
      : `Rating: <b>Unrated (Casual · Host Config)</b>`;
  } else {
    ratingStatusLabel.innerHTML = isRated
      ? `Rating: <b>Rated (ELO Active)</b>`
      : `Rating: <b>Unrated (Casual / 0 ELO)</b>`;
  }
}

function updateSetupModalProfileUI() {
  if (setupNameInput) {
    if (userProfile.name && userProfile.name !== 'Player' && userProfile.name !== 'Player 1' && userProfile.name !== 'Player 2') {
      setupNameInput.value = userProfile.name;
      setupNameInput.readOnly = true;
    } else {
      setupNameInput.value = '';
      setupNameInput.placeholder = 'Your Telegram name or @username';
      setupNameInput.readOnly = false;
    }
  }
  if (setupAvatarPreview) {
    setupAvatarPreview.innerHTML = renderAvatarHtml(userProfile.name, userProfile.photoUrl);
  }
}

function init() {
  const tgUser = initTelegramWebApp();
  useTelegramIdentity = !!tgUser.id && tgUser.id !== 12345678;
  userProfile = loadProfile(tgUser);

  // Reliable player identity across Telegram WebApp / in-app browser / mobile
  if (tgUser && tgUser.id && tgUser.id !== 12345678) {
    myClientId = `tg_${tgUser.id}`;
  } else {
    // Generate fresh isolated client ID per browser session to prevent ID collisions
    if (!sessionStorage.getItem('quoridor_client_id')) {
      myClientId = 'c_' + Math.random().toString(36).substring(2, 10);
      sessionStorage.setItem('quoridor_client_id', myClientId);
    } else {
      myClientId = sessionStorage.getItem('quoridor_client_id')!;
    }
  }

  const tg = getTelegram();

  // Check URL query parameters and Telegram WebApp start_param
  const searchStr = window.location.search.startsWith('?') ? window.location.search.slice(1) : window.location.search;
  const hashStr = window.location.hash.startsWith('#') ? window.location.hash.slice(1) : window.location.hash;
  const params = new URLSearchParams(searchStr + '&' + hashStr);
  const rawStartParam =
    tg?.initDataUnsafe?.start_param ||
    params.get('tgWebAppStartParam') ||
    params.get('startapp') ||
    params.get('gameId') ||
    params.get('room');
  const startParam = rawStartParam ? String(rawStartParam).replace(/^(game|room)[_-]/, '').trim() : '';
  if (startParam) {
    console.log(`[CLIENT] Target Room ID resolved from startapp / start_param: ${startParam}`);
  }


  const paramMode = params.get('mode');

  if (paramMode === 'bot') {
    gameMode = 'bot';
    isRatedMatch = false;
    opponentName = 'Quoridor AI';
    opponentElo = 1050;
    if (botSubTitleEl) botSubTitleEl.textContent = 'AI Match';
    openSideSelectModal();
  } else if (startParam) {
    // Inline multiplayer match between real human players
    currentGameId = startParam;
    gameMode = 'multiplayer';
    opponentName = 'Waiting for opponent…';
    opponentElo = 1000;
    if (botSubTitleEl) botSubTitleEl.textContent = '';

    // Ensure all setup modals are hidden while loading room status to prevent spectator flash
    sideSelectModal.classList.add('hidden');
    waitingModal.classList.add('hidden');

    setupMultiplayerChannel();
  } else {
    // Default open
    openSideSelectModal();
  }

  // Side Selection Listeners
  btnChooseBottom.addEventListener('click', () => selectSide('bottom'));
  btnChooseTop.addEventListener('click', () => selectSide('top'));

  // Rating Toggle
  if (setupRatingToggle) {
    updateRatingLabelUI(setupRatingToggle.checked, setupRatingToggle.disabled);
    setupRatingToggle.addEventListener('change', () => {
      isRatedMatch = setupRatingToggle.checked;
      updateRatingLabelUI(isRatedMatch, setupRatingToggle.disabled);
      updateMatchBadgeUI();
    });
  }

  // Name Input on Setup Modal
  if (setupNameInput) {
    setupNameInput.addEventListener('input', () => {
      if (useTelegramIdentity) return;
      const val = setupNameInput.value.trim();
      if (val) {
        userProfile.name = val;
        if (val.startsWith('@')) {
          const handle = val.slice(1);
          userProfile.photoUrl = `/api/user/photo?username=${encodeURIComponent(handle)}`;
        }
        saveProfile(userProfile);
        updateProfileUI();
        if (setupAvatarPreview) {
          setupAvatarPreview.innerHTML = renderAvatarHtml(userProfile.name, userProfile.photoUrl);
        }
      }
    });
    setupNameInput.readOnly = useTelegramIdentity;
  }

  // Waiting screen cancel
  if (btnCancelWaiting) {
    btnCancelWaiting.addEventListener('click', () => {
      waitingModal.classList.add('hidden');
      localStorage.removeItem(`quoridor_side_${currentGameId}`);
      fetch('/api/room/leave', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: currentGameId, playerId: myClientId })
      }).catch(() => {});
      openSideSelectModal();
      updateSideButtons(null, true);
    });
  }

  // Bottom action buttons
  btnModeMove.addEventListener('click', () => setInputMode('move'));
  btnModeWall.addEventListener('click', () => setInputMode('wall'));
  btnResign.addEventListener('click', handleResign);

  if (btnDraw) {
    btnDraw.addEventListener('click', () => {
      if (isSpectator || gameState.over !== -1) return;
      if (gameMode === 'multiplayer') {
        fetch('/api/room/action', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: currentGameId,
            type: 'DRAW',
            senderId: myClientId
          })
        }).catch(() => {});
      } else {
        gameState.over = 2;
        onServerGameOver(2);
        updateUI();
      }
      triggerHaptic('light');
    });
  }

  if (btnCancelGame) {
    btnCancelGame.addEventListener('click', handleResign);
  }

  btnSound?.addEventListener('click', () => {
    sounds.enabled = !sounds.enabled;
    if (btnSound) btnSound.textContent = sounds.enabled ? '🔊' : '🔇';
    triggerHaptic('light');
  });

  btnShareMatch?.addEventListener('click', shareMatchLink);

  // Side Drawer (Profile View)
  btnDrawerOpen.addEventListener('click', openDrawer);
  tabBtnMenu.addEventListener('click', openDrawer);
  drawerBackdrop.addEventListener('click', closeDrawer);
  btnDrawerSwitchSide.addEventListener('click', () => {
    closeDrawer();
    openSideSelectModal();
  });

  // Tab Panels (Notation & Chat)
  if (tabBtnNotation) {
    tabBtnNotation.addEventListener('click', toggleNotationPanel);
  }
  btnNotationClose.addEventListener('click', () => notationPanel.classList.add('hidden'));

  tabBtnChat.addEventListener('click', toggleChatPanel);
  btnChatClose.addEventListener('click', () => chatPanel.classList.add('hidden'));

  chatForm.addEventListener('submit', handleSendMessage);

  // Victory Modals & Play Again direct link
  btnModalRematch.addEventListener('click', async () => {
    gameOverModal.classList.add('hidden');
    hasProcessedGameOver = false;

    if (gameMode === 'multiplayer') {
      try {
        await fetch('/api/room/action', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: currentGameId, type: 'RESET' })
        });
      } catch {}

      startNewGame();
    } else {
      startNewGame();
    }
  });
  btnModalShare.addEventListener('click', shareMatchLink);

  updateProfileUI();
}

function normalizeGameState(st: any): GameState {
  if (!st) return createInitialState(0);
  const rawBlocked = Array.isArray(st.blocked)
    ? st.blocked
    : (st.blocked && typeof st.blocked === 'object' ? Object.values(st.blocked) : new Array(64).fill(0));
  const blocked = new Uint8Array(64);
  for (let i = 0; i < 64; i++) {
    blocked[i] = Number(rawBlocked[i] || 0);
  }
  return {
    blocked,
    pos: Array.isArray(st.pos) ? [Number(st.pos[0] ?? 60), Number(st.pos[1] ?? 3)] : [60, 3],
    walls: Array.isArray(st.walls) ? [Number(st.walls[0] ?? 8), Number(st.walls[1] ?? 8)] : [8, 8],
    turn: (st.turn === 1 ? 1 : 0) as Player,
    over: (st.over === 0 || st.over === 1 || st.over === 2) ? st.over : -1,
    ply: Number(st.ply || 0)
  };
}

function updateSideButtons(takenSide?: 'top' | 'bottom' | null, ratedChoice?: boolean, takenByName?: string) {
  const btnTop = btnChooseTop as HTMLButtonElement;
  const btnBottom = btnChooseBottom as HTMLButtonElement;
  void takenByName;

  if (takenSide === 'top') {
    btnTop.style.display = 'none';
    btnTop.classList.add('hidden');
    btnTop.hidden = true;
    btnTop.disabled = true;

    btnBottom.style.display = 'inline-block';
    btnBottom.classList.remove('hidden');
    btnBottom.hidden = false;
    btnBottom.disabled = false;
    btnBottom.style.opacity = '1';
    btnBottom.style.cursor = 'pointer';
    btnBottom.textContent = 'Bottom (Plays 2nd)';
  } else if (takenSide === 'bottom') {
    btnBottom.style.display = 'none';
    btnBottom.classList.add('hidden');
    btnBottom.hidden = true;
    btnBottom.disabled = true;

    btnTop.style.display = 'inline-block';
    btnTop.classList.remove('hidden');
    btnTop.hidden = false;
    btnTop.disabled = false;
    btnTop.style.opacity = '1';
    btnTop.style.cursor = 'pointer';
    btnTop.textContent = 'Top (Plays 1st)';
  } else {
    btnTop.style.display = 'inline-block';
    btnTop.classList.remove('hidden');
    btnTop.hidden = false;
    btnTop.disabled = false;
    btnTop.style.opacity = '1';
    btnTop.style.cursor = 'pointer';
    btnTop.textContent = 'Top (Plays 1st)';

    btnBottom.style.display = 'inline-block';
    btnBottom.classList.remove('hidden');
    btnBottom.hidden = false;
    btnBottom.disabled = false;
    btnBottom.style.opacity = '1';
    btnBottom.style.cursor = 'pointer';
    btnBottom.textContent = 'Bottom (Plays 2nd)';
  }

  if (gameMode === 'bot') {
    isRatedMatch = false;
    if (setupRatingToggle) {
      setupRatingToggle.checked = false;
      setupRatingToggle.disabled = true;
    }
    updateRatingLabelUI(false, true);
    updateMatchBadgeUI();
  } else if (takenSide) {
    // Joiner / second player: rated setting is determined by host and locked read-only!
    if (typeof ratedChoice === 'boolean') {
      isRatedMatch = ratedChoice;
      if (setupRatingToggle) {
        setupRatingToggle.checked = ratedChoice;
        setupRatingToggle.disabled = true;
      }
      updateRatingLabelUI(isRatedMatch, true);
      updateMatchBadgeUI();
    }
  } else {
    // Creator / first player: still choosing in lobby!
    // Incoming syncs must NOT reset local choice before seat is confirmed.
    if (setupRatingToggle) {
      setupRatingToggle.disabled = false;
      isRatedMatch = setupRatingToggle.checked;
      updateRatingLabelUI(isRatedMatch, false);
      updateMatchBadgeUI();
    }
  }
}

function openSideSelectModal() {
  waitingModal.classList.add('hidden');
  updateSetupModalProfileUI();
  const ratingRow = document.querySelector('.setup-rating-row') as HTMLElement | null;
  if (ratingRow) {
    if (gameMode === 'bot') {
      ratingRow.style.display = 'none';
      isRatedMatch = false;
    } else {
      ratingRow.style.display = 'flex';
    }
  }
  sideSelectModal.classList.remove('hidden');
}

function selectSide(side: UserSide) {
  isSpectator = false;
  playerSide = side;
  // Top starts on row 7 and moves FIRST (Player 0)
  // Bottom starts on row 0 and moves SECOND (Player 1)
  myPlayerIndex = side === 'top' ? 0 : 1;
  sideSelectModal.classList.add('hidden');

  if (gameMode === 'multiplayer') {
    if (setupNameInput && setupNameInput.value.trim()) {
      const entered = setupNameInput.value.trim();
      userProfile.name = entered;
      if (entered.startsWith('@')) {
        const handle = entered.slice(1);
        userProfile.photoUrl = `/api/user/photo?username=${encodeURIComponent(handle)}`;
      }
      saveProfile(userProfile);
    } else if (!userProfile.name || userProfile.name === 'Player') {
      userProfile.name = side === 'top' ? 'Player 1' : 'Player 2';
    }

    localStorage.setItem(`quoridor_side_${currentGameId}`, side);
    if (!setupRatingToggle.disabled) {
      isRatedMatch = setupRatingToggle.checked;
    }
    waitingSideText.textContent = side === 'top' ? 'Top (Plays 1st)' : 'Bottom (Plays 2nd)';
    waitingRatingText.textContent = isRatedMatch ? 'Yes' : 'No';
    waitingModal.classList.remove('hidden');

    const joinPayload = {
      id: currentGameId,
      initData: getRawInitData(),
      playerId: myClientId,
      side,
      name: userProfile.name,
      elo: userProfile.elo,
      photoUrl: userProfile.photoUrl,
      rated: isRatedMatch
    };

    // Sync via REST backend for cross-device & mobile support
    fetch('/api/room/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(joinPayload)
    })
      .then(r => r.json())
      .then(res => {
        if (res.error === 'ROOM_FULL') {
          isSpectator = true;
          if (res.room) handleRoomSyncData(res.room);
        } else if (res.room) {
          if (res.player?.id) {
            myClientId = res.player.id;
            sessionStorage.setItem('quoridor_client_id', myClientId);
          }
          if (res.seat) {
            playerSide = res.seat;
            myPlayerIndex = res.seat === 'top' ? 0 : 1;
            isSpectator = false;
            localStorage.setItem(`quoridor_side_${currentGameId}`, res.seat);
          }
          handleRoomSyncData(res.room);
        }
      })
      .catch(err => console.error('Join error:', err));
  } else {
    startNewGame();
  }
}

let pollInterval: any = null;
let activeEventSource: EventSource | null = null;
let sseReconnectTimer: any = null;
let localRoomVersion = 0;

function connectSSE() {
  if (activeEventSource) {
    try { activeEventSource.close(); } catch {}
    activeEventSource = null;
  }
  if (!currentGameId || gameMode !== 'multiplayer') return;

  try {
    const tgUser = initTelegramWebApp();
    const tgIdParam = (tgUser && tgUser.id && tgUser.id !== 12345678) ? `&tgId=${tgUser.id}` : '';
    const playerIdParam = myClientId ? `&playerId=${encodeURIComponent(myClientId)}` : '';
    const es = new EventSource(`/api/room/events?id=${currentGameId}${playerIdParam}${tgIdParam}`);
    activeEventSource = es;

    startHeartbeat();

    es.addEventListener('ROOM_SYNC', (e) => {
      try {
        const room = JSON.parse(e.data);
        handleRoomSyncData(room);
      } catch {}
    });
    es.addEventListener('PRESENCE', (e) => {
      try {
        const presence = JSON.parse(e.data);
        if (presence) {
          currentRoomPresence = presence;
          updateUI();
        }
      } catch {}
    });
    es.addEventListener('CHAT', (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data) renderChatMessage(data);
      } catch {}
    });
    es.addEventListener('MOVE', (e) => {
      try {
        const data = JSON.parse(e.data);
        applyRemoteMove(data);
      } catch {}
    });
    es.addEventListener('GAME_OVER', (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.winner !== undefined) {
          gameState.over = data.winner;
          onServerGameOver(data.winner, data.eloResult);
          updateUI();
        }
      } catch {}
    });
    es.onerror = () => {
      try { es.close(); } catch {}
      activeEventSource = null;
      if (!sseReconnectTimer) {
        sseReconnectTimer = setTimeout(() => {
          sseReconnectTimer = null;
          connectSSE();
          reSyncRoomState();
        }, 1500);
      }
    };
  } catch (err) {
    console.error('SSE connection error:', err);
  }
}

function reSyncRoomState() {
  if (gameMode !== 'multiplayer' || !currentGameId) return;
  if (!activeEventSource || activeEventSource.readyState === EventSource.CLOSED) {
    connectSSE();
  }
  fetch(`/api/room?id=${currentGameId}`)
    .then(r => r.json())
    .then(room => {
      if (room) {
        handleRoomSyncData(room, true);
      }
    })
    .catch(() => {});
}

// Re-fetch and re-render full room state when mobile phone wakes or app regains focus
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    sendHeartbeat();
    reSyncRoomState();
  }
});
window.addEventListener('focus', () => {
  sendHeartbeat();
  reSyncRoomState();
});
window.addEventListener('focus', () => {
  reSyncRoomState();
});

function setupMultiplayerChannel() {
  if (channel) channel.close();
  channel = new BroadcastChannel(`quoridor_room_${currentGameId}`);
  channel.onmessage = (e) => {
    const data = e.data;
    if (data.type === 'MOVE') {
      applyRemoteMove(data);
    } else if (data.type === 'CHAT') {
      renderChatMessage(data);
    } else if (data.type === 'ROOM_SYNC') {
      handleRoomSyncData(data.room);
    }
  };

  // Connect SSE for live real-time sync across devices
  connectSSE();

  // Periodic polling ensures instant fallback sync across mobile networks even if SSE drops
  if (pollInterval) clearInterval(pollInterval);
  pollInterval = setInterval(() => {
    if (gameMode === 'multiplayer') {
      fetch(`/api/room?id=${currentGameId}`)
        .then(r => r.json())
        .then(room => {
          if (!room) return;
          const wasWaiting = !waitingModal.classList.contains('hidden') || !sideSelectModal.classList.contains('hidden');
          handleRoomSyncData(room, wasWaiting);
        })
        .catch(() => {});
    }
  }, 300);

  // Initial room status fetch & auto-rejoin check with verified initData
  const rawInitData = getRawInitData();
  fetch('/api/room/rejoin', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: currentGameId,
      initData: rawInitData,
      playerId: myClientId,
      name: userProfile.name,
      elo: userProfile.elo,
      photoUrl: userProfile.photoUrl
    })
  })
    .then(r => r.json())
    .then(res => {
      if (res.isSpectator) {
        isSpectator = true;
        sideSelectModal.classList.add('hidden');
        waitingModal.classList.add('hidden');
      } else if (res.hasSeat && (res.seat || res.player?.side)) {
        const seat = res.seat || res.player?.side;
        if (res.player?.id) {
          myClientId = res.player.id;
          sessionStorage.setItem('quoridor_client_id', myClientId);
        }
        isSpectator = false;
        playerSide = seat;
        myPlayerIndex = seat === 'top' ? 0 : 1;
        localStorage.setItem(`quoridor_side_${currentGameId}`, seat);
        sideSelectModal.classList.add('hidden');
      } else {
        isSpectator = false;
        playerSide = null as any;
      }
      if (res.room) {
        handleRoomSyncData(res.room, true);
      }
    })
    .catch(() => {
      fetch(`/api/room?id=${currentGameId}`)
        .then(r => r.json())
        .then(room => handleRoomSyncData(room, true))
        .catch(() => {});
    });
}

function updateMatchBadgeUI() {
  const navBadge = document.getElementById('nav-match-badge');
  if (navBadge) {
    if (gameMode === 'bot' || !isRatedMatch) {
      navBadge.textContent = 'Unrated';
      navBadge.className = 'nav-match-badge unrated';
    } else {
      navBadge.textContent = 'Rated';
      navBadge.className = 'nav-match-badge rated';
    }
  }
}

function applyRemoteMove(_data?: any) {
  // Ignored in multiplayer because handleRoomSyncData receives the full authoritative room state!
}

function handleRoomSyncData(room: any, forceResync: boolean = false) {
  if (!room) return;
  const newVersion = typeof room.version === 'number' ? room.version : 0;
  // Accept any state with version higher than current, or full re-sync fetch even if version is the same
  if (!forceResync && newVersion > 0 && newVersion < localRoomVersion) {
    return;
  }
  if (newVersion > 0) {
    localRoomVersion = Math.max(localRoomVersion, newVersion);
  }
  console.log(`[CLIENT] State received from server v${newVersion} (forceResync=${forceResync})`);

  if (typeof room.rated === 'boolean') {
    // Only adopt room.rated if at least one seat is already confirmed
    if (room.topPlayer || room.bottomPlayer) {
      isRatedMatch = room.rated;
    }
  }
  if (room.presence) {
    currentRoomPresence = room.presence;
  }
  updateMatchBadgeUI();

  // Synchronize chat history from room state
  if (Array.isArray(room.chat)) {
    for (const c of room.chat) {
      if (c) renderChatMessage(c);
    }
  }

  const tgUser = initTelegramWebApp();
  const myTgId = (tgUser && tgUser.id && tgUser.id !== 12345678) ? Number(tgUser.id) : null;
  const myCId = (myClientId && myClientId !== 'undefined' && myClientId !== 'null') ? myClientId : '';

  const isMeTop = Boolean(
    (myTgId && Number(room.topPlayer?.tgId) === myTgId) ||
    (myTgId && room.topPlayer?.id === `tg_${myTgId}`) ||
    (myCId && room.topPlayer?.id === myCId)
  );

  const isMeBottom = Boolean(
    (myTgId && Number(room.bottomPlayer?.tgId) === myTgId) ||
    (myTgId && room.bottomPlayer?.id === `tg_${myTgId}`) ||
    (myCId && room.bottomPlayer?.id === myCId)
  );

  // SCENARIO 1: BOTH PLAYERS ARE IN THE ROOM -> START THE MATCH OR SPECTATE!
  if (room.topPlayer && room.bottomPlayer) {
    if (isMeTop) {
      isSpectator = false;
      playerSide = 'top';
      myPlayerIndex = 0;
      if (room.topPlayer?.id) {
        myClientId = room.topPlayer.id;
        sessionStorage.setItem('quoridor_client_id', myClientId);
      }
      localStorage.setItem(`quoridor_side_${currentGameId}`, 'top');
      opponentName = room.bottomPlayer.name;
      opponentElo = room.bottomPlayer.elo;
      opponentPhotoUrl = room.bottomPlayer.photoUrl;
      if (botSubTitleEl) botSubTitleEl.textContent = '';
    } else if (isMeBottom) {
      isSpectator = false;
      playerSide = 'bottom';
      myPlayerIndex = 1;
      if (room.bottomPlayer?.id) {
        myClientId = room.bottomPlayer.id;
        sessionStorage.setItem('quoridor_client_id', myClientId);
      }
      localStorage.setItem(`quoridor_side_${currentGameId}`, 'bottom');
      opponentName = room.topPlayer.name;
      opponentElo = room.topPlayer.elo;
      opponentPhotoUrl = room.topPlayer.photoUrl;
      if (botSubTitleEl) botSubTitleEl.textContent = '';
    } else {
      // 3rd player (or any visitor) entering an active 2-player game -> SPECTATOR ONLY
      isSpectator = true;
      playerSide = 'bottom';
      myPlayerIndex = 99 as Player;
      spectatorTopPlayer = {
        name: room.topPlayer.name,
        elo: room.topPlayer.elo,
        photoUrl: room.topPlayer.photoUrl
      };
      spectatorBottomPlayer = {
        name: room.bottomPlayer.name,
        elo: room.bottomPlayer.elo,
        photoUrl: room.bottomPlayer.photoUrl
      };
      if (botSubTitleEl) botSubTitleEl.textContent = 'Spectating';
    }

    // Dismiss waiting screen and setup modal on all connected devices
    waitingModal.classList.add('hidden');
    sideSelectModal.classList.add('hidden');

    // Toggle Spectator Mode UI Elements (no spectator counts)
    if (isSpectator) {
      spectatorBanner?.classList.remove('hidden');
      spectatorBar?.classList.remove('hidden');
      actionToggles?.classList.add('hidden');
      btnResign?.classList.add('hidden');
      btnDraw?.classList.add('hidden');
      btnCancelGame?.classList.add('hidden');
    } else {
      spectatorBanner?.classList.add('hidden');
      spectatorBar?.classList.add('hidden');
      actionToggles?.classList.remove('hidden');
      btnResign?.classList.remove('hidden');
      btnDraw?.classList.remove('hidden');
      btnCancelGame?.classList.remove('hidden');
    }

    // Always ensure the board and UI are up-to-date with current game state
    if (room.gameState) {
      const prevTurn = gameState ? gameState.turn : null;
      gameState = normalizeGameState(room.gameState);
      if (room.moves && room.moves.length > moveHistory.length) {
        for (let i = moveHistory.length; i < room.moves.length; i++) {
          const m = room.moves[i];
          if (m) recordNotation(m.move || m, m.who);
        }
        sounds.playMove();
      }
      if (prevTurn !== myPlayerIndex && gameState.turn === myPlayerIndex && !isSpectator) {
        setInputMode('move');
      }
      requestAnimationFrame(() => {
        updateUI();
        renderBoard();
        void gridEl.offsetHeight;
      });
      if (gameState.over >= 0) {
        onServerGameOver(gameState.over as Player, room.eloResult, room.topPlayer, room.bottomPlayer);
      }
      console.log(`[CLIENT] Board re-rendered for turn: ${gameState.turn}`);
    } else {
      updateUI();
    }
    return;
  }

  // SCENARIO 2: ONLY TOP PLAYER PRESENT (Host waiting for opponent)
  if (room.topPlayer && !room.bottomPlayer) {
    if (isMeTop) {
      isSpectator = false;
      playerSide = 'top';
      myPlayerIndex = 0;
      if (room.topPlayer?.id) {
        myClientId = room.topPlayer.id;
        sessionStorage.setItem('quoridor_client_id', myClientId);
      }
      localStorage.setItem(`quoridor_side_${currentGameId}`, 'top');
      opponentName = 'Waiting for opponent…';
      waitingSideText.textContent = 'Top (Plays 1st)';
      waitingRatingText.textContent = room.rated ? 'Yes' : 'No';
      sideSelectModal.classList.add('hidden');
      waitingModal.classList.remove('hidden');
      updateUI();
    } else {
      waitingModal.classList.add('hidden');
      openSideSelectModal();
      updateSideButtons('top', room.rated, room.topPlayer.name);
    }
    return;
  }

  // SCENARIO 3: ONLY BOTTOM PLAYER PRESENT
  if (room.bottomPlayer && !room.topPlayer) {
    if (isMeBottom) {
      isSpectator = false;
      playerSide = 'bottom';
      myPlayerIndex = 1;
      if (room.bottomPlayer?.id) {
        myClientId = room.bottomPlayer.id;
        sessionStorage.setItem('quoridor_client_id', myClientId);
      }
      localStorage.setItem(`quoridor_side_${currentGameId}`, 'bottom');
      opponentName = 'Waiting for opponent…';
      waitingSideText.textContent = 'Bottom (Plays 2nd)';
      waitingRatingText.textContent = room.rated ? 'Yes' : 'No';
      sideSelectModal.classList.add('hidden');
      waitingModal.classList.remove('hidden');
      updateUI();
    } else {
      waitingModal.classList.add('hidden');
      openSideSelectModal();
      updateSideButtons('bottom', room.rated, room.bottomPlayer.name);
    }
    return;
  }

  // SCENARIO 4: NEITHER HAS JOINED YET (Host setup screen)
  if (!room.topPlayer && !room.bottomPlayer) {
    waitingModal.classList.add('hidden');
    openSideSelectModal();
    updateSideButtons(null);
  }
}

function startNewGame() {
  isSpectator = false;
  hasProcessedGameOver = false;
  if (gameMode === 'bot' && !playerSide) {
    playerSide = 'bottom';
    myPlayerIndex = 1;
  }
  gameState = createInitialState(0);
  isBotThinking = false;
  moveHistory.length = 0;
  gameOverModal.classList.add('hidden');
  setInputMode('move');
  updateUI();
  renderNotation();
  triggerHaptic('medium');

  // If player chose Bottom, AI (Top / Player 0) makes the first move!
  if (gameMode === 'bot' && playerSide === 'bottom' && gameState.turn === 0) {
    triggerBotMoveIfNeeded();
  }
}

function setInputMode(mode: InputMode) {
  inputMode = mode;
  btnModeMove.classList.toggle('active', mode === 'move');
  btnModeWall.classList.toggle('active', mode === 'wall');
  triggerHaptic('light');
  renderBoard();
}

function updateUI() {
  updateMatchBadgeUI();
  if (isSpectator && spectatorTopPlayer && spectatorBottomPlayer) {
    p1NameEl.textContent = spectatorBottomPlayer.name;
    p1EloBadge.textContent = String(spectatorBottomPlayer.elo);
    p1EloBadge.style.backgroundColor = getEloBadgeColor(spectatorBottomPlayer.elo);
    p1AvatarEl.innerHTML = renderAvatarHtml(spectatorBottomPlayer.name, spectatorBottomPlayer.photoUrl);

    p2NameEl.textContent = spectatorTopPlayer.name;
    p2EloBadge.textContent = String(spectatorTopPlayer.elo);
    p2EloBadge.style.backgroundColor = getEloBadgeColor(spectatorTopPlayer.elo);
    p2AvatarEl.innerHTML = renderAvatarHtml(spectatorTopPlayer.name, spectatorTopPlayer.photoUrl);

    p2Bar.classList.toggle('active-turn', gameState.turn === 0);
    p1Bar.classList.toggle('active-turn', gameState.turn === 1);

    const topPres = currentRoomPresence?.top || 'waiting';
    const bottomPres = currentRoomPresence?.bottom || 'waiting';
    p2TurnTag.innerHTML = formatPresenceLabel(topPres, gameState.over === -1 && gameState.turn === 0, false);
    p1TurnTag.innerHTML = formatPresenceLabel(bottomPres, gameState.over === -1 && gameState.turn === 1, false);

    p2WallsCount.textContent = String(gameState.walls[0]);
    p1WallsCount.textContent = String(gameState.walls[1]);

    renderWallDots(p2WallDots, gameState.walls[0]);
    renderWallDots(p1WallDots, gameState.walls[1]);

    updateProfileUI();
    renderBoard();
    return;
  }

  const isTopPlayer = playerSide === 'top';

  // Bottom bar (Player 1 / Row 0)
  const bottomName = isTopPlayer ? opponentName : userProfile.name;
  const bottomElo = isTopPlayer ? opponentElo : userProfile.elo;

  // Top bar (Player 0 / Row 7)
  const topName = isTopPlayer ? userProfile.name : opponentName;
  const topElo = isTopPlayer ? userProfile.elo : opponentElo;

  p1NameEl.textContent = bottomName;
  p2NameEl.textContent = topName;

  p1EloBadge.textContent = String(bottomElo);
  p1EloBadge.style.backgroundColor = getEloBadgeColor(bottomElo);

  p2EloBadge.textContent = String(topElo);
  p2EloBadge.style.backgroundColor = getEloBadgeColor(topElo);

  // Render real Telegram profile avatars
  const userAvatarHtml = renderAvatarHtml(userProfile.name, userProfile.photoUrl);
  const oppAvatarHtml = gameMode === 'bot' ? '🤖' : renderAvatarHtml(opponentName, opponentPhotoUrl);

  if (isTopPlayer) {
    p2AvatarEl.innerHTML = userAvatarHtml;
    p1AvatarEl.innerHTML = oppAvatarHtml;
  } else {
    p1AvatarEl.innerHTML = userAvatarHtml;
    p2AvatarEl.innerHTML = oppAvatarHtml;
  }

  // Active turn indicators (0 = Top / Row 7, 1 = Bottom / Row 0)
  p2Bar.classList.toggle('active-turn', gameState.turn === 0);
  p1Bar.classList.toggle('active-turn', gameState.turn === 1);

  const topPres = gameMode === 'bot' ? 'playing' : (currentRoomPresence?.top || 'waiting');
  const bottomPres = gameMode === 'bot' ? 'playing' : (currentRoomPresence?.bottom || 'waiting');
  p2TurnTag.innerHTML = formatPresenceLabel(topPres, gameState.over === -1 && gameState.turn === 0, isTopPlayer);
  p1TurnTag.innerHTML = formatPresenceLabel(bottomPres, gameState.over === -1 && gameState.turn === 1, !isTopPlayer);

  updateOpponentDisconnectBanner();

  // Wall counts
  p2WallsCount.textContent = String(gameState.walls[0]);
  p1WallsCount.textContent = String(gameState.walls[1]);
  p1WallBtnCount.textContent = String(gameState.walls[myPlayerIndex]);

  renderWallDots(p2WallDots, gameState.walls[0]);
  renderWallDots(p1WallDots, gameState.walls[1]);

  const isMyTurn = (
    !isSpectator &&
    gameState.over === -1 &&
    !isBotThinking &&
    (gameMode === 'pvp' || gameState.turn === myPlayerIndex)
  );

  (btnModeMove as HTMLButtonElement).disabled = !isMyTurn;
  (btnModeWall as HTMLButtonElement).disabled = !isMyTurn || gameState.walls[myPlayerIndex] <= 0;
  if (!isMyTurn) {
    btnModeMove.style.opacity = '0.5';
    btnModeWall.style.opacity = '0.5';
    btnModeMove.style.pointerEvents = 'none';
    btnModeWall.style.pointerEvents = 'none';
  } else {
    btnModeMove.style.opacity = '1';
    btnModeWall.style.opacity = gameState.walls[myPlayerIndex] <= 0 ? '0.5' : '1';
    btnModeMove.style.pointerEvents = 'auto';
    btnModeWall.style.pointerEvents = gameState.walls[myPlayerIndex] <= 0 ? 'none' : 'auto';
  }

  updateProfileUI();
  renderBoard();
}

function updateProfileUI() {
  drawerAvatar.innerHTML = renderAvatarHtml(userProfile.name, userProfile.photoUrl);
  drawerName.textContent = userProfile.name;
  drawerEloBadge.textContent = String(userProfile.elo);
  drawerEloBadge.style.backgroundColor = getEloBadgeColor(userProfile.elo);
  drawerRoleTag.textContent = `Playing ${playerSide === 'top' ? 'Top ⬆️ (Plays First)' : 'Bottom ⬇️ (Plays Second)'}`;
  drawerTierName.textContent = getTierTitle(userProfile.elo);

  drawerStatRating.textContent = String(userProfile.elo);
  drawerStatPeak.textContent = String(userProfile.peakElo);
  drawerStatWins.textContent = `${userProfile.wins} (${userProfile.losses}L)`;
  drawerStatStreak.textContent = `${userProfile.currentStreak} 🔥`;
}

function renderWallDots(container: HTMLElement, remaining: number) {
  container.innerHTML = '';
  for (let i = 0; i < 8; i++) {
    const dot = document.createElement('span');
    dot.className = `wall-dot ${i >= remaining ? 'spent' : ''}`;
    container.appendChild(dot);
  }
}

const cellElements: HTMLElement[] = [];

function initGridDOM() {
  gridEl.innerHTML = '';
  cellElements.length = 0;
  for (let r = 7; r >= 0; r--) {
    for (let c = 0; c < 8; c++) {
      const cell = r * 8 + c;
      const cellEl = document.createElement('div');
      cellEl.className = 'q-cell';
      cellEl.dataset.cell = String(cell);
      cellEl.addEventListener('click', () => onCellClick(cell));
      gridEl.appendChild(cellEl);
      cellElements[cell] = cellEl;
    }
  }
}

function renderBoard() {
  if (cellElements.length !== 64) {
    initGridDOM();
  }

  const currentTurn = gameState.turn;
  const isMyTurn = (
    !isSpectator &&
    gameState.over === -1 &&
    !isBotThinking &&
    (gameMode === 'pvp' || currentTurn === myPlayerIndex)
  );

  const validPawnMoves = isMyTurn ? getPawnMoves(gameState, currentTurn) : [];

  for (let cell = 0; cell < 64; cell++) {
    const cellEl = cellElements[cell];
    if (!cellEl) continue;

    let cls = 'q-cell';
    let inner = '';

    if (gameState.pos[0] === cell) {
      inner = `<span class="q-pawn">🚀</span>`;
    } else if (gameState.pos[1] === cell) {
      inner = `<span class="q-pawn">${gameMode === 'bot' ? '🤖' : '👾'}</span>`;
    } else if (gameState.blocked[cell]) {
      cls += ' is-wall-cell';
    } else if (inputMode === 'move' && validPawnMoves.includes(cell)) {
      cls += ' valid-step';
    }

    if (cellEl.className !== cls) {
      cellEl.className = cls;
    }
    if (cellEl.innerHTML !== inner) {
      cellEl.innerHTML = inner;
    }
  }
  void gridEl.offsetHeight;
}

async function onCellClick(cell: number) {
  if (isSpectator) return;
  if (gameState.over >= 0 || isBotThinking) return;

  if (gameMode === 'multiplayer') {
    // In online multiplayer: CLIENT RUNS NO GAME RULES, NO OPTIMISTIC MUTATION, NO WIN DETECTION.
    // It only sends the move intent to the server!
    if (gameState.turn !== myPlayerIndex) return;

    if (inputMode === 'move') {
      const validMoves = getPawnMoves(gameState, myPlayerIndex);
      if (validMoves.includes(cell)) {
        const move: Move = { type: 'move', to: cell, from: gameState.pos[myPlayerIndex] };
        broadcastMove(move, myPlayerIndex);
        sounds.playMove();
        triggerHaptic('light');
        setInputMode('move');
      } else {
        sounds.playError();
        triggerHaptic('error');
      }
    } else {
      if (isWallLegal(gameState, cell, myPlayerIndex)) {
        const move: Move = { type: 'wall', cell };
        broadcastMove(move, myPlayerIndex);
        sounds.playWall();
        triggerHaptic('medium');
        setInputMode('move');
      } else {
        sounds.playError();
        triggerHaptic('error');
      }
    }
    return;
  }

  const who = gameState.turn;
  if (gameMode === 'bot' && who !== myPlayerIndex) return;

  if (inputMode === 'move') {
    const validMoves = getPawnMoves(gameState, who);
    if (validMoves.includes(cell)) {
      const move: Move = { type: 'move', to: cell, from: gameState.pos[who] };
      gameState = applyMove(gameState, who, move);
      recordNotation(move, who);
      sounds.playMove();
      triggerHaptic('light');
      setInputMode('move');

      if (gameState.over >= 0) {
        onServerGameOver(gameState.over as Player);
      }
      updateUI();
      triggerBotMoveIfNeeded();
    } else {
      sounds.playError();
      triggerHaptic('error');
    }
  } else {
    if (isWallLegal(gameState, cell, who)) {
      const move: Move = { type: 'wall', cell };
      gameState = applyMove(gameState, who, move);
      recordNotation(move, who);
      sounds.playWall();
      triggerHaptic('medium');
      setInputMode('move');

      if (gameState.over >= 0) {
        onServerGameOver(gameState.over as Player);
      }
      updateUI();
      triggerBotMoveIfNeeded();
    } else {
      sounds.playError();
      triggerHaptic('error');
    }
  }
}

function broadcastMove(move: Move, who: Player) {
  if (isSpectator) return;
  console.log('[CLIENT] Move sent: ', move, 'for player', who);
  if (gameMode === 'multiplayer') {
    const payload = {
      id: currentGameId,
      type: 'MOVE',
      sender: userProfile.name,
      senderId: myClientId,
      move,
      who,
      initData: getRawInitData()
    };

    fetch('/api/room/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(async response => {
      if (!response.ok) {
        const roomResponse = await fetch(`/api/room?id=${currentGameId}`);
        if (roomResponse.ok) {
          const room = await roomResponse.json();
          handleRoomSyncData(room, true);
        }
      }
    }).catch(err => console.error('broadcastMove error:', err));
  }
}

async function triggerBotMoveIfNeeded() {
  const botPlayerIndex: Player = (1 - myPlayerIndex) as Player;
  if (gameMode !== 'bot' || gameState.over >= 0 || gameState.turn !== botPlayerIndex) return;

  isBotThinking = true;
  updateUI();

  const botMove = await botThink(gameState, botPlayerIndex, 350);
  gameState = applyMove(gameState, botPlayerIndex, botMove);
  recordNotation(botMove, botPlayerIndex);

  if (botMove.type === 'move') sounds.playMove();
  else sounds.playWall();

  isBotThinking = false;
  if (gameState.over >= 0) {
    onServerGameOver(gameState.over as Player);
  }
  updateUI();
}

function recordNotation(move: Move, who: Player) {
  let moveStr = '';
  if (move.type === 'move') {
    moveStr = `${cellToCoord(move.from!)}-${cellToCoord(move.to!)}`;
  } else {
    moveStr = `🧱 ${cellToCoord(move.cell!)}`;
  }

  if (who === 0) {
    moveHistory.push({
      num: moveHistory.length + 1,
      p1: moveStr
    });
  } else {
    if (moveHistory.length > 0 && !moveHistory[moveHistory.length - 1].p2) {
      moveHistory[moveHistory.length - 1].p2 = moveStr;
    } else {
      moveHistory.push({
        num: moveHistory.length + 1,
        p1: '...',
        p2: moveStr
      });
    }
  }
  renderNotation();
}

function renderNotation() {
  if (moveHistory.length === 0) {
    notationList.innerHTML = `<div class="notation-empty">No moves recorded yet.</div>`;
    return;
  }
  notationList.innerHTML = moveHistory.map(row => `
    <div class="notation-row">
      <span class="notation-num">${row.num}.</span>
      <span>${row.p1}</span>
      <span>${row.p2 || ''}</span>
    </div>
  `).join('');
  notationList.scrollTop = notationList.scrollHeight;
}

let hasProcessedGameOver = false;

function onServerGameOver(winnerIndex: number, eloResult?: any, topPlayer?: any, bottomPlayer?: any) {
  if (hasProcessedGameOver) return;
  hasProcessedGameOver = true;

  sounds.playWin();
  triggerHaptic('success');

  const winnerIsTop = winnerIndex === 0;
  const isWinner = winnerIndex === myPlayerIndex;
  const isDraw = winnerIndex === 2;

  if (isSpectator) {
    const topName = spectatorTopPlayer?.name || topPlayer?.name || 'Top Player';
    const botName = spectatorBottomPlayer?.name || bottomPlayer?.name || 'Bottom Player';
    if (isDraw) {
      modalTitle.textContent = 'Draw';
      modalDesc.textContent = 'Game ended in a mutual draw agreement.';
    } else {
      const winnerName = winnerIsTop ? topName : botName;
      modalTitle.textContent = 'Match Finished';
      modalDesc.textContent = `${winnerName} reached the goal line and won!`;
    }
    modalEloPill.textContent = 'Spectator';
    modalEloPill.style.backgroundColor = '#64748b';
    if (eloResult && eloResult.rated) {
      modalDeltaText.textContent = `Top: ${eloResult.topDelta >= 0 ? '+' : ''}${eloResult.topDelta} | Bottom: ${eloResult.bottomDelta >= 0 ? '+' : ''}${eloResult.bottomDelta}`;
      modalDeltaText.style.color = '#10b981';
    } else {
      modalDeltaText.textContent = isRatedMatch ? 'Rated Game' : 'Unrated Game';
      modalDeltaText.style.color = '#94a3b8';
    }

    setTimeout(() => {
      gameOverModal.classList.remove('hidden');
    }, 350);
    return;
  }

  // Exact server Elo integration
  let eloDelta = 0;
  const isServerRated = eloResult && eloResult.rated === true;

  if (isServerRated) {
    eloDelta = myPlayerIndex === 0 ? eloResult.topDelta : eloResult.bottomDelta;
    const newElo = myPlayerIndex === 0 ? eloResult.topNewElo : eloResult.bottomNewElo;
    userProfile.elo = newElo;
    userProfile.peakElo = Math.max(userProfile.peakElo || 1000, newElo);
  }

  if (isDraw) {
    modalTitle.textContent = 'Draw';
    modalDesc.textContent = 'Game ended in a mutual draw agreement.';
  } else if (isWinner) {
    userProfile.wins += 1;
    userProfile.currentStreak += 1;
    userProfile.bestStreak = Math.max(userProfile.bestStreak, userProfile.currentStreak);
    modalTitle.textContent = 'Victory';
    modalDesc.textContent = `${userProfile.name} won the match!`;
  } else {
    userProfile.losses += 1;
    userProfile.currentStreak = 0;
    modalTitle.textContent = 'Defeat';
    modalDesc.textContent = `${opponentName} won the match!`;
  }
  saveProfile(userProfile);

  modalEloPill.textContent = String(userProfile.elo);
  modalEloPill.style.backgroundColor = getEloBadgeColor(userProfile.elo);

  if (isServerRated) {
    if (eloDelta > 0) {
      modalDeltaText.textContent = `+${eloDelta} ELO`;
      modalDeltaText.style.color = '#10b981';
    } else if (eloDelta < 0) {
      modalDeltaText.textContent = `${eloDelta} ELO`;
      modalDeltaText.style.color = '#f43f5e';
    } else {
      modalDeltaText.textContent = `0 ELO`;
      modalDeltaText.style.color = '#94a3b8';
    }
  } else {
    modalDeltaText.textContent = 'Unrated: no rating change';
    modalDeltaText.style.color = '#94a3b8';
  }

  setTimeout(() => {
    gameOverModal.classList.remove('hidden');
  }, 350);
}

function handleResign() {
  if (isSpectator) return;
  if (gameState.over >= 0) return;

  if (gameMode === 'multiplayer') {
    fetch('/api/room/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: currentGameId,
        type: 'RESIGN',
        senderId: myClientId
      })
    }).catch(() => {});
  } else {
    const winner = (1 - myPlayerIndex) as Player;
    gameState.over = winner;
    onServerGameOver(winner);
    updateUI();
  }
}

// Drawer & Tab Panels
function openDrawer() {
  updateProfileUI();
  sideDrawer.classList.remove('hidden');
  drawerBackdrop.classList.remove('hidden');
  triggerHaptic('light');
}

function closeDrawer() {
  sideDrawer.classList.add('hidden');
  drawerBackdrop.classList.add('hidden');
}

function toggleNotationPanel() {
  notationPanel.classList.toggle('hidden');
  chatPanel.classList.add('hidden');
  triggerHaptic('light');
}

function toggleChatPanel() {
  chatPanel.classList.toggle('hidden');
  notationPanel.classList.add('hidden');
  chatUnreadDot.classList.add('hidden');
  triggerHaptic('light');
}

// Live Chat System
function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

const renderedChatIds = new Set<string>();

function renderChatMessage(rawMsg: any) {
  if (!rawMsg) return;
  const msgId = String(rawMsg.id || '');
  if (msgId && renderedChatIds.has(msgId)) {
    return; // De-duplicate by message id
  }
  if (msgId) {
    renderedChatIds.add(msgId);
  }

  const senderId = String(rawMsg.senderId || '');
  const senderName = String(rawMsg.senderName || rawMsg.sender || 'Player');
  const text = String(rawMsg.text || '').trim();
  if (!text) return;

  const isSelf = (senderId && senderId === myClientId) ||
                 (rawMsg.isSelf === true) ||
                 (!senderId && senderName === userProfile.name);

  const formattedTime = rawMsg.timestamp
    ? new Date(rawMsg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : (rawMsg.time || new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));

  const msgObj: ChatMessage = {
    id: msgId || Math.random().toString(),
    senderId,
    sender: senderName,
    text,
    isSelf,
    time: formattedTime
  };
  chatMessages.push(msgObj);

  const msgEl = document.createElement('div');
  msgEl.className = `chat-msg ${isSelf ? 'mine' : 'theirs'}`;
  msgEl.innerHTML = `
    ${!isSelf ? `<div class="chat-msg-sender">${escapeHtml(senderName)}</div>` : ''}
    <div>${escapeHtml(text)}</div>
  `;
  chatMessagesList.appendChild(msgEl);
  chatMessagesList.scrollTop = chatMessagesList.scrollHeight;

  if (chatPanel.classList.contains('hidden') && !isSelf) {
    chatUnreadDot.classList.remove('hidden');
  }
}


function handleSendMessage(e: Event) {
  e.preventDefault();
  let text = chatInputField.value.trim();
  if (!text) return;
  if (text.length > 300) {
    text = text.slice(0, 300);
  }
  chatInputField.value = '';

  if (gameMode === 'multiplayer') {
    fetch('/api/room/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: currentGameId,
        type: 'CHAT',
        text,
        senderId: myClientId,
        initData: getRawInitData()
      })
    })
      .then(r => r.json())
      .then(res => {
        if (res.msg) {
          renderChatMessage(res.msg);
        }
      })
      .catch(err => console.error('Failed to send chat message:', err));
  } else {
    renderChatMessage({
      id: 'local_' + Math.random().toString(36).slice(2),
      senderName: userProfile.name,
      senderId: myClientId,
      text,
      isSelf: true,
      timestamp: Date.now()
    });

    // Simulated live match responses in bot mode
    if (Math.random() > 0.4) {
      setTimeout(() => {
        const botReplies = ['Good move!', 'Watch my wall placement 🧱', 'Nice try!', 'Calculating shortest path…'];
        const reply = botReplies[Math.floor(Math.random() * botReplies.length)];
        renderChatMessage({
          id: 'bot_' + Math.random().toString(36).slice(2),
          senderName: opponentName,
          senderId: 'bot',
          text: reply,
          isSelf: false,
          timestamp: Date.now()
        });
      }, 1200);
    }
  }
}

function shareMatchLink() {
  const tg = getTelegram();
  const botUser = tg?.initDataUnsafe?.bot_username || 'panel4wordseekbot';
  const matchUrl = `https://t.me/${botUser}?start=game_${currentGameId}`;
  const text = `⚔️ Play Quoridor with me! Room #${currentGameId.slice(-4)}`;

  if (tg?.openTelegramLink) {
    tg.openTelegramLink(`https://t.me/share/url?url=${encodeURIComponent(matchUrl)}&text=${encodeURIComponent(text)}`);
  } else {
    navigator.clipboard?.writeText(`${matchUrl}\n${text}`);
    alert(`Invite link copied to clipboard!\n${matchUrl}`);
  }
}

init();
