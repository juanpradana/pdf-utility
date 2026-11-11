'use strict';

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const { PDFDocument, degrees } = require('pdf-lib');

// ---------------------------------------------------------------------------
// Configuration (all tunable via environment variables)
// ---------------------------------------------------------------------------

function intEnv(name, fallback) {
    const parsed = parseInt(process.env[name], 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const PORT = intEnv('PORT', 3001);
const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || path.join(__dirname, 'temp_uploads'));
const OUTPUT_DIR = path.resolve(process.env.OUTPUT_DIR || path.join(__dirname, 'temp_outputs'));

const FILE_EXPIRY_MS = intEnv('FILE_EXPIRY_MIN', 30) * 60 * 1000;
const MAX_FILE_SIZE = intEnv('MAX_FILE_SIZE_MB', 50) * 1024 * 1024;
const MAX_FILES = intEnv('MAX_FILES', 50);
const MAX_TRACKED_FILES = intEnv('MAX_TRACKED_FILES', 20000);
const CLEANUP_INTERVAL_MS = intEnv('CLEANUP_INTERVAL_MS', 60 * 1000);

// Maximum number of pages accepted from a client-rendered compression job.
const MAX_COMPRESS_IMAGES = intEnv('MAX_COMPRESS_IMAGES', 300);

// Reverse proxy: when running behind Nginx/Cloudflare, trust X-Forwarded-For
// so rate limiting keys on the real client address instead of the proxy's.
const TRUST_PROXY = process.env.TRUST_PROXY !== 'false';
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || '';

// ---------------------------------------------------------------------------
// Storage directories
// ---------------------------------------------------------------------------

for (const dir of [UPLOAD_DIR, OUTPUT_DIR]) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// ---------------------------------------------------------------------------
// Path safety helpers
//
// Every client-supplied identifier reaches the filesystem, so it is validated
// against a strict whitelist and every resolved path is asserted to stay
// inside its intended directory. This closes path traversal (e.g. a fileId of
// "../../etc/passwd") and symlink escapes.
// ---------------------------------------------------------------------------

const FILE_ID_RE = /^[A-Za-z0-9-]{1,64}$/;

function isValidFileId(fileId) {
    return typeof fileId === 'string' && FILE_ID_RE.test(fileId);
}

/**
 * Resolve `name` inside `baseDir`, refusing anything that escapes it.
 * Returns the absolute path, or null when the input is unsafe.
 */
function resolveIn(baseDir, name) {
    if (typeof name !== 'string' || name.length === 0) return null;
    // Reject separators and any traversal segment outright.
    if (name.includes('/') || name.includes('\\') || name.includes('..') || name.includes('\0')) {
        return null;
    }
    const target = path.resolve(baseDir, name);
    const base = baseDir.endsWith(path.sep) ? baseDir : baseDir + path.sep;
    if (target !== baseDir && !target.startsWith(base)) return null;
    return target;
}

/** Locate an uploaded file by id across the extensions the app accepts. */
function findUploadedFile(fileId) {
    if (!isValidFileId(fileId)) return null;
    for (const ext of ['.pdf', '.jpg', '.jpeg', '.png']) {
        const candidate = resolveIn(UPLOAD_DIR, `${fileId}${ext}`);
        if (candidate && fs.existsSync(candidate)) return candidate;
    }
    return null;
}

/** Locate a generated output file by id. */
function findOutputFile(fileId) {
    if (!isValidFileId(fileId)) return null;
    const candidate = resolveIn(OUTPUT_DIR, `${fileId}.pdf`);
    return candidate && fs.existsSync(candidate) ? candidate : null;
}

/** Upload first, then output — matches the app's original lookup order. */
function findAnyFile(fileId) {
    return findUploadedFile(fileId) || findOutputFile(fileId);
}

/** Strip characters that could break a Content-Disposition header. */
function sanitizeDownloadName(name, fallback = 'document.pdf') {
    if (typeof name !== 'string' || name.length === 0) return fallback;
    const cleaned = path.basename(name).replace(/[\r\n"\\/\0]/g, '').trim();
    return cleaned.length > 0 ? cleaned.slice(0, 200) : fallback;
}

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', TRUST_PROXY ? 1 : false);

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

/** Consistent error envelope with an explicit status code. */
function fail(res, status, message, code) {
    return res.status(status).json({
        success: false,
        error: message,
        ...(code ? { code } : {}),
    });
}

function badRequest(res, message) {
    return fail(res, 400, message, 'BAD_REQUEST');
}

function notFound(res, message = 'File not found or expired.') {
    return fail(res, 404, message, 'NOT_FOUND');
}

function serverError(res, context, error) {
    console.error(`${context}:`, error);
    return fail(res, 500, 'Internal server error.', 'INTERNAL');
}

// ---------------------------------------------------------------------------
// Security middleware
// ---------------------------------------------------------------------------

app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
            fontSrc: ["'self'", 'https://fonts.gstatic.com'],
            // No inline <script> blocks exist, so 'unsafe-inline' is not needed here.
            scriptSrc: ["'self'", 'https://cdnjs.cloudflare.com'],
            // The UI uses inline event attributes (onclick=...), which need this.
            scriptSrcAttr: ["'unsafe-inline'"],
            workerSrc: ["'self'", 'blob:', 'https://cdnjs.cloudflare.com'],
            imgSrc: ["'self'", 'data:', 'blob:'],
            connectSrc: ["'self'", 'blob:'],
            objectSrc: ["'none'"],
            baseUri: ["'self'"],
            frameAncestors: ["'none'"],
            formAction: ["'self'"],
            // Disabled: the app is also reachable over plain HTTP (e.g. by IP),
            // where forcing subresources to HTTPS would break asset loading.
            upgradeInsecureRequests: null,
        },
    },
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: 'same-site' },
}));

