// Initialize PDF.js
pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

// ---------------------------------------------------------------------------
// Safety helpers
//
// File names come from the user and are reflected into templates that are
// assigned via innerHTML, so every user-controlled value must be escaped.
// ---------------------------------------------------------------------------

function escapeHtml(value) {
    if (value === null || value === undefined) return '';
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// Same escaping for values interpolated into HTML *attributes* (href, title...).
const escapeAttr = escapeHtml;

// Escape text destined for a javascript: URL context is not needed, but keep
// one helper for building query strings safely.
function encodeFileParam(value) {
    return encodeURIComponent(String(value === null || value === undefined ? '' : value));
}

// Touch drag state
let touchDragState = {
    dragging: false,
    element: null,
    startY: 0,
    startX: 0,
    currentY: 0,
    currentX: 0,
    placeholder: null,
    list: null,
    items: [],
    fromIndex: -1
};

// State management
const state = {
    currentPanel: null,
    mergeFiles: [],
    mergePages: [],
    mergePdfDocs: new Map(),
    mergePreviewVisible: false,
    splitFile: null,
    splitSelectedPages: new Set(),
    splitPdfDoc: null,
    compressFile: null,
    pdfToJpgFile: null,
    pdfToJpgDoc: null,
    jpgToPdfFiles: [],
    organizeFile: null,
    organizePages: [],
    organizePdfDoc: null,
    insertedPdfs: [],
    expiryTimers: new Map(),
    isProcessing: false,
    sessionRestored: false
};

// ---------------------------------------------------------------------------
// Session persistence
//
// Files live on disk for up to 30 minutes, backed by a stable session cookie.
// The app keeps a small metadata cache in localStorage so a browser refresh
// can recover the current tool's documents instead of showing an empty panel.
// ---------------------------------------------------------------------------

const SESSION_STORAGE_KEY = 'pdf-utility-session-cache';

function readSessionCache() {
    try {
        const raw = localStorage.getItem(SESSION_STORAGE_KEY);
        const parsed = raw ? JSON.parse(raw) : null;
        return parsed && typeof parsed === 'object' && parsed.files ? parsed : { files: {} };
    } catch {
        return { files: {} };
    }
}

function writeSessionCache(cache) {
    try {
        localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(cache));
    } catch { /* storage unavailable — non-fatal */ }
}

function rememberSessionFile(file, tool) {
    if (!file || !file.id) return;
    const cache = readSessionCache();
    cache.files[file.id] = {
        id: file.id,
        originalName: file.name || file.originalName || file.id,
        size: file.size || 0,
        tool: tool || cache.files[file.id]?.tool || null,
        expiry: file.expiry || null,
    };
    writeSessionCache(cache);
}

function forgetSessionFile(fileId) {
    if (!fileId) return;
    const cache = readSessionCache();
    if (cache.files[fileId]) {
        delete cache.files[fileId];
        writeSessionCache(cache);
    }
}

/**
 * Render an empty-state placeholder into a file list container.
 * `container` may be the <ul>/<div> that normally holds file items.
 */
function renderEmptyState(container, title, hint) {
    if (!container) return;
    container.innerHTML = `
        <div class="empty-state">
            <div class="empty-state-icon">
                <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
                    <polyline points="14 2 14 8 20 8"></polyline>
                    <line x1="12" y1="18" x2="12" y2="12"></line>
                    <line x1="9" y1="15" x2="15" y2="15"></line>
                </svg>
            </div>
            <p class="empty-state-title">${escapeHtml(title)}</p>
            <p class="empty-state-hint">${escapeHtml(hint)}</p>
        </div>
    `;
}

/** Close the mobile navigation drawer (used by the router). */
function closeMobileMenu() {
    const menu = document.getElementById('mobile-menu');
    const btn = document.getElementById('mobile-menu-btn');
    if (menu && menu.classList.contains('active')) {
        menu.classList.remove('active');
        if (btn) btn.setAttribute('aria-expanded', 'false');
    }
}

/** Warn before leaving if a processing job is in progress. */
function installRouteGuard() {
    window.addEventListener('beforeunload', (e) => {
        if (state.isProcessing) {
            e.preventDefault();
            e.returnValue = 'Proses PDF sedang berjalan. Yakin ingin meninggalkan halaman?';
            return e.returnValue;
        }
    });
}

/**
 * Restore active files from the session API and rehydrate the currently open panel.
 * Called once on DOMContentLoaded and on every route change.
 */
async function restoreSessionFiles() {
    if (state.sessionRestored) return;
    state.sessionRestored = true;

    try {
        const response = await fetch('/api/session-files');
        if (!response.ok) return;
        const { success, files } = await response.json();
        if (!success || !Array.isArray(files) || files.length === 0) return;

        const panel = state.currentPanel;
        if (!panel) return;

        // Filter files belonging to the current panel's tool
        const toolFiles = files.filter(f => f.tool === panel);
        if (toolFiles.length === 0) return;

        showToast(`Sesi Anda dipulihkan (${toolFiles.length} berkas aktif)`);

        switch (panel) {
            case 'merge':
                for (const f of toolFiles) {
                    state.mergeFiles.push({
                        id: f.id,
                        name: f.originalName,
                        size: f.size,
                        expiry: f.expiry
                    });
                    startExpiryTimer(f.id, f.expiry);
                }
                renderMergeFileList();
                if (state.mergeFiles.length >= 2) {
                    document.getElementById('merge-action-bar').style.display = 'flex';
                }
                break;

            case 'split': {
                const f = toolFiles[0];
                state.splitFile = { id: f.id, originalName: f.originalName, size: f.size, expiry: f.expiry };
                document.getElementById('split-upload-zone').style.display = 'none';
                document.getElementById('split-options').style.display = 'block';
                document.getElementById('split-action-bar').style.display = 'flex';

                // Load PDF for preview
                showLoading('Memuat preview halaman...');
                const pdfUrl = `/api/pdf-file/${f.id}`;
                state.splitPdfDoc = await pdfjsLib.getDocument(pdfUrl).promise;
                hideLoading();

                state.splitFile.pageCount = state.splitPdfDoc.numPages;
                document.getElementById('split-pdf-info').innerHTML = `
                    <div class="pdf-info-icon">
                        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
                            <polyline points="14 2 14 8 20 8"></polyline>
                        </svg>
                    </div>
                    <div class="pdf-info-details">
                        <h4>${escapeHtml(f.originalName)}</h4>
                        <p>${state.splitFile.pageCount} halaman • ${formatFileSize(f.size)}</p>
                    </div>
                `;
                await renderSplitPagePreviews();
                startExpiryTimer(f.id, f.expiry);
                break;
            }

            case 'compress': {
                const f = toolFiles[0];
                state.compressFile = { id: f.id, originalName: f.originalName, size: f.size, expiry: f.expiry };
                document.getElementById('compress-upload-zone').style.display = 'none';
                document.getElementById('compress-options').style.display = 'block';
                document.getElementById('compress-action-bar').style.display = 'flex';

                document.getElementById('compress-pdf-info').innerHTML = `
                    <div class="pdf-info-icon">
                        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
                            <polyline points="14 2 14 8 20 8"></polyline>
                        </svg>
                    </div>
                    <div class="pdf-info-details">
                        <h4>${escapeHtml(f.originalName)}</h4>
                        <p>Ukuran asli: ${formatFileSize(f.size)}</p>
                    </div>
                `;
                document.getElementById('original-size-display').textContent = formatFileSize(f.size);
                const defaultTargetMB = (f.size / (1024 * 1024) * 0.5).toFixed(1);
                document.getElementById('target-size-value').value = defaultTargetMB;
                startExpiryTimer(f.id, f.expiry);
                break;
            }

            case 'pdf-to-jpg': {
                const f = toolFiles[0];
                state.pdfToJpgFile = { id: f.id, originalName: f.originalName, size: f.size, expiry: f.expiry };
                document.getElementById('pdf-to-jpg-upload-zone').style.display = 'none';
                document.getElementById('jpg-options').style.display = 'block';
                document.getElementById('pdf-to-jpg-action-bar').style.display = 'flex';

                document.getElementById('pdf-to-jpg-info').innerHTML = `
                    <div class="pdf-info-icon">
                        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
                            <polyline points="14 2 14 8 20 8"></polyline>
                        </svg>
                    </div>
                    <div class="pdf-info-details">
                        <h4>${escapeHtml(f.originalName)}</h4>
                        <p>${f.pageCount || '?'} halaman • ${formatFileSize(f.size)}</p>
                    </div>
                `;
                // Need to fetch page count if missing
                if (!f.pageCount) {
                    const infoResponse = await fetch(`/api/pdf-info/${f.id}`);
                    const infoData = await infoResponse.json();
                    state.pdfToJpgFile.pageCount = infoData.pageCount;
                    document.querySelector('#pdf-to-jpg-info .pdf-info-details p').textContent =
                        `${infoData.pageCount} halaman • ${formatFileSize(f.size)}`;
                }
                startExpiryTimer(f.id, f.expiry);
                break;
            }

            case 'jpg-to-pdf':
                for (const f of toolFiles) {
                    state.jpgToPdfFiles.push({
                        id: f.id,
                        name: f.originalName,
                        size: f.size,
                        expiry: f.expiry
                    });
                    startExpiryTimer(f.id, f.expiry);
                }
                renderJpgToPdfFileList();
                document.getElementById('jpg-to-pdf-action-bar').style.display = 'flex';
                document.getElementById('jpg-to-pdf-options').style.display = 'block';
                break;

            case 'organize': {
                const f = toolFiles[0];
                state.organizeFile = { id: f.id, originalName: f.originalName, size: f.size, expiry: f.expiry };
                document.getElementById('organize-upload-zone').style.display = 'none';
                document.getElementById('organize-workspace').style.display = 'block';

                showLoading('Memuat halaman...');
                const pdfUrl = `/api/pdf-file/${f.id}`;
                state.organizePdfDoc = await pdfjsLib.getDocument(pdfUrl).promise;
                hideLoading();

                await renderPageGrid();
                startExpiryTimer(f.id, f.expiry);
                break;
            }
        }
    } catch (error) {
        console.error('Session restore failed:', error);
    }
}

