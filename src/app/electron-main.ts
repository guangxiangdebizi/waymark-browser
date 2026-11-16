import { app, BrowserWindow, WebContentsView, ipcMain, Menu, clipboard, nativeTheme, type WebContents, type Input, type MenuItemConstructorOptions } from 'electron';
import { randomUUID } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, fromRoot } from '../config.js';
import { createTranslator } from '../i18n.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

process.env.WAYMARK_CONFIG ??= process.env.AGENT_BROWSER_CONFIG ?? './config/electron.json';
const config = loadConfig();
const t = (key: string, values?: unknown[]) => createTranslator(config.uiLanguage).t(key, values);
app.setPath('userData', fromRoot(config.browser.userDataDir));

const API = `http://${config.server.host}:${config.server.port}`;
const HOME_URL = `${API}/home`;
const TOP = 84;
const PANEL_WIDTH = 380;

type Owner = 'agent' | 'user';
interface TabState { view: WebContentsView; owner: Owner; favicon?: string; loading: boolean }

let shell: BrowserWindow;
let activeId = 0;
let panelOpen = true;
const tabs = new Map<number, TabState>();

function layout(): void {
  if (!shell || shell.isDestroyed() || shell.isMinimized()) return;
  const [width, height] = shell.getContentSize();
  // A minimized or transiently collapsed window must not shrink pages to zero; automation keeps the last real size.
  if (width < 200 || height < TOP + 100) return;
  const pageWidth = Math.max(320, width - (panelOpen ? PANEL_WIDTH : 0));
  for (const { view } of tabs.values()) view.setBounds({ x: 0, y: TOP, width: pageWidth, height: height - TOP });
}

function summary(id: number, state: TabState) {
  const contents = state.view.webContents;
  const url = contents.getURL();
  return {
    id, url, owner: state.owner, favicon: state.favicon, loading: state.loading, active: id === activeId,
    title: !url || url.startsWith('about:blank') ? t("新标签页") : contents.getTitle() || (url.startsWith(HOME_URL) ? t("新标签页") : url),
    canGoBack: contents.navigationHistory.canGoBack(), canGoForward: contents.navigationHistory.canGoForward(),
    isHome: url.startsWith(HOME_URL), zoom: Math.round(contents.getZoomFactor() * 100)
  };
}

function listTabs() { return [...tabs.entries()].map(([id, state]) => summary(id, state)); }

let publishTimer: NodeJS.Timeout | undefined;
function publish(): void {
  if (publishTimer) return;
  publishTimer = setTimeout(() => {
    publishTimer = undefined;
    if (!shell || shell.isDestroyed()) return;
    shell.webContents.send('tabs:changed', listTabs());
    const current = tabs.get(activeId);
    shell.setTitle(current ? `${summary(activeId, current).title} - Waymark` : 'Waymark');
  }, 30);
}

function activate(id: number): void {
  const state = tabs.get(id);
  if (!state) return;
  activeId = id;
  for (const [otherId, other] of tabs) other.view.setVisible(otherId === id);
  state.view.webContents.focus();
  publish();
}

function close(id: number): void {
  const state = tabs.get(id);
  if (!state) return;
  const order = [...tabs.keys()];
  const index = order.indexOf(id);
  tabs.delete(id);
  shell.contentView.removeChildView(state.view);
  state.view.webContents.close();
  if (activeId === id) activeId = order[index + 1] ?? order[index - 1] ?? 0;
  if (activeId && tabs.has(activeId)) activate(activeId); else { activeId = 0; publish(); }
}

function normalize(input: string): string {
  const value = input.trim();
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value)) return value;
  if (/^(localhost|\d{1,3}(\.\d{1,3}){3})(:\d+)?(\/|$)/.test(value)) return `http://${value}`;
  if (!/\s/.test(value) && /^[^\s/]+\.[a-z]{2,}(:\d+)?(\/.*)?$/i.test(value)) return `https://${value}`;
  return `https://www.bing.com/search?q=${encodeURIComponent(value)}`;
}

