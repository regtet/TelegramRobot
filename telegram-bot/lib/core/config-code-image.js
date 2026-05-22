const fs = require('fs');
const path = require('path');
const os = require('os');
const sharp = require('sharp');

const CODE_THEME = 'github-dark';
const TITLE_COLOR = '#e6edf3';
const CANVAS_BG = '#0d1117';
const SECTION_GAP = 20;

let highlighterPromise = null;

async function getJsHighlighter() {
    if (!highlighterPromise) {
        highlighterPromise = (async () => {
            const { getSingletonHighlighter } = await import('shiki');
            return getSingletonHighlighter({
                themes: [CODE_THEME],
                langs: ['javascript'],
            });
        })();
    }
    return highlighterPromise;
}

function escapeXml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/** 等宽字宽（仅用于估算画布宽度，不用于定位） */
function estimateLineWidth(text, fontSize) {
    const mono = fontSize * 0.62;
    let w = 0;
    for (const ch of String(text)) {
        w += ch.charCodeAt(0) > 255 ? fontSize : mono;
    }
    return w;
}

/**
 * @returns {Promise<{ svg: string, width: number, height: number }>}
 */
async function codeToSvgDocument(code, title) {
    const highlighter = await getJsHighlighter();
    const { tokens, bg } = highlighter.codeToTokens(code, {
        lang: 'javascript',
        theme: CODE_THEME,
    });

    const fontSize = 13;
    const lineHeight = 20;
    const padX = 14;
    const titleHeight = title ? 36 : 12;
    const lines = tokens.length;
    const height = titleHeight + lines * lineHeight + 20;

    let maxWidth = 400;
    const textNodes = [];

    let y = titleHeight;
    for (const line of tokens) {
        const tspans = [];
        let linePlain = '';
        for (const token of line) {
            const content = token.content || '';
            if (!content) continue;
            const color = token.color || '#c9d1d9';
            linePlain += content;
            tspans.push(`<tspan fill="${color}">${escapeXml(content)}</tspan>`);
        }
        if (tspans.length > 0) {
            textNodes.push(
                `<text x="${padX}" y="${y}" font-family="Consolas, 'Courier New', monospace" font-size="${fontSize}" xml:space="preserve">${tspans.join('')}</text>`,
            );
            maxWidth = Math.max(maxWidth, padX + estimateLineWidth(linePlain, fontSize) + padX);
        }
        y += lineHeight;
    }

    const width = Math.min(Math.max(maxWidth, 520), 1400);
    const titleEl = title
        ? `<text x="${padX}" y="24" font-family="Segoe UI, Microsoft YaHei, sans-serif" font-size="14" font-weight="600" fill="${TITLE_COLOR}">${escapeXml(title)}</text>`
        : '';

    const fill = bg || CANVAS_BG;
    const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
  <rect width="100%" height="100%" fill="${fill}"/>
  ${titleEl}
  ${textNodes.join('\n  ')}
</svg>`;

    return { svg, width, height };
}

async function svgDocumentToPngBuffer(svgDoc) {
    return sharp(Buffer.from(svgDoc.svg)).png().toBuffer();
}

/**
 * 横向（左右）拼接多张 PNG，高度不一致时垂直居中
 * @param {Buffer[]} buffers
 */
async function stitchPngBuffersHorizontally(buffers) {
    if (buffers.length === 0) {
        throw new Error('没有可拼接的截图');
    }
    if (buffers.length === 1) {
        return buffers[0];
    }

    const metas = await Promise.all(buffers.map((b) => sharp(b).metadata()));
    const totalWidth =
        metas.reduce((sum, m) => sum + (m.width || 0), 0) + SECTION_GAP * (buffers.length - 1);
    const height = Math.max(...metas.map((m) => m.height || 0));

    const composites = [];
    let left = 0;
    for (let i = 0; i < buffers.length; i++) {
        const h = metas[i].height || 0;
        const top = Math.max(0, Math.floor((height - h) / 2));
        composites.push({ input: buffers[i], top, left });
        left += (metas[i].width || 0) + SECTION_GAP;
    }

    return sharp({
        create: {
            width: totalWidth,
            height,
            channels: 4,
            background: CANVAS_BG,
        },
    })
        .composite(composites)
        .png()
        .toBuffer();
}

async function renderSourceFileToPng(filePath, options = {}) {
    const content = fs.readFileSync(filePath, 'utf8');
    const baseName = path.basename(filePath);
    const title = options.title || baseName;

    const svgDoc = await codeToSvgDocument(content, title);
    const outPath = path.join(
        os.tmpdir(),
        `pack-config-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`,
    );

    await sharp(Buffer.from(svgDoc.svg)).png().toFile(outPath);
    return outPath;
}

/**
 * 生成 config.js + server.js 左右拼接为一张暗黑主题 PNG
 * @returns {Promise<string|null>} 临时 png 路径，无文件时返回 null
 */
async function renderConfigScreenshots(projectPath, meta) {
    const files = [
        { rel: 'src/config/config.js', label: 'config.js' },
        { rel: 'src/config/server.js', label: 'server.js' },
    ];

    const pngBuffers = [];
    for (const f of files) {
        const full = path.join(projectPath, f.rel);
        if (!fs.existsSync(full)) continue;
        const title = `${meta.projectLabel} · ${meta.branchName} · ${f.label}`;
        const content = fs.readFileSync(full, 'utf8');
        const svgDoc = await codeToSvgDocument(content, title);
        pngBuffers.push(await svgDocumentToPngBuffer(svgDoc));
    }

    if (pngBuffers.length === 0) return null;

    const merged = await stitchPngBuffersHorizontally(pngBuffers);
    const outPath = path.join(
        os.tmpdir(),
        `pack-config-merged-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`,
    );
    await sharp(merged).toFile(outPath);
    return outPath;
}

function tryUnlinkPngs(pngPaths) {
    const list = Array.isArray(pngPaths) ? pngPaths : pngPaths ? [pngPaths] : [];
    for (const p of list) {
        try {
            if (p && fs.existsSync(p)) fs.unlinkSync(p);
        } catch {
            // ignore
        }
    }
}

module.exports = {
    renderSourceFileToPng,
    renderConfigScreenshots,
    tryUnlinkPngs,
};
