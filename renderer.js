const state = {
  libraries: [],
  books: [],
  selectedLibraryId: null,
  selectedBook: null,
  selectedPart: null,
  text: '',
  segments: [],
  pages: [],
  pageIndex: 0,
  currentParts: [],
  chapters: [],
  currentChapterIndex: -1
};

const elements = {
  libraryList: document.getElementById('libraryList'),
  bookList: document.getElementById('bookList'),
  partList: document.getElementById('partList'),
  chapterList: document.getElementById('chapterList'),
  readerTitle: document.getElementById('readerTitle'),
  readerText: document.getElementById('readerText'),
  readerViewport: document.getElementById('readerViewport'),
  pageIndicator: document.getElementById('pageIndicator'),
  statusBar: document.getElementById('statusBar'),
  addLocalBtn: document.getElementById('addLocalBtn'),
  addGitHubBtn: document.getElementById('addGitHubBtn'),
  githubUrl: document.getElementById('githubUrl'),
  prevPageBtn: document.getElementById('prevPageBtn'),
  nextPageBtn: document.getElementById('nextPageBtn'),
  prevPartBtn: document.getElementById('prevPartBtn'),
  nextPartBtn: document.getElementById('nextPartBtn'),
  measure: document.getElementById('measure')
};

let partLoadToken = 0;
let resizeTimer = null;
const PAGE_SEPARATOR = 'PAGE_SEPARATOR';

function setStatus(message, isError = false) {
  elements.statusBar.textContent = message || '';
  elements.statusBar.dataset.error = isError ? 'true' : 'false';
}

function setBusy(isBusy) {
  elements.addLocalBtn.disabled = isBusy;
  elements.addGitHubBtn.disabled = isBusy;
  elements.githubUrl.disabled = isBusy;
}

function clearReader() {
  state.text = '';
  state.segments = [];
  state.pages = [];
  state.pageIndex = 0;
  state.chapters = [];
  state.currentChapterIndex = -1;
  elements.readerText.textContent = '';
  elements.pageIndicator.textContent = 'Page 0 / 0';
  elements.chapterList.innerHTML = '';
}

function updateReaderTitle() {
  if (!state.selectedBook) {
    elements.readerTitle.textContent = 'Choose a library to begin';
    return;
  }
  const partLabel = state.selectedPart ? ` — ${state.selectedPart.label}` : '';
  elements.readerTitle.textContent = `${state.selectedBook}${partLabel}`;
}

async function refreshLibraries(selectId = null) {
  state.libraries = await window.api.getLibraries();
  if (selectId) {
    state.selectedLibraryId = selectId;
  }
  renderLibraries();
}

function renderLibraries() {
  elements.libraryList.innerHTML = '';
  state.libraries.forEach((library) => {
    const item = document.createElement('li');
    item.textContent = library.label;
    item.dataset.id = library.id;
    if (library.id === state.selectedLibraryId) {
      item.classList.add('active');
    }
    elements.libraryList.appendChild(item);
  });
}

function renderBooks() {
  elements.bookList.innerHTML = '';
  state.books.forEach((book) => {
    const item = document.createElement('li');
    item.textContent = book.title;
    item.dataset.title = book.title;
    if (book.title === state.selectedBook) {
      item.classList.add('active');
    }
    elements.bookList.appendChild(item);
  });
}

function renderParts() {
  elements.partList.innerHTML = '';
  state.currentParts.forEach((part) => {
    const item = document.createElement('li');
    item.textContent = part.label;
    item.dataset.partId = part.id;
    if (state.selectedPart && part.id === state.selectedPart.id) {
      item.classList.add('active');
    }
    elements.partList.appendChild(item);
  });
}

function renderChapters() {
  elements.chapterList.innerHTML = '';
  state.chapters.forEach((chapter, index) => {
    const item = document.createElement('li');
    item.textContent = chapter.title;
    item.dataset.chapterIndex = String(index);
    item.classList.add('chapter');
    if (index === state.currentChapterIndex) {
      item.classList.add('active');
    }
    elements.chapterList.appendChild(item);
  });
}

function renderPage() {
  if (!state.pages.length) {
    elements.readerText.textContent = state.text ? state.text : '';
    elements.pageIndicator.textContent = state.text ? 'Page 1 / 1' : 'Page 0 / 0';
    updateCurrentChapter();
    updateControls();
    return;
  }
  const page = state.pages[state.pageIndex];
  elements.readerText.textContent = state.text.slice(page.start, page.end);
  elements.pageIndicator.textContent = `Page ${state.pageIndex + 1} / ${state.pages.length}`;
  updateCurrentChapter();
  updateControls();
}

function updateControls() {
  elements.prevPageBtn.disabled = state.pageIndex <= 0;
  elements.nextPageBtn.disabled = state.pageIndex >= state.pages.length - 1;
  const partIndex = state.currentParts.findIndex(
    (part) => state.selectedPart && part.id === state.selectedPart.id
  );
  elements.prevPartBtn.disabled = partIndex <= 0;
  elements.nextPartBtn.disabled = partIndex < 0 || partIndex >= state.currentParts.length - 1;
}

