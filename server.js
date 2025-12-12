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
const sharp = require('sharp');

const app = express();
const PORT = process.env.PORT || 3000;

// Create upload directories
const UPLOAD_DIR = path.join(__dirname, 'temp_uploads');
const OUTPUT_DIR = path.join(__dirname, 'temp_outputs');

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

// File tracking for auto-deletion
const fileTracker = new Map();
const FILE_EXPIRY_MS = 30 * 60 * 1000; // 30 minutes

// Security middleware
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
            fontSrc: ["'self'", "https://fonts.gstatic.com"],
            scriptSrc: ["'self'", "'unsafe-inline'"],
            imgSrc: ["'self'", "data:", "blob:"],
        },
    },
}));
app.use(cors());
app.use(cookieParser());
app.use(express.json({ limit: '100mb' }));
app.use(express.static('public'));

// Rate limiting
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // limit each IP to 100 requests per windowMs
    message: { error: 'Too many requests, please try again later.' },
    validate: { xForwardedForHeader: false }
});

const uploadLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20, // stricter limit for uploads
    message: { error: 'Too many upload requests, please try again later.' },
    validate: { xForwardedForHeader: false }
});

app.use('/api/', limiter);
app.use('/api/upload', uploadLimiter);

// Multer configuration
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => {
        const uuid = uuidv4();
        const ext = path.extname(file.originalname).toLowerCase();
        cb(null, `${uuid}${ext}`);
    }
});

const fileFilter = (req, file, cb) => {
    const allowedMimes = ['application/pdf', 'image/jpeg', 'image/png', 'image/jpg'];
    if (allowedMimes.includes(file.mimetype)) {
        cb(null, true);
    } else {
        cb(new Error('Invalid file type. Only PDF and JPG/PNG files are allowed.'), false);
    }
};

const upload = multer({
    storage,
    fileFilter,
    limits: {
        fileSize: 50 * 1024 * 1024, // 50MB limit
        files: 50 // max 50 files at once
    }
});

// Track file for auto-deletion
function trackFile(filePath, sessionId, originalName = null) {
    const expiry = Date.now() + FILE_EXPIRY_MS;
    fileTracker.set(filePath, { expiry, sessionId, originalName });
    return expiry;
}

// Cleanup expired files
function cleanupExpiredFiles() {
    const now = Date.now();
    for (const [filePath, data] of fileTracker.entries()) {
        if (data.expiry <= now) {
            try {
                if (fs.existsSync(filePath)) {
                    fs.unlinkSync(filePath);
                }
                fileTracker.delete(filePath);
            } catch (err) {
                console.error(`Error deleting file ${filePath}:`, err);
            }
        }
    }
}

// Run cleanup every minute
setInterval(cleanupExpiredFiles, 60 * 1000);

// Validate PDF magic bytes
async function validatePDF(filePath) {
    const buffer = Buffer.alloc(5);
    const fd = fs.openSync(filePath, 'r');
    fs.readSync(fd, buffer, 0, 5, 0);
    fs.closeSync(fd);
    return buffer.toString() === '%PDF-';
}

// Validate image magic bytes
async function validateImage(filePath) {
    const buffer = Buffer.alloc(8);
    const fd = fs.openSync(filePath, 'r');
    fs.readSync(fd, buffer, 0, 8, 0);
    fs.closeSync(fd);
    
    // JPEG: FF D8 FF
    if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) return true;
    // PNG: 89 50 4E 47
    if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) return true;
    
    return false;
}

// API Routes

// Upload files
app.post('/api/upload', upload.array('files', 50), async (req, res) => {
    try {
        const sessionId = uuidv4();
        const files = [];
        
        for (const file of req.files) {
            const filePath = file.path;
            const isPDF = file.mimetype === 'application/pdf';
            
            // Validate file content
            if (isPDF) {
                if (!await validatePDF(filePath)) {
                    fs.unlinkSync(filePath);
                    continue;
                }
            } else {
                if (!await validateImage(filePath)) {
                    fs.unlinkSync(filePath);
                    continue;
                }
            }
            
            const expiry = trackFile(filePath, sessionId, file.originalname);
            
            files.push({
                id: file.filename.replace(/\.[^/.]+$/, ''),
                originalName: file.originalname,
                size: file.size,
                expiry
            });
        }
        
        res.json({ 
            success: true, 
            sessionId,
            files,
            expiresIn: FILE_EXPIRY_MS / 1000 / 60 // minutes
        });
    } catch (error) {
        console.error('Upload error:', error);
        res.status(500).json({ error: 'Upload failed.' });
    }
});

