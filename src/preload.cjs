// En CommonJS : un preload sandboxe ne peut pas etre un module ES, alors que le
// package.json du projet est "type": "module". L'extension .cjs tranche.
const { contextBridge, ipcRenderer } = require('electron');

// Flux a sens unique, du process principal vers la page. La page n'a ni Node,
// ni acces au disque, ni moyen de repondre : elle ne fait qu'afficher.
contextBridge.exposeInMainWorld('mur', {
  surMeme: (callback) => ipcRenderer.on('meme', (_evenement, meme) => callback(meme)),
  surRetrait: (callback) => ipcRenderer.on('retrait', () => callback()),
});
