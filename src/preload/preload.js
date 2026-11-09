'use strict';
// 渲染进程桥：仅暴露显式白名单通道（contextIsolation 开启）

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getSnapshot: () => ipcRenderer.invoke('get-snapshot'),
  getConfig: () => ipcRenderer.invoke('get-config'),
  saveConfig: (patch) => ipcRenderer.invoke('save-config', patch),
  refreshNow: () => ipcRenderer.invoke('refresh-now'),
  setCollapsed: (v) => ipcRenderer.invoke('set-collapsed', v),
  openSettings: () => ipcRenderer.invoke('open-settings'),
  getHistory: (providerId) => ipcRenderer.invoke('history:get', providerId),
  loginOpenCode: () => ipcRenderer.invoke('opencode:login'),
  logoutOpenCode: () => ipcRenderer.invoke('opencode:logout'),
  loginZhipu: () => ipcRenderer.invoke('zhipu:login'),
  logoutZhipu: () => ipcRenderer.invoke('zhipu:logout'),
  quit: () => ipcRenderer.invoke('quit-app'),
  onSnapshot: (cb) => ipcRenderer.on('snapshot', (e, d) => cb(d)),
  onConfigChanged: (cb) => ipcRenderer.on('config-changed', (e, d) => cb(d)),
  onOpenCodeAuth: (cb) => ipcRenderer.on('opencode:auth', (e, d) => cb(d)),
  onZhipuAuth: (cb) => ipcRenderer.on('zhipu:auth', (e, d) => cb(d)),
  ready: () => ipcRenderer.send('renderer-ready'),
});