// Merge PDFs with page-level control
app.post('/api/merge', async (req, res) => {
    try {
        const { fileIds, order, pages } = req.body;
        
        if (!fileIds || fileIds.length < 2) {
            return res.status(400).json({ error: 'At least 2 files required for merge.' });
        }
        
        const mergedPdf = await PDFDocument.create();
        const pdfCache = new Map();
        
        // Load all PDFs into cache
        for (const fileId of fileIds) {
            const filePath = path.join(UPLOAD_DIR, `${fileId}.pdf`);
            if (!fs.existsSync(filePath)) {
                return res.status(404).json({ error: `File ${fileId} not found.` });
            }
            const pdfBytes = fs.readFileSync(filePath);
            const pdf = await PDFDocument.load(pdfBytes);
            pdfCache.set(fileId, pdf);
        }
        
        // If page-level order is provided
        if (pages && Array.isArray(pages)) {
            for (const pageInfo of pages) {
                const pdf = pdfCache.get(pageInfo.fileId);
                if (pdf) {
                    const [page] = await mergedPdf.copyPages(pdf, [pageInfo.pageIndex]);
                    mergedPdf.addPage(page);
                }
            }
        } else {
            // File-level order (legacy)
            const orderedIds = order || fileIds;
            for (const fileId of orderedIds) {
                const pdf = pdfCache.get(fileId);
                if (pdf) {
                    const copiedPages = await mergedPdf.copyPages(pdf, pdf.getPageIndices());
                    copiedPages.forEach(page => mergedPdf.addPage(page));
                }
            }
        }
        
        const mergedBytes = await mergedPdf.save();
        const outputId = uuidv4();
        const outputPath = path.join(OUTPUT_DIR, `${outputId}.pdf`);
        fs.writeFileSync(outputPath, mergedBytes);
        
        const expiry = trackFile(outputPath, 'output');
        
        // Get first file's original name for output naming
        const firstFileId = pages?.[0]?.fileId || (order || fileIds)[0];
        const firstFileInfo = fileTracker.get(path.join(UPLOAD_DIR, `${firstFileId}.pdf`));
        const baseName = firstFileInfo?.originalName || 'document';
        const cleanName = baseName.replace(/\.pdf$/i, '');
        
        res.json({
            success: true,
            fileId: outputId,
            filename: `merged_${cleanName}.pdf`,
            size: mergedBytes.length,
            expiry
        });
    } catch (error) {
        console.error('Merge error:', error);
        res.status(500).json({ error: 'Merge failed.' });
    }
});

// Split PDF
app.post('/api/split', async (req, res) => {
    try {
        const { fileId, ranges, extractAll } = req.body;
        
        const filePath = path.join(UPLOAD_DIR, `${fileId}.pdf`);
        if (!fs.existsSync(filePath)) {
            return res.status(404).json({ error: 'File not found.' });
        }
        
        const pdfBytes = fs.readFileSync(filePath);
        const pdf = await PDFDocument.load(pdfBytes);
        const totalPages = pdf.getPageCount();
        
        const results = [];
        
        if (extractAll) {
            // Extract each page as separate PDF
            for (let i = 0; i < totalPages; i++) {
                const newPdf = await PDFDocument.create();
                const [page] = await newPdf.copyPages(pdf, [i]);
                newPdf.addPage(page);
                
                const bytes = await newPdf.save();
                const outputId = uuidv4();
                const outputPath = path.join(OUTPUT_DIR, `${outputId}.pdf`);
                fs.writeFileSync(outputPath, bytes);
                
                const expiry = trackFile(outputPath, 'output');
                const sourceInfo = fileTracker.get(filePath);
                const baseName = (sourceInfo?.originalName || 'document').replace(/\.pdf$/i, '');
                results.push({
                    fileId: outputId,
                    filename: `split_${baseName}_page${i + 1}.pdf`,
                    size: bytes.length,
                    expiry
                });
            }
        } else {
            // Split by ranges
            for (const range of ranges) {
                const start = Math.max(0, range.start - 1);
                const end = Math.min(totalPages - 1, (range.end || range.start) - 1);
                
                const newPdf = await PDFDocument.create();
                const pageIndices = [];
                for (let i = start; i <= end; i++) {
                    pageIndices.push(i);
                }
                
                const pages = await newPdf.copyPages(pdf, pageIndices);
                pages.forEach(page => newPdf.addPage(page));
                
                const bytes = await newPdf.save();
                const outputId = uuidv4();
                const outputPath = path.join(OUTPUT_DIR, `${outputId}.pdf`);
                fs.writeFileSync(outputPath, bytes);
                
                const expiry = trackFile(outputPath, 'output');
                const sourceInfo = fileTracker.get(filePath);
                const baseName = (sourceInfo?.originalName || 'document').replace(/\.pdf$/i, '');
                results.push({
                    fileId: outputId,
                    filename: `split_${baseName}_pages${range.start}-${range.end || range.start}.pdf`,
                    size: bytes.length,
                    expiry
                });
            }
        }
        
        res.json({ success: true, files: results, totalPages });
    } catch (error) {
        console.error('Split error:', error);
        res.status(500).json({ error: 'Split failed.' });
    }
});

