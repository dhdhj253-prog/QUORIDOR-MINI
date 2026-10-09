export interface TelegramUser {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  photo_url?: string;
}

export function getTelegram(): any {
  return (window as any).Telegram?.WebApp;
}

export function initTelegramWebApp(): TelegramUser {
  const tg = getTelegram();
  if (tg) {
    try {
      tg.ready();
      tg.expand();
      tg.setHeaderColor?.('#383c55');
      tg.setBackgroundColor?.('#555b7c');
    } catch {}

    const tgUser = tg.initDataUnsafe?.user;
    if (tgUser && (tgUser.id || tgUser.first_name)) {
      const u: TelegramUser = {
        id: tgUser.id || 12345678,
        first_name: tgUser.first_name || '',
        last_name: tgUser.last_name,
        username: tgUser.username,
        photo_url: tgUser.photo_url || (tgUser.id ? `/api/user/photo?id=${tgUser.id}` : undefined)
      };
      return u;
    }
  }

  // Parse tgWebAppData from hash or search
  try {
    const raw = (window.location.hash.slice(1) + '&' + window.location.search.slice(1));
    const params = new URLSearchParams(raw);
    const tgWebAppData = params.get('tgWebAppData');
    if (tgWebAppData) {
      const dataParams = new URLSearchParams(tgWebAppData);
      const userStr = dataParams.get('user');
      if (userStr) {
        const u = JSON.parse(decodeURIComponent(userStr));
        if (u && (u.id || u.first_name)) {
          const userObj: TelegramUser = {
            id: u.id || 12345678,
            first_name: u.first_name || '',
            last_name: u.last_name,
            username: u.username,
            photo_url: u.photo_url || (u.id ? `/api/user/photo?id=${u.id}` : undefined)
          };
          return userObj;
        }
      }
    }
  } catch {}

  return {
    id: 12345678,
    first_name: '',
    username: '',
    photo_url: undefined
  };
}

export function triggerHaptic(type: 'light' | 'medium' | 'heavy' | 'success' | 'error') {
  const tg = getTelegram();
  if (!tg?.HapticFeedback) return;
  try {
    if (type === 'success' || type === 'error') {
      tg.HapticFeedback.notificationOccurred(type);
    } else {
      tg.HapticFeedback.impactOccurred(type);
    }
  } catch {}
}

export function getRawInitData(): string {
  const tg = getTelegram();
  if (tg?.initData) return tg.initData;
  try {
    const raw = (window.location.hash.slice(1) + '&' + window.location.search.slice(1));
    const params = new URLSearchParams(raw);
    const tgWebAppData = params.get('tgWebAppData');
    if (tgWebAppData) return tgWebAppData;
  } catch {}
  return '';
}