function normalizeText(rawText) {
  const lines = rawText.split(/\r?\n/);
  const segments = [];
  let current = [];
  for (const line of lines) {
    if (line.trim() === PAGE_SEPARATOR) {
      segments.push(current.join('\n'));
      current = [];
    } else {
      current.push(line);
    }
  }
  segments.push(current.join('\n'));

  const joiner = '\n\n';
  let offset = 0;
  const ranges = [];
  const displayText = segments.join(joiner);
  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i];
    const start = offset;
    const end = start + segment.length;
    ranges.push({ start, end });
    offset = end + (i === segments.length - 1 ? 0 : joiner.length);
  }
  return { text: displayText, segments: ranges };
}

function paginateText(text, measureEl, maxHeight) {
  const pages = [];
  if (!text) {
    return pages;
  }

  let start = 0;
  const total = text.length;
  while (start < total) {
    let low = start + 1;
    let high = total;
    let best = start + 1;
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      measureEl.textContent = text.slice(start, mid);
      if (measureEl.scrollHeight <= maxHeight) {
        best = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    if (best <= start) {
      best = Math.min(start + 1, total);
    }
    pages.push({ start, end: best });
    start = best;
  }
  return pages;
}

function paginateSegments(text, segments, measureEl, maxHeight) {
  const pages = [];
  if (!segments.length) {
    return pages;
  }
  for (const segment of segments) {
    const segmentText = text.slice(segment.start, segment.end);
    if (!segmentText) {
      continue;
    }
    const segmentPages = paginateText(segmentText, measureEl, maxHeight);
    segmentPages.forEach((page) => {
      pages.push({
        start: segment.start + page.start,
        end: segment.start + page.end
      });
    });
  }
  return pages;
}

function findPageIndex(pages, position) {
  let low = 0;
  let high = pages.length - 1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const page = pages[mid];
    if (position < page.start) {
      high = mid - 1;
    } else if (position >= page.end) {
      low = mid + 1;
    } else {
      return mid;
    }
  }
  return 0;
}

function parseChapters(text) {
  const chapters = [];
  const lines = text.split('\n');
  let offset = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.startsWith('##')) {
      const title = line.replace(/^##\s*/, '').trim() || 'Untitled Chapter';
      chapters.push({ title, position: offset, pageIndex: 0 });
    }
    offset += line.length;
    if (i < lines.length - 1) {
      offset += 1;
    }
  }
  return chapters;
}

function updateCurrentChapter() {
  if (!state.chapters.length || !state.pages.length) {
    state.currentChapterIndex = -1;
    renderChapters();
    return;
  }
  const pageStart = state.pages[state.pageIndex].start;
  let currentIndex = -1;
  for (let i = 0; i < state.chapters.length; i += 1) {
    if (state.chapters[i].position <= pageStart) {
      currentIndex = i;
    } else {
      break;
    }
  }
  state.currentChapterIndex = currentIndex;
  renderChapters();
}

async function paginateAndRender(keepPosition = false) {
  await new Promise((resolve) => requestAnimationFrame(resolve));
  if (!state.text) {
    clearReader();
    updateReaderTitle();
    return;
  }
  const viewportHeight = elements.readerViewport.clientHeight;
  const viewportWidth = elements.readerText.clientWidth;
  if (viewportHeight <= 0 || viewportWidth <= 0) {
    state.pages = [{ start: 0, end: state.text.length }];
    state.pageIndex = 0;
    renderPage();
    return;
  }

  const currentPosition = keepPosition && state.pages.length
    ? state.pages[state.pageIndex].start
    : 0;

  elements.measure.style.width = `${viewportWidth}px`;
  state.pages = paginateSegments(state.text, state.segments, elements.measure, viewportHeight);
  state.pageIndex = findPageIndex(state.pages, currentPosition);
  state.chapters = parseChapters(state.text).map((chapter) => ({
    ...chapter,
    pageIndex: findPageIndex(state.pages, chapter.position)
  }));
  renderChapters();
  renderPage();
}

async function selectLibrary(libraryId) {
  state.selectedLibraryId = libraryId;
  state.selectedBook = null;
  state.selectedPart = null;
  state.currentParts = [];
  state.chapters = [];
  clearReader();
  renderLibraries();
  setStatus('Scanning library...');
  try {
    state.books = await window.api.scanLibrary(libraryId);
    renderBooks();
    renderParts();
    setStatus(state.books.length ? '' : 'No books found in this library.');
  } catch (error) {
    setStatus(error.message || 'Failed to scan library.', true);
  }
}