// Utility functions
function formatFileSize(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function showLoading(text = 'Memproses...') {
    document.getElementById('loading-text').textContent = text;
    document.getElementById('loading-overlay').classList.add('active');
}

function hideLoading() {
    state.isProcessing = false;
    document.getElementById('loading-overlay').classList.remove('active');
}

function showToast(message, type = 'success') {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.setAttribute('role', 'alert');
    toast.setAttribute('aria-live', 'polite');

    const icon = type === 'success' ?
        '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></svg>' :
        type === 'error' ?
        '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="15" y1="9" x2="9" y2="15"></line><line x1="9" y1="9" x2="15" y2="15"></line></svg>' :
        '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>';

    toast.innerHTML = `${icon}<span>${escapeHtml(message)}</span>`;
    container.appendChild(toast);

    setTimeout(() => {
        toast.style.animation = 'slideIn 0.3s ease reverse';
        setTimeout(() => toast.remove(), 300);
    }, 4000);
}

function formatTime(seconds) {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

/** Seconds left before an expiry timestamp, clamped at zero. */
function remainingSeconds(expiry) {
    const until = Number(expiry);
    if (!Number.isFinite(until)) return 0;
    return Math.max(0, Math.floor((until - Date.now()) / 1000));
}

// ---------------------------------------------------------------------------
// Hash router
//
// Every tool lives at its own hash (/#/merge, /#/split, ...). That makes the
// browser Back button behave the way people expect, and lets any tool be
// bookmarked or reloaded without losing the page.
// ---------------------------------------------------------------------------

// Route key -> tool panel id suffix. Kept explicit so an unknown hash is
// easy to spot.
const ROUTES = new Set([
    'merge',
    'split',
    'compress',
    'pdf-to-jpg',
    'jpg-to-pdf',
    'organize',
    'about'
]);

function routeFromHash() {
    const raw = (window.location.hash || '').replace(/^#\/?/, '').trim();
    return ROUTES.has(raw) ? raw : '';
}

// Panel management
function openPanel(feature) {
    // Hide all panels first
    document.querySelectorAll('.tool-panel').forEach(p => p.style.display = 'none');

    // Hide features grid
    const features = document.querySelector('.features');
    const hero = document.querySelector('.hero');
    if (features) features.style.display = 'none';
    if (hero) hero.style.display = 'none';

    // Show selected panel
    const panel = document.getElementById(`${feature}-panel`);
    if (panel) {
        panel.style.display = 'block';
        state.currentPanel = feature;

        // Scroll to top of viewport with sticky header offset
        window.scrollTo({ top: 0, behavior: 'smooth' });
    }
}

function closePanel() {
    document.querySelectorAll('.tool-panel').forEach(p => p.style.display = 'none');
    document.querySelector('.features').style.display = 'block';
    document.querySelector('.hero').style.display = 'block';

    // Reset state
    resetPanelState();
    state.currentPanel = null;

    // Scroll to top
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

// goHome / showAbout stay as thin aliases so any inline handler and the hash
// router agree on one implementation.
function goHome() {
    navigateTo('');
}

function showAbout() {
    navigateTo('about');
}

/**
 * Move to a route. Setting the hash pushes a history entry, so Back walks the
 * user home / to the previous tool instead of leaving the app.
 * Prevents navigation if a processing job is in progress.
 */
function navigateTo(route) {
    if (state.isProcessing) {
        if (!confirm('Proses PDF sedang berjalan. Yakin ingin berpindah halaman?')) {
            return;
        }
    }
    const target = route && ROUTES.has(route) ? `#/${route}` : '#/';
    if (window.location.hash === target) {
        handleRoute();
        return;
    }
    window.location.hash = target;
}

/** Enter/Space on the home-page feature cards, which carry role="button". */
function handleCardKeydown(event, feature) {
    if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') {
        event.preventDefault();
        navigateTo(feature);
    }
}

function handleRoute() {
    const route = routeFromHash();

    // Close mobile menu on any route change
    closeMobileMenu();

    // Mark the active nav link for assistive tech and visual orientation.
    document.querySelectorAll('.nav-link').forEach(link => {
        const isActive = link.getAttribute('href') === `#/${route}` ||
            (route === '' && link.getAttribute('href') === '#/');
        link.classList.toggle('active', isActive);
        if (isActive) {
            link.setAttribute('aria-current', 'page');
        } else {
            link.removeAttribute('aria-current');
        }
    });

    if (route) {
        openPanel(route);
        restoreSessionFiles();
    } else {
        closePanel();
    }

    // Keep the document title in step with the route.
    const titles = {
        merge: 'Gabungkan PDF',
        split: 'Pisahkan PDF',
        compress: 'Kompres PDF',
        'pdf-to-jpg': 'PDF ke Gambar',
        'jpg-to-pdf': 'Gambar ke PDF',
        organize: 'Atur Halaman',
        about: 'Tentang Aplikasi'
    };
    document.title = route
        ? `${titles[route]} — Secure PDF Utility Suite`
        : 'Secure PDF Utility Suite — Pemrosesan PDF Aman & Privat';
}

function scrollToFeatures() {
    const features = document.getElementById('features');
    if (!features) return;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    features.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
}

function toggleMobileMenu() {
    const menu = document.getElementById('mobile-menu');
    const btn = document.getElementById('mobile-menu-btn');
    if (!menu) return;

    const willOpen = !menu.classList.contains('active');
    menu.classList.toggle('active');
    if (btn) {
        btn.setAttribute('aria-expanded', String(willOpen));
    }
}

// Close mobile menu when clicking outside
document.addEventListener('click', (e) => {
    const menu = document.getElementById('mobile-menu');
    const btn = document.querySelector('.nav-menu-btn');
    if (menu && !menu.contains(e.target) && !btn.contains(e.target)) {
        menu.classList.remove('active');
        if (btn) btn.setAttribute('aria-expanded', 'false');
    }
});

function resetPanelState() {
    // Detach any touch listeners registered for the outgoing panel.
    runTouchDragCleanups();

    // PDF.js documents hold canvas references and web workers; destroy them
    // explicitly so they don't leak memory across panel switches.
    const destroyDoc = (doc) => {
        if (doc && typeof doc.destroy === 'function') {
            try { doc.destroy(); } catch { /* ignore */ }
        }
    };
    for (const doc of state.mergePdfDocs.values()) destroyDoc(doc);
    destroyDoc(state.splitPdfDoc);
    destroyDoc(state.pdfToJpgDoc);
    destroyDoc(state.organizePdfDoc);

    // Stop lingering expiry timers.
    for (const timer of state.expiryTimers.values()) clearInterval(timer);
    state.expiryTimers.clear();

    state.mergeFiles = [];
    state.mergePages = [];
    state.mergePdfDocs.clear();
    state.mergePreviewVisible = false;
    state.splitFile = null;
    state.splitSelectedPages = new Set();
    state.splitPdfDoc = null;
    state.compressFile = null;
    state.pdfToJpgFile = null;
    state.pdfToJpgDoc = null;
    state.jpgToPdfFiles = [];
    state.organizeFile = null;
    state.organizePages = [];
    state.organizePdfDoc = null;
    state.insertedPdfs = [];
    
    // Clear file lists
    document.querySelectorAll('.file-list').forEach(el => el.innerHTML = '');
    document.querySelectorAll('.result-section').forEach(el => {
        el.style.display = 'none';
        el.innerHTML = '';
    });
    document.querySelectorAll('.action-bar').forEach(el => el.style.display = 'none');
    
    // Reset upload zones
    document.querySelectorAll('.upload-zone').forEach(el => el.style.display = 'block');
    
    // Reset options
    document.getElementById('split-options').style.display = 'none';
    document.getElementById('compress-options').style.display = 'none';
    document.getElementById('jpg-options').style.display = 'none';
    document.getElementById('jpg-to-pdf-options').style.display = 'none';
    document.getElementById('organize-workspace').style.display = 'none';
    document.getElementById('merge-preview-section').style.display = 'none';
    
    // Clear preview grids
    const splitPreview = document.getElementById('split-page-preview');
    if (splitPreview) splitPreview.innerHTML = '';
    const pageGrid = document.getElementById('page-grid');
    if (pageGrid) pageGrid.innerHTML = '';
    const mergePageGrid = document.getElementById('merge-page-grid');
    if (mergePageGrid) mergePageGrid.innerHTML = '';
}

// ---------------------------------------------------------------------------
// Keyboard page reordering
//
// Drag-and-drop is unusable without a mouse, so each thumbnail also carries
// explicit move buttons. Reordering happens on the array the drag handler
// already mutates, so both paths stay consistent.
// ---------------------------------------------------------------------------

/**
 * Move an item in a page array and re-render.
 * @param {Array}  pages   state array holding the page objects
 * @param {number} from    index of the page to move
 * @param {number} to      destination index
 * @param {Function} render re-render callback for the affected grid
 */
function movePageInList(pages, from, to, render) {
    if (from < 0 || from >= pages.length) return;
    const target = Math.max(0, Math.min(pages.length - 1, to));
    if (target === from) return;
    const [moved] = pages.splice(from, 1);
    pages.splice(target, 0, moved);
    render();
}

function moveMergePage(index, direction) {
    movePageInList(state.mergePages, index, index + direction, renderMergePageGrid);
}

function moveOrganizePage(index, direction) {
    movePageInList(state.organizePages, index, index + direction, renderPageGrid);
}

// Render PDF page to canvas
async function renderPageToCanvas(pdfDoc, pageNum, canvas, maxWidth = 200) {
    try {
        const page = await pdfDoc.getPage(pageNum);
        const viewport = page.getViewport({ scale: 1 });
        const scale = maxWidth / viewport.width;
        const scaledViewport = page.getViewport({ scale });
        
        canvas.width = scaledViewport.width;
        canvas.height = scaledViewport.height;
        
        const ctx = canvas.getContext('2d');
        await page.render({
            canvasContext: ctx,
            viewport: scaledViewport
        }).promise;
    } catch (error) {
        console.error('Error rendering page:', error);
    }
}

// Feature cards route themselves via inline onclick/onkeydown, which call
// navigateTo() — no extra listener here, so a click never fires twice.

// File upload handling
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024; // must match the server's limit
const MAX_UPLOAD_FILES = 50;
const ALLOWED_UPLOAD_TYPES = ['application/pdf', 'image/jpeg', 'image/jpg', 'image/png'];

/**
 * Validate files before sending them, so obvious problems are reported
 * immediately instead of after a full upload round-trip.
 */
function validateFiles(files) {
    const list = Array.from(files || []);
    if (list.length === 0) {
        return { ok: false, message: 'Tidak ada file yang dipilih.' };
    }
    if (list.length > MAX_UPLOAD_FILES) {
        return { ok: false, message: `Maksimal ${MAX_UPLOAD_FILES} file sekaligus.` };
    }

    for (const file of list) {
        if (!ALLOWED_UPLOAD_TYPES.includes(file.type)) {
            return { ok: false, message: `"${file.name}" bukan PDF atau gambar JPG/PNG.` };
        }
        if (file.size > MAX_UPLOAD_BYTES) {
            return {
                ok: false,
                message: `"${file.name}" terlalu besar (${formatFileSize(file.size)}). Maksimal ${formatFileSize(MAX_UPLOAD_BYTES)}.`,
            };
        }
    }
    return { ok: true };
}

async function uploadFiles(files, type) {
    // Validate before sending anything to the server.
    const validation = validateFiles(files);
    if (!validation.ok) {
        showToast(validation.message, 'error');
        throw new Error(validation.message);
    }

    const formData = new FormData();

    for (const file of files) {
        formData.append('files', file);
    }
    if (type) {
        formData.append('tool', type);
    }

    try {
        showLoading('Mengunggah file...');
        // XMLHttpRequest gives us upload progress, which fetch cannot report.
        const data = await new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            xhr.open('POST', '/api/upload');

            xhr.upload.addEventListener('progress', (e) => {
                if (e.lengthComputable) {
                    const percent = Math.round((e.loaded / e.total) * 100);
                    showLoading(`Mengunggah... ${percent}%`);
                }
            });

            xhr.addEventListener('load', () => {
                let parsed = {};
                try {
                    parsed = JSON.parse(xhr.responseText);
                } catch {
                    parsed = {};
                }
                if (xhr.status >= 200 && xhr.status < 300) {
                    resolve(parsed);
                } else {
                    reject(new Error(parsed.error || `Upload gagal (HTTP ${xhr.status}).`));
                }
            });

            xhr.addEventListener('error', () => reject(new Error('Koneksi ke server gagal.')));
            xhr.addEventListener('abort', () => reject(new Error('Upload dibatalkan.')));

            xhr.send(formData);
        });

        hideLoading();

        // Surface per-file rejections reported by the server's content check.
        if (Array.isArray(data.rejected) && data.rejected.length > 0) {
            showToast(`${data.rejected.length} file ditolak: ${data.rejected[0].reason}`, 'error');
        }

        return data;
    } catch (error) {
        hideLoading();
        showToast(error.message, 'error');
        throw error;
    }
}

// Drag and drop for upload zones
function setupUploadZone(zoneId, inputId, handler) {
    const zone = document.getElementById(zoneId);
    const input = document.getElementById(inputId);
    
    if (!zone || !input) return;
    
    zone.addEventListener('dragover', (e) => {
        e.preventDefault();
        zone.classList.add('dragover');
    });
    
    zone.addEventListener('dragleave', () => {
        zone.classList.remove('dragover');
    });
    
    zone.addEventListener('drop', (e) => {
        e.preventDefault();
        // Stop here: the document-level handler would otherwise process the
        // same files a second time.
        e.stopPropagation();
        zone.classList.remove('dragover');
        const files = Array.from(e.dataTransfer.files);
        handler(files);
    });
    
    input.addEventListener('change', (e) => {
        const files = Array.from(e.target.files);
        handler(files);
        input.value = '';
    });

    // The zone is tabindex="0" role="button"; Enter/Space must open the picker.
    zone.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
            e.preventDefault();
            input.click();
        }
    });
}