// CORS is closed by default (same-origin only). Set FRONTEND_ORIGIN to allow
// one additional origin, or FRONTEND_ORIGIN=* to opt back into open CORS.
if (FRONTEND_ORIGIN) {
    app.use(cors({
        origin: FRONTEND_ORIGIN === '*' ? true : FRONTEND_ORIGIN.split(',').map(o => o.trim()),
        methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
        maxAge: 600,
    }));
}

app.use(cookieParser());
app.use(express.json({ limit: process.env.JSON_LIMIT || '25mb' }));

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

const limiter = rateLimit({
    windowMs: intEnv('RATE_LIMIT_WINDOW_MIN', 15) * 60 * 1000,
    max: intEnv('RATE_LIMIT_MAX', 300),
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, error: 'Too many requests, please try again later.', code: 'RATE_LIMITED' },
});

const uploadLimiter = rateLimit({
    windowMs: intEnv('RATE_LIMIT_WINDOW_MIN', 15) * 60 * 1000,
    max: intEnv('UPLOAD_RATE_LIMIT_MAX', 60),
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, error: 'Too many upload requests, please try again later.', code: 'RATE_LIMITED' },
});

// Health check is registered before the limiters so orchestrators are never throttled.
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', uptime: Math.floor(process.uptime()) });
});

app.use('/api/', limiter);
app.use('/api/upload', uploadLimiter);

// ---------------------------------------------------------------------------
// Upload handling
// ---------------------------------------------------------------------------

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        const safeExt = ['.pdf', '.jpg', '.jpeg', '.png'].includes(ext) ? ext : '';
        cb(null, `${uuidv4()}${safeExt}`);
    },
});

const ALLOWED_MIMES = ['application/pdf', 'image/jpeg', 'image/jpg', 'image/png'];

const fileFilter = (req, file, cb) => {
    if (ALLOWED_MIMES.includes(file.mimetype)) {
        cb(null, true);
    } else {
        cb(new Error('Invalid file type. Only PDF and JPG/PNG files are allowed.'), false);
    }
};

const upload = multer({
    storage,
    fileFilter,
    limits: { fileSize: MAX_FILE_SIZE, files: MAX_FILES },
});

// ---------------------------------------------------------------------------
// File tracking & expiry
// ---------------------------------------------------------------------------

/** filePath -> { expiry, sessionId, originalName } */
const fileTracker = new Map();

function trackFile(filePath, sessionId, originalName = null) {
    const expiry = Date.now() + FILE_EXPIRY_MS;

    // Bound the map so a long-running process cannot grow without limit.
    if (fileTracker.size >= MAX_TRACKED_FILES && !fileTracker.has(filePath)) {
        let oldestKey = null;
        let oldestExpiry = Infinity;
        for (const [key, data] of fileTracker) {
            if (data.expiry < oldestExpiry) {
                oldestExpiry = data.expiry;
                oldestKey = key;
            }
        }
        if (oldestKey !== null) fileTracker.delete(oldestKey);
    }

    fileTracker.set(filePath, { expiry, sessionId, originalName });
    return expiry;
}

function forget(filePath) {
    fileTracker.delete(filePath);
}