// Compress PDF - returns info for client-side image-based compression
app.post('/api/compress', async (req, res) => {
    try {
        const { fileId, level } = req.body;
        
        const filePath = path.join(UPLOAD_DIR, `${fileId}.pdf`);
        if (!fs.existsSync(filePath)) {
            return res.status(404).json({ error: 'File not found.' });
        }
        
        const originalBytes = fs.readFileSync(filePath);
        const originalSize = originalBytes.length;
        
        const pdf = await PDFDocument.load(originalBytes, { 
            ignoreEncryption: true,
            updateMetadata: false
        });
        
        const pageCount = pdf.getPageCount();
        const pages = [];
        
        for (let i = 0; i < pageCount; i++) {
            const page = pdf.getPage(i);
            const { width, height } = page.getSize();
            pages.push({ index: i, width, height });
        }
        
        // Get compression settings
        let quality, dpi;
        if (level === 'low') {
            quality = 85;
            dpi = 150;
        } else if (level === 'recommended') {
            quality = 70;
            dpi = 120;
        } else if (level === 'extreme') {
            quality = 50;
            dpi = 96;
        }
        
        // Get source file name for output naming
        const sourceInfo = fileTracker.get(filePath);
        const baseName = (sourceInfo?.originalName || 'document').replace(/\.pdf$/i, '');
        
        res.json({
            success: true,
            fileId: fileId,
            originalSize,
            pageCount,
            pages,
            quality,
            dpi,
            level,
            baseName,
            useClientCompression: true
        });
    } catch (error) {
        console.error('Compress error:', error);
        res.status(500).json({ error: 'Compression failed.' });
    }
});

// Save compressed PDF from client-side image data
app.post('/api/compress-save', async (req, res) => {
    try {
        const { images, baseName, originalSize } = req.body;
        
        if (!images || images.length === 0) {
            return res.status(400).json({ error: 'No images provided.' });
        }
        
        const pdfDoc = await PDFDocument.create();
        
        for (const imgData of images) {
            // imgData is base64 JPEG
            const base64Data = imgData.replace(/^data:image\/jpeg;base64,/, '');
            const imageBytes = Buffer.from(base64Data, 'base64');
            
            const image = await pdfDoc.embedJpg(imageBytes);
            const page = pdfDoc.addPage([image.width, image.height]);
            page.drawImage(image, {
                x: 0,
                y: 0,
                width: image.width,
                height: image.height
            });
        }
        
        const pdfBytes = await pdfDoc.save({
            useObjectStreams: true
        });
        
        const outputId = uuidv4();
        const outputPath = path.join(OUTPUT_DIR, `${outputId}.pdf`);
        fs.writeFileSync(outputPath, pdfBytes);
        
        const expiry = trackFile(outputPath, 'output');
        const compressedSize = pdfBytes.length;
        const reduction = Math.round((1 - compressedSize / originalSize) * 100);
        
        res.json({
            success: true,
            fileId: outputId,
            filename: `compressed_${baseName}.pdf`,
            originalSize,
            compressedSize,
            reduction: Math.max(0, reduction),
            expiry
        });
    } catch (error) {
        console.error('Compress save error:', error);
        res.status(500).json({ error: 'Failed to save compressed PDF.' });
    }
});

