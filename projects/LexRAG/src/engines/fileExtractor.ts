import crypto from 'node:crypto';
import path from 'node:path';
import zlib from 'node:zlib';
import { LexRagError, type ExtractedFileResult } from '../types/index.ts';

export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
export const SUPPORTED_EXTENSIONS = ['.txt', '.md', '.docx', '.pdf'] as const;

/**
 * 计算文件内容 SHA-256 摘要，用于秒级去重。
 */
export function computeSha256(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/**
 * 探测文本编码（UTF-8 BOM / 严格 UTF-8 / GB18030 中文编码自动回退）。
 */
export function decodeChineseTextBuffer(buffer: Buffer): string {
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return buffer.subarray(3).toString('utf-8');
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    return new TextDecoder('gb18030', { fatal: false }).decode(buffer);
  }
}

function decodeXmlEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex) => String.fromCodePoint(parseInt(hex, 16)));
}

function findEndOfCentralDirectory(buffer: Buffer): number {
  const minOffset = Math.max(0, buffer.length - 65557);
  for (let i = buffer.length - 22; i >= minOffset; i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      return i;
    }
  }
  return -1;
}

/**
 * 通过解析 ZIP Central Directory 准确读取 word/document.xml，避免 bit 3 Data Descriptor 导致 local header size 为 0 的问题。
 */
export function extractDocxText(buffer: Buffer): string {
  if (buffer.length < 22 || buffer[0] !== 0x50 || buffer[1] !== 0x4b) {
    throw new LexRagError('MAGIC_MISMATCH', '文件魔数校验失败：非有效 DOCX/ZIP 文档', 400);
  }
  const eocdOffset = findEndOfCentralDirectory(buffer);
  if (eocdOffset < 0) {
    throw new LexRagError('MAGIC_MISMATCH', 'DOCX 结构损坏：未找到 ZIP 中央目录结束标记', 400);
  }

  const totalEntries = buffer.readUInt16LE(eocdOffset + 10);
  const cdOffset = buffer.readUInt32LE(eocdOffset + 16);

  let cursor = cdOffset;
  let xmlString = '';

  for (let i = 0; i < totalEntries && cursor + 46 <= buffer.length; i++) {
    if (buffer.readUInt32LE(cursor) !== 0x02014b50) {
      break;
    }
    const compressionMethod = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const fileNameLen = buffer.readUInt16LE(cursor + 28);
    const extraLen = buffer.readUInt16LE(cursor + 30);
    const commentLen = buffer.readUInt16LE(cursor + 32);
    const localHeaderOffset = buffer.readUInt32LE(cursor + 42);
    const entryName = buffer.subarray(cursor + 46, cursor + 46 + fileNameLen).toString('utf-8');

    if (entryName === 'word/document.xml') {
      if (localHeaderOffset + 30 > buffer.length || buffer.readUInt32LE(localHeaderOffset) !== 0x04034b50) {
        throw new LexRagError('MAGIC_MISMATCH', 'DOCX 内部文件头无效', 400);
      }
      const localNameLen = buffer.readUInt16LE(localHeaderOffset + 26);
      const localExtraLen = buffer.readUInt16LE(localHeaderOffset + 28);
      const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen;
      const compressedSlice = buffer.subarray(dataStart, dataStart + compressedSize);

      const rawBytes =
        compressionMethod === 0
          ? compressedSlice
          : compressionMethod === 8
            ? zlib.inflateRawSync(compressedSlice)
            : (() => {
                throw new LexRagError('UNSUPPORTED_FORMAT', `不支持的 DOCX 压缩方式: ${compressionMethod}`, 400);
              })();

      xmlString = rawBytes.toString('utf-8');
      break;
    }

    cursor += 46 + fileNameLen + extraLen + commentLen;
  }

  if (!xmlString) {
    throw new LexRagError('INVALID_INPUT', 'DOCX 缺少正文 word/document.xml', 400);
  }

  const paragraphs: string[] = [];
  const pRegex = /<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g;
  let pMatch: RegExpExecArray | null;
  while ((pMatch = pRegex.exec(xmlString)) !== null) {
    const pInner = pMatch[1].replace(/<w:br\b[^>]*\/>/g, '\n');
    const texts: string[] = [];
    const tRegex = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g;
    let tMatch: RegExpExecArray | null;
    while ((tMatch = tRegex.exec(pInner)) !== null) {
      texts.push(decodeXmlEntities(tMatch[1]));
    }
    const line = texts.join('').trim();
    if (line) {
      paragraphs.push(line);
    }
  }

  return paragraphs.join('\n');
}