function cleanupExpiredFiles() {
    const now = Date.now();
    for (const [filePath, data] of fileTracker) {
        if (data.expiry > now) continue;
        try {
            if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        } catch (err) {
            console.error(`Error deleting file ${filePath}:`, err);
        }
        fileTracker.delete(filePath);
    }
}

const cleanupTimer = setInterval(cleanupExpiredFiles, CLEANUP_INTERVAL_MS);
cleanupTimer.unref();

// ---------------------------------------------------------------------------
// File content validation (magic bytes)
// ---------------------------------------------------------------------------

function readHeader(filePath, length) {
    const buffer = Buffer.alloc(length);
    let fd;
    try {
        fd = fs.openSync(filePath, 'r');
        const bytesRead = fs.readSync(fd, buffer, 0, length, 0);
        return bytesRead === length ? buffer : null;
    } catch {
        return null;
    } finally {
        if (fd !== undefined) {
            try { fs.closeSync(fd); } catch { /* already closed */ }
        }
    }
}

function isValidPdf(filePath) {
    const header = readHeader(filePath, 5);
    return header !== null && header.toString('latin1') === '%PDF-';
}

function isValidImage(filePath) {
    const header = readHeader(filePath, 8);
    if (header === null) return false;
    // JPEG: FF D8 FF
    if (header[0] === 0xFF && header[1] === 0xD8 && header[2] === 0xFF) return true;
    // PNG: 89 50 4E 47 0D 0A 1A 0A
    if (header[0] === 0x89 && header[1] === 0x50 && header[2] === 0x4E && header[3] === 0x47) return true;
    return false;
}

function looksLikePng(filePath) {
    const header = readHeader(filePath, 4);
    return header !== null && header[0] === 0x89 && header[1] === 0x50 && header[2] === 0x4E && header[3] === 0x47;
}

/** Base name of a tracked upload, without extension — used for output naming. */
function derivedBaseName(filePath, fallback = 'document') {
    const info = fileTracker.get(filePath);
    const original = info && info.originalName ? info.originalName : fallback;
    return path.basename(original).replace(/\.[^/.]+$/, '') || fallback;
}

/** Write bytes to a fresh output file and start tracking it. */
function writeOutput(bytes) {
    const outputId = uuidv4();
    const outputPath = path.join(OUTPUT_DIR, `${outputId}.pdf`);
    fs.writeFileSync(outputPath, bytes);
    const expiry = trackFile(outputPath, 'output');
    return { outputId, outputPath, size: bytes.length, expiry };
}

/**
 * Load a PDF by id from the upload directory.
 * Returns { path, doc } or null when missing/unreadable.
 */
async function loadUploadedPdf(fileId, options) {
    const filePath = findUploadedFile(fileId);
    if (!filePath || path.extname(filePath) !== '.pdf') return null;
    const bytes = fs.readFileSync(filePath);
    const doc = await PDFDocument.load(bytes, options);
    return { path: filePath, doc };
}

// ---------------------------------------------------------------------------
// API: upload
// ---------------------------------------------------------------------------

app.post('/api/upload', upload.array('files', MAX_FILES), async (req, res) => {
    try {
        const incoming = req.files || [];
        if (incoming.length === 0) {
            return badRequest(res, 'No files were uploaded.');
        }

        const sessionId = uuidv4();
        const files = [];
        const rejected = [];

        for (const file of incoming) {
            const filePath = file.path;
            const isPdf = file.mimetype === 'application/pdf';

            // Content sniffing: the declared MIME type is not trusted.
            const valid = isPdf ? isValidPdf(filePath) : isValidImage(filePath);
            if (!valid) {
                try { fs.unlinkSync(filePath); } catch { /* best effort */ }
                rejected.push({
                    originalName: file.originalname,
                    reason: isPdf ? 'File is not a valid PDF.' : 'File is not a valid JPG/PNG image.',
                });
                continue;
            }

            const expiry = trackFile(filePath, sessionId, file.originalname);

            files.push({
                id: path.basename(file.filename, path.extname(file.filename)),
                originalName: file.originalname,
                size: file.size,
                expiry,
            });
        }

        if (files.length === 0) {
            return fail(res, 422, 'None of the uploaded files passed validation.', 'UNPROCESSABLE');
        }

        res.json({
            success: true,
            sessionId,
            files,
            rejected,
            expiresIn: FILE_EXPIRY_MS / 1000 / 60,
        });
    } catch (error) {
        return serverError(res, 'Upload error', error);
    }
});