// Merge PDF handlers
setupUploadZone('merge-upload-zone', 'merge-file-input', handleMergeUpload);

async function handleMergeUpload(files) {
    const pdfFiles = files.filter(f => f.type === 'application/pdf');
    if (pdfFiles.length === 0) {
        showToast('Pilih file PDF yang valid', 'error');
        return;
    }
    
    try {
        const data = await uploadFiles(pdfFiles, 'merge');
        
        data.files.forEach(file => {
            state.mergeFiles.push({
                id: file.id,
                name: file.originalName,
                size: file.size,
                expiry: file.expiry
            });
            rememberSessionFile({ id: file.id, name: file.originalName, size: file.size, expiry: file.expiry }, 'merge');
            startExpiryTimer(file.id, file.expiry);
        });

        renderMergeFileList();

        if (state.mergeFiles.length >= 2) {
            document.getElementById('merge-action-bar').style.display = 'flex';
        }

        showToast(`${pdfFiles.length} file berhasil diunggah`);
    } catch (error) {
        console.error('Upload error:', error);
    }
}

function renderMergeFileList() {
    const list = document.getElementById('merge-file-list');
    list.innerHTML = '';

    if (state.mergeFiles.length === 0) {
        renderEmptyState(list, 'Belum ada file digabung', 'Unggah atau tarik minimal 2 berkas PDF ke area di atas untuk mulai menyatukan dokumen.');
        // Touch listeners are only meaningful for a non-empty list.
        runTouchDragCleanups();
        return;
    }

    state.mergeFiles.forEach((file, index) => {
        const item = document.createElement('div');
        item.className = 'file-item';
        item.draggable = true;
        item.dataset.index = index;
        
        item.innerHTML = `
            <div class="drag-handle">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <line x1="8" y1="6" x2="16" y2="6"></line>
                    <line x1="8" y1="12" x2="16" y2="12"></line>
                    <line x1="8" y1="18" x2="16" y2="18"></line>
                </svg>
            </div>
            <div class="file-icon">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
                    <polyline points="14 2 14 8 20 8"></polyline>
                </svg>
            </div>
            <div class="file-info">
                <div class="file-name">${escapeHtml(file.name)}</div>
                <div class="file-size">${formatFileSize(file.size)}</div>
            </div>
            <div class="file-actions">
                <button class="file-action-btn" onclick="removeMergeFile(${index})" title="Hapus" aria-label="Hapus file">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <polyline points="3 6 5 6 21 6"></polyline>
                        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                    </svg>
                </button>
            </div>
        `;
        
        // Drag events for reordering
        item.addEventListener('dragstart', (e) => {
            item.classList.add('dragging');
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', index);
        });
        
        item.addEventListener('dragend', () => {
            item.classList.remove('dragging');
            document.querySelectorAll('.file-item').forEach(i => i.classList.remove('drag-over'));
        });
        
        item.addEventListener('dragover', (e) => {
            e.preventDefault();
            const dragging = document.querySelector('.file-item.dragging');
            if (dragging !== item) {
                item.classList.add('drag-over');
            }
        });
        
        item.addEventListener('dragleave', () => {
            item.classList.remove('drag-over');
        });
        
        item.addEventListener('drop', (e) => {
            e.preventDefault();
            item.classList.remove('drag-over');
            const fromIndex = parseInt(e.dataTransfer.getData('text/plain'));
            const toIndex = index;
            
            if (fromIndex !== toIndex) {
                const [moved] = state.mergeFiles.splice(fromIndex, 1);
                state.mergeFiles.splice(toIndex, 0, moved);
                renderMergeFileList();
            }
        });
        
        list.appendChild(item);
    });
    
    // Initialize touch drag for mobile
    initTouchDrag(list, list, (fromIndex, toIndex) => {
        const [moved] = state.mergeFiles.splice(fromIndex, 1);
        state.mergeFiles.splice(toIndex, 0, moved);
        renderMergeFileList();
        rebuildMergePages();
    });
}

async function removeMergeFile(index) {
    const file = state.mergeFiles[index];
    if (!file) return;

    try {
        const response = await fetch(`/api/delete/${file.id}`, { method: 'DELETE' });
        if (!response.ok) {
            console.warn('Failed to delete file on server:', file.id);
        }
    } catch (err) {
        console.error('Delete request error:', err);
    }

    forgetSessionFile(file.id);
    state.mergePdfDocs.delete(file.id);

    state.mergeFiles.splice(index, 1);
    renderMergeFileList();

    // Rebuild merge pages
    rebuildMergePages();

    if (state.mergeFiles.length < 2) {
        document.getElementById('merge-action-bar').style.display = 'none';
        document.getElementById('merge-preview-section').style.display = 'none';
        state.mergePreviewVisible = false;
    }
}

async function toggleMergePreview() {
    if (state.mergePreviewVisible) {
        document.getElementById('merge-preview-section').style.display = 'none';
        document.getElementById('merge-preview-btn-text').textContent = 'Lihat Preview';
        state.mergePreviewVisible = false;
    } else {
        await loadMergePreview();
        document.getElementById('merge-preview-section').style.display = 'block';
        document.getElementById('merge-preview-btn-text').textContent = 'Sembunyikan Preview';
        state.mergePreviewVisible = true;
    }
}

async function loadMergePreview() {
    showLoading('Memuat preview...');
    
    // Load PDF docs for each file
    for (const file of state.mergeFiles) {
        if (!state.mergePdfDocs.has(file.id)) {
            try {
                const pdfUrl = `/api/pdf-file/${file.id}`;
                const pdfDoc = await pdfjsLib.getDocument(pdfUrl).promise;
                state.mergePdfDocs.set(file.id, pdfDoc);
            } catch (error) {
                console.error(`Error loading PDF ${file.id}:`, error);
            }
        }
    }
    
    // Build pages array
    rebuildMergePages();
    
    hideLoading();
    await renderMergePageGrid();
}

function rebuildMergePages() {
    state.mergePages = [];
    
    for (const file of state.mergeFiles) {
        const pdfDoc = state.mergePdfDocs.get(file.id);
        if (pdfDoc) {
            for (let i = 0; i < pdfDoc.numPages; i++) {
                state.mergePages.push({
                    fileId: file.id,
                    fileName: file.name,
                    pageIndex: i,
                    pdfDoc: pdfDoc
                });
            }
        }
    }
}

async function renderMergePageGrid() {
    const grid = document.getElementById('merge-page-grid');
    grid.innerHTML = '';
    
    for (let index = 0; index < state.mergePages.length; index++) {
        const page = state.mergePages[index];
        const item = document.createElement('div');
        item.className = 'merge-page-item';
        item.draggable = true;
        item.dataset.index = index;
        
        item.innerHTML = `
            <canvas></canvas>
            <div class="page-reorder-controls">
                <button type="button" class="page-move-btn" onclick="moveMergePage(${index}, -1)" ${index === 0 ? 'disabled' : ''} aria-label="Pindahkan halaman ${index + 1} ke urutan sebelumnya" title="Geser ke kiri">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><polyline points="15 18 9 12 15 6"></polyline></svg>
                </button>
                <button type="button" class="page-move-btn" onclick="moveMergePage(${index}, 1)" ${index === state.mergePages.length - 1 ? 'disabled' : ''} aria-label="Pindahkan halaman ${index + 1} ke urutan sesudahnya" title="Geser ke kanan">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><polyline points="9 18 15 12 9 6"></polyline></svg>
                </button>
            </div>
            <div class="merge-page-item-overlay">
                <div class="merge-page-item-number">Hal ${page.pageIndex + 1}</div>
                <div class="merge-page-item-source">${escapeHtml(page.fileName)}</div>
            </div>
        `;
        
        grid.appendChild(item);
        
        // Render page preview
        const canvas = item.querySelector('canvas');
        await renderPageToCanvas(page.pdfDoc, page.pageIndex + 1, canvas, 120);
        
        // Drag events
        item.addEventListener('dragstart', (e) => {
            item.classList.add('dragging');
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', index);
        });
        
        item.addEventListener('dragend', () => {
            item.classList.remove('dragging');
            document.querySelectorAll('.merge-page-item').forEach(i => i.classList.remove('drag-over'));
        });
        
        item.addEventListener('dragover', (e) => {
            e.preventDefault();
            const dragging = document.querySelector('.merge-page-item.dragging');
            if (dragging !== item) {
                item.classList.add('drag-over');
            }
        });
        
        item.addEventListener('dragleave', () => {
            item.classList.remove('drag-over');
        });
        
        item.addEventListener('drop', (e) => {
            e.preventDefault();
            item.classList.remove('drag-over');
            const fromIndex = parseInt(e.dataTransfer.getData('text/plain'));
            const toIndex = index;
            
            if (fromIndex !== toIndex) {
                const [moved] = state.mergePages.splice(fromIndex, 1);
                state.mergePages.splice(toIndex, 0, moved);
                renderMergePageGrid();
            }
        });
    }
    
    // Initialize touch drag for mobile
    initTouchDrag(grid, grid, (fromIndex, toIndex) => {
        const [moved] = state.mergePages.splice(fromIndex, 1);
        state.mergePages.splice(toIndex, 0, moved);
        renderMergePageGrid();
    });
}