interface PdfObjectEntry {
  dictStr: string;
  rawObjStr: string;
  streamBuf: Buffer | null;
}

interface PdfFontInfo {
  cmap: Map<number, string> | null;
  isTwoByte: boolean;
}

function unescapePdfLiteralBytes(raw: string): Buffer {
  const bytes: number[] = [];
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    if (code === 0x5c && i + 1 < raw.length) {
      const next = raw[i + 1];
      if (next === 'n') {
        bytes.push(0x0a);
        i++;
      } else if (next === 'r') {
        bytes.push(0x0d);
        i++;
      } else if (next === 't') {
        bytes.push(0x09);
        i++;
      } else if (next === 'b') {
        bytes.push(0x08);
        i++;
      } else if (next === 'f') {
        bytes.push(0x0c);
        i++;
      } else if (next === '(' || next === ')' || next === '\\') {
        bytes.push(next.charCodeAt(0));
        i++;
      } else if (next === '\r' && raw[i + 2] === '\n') {
        i += 2;
      } else if (next === '\n' || next === '\r') {
        i++;
      } else if (/[0-7]/.test(next)) {
        const octMatch = raw.slice(i + 1, i + 4).match(/^[0-7]{1,3}/);
        if (octMatch) {
          bytes.push(parseInt(octMatch[0], 8) & 0xff);
          i += octMatch[0].length;
        }
      } else {
        bytes.push(next.charCodeAt(0));
        i++;
      }
    } else {
      bytes.push(code & 0xff);
    }
  }
  return Buffer.from(bytes);
}

function parseSingleToUnicodeCMap(cmapStr: string): Map<number, string> {
  const cmap = new Map<number, string>();
  if (!cmapStr.includes('beginbfchar') && !cmapStr.includes('beginbfrange')) {
    return cmap;
  }

  for (const block of cmapStr.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const pair of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) {
      const srcCid = parseInt(pair[1], 16);
      const dstHex = pair[2];
      const codePoints: number[] = [];
      for (let i = 0; i + 3 < dstHex.length; i += 4) {
        codePoints.push(parseInt(dstHex.slice(i, i + 4), 16));
      }
      if (codePoints.length > 0) {
        cmap.set(srcCid, String.fromCharCode(...codePoints));
      }
    }
  }

  for (const block of cmapStr.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    // Form 1: <start> <end> <baseUnicode>
    for (const entry of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) {
      const start = parseInt(entry[1], 16);
      const end = parseInt(entry[2], 16);
      const base = parseInt(entry[3], 16);
      const span = Math.min(end - start, 4096);
      for (let offset = 0; offset <= span; offset++) {
        cmap.set(start + offset, String.fromCharCode(base + offset));
      }
    }
    // Form 2: <start> <end> [ <u1> <u2> ... ]
    for (const entry of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*\[([\s\S]*?)\]/g)) {
      const start = parseInt(entry[1], 16);
      const hexList = Array.from(entry[3].matchAll(/<([0-9a-fA-F]+)>/g));
      hexList.forEach((h, idx) => {
        const dstHex = h[1];
        const cps: number[] = [];
        for (let i = 0; i + 3 < dstHex.length; i += 4) {
          cps.push(parseInt(dstHex.slice(i, i + 4), 16));
        }
        if (cps.length > 0) {
          cmap.set(start + idx, String.fromCharCode(...cps));
        }
      });
    }
  }

  return cmap;
}