// ---------------------------------------------------------------------------
// API: merge
// ---------------------------------------------------------------------------

app.post('/api/merge', async (req, res) => {
    try {
        const { fileIds, order, pages } = req.body || {};

        if (!Array.isArray(fileIds) || fileIds.length < 2) {
            return badRequest(res, 'At least 2 files are required for merge.');
        }
        if (!fileIds.every(isValidFileId)) {
            return badRequest(res, 'One or more file ids are invalid.');
        }

        // Load every source PDF, rejecting missing or malformed files early.
        const pdfCache = new Map();
        for (const fileId of fileIds) {
            const loaded = await loadUploadedPdf(fileId);
            if (!loaded) {
                return notFound(res, `File ${fileId} not found.`);
            }
            pdfCache.set(fileId, loaded.doc);
        }

        const mergedPdf = await PDFDocument.create();

        if (Array.isArray(pages)) {
            if (pages.length === 0) {
                return badRequest(res, 'No pages were selected for merge.');
            }
            for (const pageInfo of pages) {
                const pdf = pdfCache.get(pageInfo && pageInfo.fileId);
                if (!pdf) continue;

                const pageIndex = Number(pageInfo.pageIndex);
                if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= pdf.getPageCount()) {
                    return badRequest(res, `Page index ${pageInfo.pageIndex} is out of range.`);
                }
                const [page] = await mergedPdf.copyPages(pdf, [pageIndex]);
                mergedPdf.addPage(page);
            }
        } else {
            const orderedIds = Array.isArray(order) && order.length > 0 ? order : fileIds;
            for (const fileId of orderedIds) {
                const pdf = pdfCache.get(fileId);
                if (!pdf) continue;
                const copied = await mergedPdf.copyPages(pdf, pdf.getPageIndices());
                copied.forEach(page => mergedPdf.addPage(page));
            }
        }

        if (mergedPdf.getPageCount() === 0) {
            return fail(res, 422, 'The merge produced an empty document.', 'UNPROCESSABLE');
        }

        const mergedBytes = await mergedPdf.save();
        const output = writeOutput(mergedBytes);

        const firstFileId = (pages && pages[0] && pages[0].fileId) || (order && order[0]) || fileIds[0];
        const baseName = derivedBaseName(path.join(UPLOAD_DIR, `${firstFileId}.pdf`));

        res.json({
            success: true,
            fileId: output.outputId,
            filename: `merged_${baseName}.pdf`,
            size: output.size,
            expiry: output.expiry,
        });
    } catch (error) {
        return serverError(res, 'Merge error', error);
    }
});

// ---------------------------------------------------------------------------
// API: split
// ---------------------------------------------------------------------------

app.post('/api/split', async (req, res) => {
    try {
        const { fileId, ranges, extractAll } = req.body || {};

        const loaded = await loadUploadedPdf(fileId);
        if (!loaded) return notFound(res);

        const { path: filePath, doc: pdf } = loaded;
        const totalPages = pdf.getPageCount();
        const baseName = derivedBaseName(filePath);
        const results = [];

        if (extractAll) {
            for (let i = 0; i < totalPages; i++) {
                const newPdf = await PDFDocument.create();
                const [page] = await newPdf.copyPages(pdf, [i]);
                newPdf.addPage(page);
                const output = writeOutput(await newPdf.save());
                results.push({
                    fileId: output.outputId,
                    filename: `split_${baseName}_page${i + 1}.pdf`,
                    size: output.size,
                    expiry: output.expiry,
                });
            }
        } else {
            if (!Array.isArray(ranges) || ranges.length === 0) {
                return badRequest(res, 'At least one page range is required.');
            }

            // Validate every range before writing any output.
            const normalized = [];
            for (const range of ranges) {
                const rawStart = Number(range && range.start);
                const rawEnd = range && range.end !== undefined && range.end !== null
                    ? Number(range.end)
                    : rawStart;

                if (!Number.isInteger(rawStart) || !Number.isInteger(rawEnd)) {
                    return badRequest(res, 'Page ranges must be whole numbers.');
                }
                if (rawStart < 1 || rawEnd < 1) {
                    return badRequest(res, 'Page numbers start at 1.');
                }
                if (rawStart > rawEnd) {
                    return badRequest(res, `Invalid range ${rawStart}-${rawEnd}: the start page is after the end page.`);
                }
                if (rawEnd > totalPages) {
                    return badRequest(res, `Page ${rawEnd} is out of range; this document has ${totalPages} page(s).`);
                }
                normalized.push({ start: rawStart, end: rawEnd });
            }

            for (const { start, end } of normalized) {
                const newPdf = await PDFDocument.create();
                const pageIndices = [];
                for (let i = start - 1; i <= end - 1; i++) pageIndices.push(i);

                const pages = await newPdf.copyPages(pdf, pageIndices);
                pages.forEach(page => newPdf.addPage(page));

                const output = writeOutput(await newPdf.save());
                results.push({
                    fileId: output.outputId,
                    filename: `split_${baseName}_pages${start}-${end}.pdf`,
                    size: output.size,
                    expiry: output.expiry,
                });
            }
        }

        res.json({ success: true, files: results, totalPages });
    } catch (error) {
        return serverError(res, 'Split error', error);
    }
});

