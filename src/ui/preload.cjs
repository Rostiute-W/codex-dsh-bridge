const { contextBridge, ipcRenderer } = require('electron');
const allowed = new Set(['state', 'saveSettings', 'dshModels', 'pick', 'permission', 'resume', 'revalidate', 'revise', 'cancel', 'openWorktree', 'openDshChat', 'integration', 'installCodex', 'installDshObserver', 'copyTaskId', 'copyIntegration']);
contextBridge.exposeInMainWorld('bridge', Object.freeze({
  invoke(method, params) {
    if (!allowed.has(method)) return Promise.reject(new Error('未知操作。'));
    return ipcRenderer.invoke('bridge:invoke', { method, params });
  },
}));