async function processMerge() {
    if (state.mergeFiles.length < 2) {
        showToast('Minimal 2 file diperlukan untuk merge', 'error');
        return;
    }

    state.isProcessing = true;
    try {
        showLoading('Menggabungkan PDF...');
        
        // If preview was used, send page-level order
        let requestBody;
        if (state.mergePages.length > 0) {
            requestBody = {
                fileIds: state.mergeFiles.map(f => f.id),
                pages: state.mergePages.map(p => ({
                    fileId: p.fileId,
                    pageIndex: p.pageIndex
                }))
            };
        } else {
            requestBody = {
                fileIds: state.mergeFiles.map(f => f.id),
                order: state.mergeFiles.map(f => f.id)
            };
        }
        
        const response = await fetch('/api/merge', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(requestBody)
        });
        
        const data = await response.json();
        hideLoading();
        
        if (!response.ok) {
            throw new Error(data.error || 'Merge failed');
        }
        
        showResult('merge', [{
            id: data.fileId,
            name: data.filename,
            size: data.size,
            expiry: data.expiry
        }]);
        
        showToast('PDF berhasil digabungkan!');
    } catch (error) {
        hideLoading();
        showToast(error.message, 'error');
    }
}

// Split PDF handlers
setupUploadZone('split-upload-zone', 'split-file-input', handleSplitUpload);

async function handleSplitUpload(files) {
    const pdfFile = files.find(f => f.type === 'application/pdf');
    if (!pdfFile) {
        showToast('Pilih file PDF yang valid', 'error');
        return;
    }
    
    try {
        const data = await uploadFiles([pdfFile], 'split');
        state.splitFile = data.files[0];
        state.splitFile.name = data.files[0].originalName;
        rememberSessionFile(state.splitFile, 'split');
        
        // Get PDF info
        const infoResponse = await fetch(`/api/pdf-info/${state.splitFile.id}`);
        const infoData = await infoResponse.json();
        
        document.getElementById('split-upload-zone').style.display = 'none';
        document.getElementById('split-options').style.display = 'block';
        document.getElementById('split-action-bar').style.display = 'flex';
        
        document.getElementById('split-pdf-info').innerHTML = `
            <div class="pdf-info-icon">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
                    <polyline points="14 2 14 8 20 8"></polyline>
                </svg>
            </div>
            <div class="pdf-info-details">
                <h4>${escapeHtml(state.splitFile.originalName)}</h4>
                <p>${infoData.pageCount} halaman • ${formatFileSize(state.splitFile.size)}</p>
            </div>
        `;
        
        state.splitFile.pageCount = infoData.pageCount;
        
        // Load PDF for preview
        showLoading('Memuat preview halaman...');
        const pdfUrl = `/api/pdf-file/${state.splitFile.id}`;
        state.splitPdfDoc = await pdfjsLib.getDocument(pdfUrl).promise;
        hideLoading();
        
        // Render page previews
        await renderSplitPagePreviews();
        
        showToast('File berhasil diunggah');
    } catch (error) {
        hideLoading();
        console.error('Upload error:', error);
    }
}

async function renderSplitPagePreviews() {
    const container = document.getElementById('split-page-preview');
    container.innerHTML = '';
    
    const pageCount = state.splitPdfDoc.numPages;
    
    for (let i = 1; i <= pageCount; i++) {
        const item = document.createElement('div');
        item.className = 'page-preview-item';
        item.dataset.page = i;
        
        if (state.splitSelectedPages.has(i)) {
            item.classList.add('selected');
        }
        
        item.innerHTML = `
            <canvas></canvas>
            <div class="page-preview-number">Halaman ${i}</div>
            <div class="page-preview-check">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3">
                    <polyline points="20 6 9 17 4 12"></polyline>
                </svg>
            </div>
        `;
        
        item.addEventListener('click', () => toggleSplitPageSelection(i, item));
        container.appendChild(item);
        
        // Render page preview
        const canvas = item.querySelector('canvas');
        await renderPageToCanvas(state.splitPdfDoc, i, canvas, 150);
    }
}

function toggleSplitPageSelection(pageNum, element) {
    if (state.splitSelectedPages.has(pageNum)) {
        state.splitSelectedPages.delete(pageNum);
        element.classList.remove('selected');
    } else {
        state.splitSelectedPages.add(pageNum);
        element.classList.add('selected');
    }
    
    updateSelectedPagesInfo();
}

function updateSelectedPagesInfo() {
    const count = state.splitSelectedPages.size;
    const infoEl = document.getElementById('selected-pages-info');
    const countEl = document.getElementById('selected-count');

    if (count > 0) {
        infoEl.style.display = 'block';
        countEl.textContent = count;
    } else {
        infoEl.style.display = 'none';
    }
}

/** Select every page in the current split preview. */
function selectAllSplitPages() {
    if (!state.splitPdfDoc) return;
    const pageCount = state.splitPdfDoc.numPages;
    for (let i = 1; i <= pageCount; i++) {
        state.splitSelectedPages.add(i);
    }
    document.querySelectorAll('#split-page-preview .page-preview-item').forEach(el => el.classList.add('selected'));
    updateSelectedPagesInfo();
}

/** Clear the page selection in the split preview. */
function deselectAllSplitPages() {
    state.splitSelectedPages.clear();
    document.querySelectorAll('#split-page-preview .page-preview-item').forEach(el => el.classList.remove('selected'));
    updateSelectedPagesInfo();
}

// Split mode toggle
document.querySelectorAll('input[name="split-mode"]').forEach(radio => {
    radio.addEventListener('change', (e) => {
        const rangeInput = document.getElementById('range-input');
        const selectedInfo = document.getElementById('selected-pages-info');
        
        rangeInput.style.display = e.target.value === 'range' ? 'block' : 'none';
        
        if (e.target.value === 'selected') {
            updateSelectedPagesInfo();
        } else {
            selectedInfo.style.display = 'none';
        }
    });
});

async function processSplit() {
    if (!state.splitFile) {
        showToast('Upload file PDF terlebih dahulu', 'error');
        return;
    }

    const mode = document.querySelector('input[name="split-mode"]:checked').value;

    // Handle selected pages mode
    if (mode === 'selected') {
        if (state.splitSelectedPages.size === 0) {
            showToast('Pilih halaman yang ingin diekstrak', 'error');
            return;
        }
    }

    state.isProcessing = true;
    try {
        showLoading('Memisahkan PDF...');
        
        let body = { fileId: state.splitFile.id };
        
        if (mode === 'all') {
            body.extractAll = true;
        } else if (mode === 'selected') {
            // Convert selected pages to ranges
            const selectedArray = Array.from(state.splitSelectedPages).sort((a, b) => a - b);
            body.ranges = selectedArray.map(p => ({ start: p, end: p }));
        } else {
            const rangeText = document.getElementById('page-ranges').value;
            if (!rangeText.trim()) {
                hideLoading();
                showToast('Masukkan rentang halaman', 'error');
                return;
            }
            
            // Parse ranges
            const ranges = [];
            const parts = rangeText.split(',').map(p => p.trim());
            
            for (const part of parts) {
                if (part.includes('-')) {
                    const [start, end] = part.split('-').map(n => parseInt(n.trim()));
                    ranges.push({ start, end: end || start });
                } else {
                    const page = parseInt(part);
                    ranges.push({ start: page, end: page });
                }
            }
            
            body.ranges = ranges;
        }
        
        const response = await fetch('/api/split', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        
        const data = await response.json();
        hideLoading();
        
        if (!response.ok) {
            throw new Error(data.error || 'Split failed');
        }
        
        const files = data.files.map(f => ({
            id: f.fileId,
            name: f.filename,
            size: f.size,
            expiry: f.expiry
        }));
        
        showResult('split', files);
        showToast(`PDF berhasil dipisahkan menjadi ${files.length} file!`);
    } catch (error) {
        hideLoading();
        showToast(error.message, 'error');
    }
}

// Compress PDF handlers
setupUploadZone('compress-upload-zone', 'compress-file-input', handleCompressUpload);

async function handleCompressUpload(files) {
    const pdfFile = files.find(f => f.type === 'application/pdf');
    if (!pdfFile) {
        showToast('Pilih file PDF yang valid', 'error');
        return;
    }
    
    try {
        const data = await uploadFiles([pdfFile], 'compress');
        state.compressFile = data.files[0];
        state.compressFile.name = data.files[0].originalName;
        rememberSessionFile(state.compressFile, 'compress');
        
        document.getElementById('compress-upload-zone').style.display = 'none';
        document.getElementById('compress-options').style.display = 'block';
        document.getElementById('compress-action-bar').style.display = 'flex';
        
        document.getElementById('compress-pdf-info').innerHTML = `
            <div class="pdf-info-icon">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
                    <polyline points="14 2 14 8 20 8"></polyline>
                </svg>
            </div>
            <div class="pdf-info-details">
                <h4>${escapeHtml(state.compressFile.originalName)}</h4>
                <p>Ukuran asli: ${formatFileSize(state.compressFile.size)}</p>
            </div>
        `;
        
        // Update original size display for target mode
        document.getElementById('original-size-display').textContent = formatFileSize(state.compressFile.size);
        
        // Set default target size (50% of original)
        const defaultTargetMB = (state.compressFile.size / (1024 * 1024) * 0.5).toFixed(1);
        document.getElementById('target-size-value').value = defaultTargetMB;
        
        showToast('File berhasil diunggah');
    } catch (error) {
        console.error('Upload error:', error);
    }
}

// Compression level selection
document.querySelectorAll('input[name="compress-level"]').forEach(radio => {
    radio.addEventListener('change', () => {
        document.querySelectorAll('.level-card').forEach(card => card.classList.remove('selected'));
        radio.nextElementSibling.classList.add('selected');
    });
});

// Toggle compress mode (level vs target)
function toggleCompressMode() {
    const mode = document.querySelector('input[name="compress-mode"]:checked').value;
    document.getElementById('compress-level-section').style.display = mode === 'level' ? 'block' : 'none';
    document.getElementById('compress-target-section').style.display = mode === 'target' ? 'block' : 'none';
}

/**
 * Show or hide the target-size warning depending on how aggressive the request
 * is. Runs on every input so the message never lags behind the field.
 */
function updateTargetSizeWarning() {
    if (!state.compressFile) return;
    const targetBytes = getTargetSizeBytes();
    const warning = document.getElementById('target-size-warning');
    if (!warning) return;

    // Warn when the target is 25% or less of the original: below that point,
    // fine text in scanned images starts to lose legibility.
    if (targetBytes !== null && targetBytes <= state.compressFile.size * 0.25) {
        warning.style.display = 'block';
    } else {
        warning.style.display = 'none';
    }
}

// Live validation on the target size fields.
['target-size-value', 'target-size-unit'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('input', updateTargetSizeWarning);
    el.addEventListener('change', updateTargetSizeWarning);
});

// Calculate target size in bytes
function getTargetSizeBytes() {
    const value = parseFloat(document.getElementById('target-size-value').value);
    const unit = document.getElementById('target-size-unit').value;
    
    if (isNaN(value) || value <= 0) return null;
    
    if (unit === 'mb') {
        return value * 1024 * 1024;
    } else if (unit === 'kb') {
        return value * 1024;
    } else if (unit === 'percent') {
        return (state.compressFile.size * value) / 100;
    }
    return null;
}

// Calculate compression settings based on target size
function calculateCompressionSettings(targetBytes, originalBytes) {
    const ratio = targetBytes / originalBytes;
    
    // Map ratio to quality and DPI
    // Lower ratio = more aggressive compression
    let quality, dpi;
    
    if (ratio >= 0.7) {
        quality = 85;
        dpi = 150;
    } else if (ratio >= 0.5) {
        quality = 70;
        dpi = 120;
    } else if (ratio >= 0.3) {
        quality = 55;
        dpi = 100;
    } else if (ratio >= 0.2) {
        quality = 45;
        dpi = 85;
    } else {
        quality = 35;
        dpi = 72;
    }
    
    return { quality, dpi };
}