// ---------------------------------------------------------------------------
// API: compress (metadata for the client-side rasterisation pipeline)
// ---------------------------------------------------------------------------

const COMPRESS_LEVELS = {
    low: { quality: 85, dpi: 150 },
    recommended: { quality: 70, dpi: 120 },
    extreme: { quality: 50, dpi: 96 },
};

app.post('/api/compress', async (req, res) => {
    try {
        const { fileId, level } = req.body || {};

        const loaded = await loadUploadedPdf(fileId, { ignoreEncryption: true, updateMetadata: false });
        if (!loaded) return notFound(res);

        const { path: filePath, doc: pdf } = loaded;
        const settings = COMPRESS_LEVELS[level];
        if (!settings) {
            return badRequest(res, 'Compression level must be one of: low, recommended, extreme.');
        }

        const pages = [];
        for (let i = 0; i < pdf.getPageCount(); i++) {
            const { width, height } = pdf.getPage(i).getSize();
            pages.push({ index: i, width, height });
        }

        res.json({
            success: true,
            fileId,
            originalSize: fs.statSync(filePath).size,
            pageCount: pdf.getPageCount(),
            pages,
            quality: settings.quality,
            dpi: settings.dpi,
            level,
            baseName: derivedBaseName(filePath),
            useClientCompression: true,
        });
    } catch (error) {
        return serverError(res, 'Compress error', error);
    }
});

app.post('/api/compress-save', async (req, res) => {
    try {
        const { images, baseName, originalSize } = req.body || {};

        if (!Array.isArray(images) || images.length === 0) {
            return badRequest(res, 'No page images were provided.');
        }
        if (images.length > MAX_COMPRESS_IMAGES) {
            return badRequest(res, `Too many pages to compress at once (limit ${MAX_COMPRESS_IMAGES}).`);
        }
        if (!images.every(img => typeof img === 'string')) {
            return badRequest(res, 'Each page image must be a base64 JPEG string.');
        }

        const pdfDoc = await PDFDocument.create();

        for (const imgData of images) {
            const base64Data = imgData.replace(/^data:image\/jpeg;base64,/, '');
            let imageBytes;
            try {
                imageBytes = Buffer.from(base64Data, 'base64');
            } catch {
                return badRequest(res, 'One of the page images was not valid base64 data.');
            }
            if (imageBytes.length === 0) {
                return badRequest(res, 'One of the page images was empty.');
            }

            const image = await pdfDoc.embedJpg(imageBytes);
            const page = pdfDoc.addPage([image.width, image.height]);
            page.drawImage(image, { x: 0, y: 0, width: image.width, height: image.height });
        }

        const pdfBytes = await pdfDoc.save({ useObjectStreams: true });
        const output = writeOutput(pdfBytes);

        const original = Number(originalSize);
        const reduction = Number.isFinite(original) && original > 0
            ? Math.max(0, Math.round((1 - output.size / original) * 100))
            : 0;

        res.json({
            success: true,
            fileId: output.outputId,
            filename: `compressed_${sanitizeDownloadName(baseName, 'document').replace(/\.pdf$/i, '')}.pdf`,
            originalSize: Number.isFinite(original) ? original : null,
            compressedSize: output.size,
            reduction,
            expiry: output.expiry,
        });
    } catch (error) {
        return serverError(res, 'Compress save error', error);
    }
});

// ---------------------------------------------------------------------------
// API: pdf info / raw file / download
// ---------------------------------------------------------------------------

