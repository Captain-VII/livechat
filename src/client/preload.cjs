// En CommonJS : un preload sandboxe ne peut pas etre un module ES, alors que le
// package.json du projet est "type": "module". L'extension .cjs tranche.
const { contextBridge, ipcRenderer } = require('electron');

// La page n'a ni Node, ni acces au disque. Elle recoit ce qu'il faut afficher,
// et ne renvoie qu'une chose : la liste des sorties audio, que seul un renderer
// peut enumerer.
contextBridge.exposeInMainWorld('livechat', {
  surMeme: (callback) => ipcRenderer.on('meme', (_evenement, meme) => callback(meme)),
  surRetrait: (callback) => ipcRenderer.on('retrait', () => callback()),
  surSortieAudio: (callback) => ipcRenderer.on('sortie-audio', (_evenement, id) => callback(id)),
  annoncerSorties: (sorties) => ipcRenderer.send('sorties-audio', sorties),
  demanderPasser: () => ipcRenderer.send('demander-passer'),
  survolBoutonPasser: (survole) => ipcRenderer.send('survol-bouton-passer', survole),
});