async function processCompress() {
    if (!state.compressFile) {
        showToast('Upload file PDF terlebih dahulu', 'error');
        return;
    }
    
    const mode = document.querySelector('input[name="compress-mode"]:checked').value;
    let level, targetBytes = null;
    
    if (mode === 'target') {
        targetBytes = getTargetSizeBytes();
        if (!targetBytes) {
            showToast('Masukkan target ukuran yang valid', 'error');
            return;
        }
        if (targetBytes >= state.compressFile.size) {
            showToast('Target ukuran harus lebih kecil dari ukuran asli', 'error');
            return;
        }
        // Calculate level based on target
        level = 'custom';
    } else {
        level = document.querySelector('input[name="compress-level"]:checked').value;
    }

    state.isProcessing = true;
    try {
        showLoading('Menganalisis PDF...');
        
        // Get compression settings from server
        const response = await fetch('/api/compress', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                fileId: state.compressFile.id,
                level,
                targetBytes: targetBytes
            })
        });
        
        const data = await response.json();
        
        if (!response.ok) {
            hideLoading();
            throw new Error(data.error || 'Compression failed');
        }
        
        // Use client-side image-based compression
        if (data.useClientCompression) {
            // If target mode, calculate custom settings
            if (targetBytes) {
                const customSettings = calculateCompressionSettings(targetBytes, state.compressFile.size);
                data.quality = customSettings.quality;
                data.dpi = customSettings.dpi;
                data.targetBytes = targetBytes;
            }
            await performClientSideCompression(data);
        } else {
            hideLoading();
            showCompressResult(data);
            showToast('PDF berhasil dikompres!');
        }
    } catch (error) {
        hideLoading();
        showToast(error.message, 'error');
    }
}

async function performClientSideCompression(compressInfo) {
    try {
        showLoading(`Mengkompresi halaman (0/${compressInfo.pageCount})...`);
        
        // Load PDF
        const pdfUrl = `/api/pdf-file/${compressInfo.fileId}`;
        const pdfDoc = await pdfjsLib.getDocument(pdfUrl).promise;
        
        const images = [];
        const quality = compressInfo.quality / 100;
        const scale = compressInfo.dpi / 72; // PDF default is 72 DPI
        
        for (let i = 1; i <= pdfDoc.numPages; i++) {
            showLoading(`Mengkompresi halaman (${i}/${compressInfo.pageCount})...`);
            
            const page = await pdfDoc.getPage(i);
            const viewport = page.getViewport({ scale });
            
            const canvas = document.createElement('canvas');
            canvas.width = viewport.width;
            canvas.height = viewport.height;
            
            const ctx = canvas.getContext('2d');
            await page.render({
                canvasContext: ctx,
                viewport: viewport
            }).promise;
            
            // Convert to compressed JPEG
            const jpegData = canvas.toDataURL('image/jpeg', quality);
            images.push(jpegData);
        }
        
        showLoading('Menyimpan PDF terkompresi...');
        
        // Send compressed images to server to create PDF
        const saveResponse = await fetch('/api/compress-save', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                images,
                baseName: compressInfo.baseName,
                originalSize: compressInfo.originalSize
            })
        });
        
        const saveData = await saveResponse.json();
        hideLoading();
        
        if (!saveResponse.ok) {
            throw new Error(saveData.error || 'Failed to save compressed PDF');
        }
        
        showCompressResult(saveData);
        showToast('PDF berhasil dikompres!');
    } catch (error) {
        hideLoading();
        throw error;
    }
}

function showCompressResult(data) {
    const resultSection = document.getElementById('compress-result');
    resultSection.style.display = 'block';
    
    resultSection.innerHTML = `
        <div class="result-header">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path>
                <polyline points="22 4 12 14.01 9 11.01"></polyline>
            </svg>
            <h3>Kompresi Berhasil!</h3>
        </div>
        
        <div class="compression-stats">
            <div class="stat-item">
                <div class="stat-value">${formatFileSize(data.originalSize)}</div>
                <div class="stat-label">Ukuran Asli</div>
            </div>
            <div class="stat-item highlight">
                <div class="stat-value">${formatFileSize(data.compressedSize)}</div>
                <div class="stat-label">Ukuran Baru</div>
            </div>
            <div class="stat-item highlight">
                <div class="stat-value">${data.reduction}%</div>
                <div class="stat-label">Pengurangan</div>
            </div>
        </div>
        
        <div class="result-files">
            <div class="result-file">
                <div class="result-file-info">
                    <div class="file-icon">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
                            <polyline points="14 2 14 8 20 8"></polyline>
                        </svg>
                    </div>
                    <div class="result-file-details">
                        <h4>${escapeHtml(data.filename)}</h4>
                        <p>${formatFileSize(data.compressedSize)}</p>
                    </div>
                </div>
                <div class="result-actions">
                    <a href="/api/download/${data.fileId}?filename=${encodeURIComponent(data.filename)}" class="btn btn-primary" download>
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                            <polyline points="7 10 12 15 17 10"></polyline>
                            <line x1="12" y1="15" x2="12" y2="3"></line>
                        </svg>
                        Download
                    </a>
                    <button class="btn btn-danger btn-sm" onclick="deleteFile('${data.fileId}', 'compress')">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <polyline points="3 6 5 6 21 6"></polyline>
                            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                        </svg>
                        Hapus
                    </button>
                </div>
            </div>
        </div>
        
        <div class="expiry-timer" id="timer-${data.fileId}">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="12" cy="12" r="10"></circle>
                <polyline points="12 6 12 12 16 14"></polyline>
            </svg>
            <span>File akan dihapus permanen dalam <strong id="countdown-${data.fileId}">${formatTime(remainingSeconds(data.expiry))}</strong> menit</span>
        </div>
    `;
    
    startExpiryTimer(data.fileId, data.expiry);
}

// PDF to JPG handlers
setupUploadZone('pdf-to-jpg-upload-zone', 'pdf-to-jpg-file-input', handlePdfToJpgUpload);

async function handlePdfToJpgUpload(files) {
    const pdfFile = files.find(f => f.type === 'application/pdf');
    if (!pdfFile) {
        showToast('Pilih file PDF yang valid', 'error');
        return;
    }
    
    try {
        const data = await uploadFiles([pdfFile], 'pdf-to-jpg');
        state.pdfToJpgFile = data.files[0];
        state.pdfToJpgFile.name = data.files[0].originalName;
        rememberSessionFile(state.pdfToJpgFile, 'pdf-to-jpg');
        
        // Get PDF info
        const infoResponse = await fetch(`/api/pdf-info/${state.pdfToJpgFile.id}`);
        const infoData = await infoResponse.json();
        
        document.getElementById('pdf-to-jpg-upload-zone').style.display = 'none';
        document.getElementById('jpg-options').style.display = 'block';
        document.getElementById('pdf-to-jpg-action-bar').style.display = 'flex';
        
        document.getElementById('pdf-to-jpg-info').innerHTML = `
            <div class="pdf-info-icon">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
                    <polyline points="14 2 14 8 20 8"></polyline>
                </svg>
            </div>
            <div class="pdf-info-details">
                <h4>${escapeHtml(state.pdfToJpgFile.originalName)}</h4>
                <p>${infoData.pageCount} halaman • ${formatFileSize(state.pdfToJpgFile.size)}</p>
            </div>
        `;
        
        state.pdfToJpgFile.pageCount = infoData.pageCount;
        
        showToast('File berhasil diunggah');
    } catch (error) {
        console.error('Upload error:', error);
    }
}

async function processPdfToJpg() {
    if (!state.pdfToJpgFile) {
        showToast('Upload file PDF terlebih dahulu', 'error');
        return;
    }

    const quality = document.querySelector('input[name="jpg-quality"]:checked').value;
    const jpgQuality = quality === 'high' ? 0.95 : quality === 'medium' ? 0.80 : 0.60;

    state.isProcessing = true;
    try {
        showLoading('Mengkonversi ke JPG...');
        
        // Load PDF with PDF.js
        const pdfUrl = `/api/pdf-file/${state.pdfToJpgFile.id}`;
        state.pdfToJpgDoc = await pdfjsLib.getDocument(pdfUrl).promise;
        
        const pageCount = state.pdfToJpgDoc.numPages;
        const images = [];
        
        // Render each page to canvas and convert to JPG
        for (let i = 1; i <= pageCount; i++) {
            showLoading(`Mengkonversi halaman ${i}/${pageCount}...`);
            
            const page = await state.pdfToJpgDoc.getPage(i);
            const viewport = page.getViewport({ scale: 2 }); // Higher scale for better quality
            
            const canvas = document.createElement('canvas');
            canvas.width = viewport.width;
            canvas.height = viewport.height;
            
            const ctx = canvas.getContext('2d');
            await page.render({
                canvasContext: ctx,
                viewport: viewport
            }).promise;
            
            // Convert to JPG data URL
            const dataUrl = canvas.toDataURL('image/jpeg', jpgQuality);
            
            images.push({
                page: i,
                dataUrl: dataUrl,
                width: Math.round(viewport.width),
                height: Math.round(viewport.height)
            });
        }
        
        hideLoading();
        
        // Show results with download buttons
        const resultSection = document.getElementById('pdf-to-jpg-result');
        resultSection.style.display = 'block';
        resultSection.innerHTML = `
            <div class="result-header">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path>
                    <polyline points="22 4 12 14.01 9 11.01"></polyline>
                </svg>
                <h3>Konversi Berhasil!</h3>
            </div>
            <p style="color: var(--text-secondary); margin-bottom: 1rem;">
                ${pageCount} halaman berhasil dikonversi ke JPG dengan kualitas ${Math.round(jpgQuality * 100)}%
            </p>
            <div class="result-files" id="jpg-results">
                ${images.map(img => `
                    <div class="result-file">
                        <div class="result-file-info">
                            <div class="file-icon" style="background: linear-gradient(135deg, #10b981, #059669);">
                                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                    <rect x="3" y="3" width="18" height="18" rx="2"></rect>
                                    <circle cx="8.5" cy="8.5" r="1.5"></circle>
                                    <path d="M21 15l-5-5L5 21"></path>
                                </svg>
                            </div>
                            <div class="result-file-details">
                                <h4>page_${img.page}.jpg</h4>
                                <p>${img.width} x ${img.height} px</p>
                            </div>
                        </div>
                        <div class="result-actions">
                            <a href="${img.dataUrl}" download="page_${img.page}.jpg" class="btn btn-primary btn-sm">
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                                    <polyline points="7 10 12 15 17 10"></polyline>
                                    <line x1="12" y1="15" x2="12" y2="3"></line>
                                </svg>
                                Download
                            </a>
                        </div>
                    </div>
                `).join('')}
            </div>
            <div style="margin-top: 1rem;">
                <button class="btn btn-secondary" onclick="downloadAllJpg()">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                        <polyline points="7 10 12 15 17 10"></polyline>
                        <line x1="12" y1="15" x2="12" y2="3"></line>
                    </svg>
                    Download Semua
                </button>
            </div>
        `;
        
        // Store images for download all
        state.pdfToJpgImages = images;
        
        showToast(`${pageCount} halaman berhasil dikonversi ke JPG!`);
    } catch (error) {
        hideLoading();
        showToast(error.message, 'error');
    }
}