function parsePdfObjects(buffer: Buffer, latinText: string): Map<number, PdfObjectEntry> {
  const objMap = new Map<number, PdfObjectEntry>();
  const objRe = /(\d+)\s+(\d+)\s+obj\b/g;
  let m: RegExpExecArray | null;

  while ((m = objRe.exec(latinText)) !== null) {
    const objNum = Number(m[1]);
    const bodyStart = m.index + m[0].length;
    const endObjIdx = latinText.indexOf('endobj', bodyStart);
    if (endObjIdx < 0) continue;

    const rawObjStr = latinText.slice(bodyStart, endObjIdx);
    const streamIdx = rawObjStr.indexOf('stream');
    let dictStr = rawObjStr;
    let streamBuf: Buffer | null = null;

    if (streamIdx >= 0) {
      dictStr = rawObjStr.slice(0, streamIdx);
      const absStreamPos = bodyStart + streamIdx + 6;
      const nlLen =
        latinText[absStreamPos] === '\r' && latinText[absStreamPos + 1] === '\n'
          ? 2
          : latinText[absStreamPos] === '\n' || latinText[absStreamPos] === '\r'
            ? 1
            : 0;
      const dataStart = absStreamPos + nlLen;
      const absEndStream = latinText.indexOf('endstream', dataStart);
      if (absEndStream > dataStart) {
        let dataEnd = absEndStream;
        if (latinText[dataEnd - 1] === '\n') dataEnd--;
        if (latinText[dataEnd - 1] === '\r') dataEnd--;
        const slice = buffer.subarray(dataStart, dataEnd);
        try {
          streamBuf = /\/FlateDecode\b/.test(dictStr) ? zlib.inflateSync(slice) : slice;
        } catch {
          streamBuf = null;
        }
      }
    }

    objMap.set(objNum, { dictStr, rawObjStr, streamBuf });
  }

  // Unpack PDF 1.5+ /ObjStm compressed objects if present
  for (const [, entry] of Array.from(objMap.entries())) {
    if (/\/Type\s*\/ObjStm\b/.test(entry.dictStr) && entry.streamBuf) {
      const firstMatch = entry.dictStr.match(/\/First\s+(\d+)/);
      const nMatch = entry.dictStr.match(/\/N\s+(\d+)/);
      if (!firstMatch || !nMatch) continue;
      const firstOffset = Number(firstMatch[1]);
      const objCount = Number(nMatch[1]);
      const stmStr = entry.streamBuf.toString('latin1');
      const headerNums = stmStr.slice(0, firstOffset).trim().split(/\s+/).map(Number);
      for (let i = 0; i < objCount && i * 2 + 1 < headerNums.length; i++) {
        const innerId = headerNums[i * 2];
        const relOff = headerNums[i * 2 + 1];
        const start = firstOffset + relOff;
        const nextRel = i + 1 < objCount && (i + 1) * 2 + 1 < headerNums.length ? firstOffset + headerNums[(i + 1) * 2 + 1] : stmStr.length;
        const innerStr = stmStr.slice(start, nextRel).trim();
        if (!objMap.has(innerId)) {
          objMap.set(innerId, { dictStr: innerStr, rawObjStr: innerStr, streamBuf: null });
        }
      }
    }
  }

  return objMap;
}