// Serve PDF file for client-side rendering
app.get('/api/pdf-file/:fileId', (req, res) => {
    const { fileId } = req.params;
    
    let filePath = path.join(UPLOAD_DIR, `${fileId}.pdf`);
    if (!fs.existsSync(filePath)) {
        filePath = path.join(OUTPUT_DIR, `${fileId}.pdf`);
    }
    
    if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: 'File not found.' });
    }
    
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Access-Control-Allow-Origin', '*');
    fs.createReadStream(filePath).pipe(res);
});

// PDF to JPG - returns info for client-side rendering
app.post('/api/pdf-to-jpg', async (req, res) => {
    try {
        const { fileId, quality } = req.body;
        
        const filePath = path.join(UPLOAD_DIR, `${fileId}.pdf`);
        if (!fs.existsSync(filePath)) {
            return res.status(404).json({ error: 'File not found.' });
        }
        
        const pdfBytes = fs.readFileSync(filePath);
        const pdf = await PDFDocument.load(pdfBytes);
        const pageCount = pdf.getPageCount();
        
        const results = [];
        const jpgQuality = quality === 'high' ? 95 : quality === 'medium' ? 80 : 60;
        
        for (let i = 0; i < pageCount; i++) {
            const page = pdf.getPage(i);
            const { width, height } = page.getSize();
            
            results.push({
                page: i + 1,
                width: Math.round(width),
                height: Math.round(height),
                quality: jpgQuality
            });
        }
        
        res.json({
            success: true,
            fileId: fileId,
            pages: results,
            totalPages: pageCount,
            quality: jpgQuality
        });
    } catch (error) {
        console.error('PDF to JPG error:', error);
        res.status(500).json({ error: 'Conversion failed.' });
    }
});

// JPG to PDF with paper size options
app.post('/api/jpg-to-pdf', async (req, res) => {
    try {
        const { fileIds, order, paperSize = 'original', orientation = 'auto' } = req.body;
        
        if (!fileIds || fileIds.length < 1) {
            return res.status(400).json({ error: 'At least 1 image required.' });
        }
        
        // Paper size definitions in points (72 points = 1 inch)
        const paperSizes = {
            'a4': { width: 595.28, height: 841.89 },
            'letter': { width: 612, height: 792 },
            'legal': { width: 612, height: 1008 },
            'a3': { width: 841.89, height: 1190.55 },
            'a5': { width: 419.53, height: 595.28 },
            'original': null // Use image dimensions
        };
        
        const pdfDoc = await PDFDocument.create();
        const orderedIds = order || fileIds;
        let firstFileName = null;
        
        for (const fileId of orderedIds) {
            // Try both jpg and png extensions
            let filePath = path.join(UPLOAD_DIR, `${fileId}.jpg`);
            if (!fs.existsSync(filePath)) {
                filePath = path.join(UPLOAD_DIR, `${fileId}.jpeg`);
            }
            if (!fs.existsSync(filePath)) {
                filePath = path.join(UPLOAD_DIR, `${fileId}.png`);
            }
            
            if (!fs.existsSync(filePath)) {
                return res.status(404).json({ error: `Image ${fileId} not found.` });
            }
            
            // Get first file name for output naming
            if (!firstFileName) {
                const fileInfo = fileTracker.get(filePath);
                firstFileName = fileInfo?.originalName?.replace(/\.[^/.]+$/, '') || 'images';
            }
            
            const imageBytes = fs.readFileSync(filePath);
            let image;
            
            if (filePath.endsWith('.png')) {
                image = await pdfDoc.embedPng(imageBytes);
            } else {
                image = await pdfDoc.embedJpg(imageBytes);
            }
            
            let pageWidth, pageHeight, imgX, imgY, imgWidth, imgHeight;
            
            if (paperSize === 'original' || !paperSizes[paperSize]) {
                // Use original image dimensions
                pageWidth = image.width;
                pageHeight = image.height;
                imgX = 0;
                imgY = 0;
                imgWidth = image.width;
                imgHeight = image.height;
            } else {
                // Fit image to paper size
                const paper = paperSizes[paperSize];
                const isLandscape = orientation === 'landscape' || 
                    (orientation === 'auto' && image.width > image.height);
                
                pageWidth = isLandscape ? paper.height : paper.width;
                pageHeight = isLandscape ? paper.width : paper.height;
                
                // Calculate scaling to fit image in page with margins
                const margin = 36; // 0.5 inch margin
                const availableWidth = pageWidth - (margin * 2);
                const availableHeight = pageHeight - (margin * 2);
                
                const scaleX = availableWidth / image.width;
                const scaleY = availableHeight / image.height;
                const scale = Math.min(scaleX, scaleY);
                
                imgWidth = image.width * scale;
                imgHeight = image.height * scale;
                imgX = (pageWidth - imgWidth) / 2;
                imgY = (pageHeight - imgHeight) / 2;
            }
            
            const page = pdfDoc.addPage([pageWidth, pageHeight]);
            page.drawImage(image, {
                x: imgX,
                y: imgY,
                width: imgWidth,
                height: imgHeight
            });
        }
        
        const pdfBytes = await pdfDoc.save();
        const outputId = uuidv4();
        const outputPath = path.join(OUTPUT_DIR, `${outputId}.pdf`);
        fs.writeFileSync(outputPath, pdfBytes);
        
        const expiry = trackFile(outputPath, 'output');
        
        res.json({
            success: true,
            fileId: outputId,
            filename: `images_${firstFileName}.pdf`,
            size: pdfBytes.length,
            pageCount: pdfDoc.getPageCount(),
            expiry
        });
    } catch (error) {
        console.error('JPG to PDF error:', error);
        res.status(500).json({ error: 'Conversion failed.' });
    }
});