async function downloadAllJpg() {
    if (!state.pdfToJpgImages || state.pdfToJpgImages.length === 0) {
        showToast('Tidak ada gambar untuk didownload', 'error');
        return;
    }

    showToast('Mengunduh semua gambar...');

    for (const img of state.pdfToJpgImages) {
        let objectUrl = null;
        try {
            // Fetching the data URL gives us a Blob we can revoke, which keeps
            // large multi-page exports from ballooning memory in one go.
            const response = await fetch(img.dataUrl);
            const blob = await response.blob();
            objectUrl = URL.createObjectURL(blob);

            const link = document.createElement('a');
            link.href = objectUrl;
            link.download = `page_${img.page}.jpg`;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
        } catch {
            // Fall back to the raw data URL if the blob conversion fails.
            const link = document.createElement('a');
            link.href = img.dataUrl;
            link.download = `page_${img.page}.jpg`;
            link.click();
        } finally {
            if (objectUrl) {
                setTimeout(() => URL.revokeObjectURL(objectUrl), 2000);
            }
        }

        // Keep a small gap between saves so browsers do not treat the burst as
        // a blocked multi-download.
        await new Promise(resolve => setTimeout(resolve, 250));
    }
}

// JPG to PDF handlers
setupUploadZone('jpg-to-pdf-upload-zone', 'jpg-to-pdf-file-input', handleJpgToPdfUpload);

async function handleJpgToPdfUpload(files) {
    const imageFiles = files.filter(f => f.type.startsWith('image/'));
    if (imageFiles.length === 0) {
        showToast('Pilih file gambar yang valid (JPG/PNG)', 'error');
        return;
    }
    
    try {
        const data = await uploadFiles(imageFiles, 'jpg-to-pdf');
        
        data.files.forEach(file => {
            state.jpgToPdfFiles.push({
                id: file.id,
                name: file.originalName,
                size: file.size,
                expiry: file.expiry
            });
            rememberSessionFile({ id: file.id, name: file.originalName, size: file.size, expiry: file.expiry }, 'jpg-to-pdf');
            startExpiryTimer(file.id, file.expiry);
        });

        renderJpgToPdfFileList();
        document.getElementById('jpg-to-pdf-action-bar').style.display = 'flex';
        document.getElementById('jpg-to-pdf-options').style.display = 'block';

        showToast(`${imageFiles.length} gambar berhasil diunggah`);
    } catch (error) {
        console.error('Upload error:', error);
    }
}

function renderJpgToPdfFileList() {
    const list = document.getElementById('jpg-to-pdf-file-list');
    list.innerHTML = '';

    if (state.jpgToPdfFiles.length === 0) {
        renderEmptyState(list, 'Belum ada gambar', 'Unggah atau tarik beberapa berkas JPG/PNG untuk disatukan menjadi satu PDF.');
        runTouchDragCleanups();
        return;
    }

    state.jpgToPdfFiles.forEach((file, index) => {
        const item = document.createElement('div');
        item.className = 'file-item';
        item.draggable = true;
        item.dataset.index = index;
        
        item.innerHTML = `
            <div class="drag-handle">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <line x1="8" y1="6" x2="16" y2="6"></line>
                    <line x1="8" y1="12" x2="16" y2="12"></line>
                    <line x1="8" y1="18" x2="16" y2="18"></line>
                </svg>
            </div>
            <div class="file-icon" style="background: linear-gradient(135deg, #10b981, #059669);">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <rect x="3" y="3" width="18" height="18" rx="2"></rect>
                    <circle cx="8.5" cy="8.5" r="1.5"></circle>
                    <path d="M21 15l-5-5L5 21"></path>
                </svg>
            </div>
            <div class="file-info">
                <div class="file-name">${escapeHtml(file.name)}</div>
                <div class="file-size">${formatFileSize(file.size)}</div>
            </div>
            <div class="file-actions">
                <button class="file-action-btn" onclick="removeJpgToPdfFile(${index})" title="Hapus" aria-label="Hapus file">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <polyline points="3 6 5 6 21 6"></polyline>
                        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                    </svg>
                </button>
            </div>
        `;
        
        // Drag events
        item.addEventListener('dragstart', (e) => {
            item.classList.add('dragging');
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', index);
        });
        
        item.addEventListener('dragend', () => {
            item.classList.remove('dragging');
            document.querySelectorAll('.file-item').forEach(i => i.classList.remove('drag-over'));
        });
        
        item.addEventListener('dragover', (e) => {
            e.preventDefault();
            const dragging = document.querySelector('.file-item.dragging');
            if (dragging !== item) {
                item.classList.add('drag-over');
            }
        });
        
        item.addEventListener('dragleave', () => {
            item.classList.remove('drag-over');
        });
        
        item.addEventListener('drop', (e) => {
            e.preventDefault();
            item.classList.remove('drag-over');
            const fromIndex = parseInt(e.dataTransfer.getData('text/plain'));
            const toIndex = index;
            
            if (fromIndex !== toIndex) {
                const [moved] = state.jpgToPdfFiles.splice(fromIndex, 1);
                state.jpgToPdfFiles.splice(toIndex, 0, moved);
                renderJpgToPdfFileList();
            }
        });
        
        list.appendChild(item);
    });
    
    // Initialize touch drag for mobile
    initTouchDrag(list, list, (fromIndex, toIndex) => {
        const [moved] = state.jpgToPdfFiles.splice(fromIndex, 1);
        state.jpgToPdfFiles.splice(toIndex, 0, moved);
        renderJpgToPdfFileList();
    });
}

async function removeJpgToPdfFile(index) {
    const file = state.jpgToPdfFiles[index];
    if (!file) return;

    try {
        const response = await fetch(`/api/delete/${file.id}`, { method: 'DELETE' });
        if (!response.ok) {
            console.warn('Failed to delete image on server:', file.id);
        }
    } catch (err) {
        console.error('Delete request error:', err);
    }

    forgetSessionFile(file.id);
    state.jpgToPdfFiles.splice(index, 1);
    renderJpgToPdfFileList();

    if (state.jpgToPdfFiles.length === 0) {
        document.getElementById('jpg-to-pdf-action-bar').style.display = 'none';
        document.getElementById('jpg-to-pdf-options').style.display = 'none';
    }
}

async function processJpgToPdf() {
    if (state.jpgToPdfFiles.length === 0) {
        showToast('Upload gambar terlebih dahulu', 'error');
        return;
    }

    state.isProcessing = true;
    try {
        showLoading('Mengkonversi ke PDF...');
        
        const paperSize = document.querySelector('input[name="paper-size"]:checked')?.value || 'original';
        const orientation = document.querySelector('input[name="paper-orientation"]:checked')?.value || 'auto';
        
        const response = await fetch('/api/jpg-to-pdf', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                fileIds: state.jpgToPdfFiles.map(f => f.id),
                order: state.jpgToPdfFiles.map(f => f.id),
                paperSize,
                orientation
            })
        });
        
        const data = await response.json();
        hideLoading();
        
        if (!response.ok) {
            throw new Error(data.error || 'Conversion failed');
        }
        
        showResult('jpg-to-pdf', [{
            id: data.fileId,
            name: data.filename,
            size: data.size,
            expiry: data.expiry
        }]);
        
        showToast('Gambar berhasil dikonversi ke PDF!');
    } catch (error) {
        hideLoading();
        showToast(error.message, 'error');
    }
}

// Organize PDF handlers
setupUploadZone('organize-upload-zone', 'organize-file-input', handleOrganizeUpload);

// Setup insert PDF input
document.getElementById('organize-insert-input')?.addEventListener('change', handleInsertPdf);

// Setup drag-drop for PDF insert in organize workspace
function setupOrganizeDropzone() {
    const dropzone = document.getElementById('page-grid-dropzone');
    if (!dropzone) return;
    
    dropzone.addEventListener('dragover', (e) => {
        e.preventDefault();
        // Only show overlay for file drops, not page reordering
        if (e.dataTransfer.types.includes('Files')) {
            dropzone.classList.add('drag-over');
        }
    });
    
    dropzone.addEventListener('dragleave', (e) => {
        if (!dropzone.contains(e.relatedTarget)) {
            dropzone.classList.remove('drag-over');
        }
    });
    
    dropzone.addEventListener('drop', async (e) => {
        e.preventDefault();
        // Handled here as an "insert pages" drop — keep it away from the
        // document-level handler, which would treat it as a fresh upload.
        e.stopPropagation();
        dropzone.classList.remove('drag-over');

        const files = Array.from(e.dataTransfer.files);
        const pdfFile = files.find(f => f.type === 'application/pdf');

        if (pdfFile) {
            await handleInsertPdfFile(pdfFile);
        }
    });
}

async function handleInsertPdfFile(pdfFile) {
    try {
        const formData = new FormData();
        formData.append('files', pdfFile);
        
        showLoading('Mengunggah PDF...');
        const uploadResponse = await fetch('/api/upload', {
            method: 'POST',
            body: formData
        });
        
        const uploadData = await uploadResponse.json();
        if (!uploadResponse.ok || !uploadData.files?.length) {
            throw new Error('Upload failed');
        }
        
        const insertedFile = uploadData.files[0];
        
        // Get PDF info
        const infoResponse = await fetch(`/api/pdf-info/${insertedFile.id}`);
        const infoData = await infoResponse.json();
        
        // Load PDF for preview
        const pdfUrl = `/api/pdf-file/${insertedFile.id}`;
        const insertedPdfDoc = await pdfjsLib.getDocument(pdfUrl).promise;
        hideLoading();
        
        // Add pages to organize pages
        for (let i = 0; i < infoData.pageCount; i++) {
            state.organizePages.push({
                index: i,
                rotation: 0,
                deleted: false,
                sourceFile: insertedFile.id,
                sourceName: insertedFile.originalName,
                pdfDoc: insertedPdfDoc
            });
        }
        
        state.insertedPdfs.push({
            id: insertedFile.id,
            name: insertedFile.originalName,
            pdfDoc: insertedPdfDoc,
            pageCount: infoData.pageCount
        });
        
        await renderPageGrid();
        showToast(`${infoData.pageCount} halaman ditambahkan dari ${insertedFile.originalName}`);
    } catch (error) {
        hideLoading();
        console.error('Insert error:', error);
        showToast('Gagal menambahkan PDF', 'error');
    }
}

// Initialize dropzone when DOM is ready
document.addEventListener('DOMContentLoaded', setupOrganizeDropzone);