function buildFontInfoMap(objMap: Map<number, PdfObjectEntry>): Map<number, PdfFontInfo> {
  const fontInfoMap = new Map<number, PdfFontInfo>();
  for (const [objNum, obj] of objMap) {
    if (!/\/Type\s*\/Font\b/.test(obj.dictStr)) continue;
    const toUniMatch = obj.dictStr.match(/\/ToUnicode\s+(\d+)\s+\d+\s+R/);
    const isTwoByte = /Identity-[HV]/.test(obj.dictStr) || /\/Subtype\s*\/Type0\b/.test(obj.dictStr);
    let cmap: Map<number, string> | null = null;
    if (toUniMatch) {
      const cmapObj = objMap.get(Number(toUniMatch[1]));
      if (cmapObj?.streamBuf) {
        const parsed = parseSingleToUnicodeCMap(cmapObj.streamBuf.toString('latin1'));
        if (parsed.size > 0) cmap = parsed;
      }
    }
    fontInfoMap.set(objNum, { cmap, isTwoByte });
  }
  return fontInfoMap;
}

function decodePdfBytesWithFont(byteBuf: Buffer, fontInfo: PdfFontInfo | null): string {
  if (fontInfo?.cmap && fontInfo.cmap.size > 0) {
    if (fontInfo.isTwoByte && byteBuf.length >= 2 && byteBuf.length % 2 === 0) {
      let out = '';
      for (let i = 0; i + 1 < byteBuf.length; i += 2) {
        const cid = (byteBuf[i] << 8) | byteBuf[i + 1];
        out += fontInfo.cmap.get(cid) ?? '';
      }
      return out;
    }
    let out = '';
    for (let i = 0; i < byteBuf.length; i++) {
      out += fontInfo.cmap.get(byteBuf[i]) ?? String.fromCharCode(byteBuf[i]);
    }
    return out;
  }

  if (byteBuf.length >= 2 && byteBuf[0] === 0xfe && byteBuf[1] === 0xff) {
    let str = '';
    for (let i = 2; i + 1 < byteBuf.length; i += 2) {
      str += String.fromCharCode((byteBuf[i] << 8) | byteBuf[i + 1]);
    }
    return str;
  }

  return byteBuf.toString('utf-8');
}

function normalizePdfLineSpacing(line: string): string {
  return line
    .replace(/[ \t]+/g, ' ')
    .replace(/([\u4e00-\u9fff])\s+([，。、；：？！）】》”’])/g, '$1$2')
    .replace(/([（【《“‘])\s+([\u4e00-\u9fff])/g, '$1$2')
    .replace(/([，。、；：？！])\s+([\u4e00-\u9fff])/g, '$1$2')
    .trim();
}

function extractLinesFromPdfContentStream(
  content: string,
  localFonts: Map<string, PdfFontInfo>
): string[] {
  const lines: string[] = [];
  const opRe =
    /\/([A-Za-z0-9_+-]+)\s+[\d.-]+\s+Tf|([\d.-]+)\s+([\d.-]+)\s+T[dD]|[\d.-]+\s+[\d.-]+\s+[\d.-]+\s+[\d.-]+\s+([\d.-]+)\s+([\d.-]+)\s+Tm|\(((?:\\.|[^\\)])*)\)\s*(?:Tj|')|<([0-9a-fA-F\s]+)>\s*Tj|\[([\s\S]*?)\]\s*TJ|T\*|\bET\b/g;

  let curFont: PdfFontInfo | null = null;
  let curTmY = 0;
  let lastY: number | null = null;
  let curLine = '';

  const flushLine = () => {
    const cleaned = normalizePdfLineSpacing(curLine);
    if (cleaned) lines.push(cleaned);
    curLine = '';
  };

  let m: RegExpExecArray | null;
  while ((m = opRe.exec(content)) !== null) {
    if (m[1]) {
      curFont = localFonts.get(m[1]) ?? null;
    } else if (m[4] !== undefined) {
      const nextTmY = parseFloat(m[5]);
      if (lastY !== null && nextTmY !== 0 && Math.abs(nextTmY - lastY) > 2) {
        flushLine();
      }
      curTmY = nextTmY;
      if (nextTmY !== 0) lastY = nextTmY;
    } else if (m[2] !== undefined) {
      const ty = parseFloat(m[3]);
      const y = curTmY + ty;
      if (lastY !== null && Math.abs(y - lastY) > 2) {
        flushLine();
      } else if (curLine && !curLine.endsWith(' ')) {
        curLine += ' ';
      }
      lastY = y;
    } else if (m[0] === 'T*' || m[0] === 'ET') {
      flushLine();
      if (m[0] === 'ET') {
        curTmY = 0;
        lastY = null;
      }
    } else if (m[6] !== undefined) {
      curLine += decodePdfBytesWithFont(unescapePdfLiteralBytes(m[6]), curFont);
    } else if (m[7] !== undefined) {
      const cleanHex = m[7].replace(/\s+/g, '');
      if (cleanHex.length >= 2) {
        curLine += decodePdfBytesWithFont(Buffer.from(cleanHex, 'hex'), curFont);
      }
    } else if (m[8] !== undefined) {
      for (const sub of m[8].matchAll(/\(((?:\\.|[^\\)])*)\)|<([0-9a-fA-F\s]+)>/g)) {
        if (sub[1] !== undefined) {
          curLine += decodePdfBytesWithFont(unescapePdfLiteralBytes(sub[1]), curFont);
        } else if (sub[2] !== undefined) {
          const cleanHex = sub[2].replace(/\s+/g, '');
          if (cleanHex.length >= 2) {
            curLine += decodePdfBytesWithFont(Buffer.from(cleanHex, 'hex'), curFont);
          }
        }
      }
    }
  }

  flushLine();
  return lines;
}