app.get('/api/pdf-info/:fileId', async (req, res) => {
    try {
        const loaded = await loadUploadedPdf(req.params.fileId);
        if (!loaded) return notFound(res);

        const { doc: pdf } = loaded;
        const pages = [];
        for (let i = 0; i < pdf.getPageCount(); i++) {
            const page = pdf.getPage(i);
            const { width, height } = page.getSize();
            pages.push({ index: i, width, height, rotation: page.getRotation().angle });
        }

        res.json({ success: true, pageCount: pdf.getPageCount(), pages });
    } catch (error) {
        return serverError(res, 'PDF info error', error);
    }
});

app.get('/api/pdf-file/:fileId', (req, res) => {
    const filePath = findAnyFile(req.params.fileId);
    if (!filePath || path.extname(filePath) !== '.pdf') return notFound(res);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('Cache-Control', 'private, no-store');

    const stream = fs.createReadStream(filePath);
    stream.on('error', (err) => {
        console.error('Stream error for', filePath, err);
        if (!res.headersSent) {
            fail(res, 500, 'Failed to read file.', 'READ_ERROR');
        } else {
            res.destroy(err);
        }
    });
    stream.pipe(res);
});

app.get('/api/download/:fileId', (req, res) => {
    const filePath = findAnyFile(req.params.fileId);
    if (!filePath) return notFound(res);

    const requested = sanitizeDownloadName(req.query.filename, path.basename(filePath));
    res.download(filePath, requested, (err) => {
        if (!err) return;
        console.error('Download error for', filePath, err);
        if (!res.headersSent) fail(res, 500, 'Failed to send file.', 'READ_ERROR');
    });
});

// ---------------------------------------------------------------------------
// API: pdf -> jpg (page metadata for client-side rendering)
// ---------------------------------------------------------------------------

app.post('/api/pdf-to-jpg', async (req, res) => {
    try {
        const { fileId, quality } = req.body || {};
        const qualityMap = { high: 95, medium: 80, low: 60 };
        const jpgQuality = qualityMap[quality] !== undefined ? qualityMap[quality] : qualityMap.low;

        const loaded = await loadUploadedPdf(fileId);
        if (!loaded) return notFound(res);

        const { doc: pdf } = loaded;
        const pages = [];
        for (let i = 0; i < pdf.getPageCount(); i++) {
            const { width, height } = pdf.getPage(i).getSize();
            pages.push({ page: i + 1, width: Math.round(width), height: Math.round(height), quality: jpgQuality });
        }

        res.json({ success: true, fileId, pages, totalPages: pdf.getPageCount(), quality: jpgQuality });
    } catch (error) {
        return serverError(res, 'PDF to JPG error', error);
    }
});

// ---------------------------------------------------------------------------
// API: jpg -> pdf
// ---------------------------------------------------------------------------

const PAPER_SIZES = {
    a4: { width: 595.28, height: 841.89 },
    letter: { width: 612, height: 792 },
    legal: { width: 612, height: 1008 },
    a3: { width: 841.89, height: 1190.55 },
    a5: { width: 419.53, height: 595.28 },
};

app.post('/api/jpg-to-pdf', async (req, res) => {
    try {
        const { fileIds, order, paperSize = 'original', orientation = 'auto' } = req.body || {};

        if (!Array.isArray(fileIds) || fileIds.length === 0) {
            return badRequest(res, 'At least 1 image is required.');
        }
        const orderedIds = Array.isArray(order) && order.length > 0 ? order : fileIds;
        if (!orderedIds.every(isValidFileId)) {
            return badRequest(res, 'One or more file ids are invalid.');
        }
        if (paperSize !== 'original' && !PAPER_SIZES[paperSize]) {
            return badRequest(res, 'Unsupported paper size.');
        }
        if (!['auto', 'portrait', 'landscape'].includes(orientation)) {
            return badRequest(res, 'Orientation must be auto, portrait or landscape.');
        }

        const pdfDoc = await PDFDocument.create();
        let firstFileName = null;

        for (const fileId of orderedIds) {
            const filePath = findUploadedFile(fileId);
            if (!filePath || path.extname(filePath) === '.pdf') {
                return notFound(res, `Image ${fileId} not found.`);
            }

            if (!firstFileName) {
                firstFileName = derivedBaseName(filePath, 'images');
            }

            const isPng = looksLikePng(filePath);
            const imageBytes = fs.readFileSync(filePath);
            const image = isPng ? await pdfDoc.embedPng(imageBytes) : await pdfDoc.embedJpg(imageBytes);

            let pageWidth, pageHeight, imgX, imgY, imgWidth, imgHeight;

            if (paperSize === 'original') {
                pageWidth = image.width;
                pageHeight = image.height;
                imgX = 0;
                imgY = 0;
                imgWidth = image.width;
                imgHeight = image.height;
            } else {
                const paper = PAPER_SIZES[paperSize];
                const isLandscape = orientation === 'landscape'
                    || (orientation === 'auto' && image.width > image.height);

                pageWidth = isLandscape ? paper.height : paper.width;
                pageHeight = isLandscape ? paper.width : paper.height;

                const margin = 36; // 0.5 inch
                const availableWidth = pageWidth - margin * 2;
                const availableHeight = pageHeight - margin * 2;
                const scale = Math.min(availableWidth / image.width, availableHeight / image.height);

                imgWidth = image.width * scale;
                imgHeight = image.height * scale;
                imgX = (pageWidth - imgWidth) / 2;
                imgY = (pageHeight - imgHeight) / 2;
            }

            const page = pdfDoc.addPage([pageWidth, pageHeight]);
            page.drawImage(image, { x: imgX, y: imgY, width: imgWidth, height: imgHeight });
        }

        const output = writeOutput(await pdfDoc.save());

        res.json({
            success: true,
            fileId: output.outputId,
            filename: `images_${firstFileName}.pdf`,
            size: output.size,
            pageCount: pdfDoc.getPageCount(),
            expiry: output.expiry,
        });
    } catch (error) {
        return serverError(res, 'JPG to PDF error', error);
    }
});