async function selectBook(bookTitle) {
  state.selectedBook = bookTitle;
  const book = state.books.find((item) => item.title === bookTitle);
  state.currentParts = book ? book.parts : [];
  state.selectedPart = null;
  state.chapters = [];
  clearReader();
  renderBooks();
  renderParts();
  renderChapters();
  updateReaderTitle();
  if (state.currentParts.length) {
    await selectPart(state.currentParts[0].id);
  } else {
    setStatus('No TXT parts found in this book.');
  }
}

async function selectPart(partId) {
  const token = ++partLoadToken;
  const part = state.currentParts.find((item) => item.id === partId);
  if (!part) {
    return;
  }
  state.selectedPart = part;
  renderParts();
  renderChapters();
  updateReaderTitle();
  setStatus('Loading part...');
  try {
    const text = await window.api.readPart(
      state.selectedLibraryId,
      state.selectedBook,
      part
    );
    if (token !== partLoadToken) {
      return;
    }
    const normalized = normalizeText(text || '');
    state.text = normalized.text;
    state.segments = normalized.segments;
    await paginateAndRender(false);
    setStatus('');
  } catch (error) {
    setStatus(error.message || 'Failed to load part.', true);
  }
}

function goToNextPage() {
  if (state.pageIndex < state.pages.length - 1) {
    state.pageIndex += 1;
    renderPage();
  }
}

function goToPrevPage() {
  if (state.pageIndex > 0) {
    state.pageIndex -= 1;
    renderPage();
  }
}

async function goToNextPart() {
  const idx = state.currentParts.findIndex(
    (part) => state.selectedPart && part.id === state.selectedPart.id
  );
  if (idx >= 0 && idx < state.currentParts.length - 1) {
    await selectPart(state.currentParts[idx + 1].id);
  }
}

async function goToPrevPart() {
  const idx = state.currentParts.findIndex(
    (part) => state.selectedPart && part.id === state.selectedPart.id
  );
  if (idx > 0) {
    await selectPart(state.currentParts[idx - 1].id);
  }
}

elements.libraryList.addEventListener('click', (event) => {
  const item = event.target.closest('li');
  if (!item) {
    return;
  }
  selectLibrary(item.dataset.id);
});

elements.bookList.addEventListener('click', (event) => {
  const item = event.target.closest('li');
  if (!item) {
    return;
  }
  selectBook(item.dataset.title);
});

elements.partList.addEventListener('click', (event) => {
  const item = event.target.closest('li');
  if (!item) {
    return;
  }
  selectPart(item.dataset.partId);
});

elements.chapterList.addEventListener('click', (event) => {
  const item = event.target.closest('li');
  if (!item) {
    return;
  }
  const index = Number.parseInt(item.dataset.chapterIndex, 10);
  const chapter = state.chapters[index];
  if (!chapter) {
    return;
  }
  state.pageIndex = chapter.pageIndex;
  renderPage();
});

elements.addLocalBtn.addEventListener('click', async () => {
  setBusy(true);
  setStatus('Waiting for folder selection...');
  try {
    const library = await window.api.addLocalLibrary();
    if (library) {
      await refreshLibraries(library.id);
      await selectLibrary(library.id);
    } else {
      setStatus('');
    }
  } catch (error) {
    setStatus(error.message || 'Failed to add library.', true);
  } finally {
    setBusy(false);
  }
});

elements.addGitHubBtn.addEventListener('click', async () => {
  const url = elements.githubUrl.value.trim();
  if (!url) {
    setStatus('Enter a GitHub repository URL first.', true);
    return;
  }
  setBusy(true);
  setStatus('Fetching repository...');
  try {
    const library = await window.api.addGitHubLibrary(url);
    if (library) {
      elements.githubUrl.value = '';
      await refreshLibraries(library.id);
      await selectLibrary(library.id);
    }
  } catch (error) {
    setStatus(error.message || 'Failed to add GitHub library.', true);
  } finally {
    setBusy(false);
  }
});

elements.prevPageBtn.addEventListener('click', () => {
  goToPrevPage();
});

elements.nextPageBtn.addEventListener('click', () => {
  goToNextPage();
});

elements.prevPartBtn.addEventListener('click', () => {
  goToPrevPart();
});

elements.nextPartBtn.addEventListener('click', () => {
  goToNextPart();
});

window.addEventListener('keydown', (event) => {
  const active = document.activeElement;
  if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) {
    return;
  }
  if (event.key === 'ArrowRight' || event.key === 'PageDown') {
    event.preventDefault();
    goToNextPage();
  }
  if (event.key === 'ArrowLeft' || event.key === 'PageUp') {
    event.preventDefault();
    goToPrevPage();
  }
});

window.addEventListener('resize', () => {
  if (resizeTimer) {
    clearTimeout(resizeTimer);
  }
  resizeTimer = setTimeout(() => {
    paginateAndRender(true);
  }, 200);
});

async function init() {
  setStatus('Loading libraries...');
  try {
    await refreshLibraries();
    setStatus(state.libraries.length ? '' : 'Add a library to start reading.');
  } catch (error) {
    setStatus(error.message || 'Failed to load libraries.', true);
  }
}

init();