// Organize PDF (rotate, delete, reorder) with multi-source support
app.post('/api/organize', async (req, res) => {
    try {
        const { fileId, operations, pages } = req.body;
        
        const mainFilePath = path.join(UPLOAD_DIR, `${fileId}.pdf`);
        if (!fs.existsSync(mainFilePath)) {
            return res.status(404).json({ error: 'File not found.' });
        }
        
        const newPdf = await PDFDocument.create();
        
        // Cache loaded PDFs
        const pdfCache = new Map();
        
        // Load main PDF
        const mainPdfBytes = fs.readFileSync(mainFilePath);
        const mainPdf = await PDFDocument.load(mainPdfBytes);
        pdfCache.set(fileId, mainPdf);
        
        // If pages array is provided (multi-source mode)
        if (pages && Array.isArray(pages)) {
            for (const pageInfo of pages) {
                if (pageInfo.deleted) continue;
                
                const sourceFileId = pageInfo.sourceFile || fileId;
                let sourcePdf = pdfCache.get(sourceFileId);
                
                // Load source PDF if not cached
                if (!sourcePdf) {
                    const sourcePath = path.join(UPLOAD_DIR, `${sourceFileId}.pdf`);
                    if (fs.existsSync(sourcePath)) {
                        const sourceBytes = fs.readFileSync(sourcePath);
                        sourcePdf = await PDFDocument.load(sourceBytes);
                        pdfCache.set(sourceFileId, sourcePdf);
                    } else {
                        continue; // Skip if source not found
                    }
                }
                
                const [page] = await newPdf.copyPages(sourcePdf, [pageInfo.index]);
                
                if (pageInfo.rotation) {
                    page.setRotation(degrees(pageInfo.rotation));
                }
                
                newPdf.addPage(page);
            }
        } else {
            // Legacy mode: single source with operations
            const { order, rotations = {}, deletions = [] } = operations || {};
            const pageOrder = order || mainPdf.getPageIndices();
            
            for (const pageIndex of pageOrder) {
                if (deletions.includes(pageIndex)) continue;
                
                const [page] = await newPdf.copyPages(mainPdf, [pageIndex]);
                
                if (rotations[pageIndex]) {
                    page.setRotation(degrees(rotations[pageIndex]));
                }
                
                newPdf.addPage(page);
            }
        }
        
        const outputBytes = await newPdf.save();
        const outputId = uuidv4();
        const outputPath = path.join(OUTPUT_DIR, `${outputId}.pdf`);
        fs.writeFileSync(outputPath, outputBytes);
        
        const expiry = trackFile(outputPath, 'output');
        
        // Get source file name for output naming
        const sourceInfo = fileTracker.get(mainFilePath);
        const baseName = (sourceInfo?.originalName || 'document').replace(/\.pdf$/i, '');
        
        res.json({
            success: true,
            fileId: outputId,
            filename: `organized_${baseName}.pdf`,
            size: outputBytes.length,
            pageCount: newPdf.getPageCount(),
            expiry
        });
    } catch (error) {
        console.error('Organize error:', error);
        res.status(500).json({ error: 'Organization failed.' });
    }
});

