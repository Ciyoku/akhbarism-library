const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs/promises');
const fsSync = require('fs');
const { execFile } = require('child_process');
const crypto = require('crypto');

const WINDOW_WIDTH = 1200;
const WINDOW_HEIGHT = 800;

let librariesCache = null;

function execFileAsync(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { windowsHide: true, ...options }, (error, stdout, stderr) => {
      if (error) {
        const wrapped = new Error(stderr || error.message || 'Command failed');
        wrapped.cause = error;
        return reject(wrapped);
      }
      return resolve({ stdout, stderr });
    });
  });
}

function makeId(input) {
  return crypto.createHash('sha1').update(input).digest('hex');
}

function getRepoLabel(url) {
  const clean = url.trim().replace(/\.git$/i, '');
  const parts = clean.split(/[/:]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : clean;
}

function getPaths() {
  const userData = app.getPath('userData');
  return {
    userData,
    librariesFile: path.join(userData, 'libraries.json'),
    reposDir: path.join(userData, 'repos')
  };
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function loadLibraries() {
  if (librariesCache) {
    return librariesCache;
  }
  const { librariesFile, reposDir } = getPaths();
  await ensureDir(path.dirname(librariesFile));
  await ensureDir(reposDir);
  try {
    const raw = await fs.readFile(librariesFile, 'utf8');
    const parsed = JSON.parse(raw);
    librariesCache = Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    librariesCache = [];
  }
  return librariesCache;
}

async function saveLibraries(libraries) {
  const { librariesFile } = getPaths();
  await ensureDir(path.dirname(librariesFile));
  await fs.writeFile(librariesFile, JSON.stringify(libraries, null, 2), 'utf8');
  librariesCache = libraries;
}

async function ensureGitAvailable() {
  try {
    await execFileAsync('git', ['--version']);
  } catch (error) {
    throw new Error('Git is required but was not found in your PATH.');
  }
}

async function cloneSparseRepo(repoUrl, destDir) {
  await ensureGitAvailable();
  const destExists = fsSync.existsSync(destDir);
  if (destExists) {
    const gitDir = path.join(destDir, '.git');
    if (!fsSync.existsSync(gitDir)) {
      throw new Error('Destination exists and is not a git repository.');
    }
    return;
  }

  try {
    await execFileAsync('git', [
      'clone',
      '--depth',
      '1',
      '--filter=blob:none',
      '--sparse',
      repoUrl,
      destDir
    ]);
    await execFileAsync('git', ['-C', destDir, 'sparse-checkout', 'set', 'books']);
  } catch (error) {
    throw new Error(
      'Failed to clone with sparse checkout. Ensure your Git version supports sparse checkout.'
    );
  }
}

async function isDirectory(targetPath) {
  try {
    const stat = await fs.stat(targetPath);
    return stat.isDirectory();
  } catch (error) {
    return false;
  }
}

function isWithinRoot(rootPath, targetPath) {
  const relative = path.relative(rootPath, targetPath);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function parsePartInfo(filename) {
  const match = filename.match(/\d+/);
  if (!match) {
    return { hasNumber: false, number: 0 };
  }
  return { hasNumber: true, number: Number.parseInt(match[0], 10) };
}

function sortParts(a, b) {
  const aInfo = parsePartInfo(a);
  const bInfo = parsePartInfo(b);
  if (!aInfo.hasNumber && !bInfo.hasNumber) {
    return a.localeCompare(b, undefined, { sensitivity: 'base' });
  }
  if (!aInfo.hasNumber) {
    return -1;
  }
  if (!bInfo.hasNumber) {
    return 1;
  }
  if (aInfo.number !== bInfo.number) {
    return aInfo.number - bInfo.number;
  }
  return a.localeCompare(b, undefined, { sensitivity: 'base' });
}

function sortPartObjects(a, b) {
  const primary = sortParts(a.sortKey, b.sortKey);
  if (primary !== 0) {
    return primary;
  }
  return a.label.localeCompare(b.label, undefined, { sensitivity: 'base' });
}

async function scanBooks(booksRoot) {
  const entries = await fs.readdir(booksRoot, { withFileTypes: true });
  const bookDirs = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  bookDirs.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  const books = [];
  for (const bookDir of bookDirs) {
    const bookPath = path.join(booksRoot, bookDir);
    const files = await fs.readdir(bookPath, { withFileTypes: true });
    const directFiles = files
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .filter((name) => name.toLowerCase().endsWith('.txt'));

    const folderEntries = files.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    const parts = [];

    directFiles.forEach((name) => {
      parts.push({
        id: `file:${name}`,
        type: 'file',
        name,
        label: name,
        sortKey: name
      });
    });

    for (const folder of folderEntries) {
      const folderPath = path.join(bookPath, folder);
      const innerEntries = await fs.readdir(folderPath, { withFileTypes: true });
      const innerFiles = innerEntries
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name)
        .filter((name) => name.toLowerCase().endsWith('.txt'))
        .sort(sortParts);

      if (innerFiles.length > 1) {
        parts.push({
          id: `folder:${folder}`,
          type: 'folder',
          name: folder,
          label: folder,
          sortKey: folder
        });
      } else if (innerFiles.length === 1) {
        const relativeName = path.join(folder, innerFiles[0]);
        parts.push({
          id: `file:${relativeName}`,
          type: 'file',
          name: relativeName,
          label: relativeName,
          sortKey: innerFiles[0]
        });
      }
    }

    parts.sort(sortPartObjects);
    books.push({ title: bookDir, parts });
  }
  return books;
}

async function addLibrary(library) {
  const libraries = await loadLibraries();
  const existingIndex = libraries.findIndex((item) => item.id === library.id);
  if (existingIndex >= 0) {
    libraries[existingIndex] = library;
  } else {
    libraries.unshift(library);
  }
  await saveLibraries(libraries);
  return library;
}

async function createWindow() {
  const mainWindow = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#f5efe6',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  await mainWindow.loadFile('index.html');
}

ipcMain.handle('libraries:get', async () => {
  return loadLibraries();
});

ipcMain.handle('library:addLocal', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory'],
    title: 'Select your books folder'
  });
  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }
  const selectedPath = result.filePaths[0];
  if (!(await isDirectory(selectedPath))) {
    throw new Error('Selected path is not a folder.');
  }

  const library = {
    id: makeId(`local:${selectedPath}`),
    type: 'local',
    source: selectedPath,
    booksRoot: selectedPath,
    label: path.basename(selectedPath) || selectedPath
  };
  return addLibrary(library);
});