function createTab(token: string, url = 'about:blank', owner: Owner = 'agent', background = false): number {
  const view = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false, backgroundThrottling: false } });
  const contents = view.webContents;
  const id = contents.id;
  const state: TabState = { view, owner, loading: true };
  tabs.set(id, state);
  shell.contentView.addChildView(view);
  view.setVisible(false);
  layout();
  void contents.loadURL(url === 'about:blank' ? `about:blank#${token}` : url).catch(() => undefined);
  contents.on('page-title-updated', event => { event.preventDefault(); publish(); });
  contents.on('page-favicon-updated', (_event, icons) => { state.favicon = icons[0]; publish(); });
  contents.on('did-start-loading', () => { state.loading = true; publish(); });
  contents.on('did-stop-loading', () => { state.loading = false; publish(); });
  contents.on('did-navigate', () => { state.favicon = undefined; publish(); });
  contents.on('did-navigate-in-page', publish);
  contents.on('zoom-changed', (_event, direction) => zoom(id, direction === 'in' ? 1 : -1));
  contents.on('before-input-event', (event, input) => { if (shortcut(input)) event.preventDefault(); });
  contents.on('context-menu', (_event, params) => pageMenu(id, contents, params));
  contents.on('destroyed', () => {
    if (!tabs.delete(id)) return;
    if (activeId === id) activeId = [...tabs.keys()].at(-1) ?? 0;
    if (activeId) activate(activeId); else publish();
  });
  contents.setWindowOpenHandler(({ url: target, disposition }) => {
    createTab(randomUUID(), target, owner, disposition === 'background-tab');
    return { action: 'deny' };
  });
  if (!background || !activeId) activate(id); else publish();
  return id;
}

function navigate(id: number, url: string): void {
  const state = tabs.get(id);
  if (state && url.trim()) void state.view.webContents.loadURL(normalize(url)).catch(() => undefined);
}