// Get PDF info
app.get('/api/pdf-info/:fileId', async (req, res) => {
    try {
        const { fileId } = req.params;
        const filePath = path.join(UPLOAD_DIR, `${fileId}.pdf`);
        
        if (!fs.existsSync(filePath)) {
            return res.status(404).json({ error: 'File not found.' });
        }
        
        const pdfBytes = fs.readFileSync(filePath);
        const pdf = await PDFDocument.load(pdfBytes);
        
        const pages = [];
        for (let i = 0; i < pdf.getPageCount(); i++) {
            const page = pdf.getPage(i);
            const { width, height } = page.getSize();
            const rotation = page.getRotation().angle;
            pages.push({ index: i, width, height, rotation });
        }
        
        res.json({
            success: true,
            pageCount: pdf.getPageCount(),
            pages
        });
    } catch (error) {
        console.error('PDF info error:', error);
        res.status(500).json({ error: 'Failed to get PDF info.' });
    }
});

// Download file
app.get('/api/download/:fileId', (req, res) => {
    const { fileId } = req.params;
    const filename = req.query.filename || 'document.pdf';
    
    // Check output directory first, then upload directory
    let filePath = path.join(OUTPUT_DIR, `${fileId}.pdf`);
    if (!fs.existsSync(filePath)) {
        filePath = path.join(UPLOAD_DIR, `${fileId}.pdf`);
    }
    
    if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: 'File not found or expired.' });
    }
    
    res.download(filePath, filename);
});

// Delete file manually
app.delete('/api/delete/:fileId', (req, res) => {
    const { fileId } = req.params;
    
    const paths = [
        path.join(OUTPUT_DIR, `${fileId}.pdf`),
        path.join(UPLOAD_DIR, `${fileId}.pdf`),
        path.join(UPLOAD_DIR, `${fileId}.jpg`),
        path.join(UPLOAD_DIR, `${fileId}.jpeg`),
        path.join(UPLOAD_DIR, `${fileId}.png`)
    ];
    
    let deleted = false;
    for (const filePath of paths) {
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
            fileTracker.delete(filePath);
            deleted = true;
        }
    }
    
    if (deleted) {
        res.json({ success: true, message: 'File deleted.' });
    } else {
        res.status(404).json({ error: 'File not found.' });
    }
});

// Get file expiry info
app.get('/api/expiry/:fileId', (req, res) => {
    const { fileId } = req.params;
    
    for (const [filePath, data] of fileTracker.entries()) {
        if (filePath.includes(fileId)) {
            const remainingMs = data.expiry - Date.now();
            return res.json({
                success: true,
                expiry: data.expiry,
                remainingSeconds: Math.max(0, Math.floor(remainingMs / 1000))
            });
        }
    }
    
    res.status(404).json({ error: 'File not found.' });
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error('Server error:', err);
    
    if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
            return res.status(400).json({ error: 'File too large. Maximum size is 50MB.' });
        }
        if (err.code === 'LIMIT_FILE_COUNT') {
            return res.status(400).json({ error: 'Too many files. Maximum is 50 files.' });
        }
    }
    
    res.status(500).json({ error: 'Internal server error.' });
});

app.listen(PORT, () => {
    console.log(`🚀 Secure PDF Utility Suite running on http://localhost:${PORT}`);
    console.log(`📁 Upload directory: ${UPLOAD_DIR}`);
    console.log(`📁 Output directory: ${OUTPUT_DIR}`);
    console.log(`⏰ Files auto-delete after ${FILE_EXPIRY_MS / 1000 / 60} minutes`);
});
