// En CommonJS pour la meme raison que l'autre preload : un preload sandboxe ne
// peut pas etre un module ES tant que le package.json est "type": "module".
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('config', {
  lire: () => ipcRenderer.invoke('config:lire'),
  sauver: (url) => ipcRenderer.invoke('config:sauver', url),
});