async function handleInsertPdf(e) {
    const files = Array.from(e.target.files);
    const pdfFile = files.find(f => f.type === 'application/pdf');
    if (!pdfFile) {
        showToast('Pilih file PDF yang valid', 'error');
        return;
    }
    
    try {
        const data = await uploadFiles([pdfFile], 'organize-insert');
        const insertedFile = data.files[0];
        
        // Get PDF info
        const infoResponse = await fetch(`/api/pdf-info/${insertedFile.id}`);
        const infoData = await infoResponse.json();
        
        // Load PDF for preview
        showLoading('Memuat halaman...');
        const pdfUrl = `/api/pdf-file/${insertedFile.id}`;
        const insertedPdfDoc = await pdfjsLib.getDocument(pdfUrl).promise;
        hideLoading();
        
        // Add pages to organize pages
        const startIndex = state.organizePages.length;
        for (let i = 0; i < infoData.pageCount; i++) {
            state.organizePages.push({
                index: i,
                rotation: 0,
                deleted: false,
                sourceFile: insertedFile.id,
                sourceName: insertedFile.originalName,
                pdfDoc: insertedPdfDoc
            });
        }
        
        state.insertedPdfs.push({
            id: insertedFile.id,
            name: insertedFile.originalName,
            pdfDoc: insertedPdfDoc,
            pageCount: infoData.pageCount
        });
        
        await renderPageGrid();
        showToast(`${infoData.pageCount} halaman ditambahkan dari ${insertedFile.originalName}`);
    } catch (error) {
        hideLoading();
        console.error('Insert error:', error);
    }
    
    e.target.value = '';
}

async function handleOrganizeUpload(files) {
    const pdfFile = files.find(f => f.type === 'application/pdf');
    if (!pdfFile) {
        showToast('Pilih file PDF yang valid', 'error');
        return;
    }
    
    try {
        const data = await uploadFiles([pdfFile], 'organize');
        state.organizeFile = data.files[0];
        state.organizeFile.name = data.files[0].originalName;
        rememberSessionFile(state.organizeFile, 'organize');
        
        // Get PDF info
        const infoResponse = await fetch(`/api/pdf-info/${state.organizeFile.id}`);
        const infoData = await infoResponse.json();
        
        // Load PDF for preview
        showLoading('Memuat preview halaman...');
        const pdfUrl = `/api/pdf-file/${state.organizeFile.id}`;
        state.organizePdfDoc = await pdfjsLib.getDocument(pdfUrl).promise;
        hideLoading();
        
        state.organizePages = infoData.pages.map(p => ({
            index: p.index,
            rotation: p.rotation,
            deleted: false,
            sourceFile: state.organizeFile.id,
            pdfDoc: state.organizePdfDoc
        }));
        
        document.getElementById('organize-upload-zone').style.display = 'none';
        document.getElementById('organize-workspace').style.display = 'block';
        document.getElementById('organize-action-bar').style.display = 'flex';
        
        await renderPageGrid();
        showToast('File berhasil diunggah');
    } catch (error) {
        hideLoading();
        console.error('Upload error:', error);
    }
}

async function renderPageGrid() {
    const grid = document.getElementById('page-grid');
    grid.innerHTML = '';
    
    for (let index = 0; index < state.organizePages.length; index++) {
        const page = state.organizePages[index];
        const item = document.createElement('div');
        item.className = `page-item ${page.deleted ? 'deleted' : ''}`;
        item.draggable = !page.deleted;
        item.dataset.index = index;
        
        const isInserted = page.sourceFile !== state.organizeFile?.id;
        
        item.innerHTML = `
            <canvas></canvas>
            <div class="page-reorder-controls">
                <button type="button" class="page-move-btn" onclick="moveOrganizePage(${index}, -1)" ${index === 0 ? 'disabled' : ''} aria-label="Pindahkan halaman ${index + 1} ke urutan sebelumnya" title="Geser ke kiri">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><polyline points="15 18 9 12 15 6"></polyline></svg>
                </button>
                <button type="button" class="page-move-btn" onclick="moveOrganizePage(${index}, 1)" ${index === state.organizePages.length - 1 ? 'disabled' : ''} aria-label="Pindahkan halaman ${index + 1} ke urutan sesudahnya" title="Geser ke kanan">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><polyline points="9 18 15 12 9 6"></polyline></svg>
                </button>
            </div>
            <div class="page-item-actions">
                <button class="page-action-btn rotate" onclick="rotatePage(${index})" title="Putar 90°">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M21 2v6h-6"></path>
                        <path d="M3 12a9 9 0 0 1 15-6.7L21 8"></path>
                    </svg>
                </button>
                <button class="page-action-btn delete" onclick="toggleDeletePage(${index})" title="${page.deleted ? 'Pulihkan' : 'Hapus'}">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        ${page.deleted ?
                            '<path d="M3 12l5 5L21 6"></path>' :
                            '<polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>'
                        }
                    </svg>
                </button>
            </div>
            <div class="page-item-overlay">
                <div class="page-item-number">Hal ${page.index + 1}</div>
                ${page.rotation ? `<div class="page-item-rotation">${page.rotation}°</div>` : ''}
                ${isInserted ? `<div class="page-item-source">${escapeHtml(page.sourceName || 'Inserted')}</div>` : ''}
            </div>
        `;
        
        grid.appendChild(item);
        
        // Render page preview
        if (page.pdfDoc) {
            const canvas = item.querySelector('canvas');
            await renderPageToCanvas(page.pdfDoc, page.index + 1, canvas, 150);
        }
        
        if (!page.deleted) {
            // Drag events
            item.addEventListener('dragstart', (e) => {
                item.classList.add('dragging');
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', index);
            });
            
            item.addEventListener('dragend', () => {
                item.classList.remove('dragging');
                document.querySelectorAll('.page-item').forEach(i => i.classList.remove('drag-over'));
            });
            
            item.addEventListener('dragover', (e) => {
                e.preventDefault();
                const dragging = document.querySelector('.page-item.dragging');
                if (dragging !== item) {
                    item.classList.add('drag-over');
                }
            });
            
            item.addEventListener('dragleave', () => {
                item.classList.remove('drag-over');
            });
            
            item.addEventListener('drop', (e) => {
                e.preventDefault();
                item.classList.remove('drag-over');
                const fromIndex = parseInt(e.dataTransfer.getData('text/plain'));
                const toIndex = index;
                
                if (fromIndex !== toIndex) {
                    const [moved] = state.organizePages.splice(fromIndex, 1);
                    state.organizePages.splice(toIndex, 0, moved);
                    renderPageGrid();
                }
            });
        }
    }
    
    // Initialize touch drag for mobile
    initTouchDrag(grid, grid, (fromIndex, toIndex) => {
        const [moved] = state.organizePages.splice(fromIndex, 1);
        state.organizePages.splice(toIndex, 0, moved);
        renderPageGrid();
    });
}

function rotatePage(index) {
    const page = state.organizePages[index];
    page.rotation = ((page.rotation || 0) + 90) % 360;
    renderPageGrid();
}

function toggleDeletePage(index) {
    state.organizePages[index].deleted = !state.organizePages[index].deleted;
    renderPageGrid();
}

async function processOrganize() {
    if (!state.organizeFile) {
        showToast('Upload file PDF terlebih dahulu', 'error');
        return;
    }
    
    const activePages = state.organizePages.filter(p => !p.deleted);
    if (activePages.length === 0) {
        showToast('Tidak ada halaman yang tersisa', 'error');
        return;
    }

    state.isProcessing = true;
    try {
        showLoading('Menyimpan perubahan...');
        
        // Build pages array with source info for multi-PDF support
        const pagesData = state.organizePages.map(page => ({
            index: page.index,
            rotation: page.rotation || 0,
            deleted: page.deleted || false,
            sourceFile: page.sourceFile || state.organizeFile.id
        }));
        
        const response = await fetch('/api/organize', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                fileId: state.organizeFile.id,
                pages: pagesData
            })
        });
        
        const data = await response.json();
        hideLoading();
        
        if (!response.ok) {
            throw new Error(data.error || 'Organization failed');
        }
        
        showResult('organize', [{
            id: data.fileId,
            name: data.filename,
            size: data.size,
            expiry: data.expiry
        }]);
        
        showToast(`PDF berhasil diorganisir! (${data.pageCount} halaman)`);
    } catch (error) {
        hideLoading();
        showToast(error.message, 'error');
    }
}

// Generic result display
function showResult(type, files) {
    const resultSection = document.getElementById(`${type}-result`);
    resultSection.style.display = 'block';
    
    resultSection.innerHTML = `
        <div class="result-header">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path>
                <polyline points="22 4 12 14.01 9 11.01"></polyline>
            </svg>
            <h3>Berhasil!</h3>
        </div>
        
        <div class="result-files">
            ${files.map(file => `
                <div class="result-file" id="result-file-${escapeAttr(file.id)}">
                    <div class="result-file-info">
                        <div class="file-icon">
                            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
                                <polyline points="14 2 14 8 20 8"></polyline>
                            </svg>
                        </div>
                        <div class="result-file-details">
                            <h4>${escapeHtml(file.name)}</h4>
                            <p>${formatFileSize(file.size)}</p>
                        </div>
                    </div>
                    <div class="result-actions">
                        <a href="/api/download/${encodeFileParam(file.id)}?filename=${encodeFileParam(file.name)}" class="btn btn-primary" download>
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                                <polyline points="7 10 12 15 17 10"></polyline>
                                <line x1="12" y1="15" x2="12" y2="3"></line>
                            </svg>
                            Download
                        </a>
                        <button class="btn btn-danger btn-sm" onclick="deleteFile('${escapeAttr(file.id)}', '${escapeAttr(type)}')">
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <polyline points="3 6 5 6 21 6"></polyline>
                                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                            </svg>
                            Hapus
                        </button>
                    </div>
                </div>
            `).join('')}
        </div>
        
        ${files.length === 1 ? `
            <div class="expiry-timer" id="timer-${files[0].id}">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <circle cx="12" cy="12" r="10"></circle>
                    <polyline points="12 6 12 12 16 14"></polyline>
                </svg>
                <span>File akan dihapus permanen dalam <strong id="countdown-${files[0].id}">${formatTime(remainingSeconds(files[0].expiry))}</strong> menit</span>
            </div>
        ` : ''}
    `;
    
    // Start expiry timers
    files.forEach(file => {
        startExpiryTimer(file.id, file.expiry);
    });
}

function startExpiryTimer(fileId, expiry) {
    const countdownEl = document.getElementById(`countdown-${fileId}`);
    if (!countdownEl) return;
    
    const updateTimer = () => {
        const remaining = Math.max(0, Math.floor((expiry - Date.now()) / 1000));
        countdownEl.textContent = formatTime(remaining);
        
        if (remaining <= 0) {
            clearInterval(state.expiryTimers.get(fileId));
            state.expiryTimers.delete(fileId);
            
            const timerEl = document.getElementById(`timer-${fileId}`);
            if (timerEl) {
                timerEl.innerHTML = `
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <circle cx="12" cy="12" r="10"></circle>
                        <line x1="15" y1="9" x2="9" y2="15"></line>
                        <line x1="9" y1="9" x2="15" y2="15"></line>
                    </svg>
                    <span>File telah dihapus</span>
                `;
                timerEl.style.background = 'rgba(239, 68, 68, 0.1)';
                timerEl.style.borderColor = 'rgba(239, 68, 68, 0.3)';
                timerEl.style.color = 'var(--error)';
            }
        }
    };
    
    updateTimer();
    const interval = setInterval(updateTimer, 1000);
    state.expiryTimers.set(fileId, interval);
}