ipcMain.handle('library:addGitHub', async (_event, repoUrl) => {
  const trimmed = String(repoUrl || '').trim();
  if (!trimmed) {
    throw new Error('GitHub repository URL is required.');
  }

  const { reposDir } = getPaths();
  await ensureDir(reposDir);
  const repoId = makeId(trimmed);
  const repoPath = path.join(reposDir, repoId);

  await cloneSparseRepo(trimmed, repoPath);
  const booksRoot = path.join(repoPath, 'books');
  if (!(await isDirectory(booksRoot))) {
    throw new Error('No books folder found in the repository.');
  }

  const library = {
    id: makeId(`github:${trimmed}`),
    type: 'github',
    source: trimmed,
    booksRoot,
    label: getRepoLabel(trimmed)
  };
  return addLibrary(library);
});

ipcMain.handle('library:scan', async (_event, libraryId) => {
  const libraries = await loadLibraries();
  const library = libraries.find((item) => item.id === libraryId);
  if (!library) {
    throw new Error('Library not found.');
  }
  if (!(await isDirectory(library.booksRoot))) {
    throw new Error('Library path is missing.');
  }
  return scanBooks(library.booksRoot);
});

ipcMain.handle('book:readPart', async (_event, libraryId, bookTitle, part) => {
  const libraries = await loadLibraries();
  const library = libraries.find((item) => item.id === libraryId);
  if (!library) {
    throw new Error('Library not found.');
  }

  const safeBookTitle = String(bookTitle || '');
  const safePart = part && typeof part === 'object' ? part : null;
  if (!safePart || !safePart.name || !safePart.type) {
    throw new Error('Invalid part request.');
  }
  const safePartName = String(safePart.name || '');
  const bookPath = path.join(library.booksRoot, safeBookTitle);
  const partPath = path.join(bookPath, safePartName);
  if (!isWithinRoot(library.booksRoot, bookPath) || !isWithinRoot(bookPath, partPath)) {
    throw new Error('Invalid book or part path.');
  }
  if (!(await isDirectory(bookPath))) {
    throw new Error('Book folder not found.');
  }
  if (safePart.type === 'folder') {
    if (!(await isDirectory(partPath))) {
      throw new Error('Part folder not found.');
    }
    const innerEntries = await fs.readdir(partPath, { withFileTypes: true });
    const innerFiles = innerEntries
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .filter((name) => name.toLowerCase().endsWith('.txt'))
      .sort(sortParts);

    if (!innerFiles.length) {
      return '';
    }
    const contents = [];
    for (const filename of innerFiles) {
      const filePath = path.join(partPath, filename);
      if (!isWithinRoot(bookPath, filePath)) {
        continue;
      }
      contents.push(await fs.readFile(filePath, 'utf8'));
    }
    return contents.join('\n\n');
  }

  const text = await fs.readFile(partPath, 'utf8');
  return text;
});

app.whenReady().then(async () => {
  await createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
