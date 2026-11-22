// Cookie portability: normalize cookies between CDP / Playwright / Electron shapes, read them from another
// Chromium over its DevTools endpoint, and keep session cookies across restarts the way a normal browser does.

/** Common subset of a CDP Network.Cookie, a Playwright cookie and an Electron cookie. */
export interface CookieRecord {
  name: string;
  value: string;
  domain: string;
  path?: string;
  /** Seconds since the epoch; -1, 0 or missing means a session cookie. */
  expires?: number;
  expirationDate?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: string;
  hostOnly?: boolean;
  session?: boolean;
}

export interface PlaywrightCookie {
  name: string; value: string; domain: string; path: string; expires: number;
  httpOnly: boolean; secure: boolean; sameSite: 'Strict' | 'Lax' | 'None';
}

export function domainMatches(cookieDomain: string, filters?: string[]): boolean {
  if (!filters?.length) return true;
  const host = cookieDomain.replace(/^\./, '').toLowerCase();
  return filters.some(filter => {
    const f = filter.replace(/^\./, '').toLowerCase();
    return host === f || host.endsWith(`.${f}`);
  });
}

function sameSiteOf(value: string | undefined): PlaywrightCookie['sameSite'] {
  const v = (value ?? '').toLowerCase();
  if (v === 'strict') return 'Strict';
  if (v === 'none' || v === 'no_restriction') return 'None';
  return 'Lax';
}

/** Accepts CDP, Playwright or Electron cookie objects and returns what BrowserContext.addCookies expects. */
export function toPlaywright(cookie: CookieRecord): PlaywrightCookie {
  const expiresRaw = cookie.expires ?? cookie.expirationDate;
  const isSession = cookie.session === true || expiresRaw === undefined || expiresRaw <= 0;
  const secure = Boolean(cookie.secure);
  let sameSite = sameSiteOf(cookie.sameSite);
  // Chromium rejects SameSite=None without Secure.
  if (sameSite === 'None' && !secure) sameSite = 'Lax';
  return {
    name: cookie.name, value: cookie.value, domain: cookie.domain, path: cookie.path || '/',
    expires: isSession ? -1 : Math.floor(Number(expiresRaw)), httpOnly: Boolean(cookie.httpOnly), secure, sameSite
  };
}

/** Reads every cookie from another Chromium-based browser through its DevTools endpoint, e.g. http://127.0.0.1:9222. */
export async function readCdpCookies(endpoint: string, timeoutMs = 15000): Promise<CookieRecord[]> {
  const base = endpoint.replace(/\/+$/, '');
  let wsUrl = base;
  if (/^https?:/i.test(base)) {
    const response = await fetch(`${base}/json/version`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) throw new Error(`DevTools endpoint answered HTTP ${response.status}`);
    const info = await response.json() as { webSocketDebuggerUrl?: string };
    if (!info.webSocketDebuggerUrl) throw new Error('DevTools endpoint did not report webSocketDebuggerUrl');
    // Keep the host/port the caller used (it may be a tunnel), take only the path from the browser.
    const reported = new URL(info.webSocketDebuggerUrl);
    const given = new URL(base);
    wsUrl = `${given.protocol === 'https:' ? 'wss' : 'ws'}://${given.host}${reported.pathname}`;
  }
  return await new Promise<CookieRecord[]>((resolveCookies, reject) => {
    const socket = new WebSocket(wsUrl);
    const timer = setTimeout(() => { socket.close(); reject(new Error('Timed out reading cookies over DevTools')); }, timeoutMs);
    socket.addEventListener('open', () => socket.send(JSON.stringify({ id: 1, method: 'Storage.getCookies' })));
    socket.addEventListener('message', event => {
      const message = JSON.parse(String(event.data)) as { id?: number; result?: { cookies: CookieRecord[] }; error?: { message: string } };
      if (message.id !== 1) return;
      clearTimeout(timer);
      socket.close();
      if (message.error) reject(new Error(message.error.message)); else resolveCookies(message.result?.cookies ?? []);
    });
    socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error(`Cannot connect to ${wsUrl}`)); });
  });
}

/** Saved shape of session cookies between runs. */
export interface SessionCookieFile { savedAt: number; cookies: CookieRecord[] }

export const SESSION_COOKIE_MAX_AGE_DAYS = 30;

/** Drops a stale snapshot; a browser that was closed for over a month should not resurrect old sessions. */
export function restorable(file: SessionCookieFile | undefined, now = Date.now()): CookieRecord[] {
  if (!file || !Array.isArray(file.cookies)) return [];
  if (now - file.savedAt > SESSION_COOKIE_MAX_AGE_DAYS * 86400_000) return [];
  return file.cookies.filter(cookie => cookie && cookie.name && cookie.domain);
}

/** URL Electron's cookies.set needs to scope a cookie. */
export function cookieUrl(cookie: CookieRecord): string {
  return `${cookie.secure ? 'https' : 'http'}://${cookie.domain.replace(/^\./, '')}${cookie.path || '/'}`;
}