function resolvePageLocalFonts(
  pageObj: PdfObjectEntry,
  objMap: Map<number, PdfObjectEntry>,
  fontInfoMap: Map<number, PdfFontInfo>
): Map<string, PdfFontInfo> {
  const localFonts = new Map<string, PdfFontInfo>();
  let resStr = pageObj.rawObjStr;
  const resRef = pageObj.dictStr.match(/\/Resources\s+(\d+)\s+\d+\s+R/);
  if (resRef) {
    resStr = objMap.get(Number(resRef[1]))?.rawObjStr || resStr;
  }
  const fontDictRef = resStr.match(/\/Font\s+(\d+)\s+\d+\s+R/);
  const fontSearchTarget = fontDictRef ? objMap.get(Number(fontDictRef[1]))?.rawObjStr || resStr : resStr;

  for (const fm of fontSearchTarget.matchAll(/\/([A-Za-z0-9_+-]+)\s+(\d+)\s+\d+\s+R/g)) {
    const info = fontInfoMap.get(Number(fm[2]));
    if (info) {
      localFonts.set(fm[1], info);
    }
  }
  return localFonts;
}

/**
 * 抽取文字版 PDF 文本层并拦截加密文档及无文字层纯图片扫描件 PDF。
 */
export function extractPdfText(buffer: Buffer): { text: string; pageCount: number } {
  const header = buffer.subarray(0, Math.min(16, buffer.length)).toString('latin1');
  if (!header.includes('%PDF-')) {
    throw new LexRagError('MAGIC_MISMATCH', '文件魔数校验失败：非有效 PDF 文档', 400);
  }

  const latinText = buffer.toString('latin1');
  if (/\/Encrypt\b/.test(latinText)) {
    throw new LexRagError('ENCRYPTED_PDF', '检测到该 PDF 受密码加密保护，请解密后再上传', 422);
  }

  const objMap = parsePdfObjects(buffer, latinText);
  const fontInfoMap = buildFontInfoMap(objMap);

  const pageEntries = Array.from(objMap.values()).filter((o) => /\/Type\s*\/Page\b(?!s)/.test(o.dictStr));
  const pageCount = Math.max(1, pageEntries.length);

  const allLines: string[] = [];
  for (const pageObj of pageEntries) {
    const localFonts = resolvePageLocalFonts(pageObj, objMap, fontInfoMap);

    const contentIds: number[] = [];
    const singleRef = pageObj.dictStr.match(/\/Contents\s+(\d+)\s+\d+\s+R/);
    if (singleRef) {
      contentIds.push(Number(singleRef[1]));
    } else {
      const arrayRef = pageObj.dictStr.match(/\/Contents\s*\[([\s\S]*?)\]/);
      if (arrayRef) {
        for (const r of arrayRef[1].matchAll(/(\d+)\s+\d+\s+R/g)) {
          contentIds.push(Number(r[1]));
        }
      }
    }

    for (const cid of contentIds) {
      const cObj = objMap.get(cid);
      if (!cObj?.streamBuf) continue;
      const stm = cObj.streamBuf.toString('latin1');
      if (stm.includes('BT') && stm.includes('ET')) {
        allLines.push(...extractLinesFromPdfContentStream(stm, localFonts));
      }
    }
  }

  // Fallback for synthetic single-stream PDFs without /Contents indirect references
  if (allLines.length === 0) {
    for (const entry of objMap.values()) {
      if (!entry.streamBuf) continue;
      const stm = entry.streamBuf.toString('latin1');
      if (stm.includes('BT') && stm.includes('ET')) {
        allLines.push(...extractLinesFromPdfContentStream(stm, new Map()));
      }
    }
  }

  const fullText = allLines.join('\n').trim();
  const effectiveChars = fullText.replace(/[^\p{L}\p{N}]/gu, '').length;
  if (effectiveChars / pageCount < 15) {
    throw new LexRagError(
      'SCANNED_PDF_REJECTED',
      '检测到该 PDF 缺少可提取文本层（疑似纯图片扫描件），当前版本不支持扫描件 OCR，请转换为文字版 PDF、DOCX 或 TXT 后重新上传。',
      422,
      { pageCount, effectiveChars }
    );
  }

  return { text: fullText, pageCount };
}