async function deleteFile(fileId, type) {
    try {
        const response = await fetch(`/api/delete/${fileId}`, { method: 'DELETE' });
        const data = await response.json();

        if (response.ok) {
            forgetSessionFile(fileId);

            const fileEl = document.getElementById(`result-file-${fileId}`);
            if (fileEl) {
                fileEl.remove();
            }

            const timerEl = document.getElementById(`timer-${fileId}`);
            if (timerEl) {
                timerEl.remove();
            }

            if (state.expiryTimers.has(fileId)) {
                clearInterval(state.expiryTimers.get(fileId));
                state.expiryTimers.delete(fileId);
            }

            showToast('File berhasil dihapus');
        } else {
            throw new Error(data.error);
        }
    } catch (error) {
        showToast(error.message, 'error');
    }
}

// Touch drag helper functions for mobile.
// Returns a cleanup function that detaches its listeners — call it whenever
// the panel is reset, otherwise listeners pile up on every re-init.
const touchDragCleanups = [];

/** Detach every registered touch-drag listener (panel switch / rebuild). */
function runTouchDragCleanups() {
    while (touchDragCleanups.length > 0) {
        try { touchDragCleanups.pop()(); } catch { /* ignore */ }
    }
}

function initTouchDrag(element, list, onReorder) {
    if (!element) return;

    // A single list may be re-rendered repeatedly; drop any listeners a
    // previous render bound to this same element before adding new ones.
    if (typeof element._touchDragCleanup === 'function') {
        element._touchDragCleanup();
    }

    element.addEventListener('touchstart', handleTouchStart, { passive: false });
    element.addEventListener('touchmove', handleTouchMove, { passive: false });
    element.addEventListener('touchend', handleTouchEnd);
    element.addEventListener('touchcancel', handleTouchEnd);

    const cleanup = () => {
        element.removeEventListener('touchstart', handleTouchStart, { passive: false });
        element.removeEventListener('touchmove', handleTouchMove, { passive: false });
        element.removeEventListener('touchend', handleTouchEnd);
        element.removeEventListener('touchcancel', handleTouchEnd);
        if (element._touchDragCleanup === cleanup) element._touchDragCleanup = undefined;
    };
    element._touchDragCleanup = cleanup;
    touchDragCleanups.push(cleanup);

    function handleTouchStart(e) {
        if (e.touches.length !== 1) return;

        const touch = e.touches[0];
        const item = e.target.closest('[draggable="true"]');
        if (!item) return;

        touchDragState.dragging = true;
        touchDragState.element = item;
        touchDragState.list = list;
        touchDragState.startY = touch.clientY;
        touchDragState.startX = touch.clientX;
        touchDragState.items = Array.from(list.querySelectorAll('[draggable="true"]'));
        touchDragState.fromIndex = touchDragState.items.indexOf(item);
        touchDragState.onReorder = onReorder;

        item.classList.add('dragging');
        item.style.zIndex = '1000';
    }

    function handleTouchMove(e) {
        if (!touchDragState.dragging || !touchDragState.element) return;
        e.preventDefault();

        const touch = e.touches[0];
        const deltaY = touch.clientY - touchDragState.startY;
        const deltaX = touch.clientX - touchDragState.startX;

        touchDragState.element.style.transform = `translate(${deltaX}px, ${deltaY}px)`;

        // Find element under touch point
        touchDragState.element.style.pointerEvents = 'none';
        const elementBelow = document.elementFromPoint(touch.clientX, touch.clientY);
        touchDragState.element.style.pointerEvents = '';

        if (elementBelow) {
            const targetItem = elementBelow.closest('[draggable="true"]');
            touchDragState.items.forEach(item => item.classList.remove('drag-over'));
            if (targetItem && targetItem !== touchDragState.element) {
                targetItem.classList.add('drag-over');
            }
        }
    }

    function handleTouchEnd() {
        if (!touchDragState.dragging || !touchDragState.element) {
            resetTouchDragState();
            return;
        }

        const item = touchDragState.element;
        item.classList.remove('dragging');
        item.style.transform = '';
        item.style.zIndex = '';

        // Find target
        const dragOverItem = touchDragState.list ? touchDragState.list.querySelector('.drag-over') : null;
        if (dragOverItem) {
            const toIndex = touchDragState.items.indexOf(dragOverItem);
            if (toIndex !== -1 && toIndex !== touchDragState.fromIndex) {
                touchDragState.onReorder(touchDragState.fromIndex, toIndex);
            }
            dragOverItem.classList.remove('drag-over');
        }

        // Reset state fully so a later drag starts clean.
        resetTouchDragState();
    }
}

function resetTouchDragState() {
    touchDragState.dragging = false;
    touchDragState.element = null;
    touchDragState.list = null;
    touchDragState.items = [];
    touchDragState.fromIndex = -1;
    touchDragState.onReorder = null;
    touchDragState.startY = 0;
    touchDragState.startX = 0;
    touchDragState.currentY = 0;
    touchDragState.currentX = 0;
}

// ---------------------------------------------------------------------------
// Theme engine
//
// An explicit stored choice wins; otherwise Obsidian Slate (dark) is the
// default regardless of OS preference. The <html> element already ships with
// data-theme="dark" so there is no flash of the wrong palette before this runs.
// ---------------------------------------------------------------------------

const THEME_STORAGE_KEY = 'pdf-utility-theme';

function preferredTheme() {
    try {
        const stored = localStorage.getItem(THEME_STORAGE_KEY);
        if (stored === 'dark' || stored === 'light') return stored;
    } catch { /* storage can be unavailable in private mode */ }

    // Dark is the app's identity, not a fallback: Obsidian Slate stays the
    // default for everyone, and light mode is an explicit opt-in via the
    // header toggle. This also matches <html data-theme="dark">, so there is
    // never a flash of the wrong palette.
    return 'dark';
}

function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) {
        meta.setAttribute('content', theme === 'light' ? '#f4f6fa' : '#0b0f17');
    }
    const btn = document.getElementById('theme-toggle-btn');
    if (btn) {
        btn.setAttribute(
            'aria-label',
            theme === 'light' ? 'Ganti ke mode gelap' : 'Ganti ke mode terang'
        );
        btn.setAttribute('aria-pressed', String(theme === 'light'));
    }
}

function initTheme() {
    applyTheme(preferredTheme());
}

function toggleTheme() {
    const current = document.documentElement.getAttribute('data-theme') || 'dark';
    const next = current === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    try {
        localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Global drag and drop
//
// Without this the browser navigates away and renders the dropped PDF itself,
// losing anything in progress. Dropping anywhere lands the file in the tool
// that is currently open, or picks a sensible tool from the upload.
// ---------------------------------------------------------------------------

let globalDragDepth = 0;

function isFileDrag(event) {
    const types = event.dataTransfer && event.dataTransfer.types;
    return !!types && Array.prototype.indexOf.call(types, 'Files') !== -1;
}

function showGlobalDropOverlay() {
    const overlay = document.getElementById('global-drop-overlay');
    if (!overlay) return;
    overlay.classList.add('active');
    overlay.setAttribute('aria-hidden', 'false');
}

function hideGlobalDropOverlay() {
    const overlay = document.getElementById('global-drop-overlay');
    if (!overlay) return;
    overlay.classList.remove('active');
    overlay.setAttribute('aria-hidden', 'true');
    globalDragDepth = 0;
}

/** Upload handler belonging to the tool that is currently on screen. */
function activeUploadHandler() {
    switch (state.currentPanel) {
        case 'merge': return handleMergeUpload;
        case 'split': return handleSplitUpload;
        case 'compress': return handleCompressUpload;
        case 'pdf-to-jpg': return handlePdfToJpgUpload;
        case 'jpg-to-pdf': return handleJpgToPdfUpload;
        case 'organize': return handleOrganizeUpload;
        default: return null;
    }
}

/** Choose the most likely tool when files are dropped on the home page. */
function routeDroppedFiles(files) {
    const list = Array.from(files || []);
    if (list.length === 0) return;

    const hasPdf = list.some(f => f.type === 'application/pdf');
    const hasImage = list.some(f => f.type === 'image/jpeg' || f.type === 'image/png');
    const pdfs = list.filter(f => f.type === 'application/pdf');
    const images = list.filter(f => f.type === 'image/jpeg' || f.type === 'image/png');

    // Mixed drops are ambiguous — let the person pick the tool themselves.
    if (hasPdf && hasImage) {
        showToast('Campur PDF dan gambar. Pilih alat yang ingin dipakai lebih dulu.', 'error');
        scrollToFeatures();
        return;
    }

    if (hasImage) {
        navigateTo('jpg-to-pdf');
        handleJpgToPdfUpload(images);
        return;
    }

    if (pdfs.length > 1) {
        navigateTo('merge');
        handleMergeUpload(pdfs);
        return;
    }

    if (pdfs.length === 1) {
        navigateTo('organize');
        handleOrganizeUpload(pdfs);
    }
}

function setupGlobalDragAndDrop() {
    const overlay = document.getElementById('global-drop-overlay');

    document.addEventListener('dragenter', (e) => {
        if (!isFileDrag(e)) return;
        e.preventDefault();
        globalDragDepth++;
        showGlobalDropOverlay();
    });

    document.addEventListener('dragover', (e) => {
        if (!isFileDrag(e)) return;
        // Required so the browser hands us the drop instead of opening the file.
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    });

    document.addEventListener('dragleave', (e) => {
        if (!isFileDrag(e)) return;
        globalDragDepth = Math.max(0, globalDragDepth - 1);
        if (globalDragDepth === 0) hideGlobalDropOverlay();
    });

    document.addEventListener('drop', async (e) => {
        if (!isFileDrag(e)) return;
        e.preventDefault();
        hideGlobalDropOverlay();

        const files = Array.from(e.dataTransfer.files || []);
        if (files.length === 0) return;

        const handler = activeUploadHandler();
        if (handler) {
            handler(files);
            return;
        }

        routeDroppedFiles(files);
    });

    // Safety net: a drag that ends outside the window leaves no dragleave.
    window.addEventListener('dragend', hideGlobalDropOverlay);
    window.addEventListener('blur', hideGlobalDropOverlay);

    if (overlay) {
        overlay.addEventListener('dragover', (e) => {
            if (isFileDrag(e)) e.preventDefault();
        });
    }
}

// ---------------------------------------------------------------------------
// Home hero: pick files first, then choose the tool
// ---------------------------------------------------------------------------

function setupHeroFileInput() {
    const input = document.getElementById('hero-file-input');
    if (!input) return;

    input.addEventListener('change', () => {
        const files = Array.from(input.files || []);
        input.value = '';
        if (files.length === 0) return;
        routeDroppedFiles(files);
    });
}

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    initTheme();
    setupHeroFileInput();
    setupGlobalDragAndDrop();
    installRouteGuard();

    // Esc closes the mobile menu, the way people expect on a phone.
    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        const menu = document.getElementById('mobile-menu');
        const btn = document.getElementById('mobile-menu-btn');
        if (menu && menu.classList.contains('active')) {
            menu.classList.remove('active');
            if (btn) {
                btn.setAttribute('aria-expanded', 'false');
                btn.focus();
            }
        }
    });

    // Router boot: honour a bookmarked hash (or the plain page) and react to
    // Back/Forward and manual hash edits from then on.
    window.addEventListener('hashchange', handleRoute);
    handleRoute();

    console.log('Secure PDF Utility Suite initialized');
});