// ---------------------------------------------------------------------------
// API: organize (rotate / reorder / delete, single or multi-source)
// ---------------------------------------------------------------------------

app.post('/api/organize', async (req, res) => {
    try {
        const { fileId, operations, pages } = req.body || {};

        const loaded = await loadUploadedPdf(fileId);
        if (!loaded) return notFound(res);

        const { path: mainFilePath, doc: mainPdf } = loaded;
        const pdfCache = new Map([[fileId, mainPdf]]);
        const newPdf = await PDFDocument.create();

        /** Rotation must be a whole number of quarter turns. */
        const applyRotation = (page, rotation) => {
            if (rotation === undefined || rotation === null) return true;
            const value = Number(rotation);
            if (!Number.isFinite(value) || value % 90 !== 0) return false;
            page.setRotation(degrees(((value % 360) + 360) % 360));
            return true;
        };

        if (Array.isArray(pages)) {
            if (pages.length === 0) {
                return badRequest(res, 'No pages were provided.');
            }

            for (const pageInfo of pages) {
                if (!pageInfo || pageInfo.deleted) continue;

                const sourceFileId = pageInfo.sourceFile || fileId;
                if (!isValidFileId(sourceFileId)) {
                    return badRequest(res, 'A source file id is invalid.');
                }

                let sourcePdf = pdfCache.get(sourceFileId);
                if (!sourcePdf) {
                    const sourceLoaded = await loadUploadedPdf(sourceFileId);
                    if (!sourceLoaded) continue;
                    sourcePdf = sourceLoaded.doc;
                    pdfCache.set(sourceFileId, sourcePdf);
                }

                const index = Number(pageInfo.index);
                if (!Number.isInteger(index) || index < 0 || index >= sourcePdf.getPageCount()) {
                    return badRequest(res, `Page index ${pageInfo.index} is out of range.`);
                }

                const [page] = await newPdf.copyPages(sourcePdf, [index]);
                if (!applyRotation(page, pageInfo.rotation)) {
                    return badRequest(res, 'Rotation must be a multiple of 90 degrees.');
                }
                newPdf.addPage(page);
            }
        } else {
            const { order, rotations = {}, deletions = [] } = operations || {};
            const pageOrder = Array.isArray(order) && order.length > 0 ? order : mainPdf.getPageIndices();
            const totalPages = mainPdf.getPageCount();
            const deletionSet = new Set(Array.isArray(deletions) ? deletions.map(Number) : []);

            for (const rawIndex of pageOrder) {
                const pageIndex = Number(rawIndex);
                if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= totalPages) {
                    return badRequest(res, `Page index ${rawIndex} is out of range.`);
                }
                if (deletionSet.has(pageIndex)) continue;

                const [page] = await newPdf.copyPages(mainPdf, [pageIndex]);
                if (!applyRotation(page, rotations[pageIndex])) {
                    return badRequest(res, 'Rotation must be a multiple of 90 degrees.');
                }
                newPdf.addPage(page);
            }
        }

        if (newPdf.getPageCount() === 0) {
            return fail(res, 422, 'The result would contain no pages.', 'UNPROCESSABLE');
        }

        const output = writeOutput(await newPdf.save());

        res.json({
            success: true,
            fileId: output.outputId,
            filename: `organized_${derivedBaseName(mainFilePath)}.pdf`,
            size: output.size,
            pageCount: newPdf.getPageCount(),
            expiry: output.expiry,
        });
    } catch (error) {
        return serverError(res, 'Organize error', error);
    }
});