/**
 * 统一入口：对上传的法典二进制内容执行安全门控、格式检验、编码转码与正文提取。
 */
export function extractTextFromBuffer(fileName: string, buffer: Buffer): ExtractedFileResult {
  if (!fileName || !fileName.trim()) {
    throw new LexRagError('INVALID_INPUT', '文件名不能为空', 400);
  }
  if (!buffer || buffer.length === 0) {
    throw new LexRagError('EMPTY_FILE', '上传文件内容为空（0 字节），无法入库', 400);
  }
  if (buffer.length > MAX_UPLOAD_BYTES) {
    throw new LexRagError('FILE_TOO_LARGE', `文件大小超出 50MB 限制（当前 ${(buffer.length / 1024 / 1024).toFixed(2)} MB）`, 413);
  }

  const fileExt = path.extname(fileName).toLowerCase();
  if (!SUPPORTED_EXTENSIONS.includes(fileExt as (typeof SUPPORTED_EXTENSIONS)[number])) {
    throw new LexRagError(
      'UNSUPPORTED_FORMAT',
      `不支持的文件格式 "${fileExt}"，仅支持 .txt / .md / .docx / 文字版 .pdf`,
      400
    );
  }

  const fileHash = computeSha256(buffer);
  let text = '';
  let pageCount: number | undefined;

  if (fileExt === '.txt' || fileExt === '.md') {
    text = decodeChineseTextBuffer(buffer).trim();
    if (!text) {
      throw new LexRagError('EMPTY_FILE', '文本文件内容全为空白字符，请核对后上传', 400);
    }
  } else if (fileExt === '.docx') {
    text = extractDocxText(buffer).trim();
    if (!text) {
      throw new LexRagError('EMPTY_FILE', 'DOCX 文档未提取到有效段落文字', 400);
    }
  } else if (fileExt === '.pdf') {
    const pdf = extractPdfText(buffer);
    text = pdf.text;
    pageCount = pdf.pageCount;
  }

  return {
    fileName,
    fileExt,
    fileSize: buffer.length,
    fileHash,
    text,
    pageCount
  };
}
