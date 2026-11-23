import { contextBridge, ipcRenderer } from 'electron';

const subscribe = (channel: string) => (callback: (value: any) => void) => {
  const listener = (_event: unknown, value: unknown) => callback(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld('agentShell', {
  list: () => ipcRenderer.invoke('tabs:list'),
  newTab: (url?: string) => ipcRenderer.invoke('tabs:new', url),
  activate: (id: number) => ipcRenderer.invoke('tabs:active', id),
  close: (id: number) => ipcRenderer.invoke('tabs:close', id),
  navigate: (id: number, url: string) => ipcRenderer.invoke('tabs:navigate', id, url),
  history: (id: number, action: string) => ipcRenderer.invoke('tabs:history', id, action),
  zoom: (id: number, step: number) => ipcRenderer.invoke('tabs:zoom', id, step),
  tabMenu: (id: number) => ipcRenderer.invoke('tabs:menu', id),
  move: (id: number, beforeId: number | null) => ipcRenderer.invoke('tabs:move', id, beforeId),
  focusOrigin: (origin: string) => ipcRenderer.invoke('tabs:focusOrigin', origin),
  devtools: () => ipcRenderer.invoke('tabs:devtools'),
  getPanel: () => ipcRenderer.invoke('panel:get'),
  setPanel: (open: boolean) => ipcRenderer.invoke('panel:set', open),
  copy: (text: string) => ipcRenderer.invoke('clipboard:write', text),
  apiGet: (path: string) => ipcRenderer.invoke('api:get', path),
  apiPost: (path: string, body?: unknown) => ipcRenderer.invoke('api:post', path, body),
  info: () => ipcRenderer.invoke('app:info'),
  openWindow: (kind: string) => ipcRenderer.invoke('window:open', kind),
  onTabs: subscribe('tabs:changed'),
  onPanel: subscribe('panel:changed'),
  onCommand: subscribe('shell:command')
});