// ---------------------------------------------------------------------------
// API: delete / expiry
// ---------------------------------------------------------------------------

app.delete('/api/delete/:fileId', (req, res) => {
    const { fileId } = req.params;
    if (!isValidFileId(fileId)) return badRequest(res, 'Invalid file id.');

    const candidates = [
        resolveIn(OUTPUT_DIR, `${fileId}.pdf`),
        resolveIn(UPLOAD_DIR, `${fileId}.pdf`),
        resolveIn(UPLOAD_DIR, `${fileId}.jpg`),
        resolveIn(UPLOAD_DIR, `${fileId}.jpeg`),
        resolveIn(UPLOAD_DIR, `${fileId}.png`),
    ].filter(Boolean);

    let deleted = false;
    for (const filePath of candidates) {
        try {
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
                deleted = true;
            }
        } catch (err) {
            console.error('Delete error for', filePath, err);
        }
        // Forget the tracker entry whether or not the file was still present.
        forget(filePath);
    }

    if (!deleted) return notFound(res);
    res.json({ success: true, message: 'File deleted.' });
});

app.get('/api/expiry/:fileId', (req, res) => {
    const { fileId } = req.params;
    if (!isValidFileId(fileId)) return badRequest(res, 'Invalid file id.');

    // Match the exact file id rather than a substring of any tracked path.
    for (const [filePath, data] of fileTracker) {
        if (path.basename(filePath, path.extname(filePath)) !== fileId) continue;
        const remainingMs = data.expiry - Date.now();
        return res.json({
            success: true,
            expiry: data.expiry,
            remainingSeconds: Math.max(0, Math.floor(remainingMs / 1000)),
        });
    }

    notFound(res);
});

// ---------------------------------------------------------------------------
// Static assets + error handling
// ---------------------------------------------------------------------------

app.use(express.static(path.resolve(__dirname, 'public'), {
    index: 'index.html',
    dotfiles: 'ignore',
}));

app.use('/api', (req, res) => notFound(res, 'Endpoint not found.'));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
    if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
            return fail(res, 413, `File too large. Maximum size is ${MAX_FILE_SIZE / (1024 * 1024)}MB.`, 'FILE_TOO_LARGE');
        }
        if (err.code === 'LIMIT_FILE_COUNT') {
            return fail(res, 400, `Too many files. Maximum is ${MAX_FILES} files.`, 'TOO_MANY_FILES');
        }
        if (err.code === 'LIMIT_UNEXPECTED_FILE') {
            return fail(res, 400, 'Unexpected file field.', 'UNEXPECTED_FILE');
        }
        return fail(res, 400, 'Upload rejected.', 'UPLOAD_ERROR');
    }

    // Malformed JSON body.
    if (err && (err.type === 'entity.parse.failed' || err instanceof SyntaxError)) {
        return fail(res, 400, 'Request body was not valid JSON.', 'BAD_JSON');
    }
    if (err && err.type === 'entity.too.large') {
        return fail(res, 413, 'Request body was too large.', 'BODY_TOO_LARGE');
    }

    // Errors raised by the upload file filter.
    if (err && typeof err.message === 'string' && err.message.startsWith('Invalid file type')) {
        return fail(res, 400, err.message, 'INVALID_FILE_TYPE');
    }

    return serverError(res, 'Server error', err);
});

// ---------------------------------------------------------------------------
// Startup & graceful shutdown
// ---------------------------------------------------------------------------

const server = app.listen(PORT, () => {
    console.log(`🚀 Secure PDF Utility Suite running on http://localhost:${PORT}`);
    console.log(`📁 Upload directory: ${UPLOAD_DIR}`);
    console.log(`📁 Output directory: ${OUTPUT_DIR}`);
    console.log(`⏰ Files auto-delete after ${FILE_EXPIRY_MS / 1000 / 60} minutes`);
});

function shutdown(signal) {
    console.log(`${signal} received, shutting down...`);
    server.close(() => {
        clearInterval(cleanupTimer);
        process.exit(0);
    });
    // Don't hang forever on lingering keep-alive connections.
    setTimeout(() => process.exit(0), 10000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

module.exports = app;
