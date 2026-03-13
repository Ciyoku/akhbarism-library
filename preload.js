const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getLibraries: () => ipcRenderer.invoke('libraries:get'),
  addLocalLibrary: () => ipcRenderer.invoke('library:addLocal'),
  addGitHubLibrary: (repoUrl) => ipcRenderer.invoke('library:addGitHub', repoUrl),
  scanLibrary: (libraryId) => ipcRenderer.invoke('library:scan', libraryId),
  readPart: (libraryId, bookTitle, partName) =>
    ipcRenderer.invoke('book:readPart', libraryId, bookTitle, partName)
});