function history(id: number, action: 'back' | 'forward' | 'reload' | 'stop' | 'home'): void {
  const contents = tabs.get(id)?.view.webContents;
  if (!contents) return;
  if (action === 'back' && contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack();
  else if (action === 'forward' && contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward();
  else if (action === 'reload') contents.reload();
  else if (action === 'stop') contents.stop();
  else if (action === 'home') void contents.loadURL(HOME_URL).catch(() => undefined);
}

function zoom(id: number, step: number): void {
  const contents = tabs.get(id)?.view.webContents;
  if (!contents) return;
  const levels = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];
  const current = contents.getZoomFactor();
  const index = levels.findIndex(level => level >= current - 0.001);
  contents.setZoomFactor(step === 0 ? 1 : levels[Math.min(levels.length - 1, Math.max(0, (index < 0 ? 5 : index) + step))]);
  publish();
}

function setPanel(open: boolean): void {
  panelOpen = open;
  layout();
  if (shell && !shell.isDestroyed()) shell.webContents.send('panel:changed', panelOpen);
}

function shellCommand(command: string): void { if (shell && !shell.isDestroyed()) shell.webContents.send('shell:command', command); }

function shortcut(input: Input): boolean {
  if (input.type !== 'keyDown') return false;
  const ctrl = input.control || input.meta;
  const key = input.key.toLowerCase();
  const order = [...tabs.keys()];
  if (ctrl && key === 't') { createTab(randomUUID(), HOME_URL, 'user'); shellCommand('focus-address'); return true; }
  if (ctrl && key === 'w') { if (activeId) close(activeId); return true; }
  if (ctrl && key === 'l' || input.key === 'F6') { shellCommand('focus-address'); return true; }
  if (ctrl && key === 'r' || input.key === 'F5') { history(activeId, 'reload'); return true; }
  if (input.alt && input.key === 'ArrowLeft') { history(activeId, 'back'); return true; }
  if (input.alt && input.key === 'ArrowRight') { history(activeId, 'forward'); return true; }
  if (ctrl && input.key === 'Tab') {
    const index = order.indexOf(activeId);
    if (order.length) activate(order[(index + (input.shift ? -1 : 1) + order.length) % order.length]);
    return true;
  }
  if (ctrl && /^[1-9]$/.test(key)) { const target = key === '9' ? order.at(-1) : order[Number(key) - 1]; if (target) activate(target); return true; }
  if (ctrl && (key === '=' || key === '+')) { zoom(activeId, 1); return true; }
  if (ctrl && key === '-') { zoom(activeId, -1); return true; }
  if (ctrl && key === '0') { zoom(activeId, 0); return true; }
  if (ctrl && input.shift && key === 'b' || input.key === 'F1') { setPanel(!panelOpen); return true; }
  if (input.key === 'F12' || ctrl && input.shift && key === 'i') { tabs.get(activeId)?.view.webContents.toggleDevTools(); return true; }
  return false;
}

function pageMenu(id: number, contents: WebContents, params: Electron.ContextMenuParams): void {
  const items: MenuItemConstructorOptions[] = [];
  if (params.linkURL) {
    items.push(
      { label: t("在新标签页中打开链接"), click: () => createTab(randomUUID(), params.linkURL, 'user', true) },
      { label: t("复制链接地址"), click: () => clipboard.writeText(params.linkURL) },
      { type: 'separator' }
    );
  }
  if (params.mediaType === 'image' && params.srcURL) {
    items.push(
      { label: t("在新标签页中打开图片"), click: () => createTab(randomUUID(), params.srcURL, 'user', true) },
      { label: t("复制图片地址"), click: () => clipboard.writeText(params.srcURL) },
      { type: 'separator' }
    );
  }
  if (params.isEditable) {
    items.push({ label: t("剪切"), role: 'cut', enabled: params.editFlags.canCut }, { label: t("复制"), role: 'copy', enabled: params.editFlags.canCopy },
      { label: t("粘贴"), role: 'paste', enabled: params.editFlags.canPaste }, { label: t("全选"), role: 'selectAll' }, { type: 'separator' });
  } else if (params.selectionText) {
    const text = params.selectionText.trim().slice(0, 40);
    items.push({ label: t("复制"), role: 'copy' },
      { label: t("用必应搜索“{0}{1}”", [text, params.selectionText.length > 40 ? '…' : '']), click: () => createTab(randomUUID(), normalize(params.selectionText.replace(/\s+/g, ' ').trim()), 'user') },
      { type: 'separator' });
  }
  items.push(
    { label: t("后退"), enabled: contents.navigationHistory.canGoBack(), click: () => history(id, 'back') },
    { label: t("前进"), enabled: contents.navigationHistory.canGoForward(), click: () => history(id, 'forward') },
    { label: t("重新加载"), click: () => history(id, 'reload') },
    { type: 'separator' },
    { label: t("检查元素"), click: () => contents.inspectElement(params.x, params.y) }
  );
  Menu.buildFromTemplate(items).popup({ window: shell });
}

function tabMenu(id: number): void {
  const state = tabs.get(id);
  if (!state) return;
  Menu.buildFromTemplate([
    { label: t("新标签页"), click: () => createTab(randomUUID(), HOME_URL, 'user') },
    { label: t("重新加载"), click: () => history(id, 'reload') },
    { label: t("复制网址"), click: () => clipboard.writeText(state.view.webContents.getURL()) },
    { label: t("复制此标签页"), click: () => createTab(randomUUID(), state.view.webContents.getURL(), 'user') },
    { type: 'separator' },
    { label: t("关闭标签页"), click: () => close(id) },
    { label: t("关闭其他标签页"), enabled: tabs.size > 1, click: () => [...tabs.keys()].filter(other => other !== id).forEach(close) }
  ]).popup({ window: shell });
}

async function api(method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown> {
  if (!path.startsWith('/api/')) throw new Error('Only local cockpit APIs are reachable from the shell');
  const response = await fetch(API + path, { method, headers: body === undefined ? undefined : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(8000) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error((data as { error?: string }).error || `HTTP ${response.status}`);
  const language = (data as { uiLanguage?: string }).uiLanguage;
  if (language && language !== config.uiLanguage) {
    config.uiLanguage = language;
    for (const { view } of tabs.values()) {
      const url = view.webContents.getURL();
      if (url === HOME_URL || url === `${API}/audit`) view.webContents.reload();
    }
    publish();
  }
  return data;
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  const dark = nativeTheme.shouldUseDarkColors;
  shell = new BrowserWindow({
    width: 1440, height: 920, minWidth: 900, minHeight: 600,
    title: 'Waymark', backgroundColor: dark ? '#1b1c22' : '#e9ebf2', show: false,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: dark ? '#1b1c22' : '#e9ebf2', symbolColor: dark ? '#e6e7ee' : '#3b3d4a', height: 40 },
    webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  nativeTheme.on('updated', () => {
    const isDark = nativeTheme.shouldUseDarkColors;
    shell.setTitleBarOverlay({ color: isDark ? '#1b1c22' : '#e9ebf2', symbolColor: isDark ? '#e6e7ee' : '#3b3d4a', height: 40 });
  });
  shell.on('resize', layout);
  shell.on('restore', layout);
  shell.on('maximize', layout);
  shell.on('unmaximize', layout);
  shell.once('ready-to-show', () => { if (shell.isMinimized()) shell.restore(); shell.show(); shell.focus(); layout(); });
  void shell.loadFile(join(__dirname, 'shell', 'index.html'), { query: { 'agent-shell': '1', lang: config.uiLanguage || 'en' } });
  shell.webContents.on('did-finish-load', publish);
  shell.webContents.on('before-input-event', (event, input) => { if (shortcut(input)) event.preventDefault(); });
});

ipcMain.handle('tabs:list', () => listTabs());
ipcMain.handle('tabs:new', (_event, url?: string) => createTab(randomUUID(), url ? normalize(url) : HOME_URL, 'user'));
ipcMain.handle('tabs:active', (_event, id: number) => activate(id));
ipcMain.handle('tabs:close', (_event, id: number) => close(id));
ipcMain.handle('tabs:navigate', (_event, id: number, url: string) => navigate(id, url));
ipcMain.handle('tabs:history', (_event, id: number, action: 'back' | 'forward' | 'reload' | 'stop' | 'home') => history(id, action));
ipcMain.handle('tabs:zoom', (_event, id: number, step: number) => zoom(id, step));
ipcMain.handle('tabs:menu', (_event, id: number) => tabMenu(id));
ipcMain.handle('tabs:move', (_event, id: number, beforeId: number | null) => {
  const state = tabs.get(id);
  if (!state || id === beforeId) return;
  const entries = [...tabs.entries()].filter(([other]) => other !== id);
  const index = beforeId === null ? entries.length : entries.findIndex(([other]) => other === beforeId);
  entries.splice(index < 0 ? entries.length : index, 0, [id, state]);
  tabs.clear();
  for (const [key, value] of entries) tabs.set(key, value);
  publish();
});
ipcMain.handle('tabs:focusOrigin', (_event, origin: string) => {
  const match = [...tabs.entries()].find(([, state]) => { try { return new URL(state.view.webContents.getURL()).origin === origin; } catch { return false; } });
  if (match) activate(match[0]);
  return Boolean(match);
});
ipcMain.handle('tabs:devtools', () => tabs.get(activeId)?.view.webContents.toggleDevTools());
ipcMain.handle('panel:get', () => panelOpen);
ipcMain.handle('panel:set', (_event, open: boolean) => setPanel(Boolean(open)));
ipcMain.handle('clipboard:write', (_event, text: string) => clipboard.writeText(String(text)));
ipcMain.handle('api:get', (_event, path: string) => api('GET', path));
ipcMain.handle('api:post', (_event, path: string, body?: unknown) => api('POST', path, body ?? {}));
ipcMain.handle('app:info', () => ({ api: API, home: HOME_URL, mcp: `${API}/mcp`, platform: process.platform, version: app.getVersion() }));

function setOwner(id: number, owner: Owner): void {
  const state = tabs.get(id);
  if (state) { state.owner = owner; publish(); }
}

(globalThis as any).agentShell = { createTab, activate, close, navigate, setOwner };

app.on('window-all-closed', () => app.quit());
