import type { HierarchyLevel, ParseResult, ParsedChunkDraft } from '../types/index.ts';

const CN_DIGITS: Record<string, number> = {
  零: 0,
  〇: 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9
};

const CN_UNITS: Record<string, number> = {
  十: 10,
  百: 100,
  千: 1000,
  万: 10000
};

const NUM_TO_CN_CHAR = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];

/**
 * 将中文条号数字（如 "五百七十七" / "一千二百六十" / "十八"）转换为阿拉伯数字。
 */
export function chineseToArabic(raw: string): number {
  const cleaned = raw.trim();
  if (/^\d+$/.test(cleaned)) {
    return parseInt(cleaned, 10);
  }

  let total = 0;
  let section = 0;
  let currentDigit = 0;

  for (const ch of cleaned) {
    if (ch in CN_DIGITS) {
      currentDigit = CN_DIGITS[ch];
    } else if (ch in CN_UNITS) {
      const unit = CN_UNITS[ch];
      if (unit === 10000) {
        section = (section + currentDigit) * unit;
        total += section;
        section = 0;
        currentDigit = 0;
      } else {
        if (currentDigit === 0 && unit === 10 && section === 0) {
          currentDigit = 1;
        }
        section += currentDigit * unit;
        currentDigit = 0;
      }
    }
  }

  return total + section + currentDigit;
}

/**
 * 将正整数转换为规范中文法典条号数字（如 577 -> "五百七十七", 105 -> "一百零五"）。
 */
export function arabicToChinese(num: number): string {
  if (num <= 0 || !Number.isInteger(num)) {
    return String(num);
  }
  if (num >= 10000) {
    const wan = Math.floor(num / 10000);
    const rest = num % 10000;
    const wanPart = `${arabicToChinese(wan)}万`;
    if (rest === 0) return wanPart;
    const restStr = arabicToChinese(rest);
    return rest < 1000 ? `${wanPart}零${restStr}` : `${wanPart}${restStr}`;
  }

  const units = ['', '十', '百', '千'];
  const digits = String(num).split('').map(Number);
  const len = digits.length;
  let out = '';
  let zeroPending = false;

  for (let i = 0; i < len; i++) {
    const d = digits[i];
    const unitIdx = len - 1 - i;
    if (d === 0) {
      if (out.length > 0) zeroPending = true;
    } else {
      if (zeroPending) {
        out += '零';
        zeroPending = false;
      }
      if (d === 1 && unitIdx === 1 && out === '') {
        out += '十';
      } else {
        out += NUM_TO_CN_CHAR[d] + units[unitIdx];
      }
    }
  }

  return out;
}

/**
 * 双向归一化法典条号，统一产出中文条号与阿拉伯数字条号。
 */
export function normalizeArticleNumber(rawArticle: string): {
  articleNumber: string;
  articleNumNorm: string;
} {
  const m = rawArticle.trim().match(/^第\s*([零〇一二两三四五六七八九十百千万0-9]+)\s*条$/);
  if (!m) {
    const trimmed = rawArticle.trim();
    return { articleNumber: trimmed, articleNumNorm: trimmed };
  }
  const num = chineseToArabic(m[1]);
  if (num <= 0) {
    return { articleNumber: rawArticle.trim(), articleNumNorm: rawArticle.trim() };
  }
  return {
    articleNumber: `第${arabicToChinese(num)}条`,
    articleNumNorm: `第${num}条`
  };
}

function cleanCjkSpacing(line: string): string {
  return line
    .replace(/[ \t]+/g, ' ')
    .replace(/([\u4e00-\u9fff])\s+([，。、；：？！）】》”’])/g, '$1$2')
    .replace(/([（【《“‘])\s+([\u4e00-\u9fff])/g, '$1$2')
    .replace(/([，。、；：？！])\s+([\u4e00-\u9fff])/g, '$1$2')
    .trim();
}

function stripDisclaimerFooter(text: string): string {
  return text.replace(/\*{2,}[\s\S]*?本信息仅供参考[\s\S]*?\*{2,}/g, '');
}

function reflowHardWrappedLines(lines: string[]): string {
  if (lines.length <= 1) return lines.join('\n').trim();
  const paragraphs: string[] = [lines[0]];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    const prev = paragraphs[paragraphs.length - 1];
    const prevEndsClause = /[。！？；：”’》）]$/.test(prev);
    const lineStartsItem = /^(?:（[一二三四五六七八九十百0-9]+）|\([0-9]+\)|[0-9]+[、.．])/.test(line);
    if (!prevEndsClause && !lineStartsItem) {
      paragraphs[paragraphs.length - 1] = `${prev}${line}`;
    } else {
      paragraphs.push(line);
    }
  }
  return paragraphs.join('\n').trim();
}

function isTocOrNoiseLine(line: string): boolean {
  if (/^目\s*录$/.test(line)) return true;
  if (/^\*{2,}/.test(line)) return true;
  if (/^第\s*[零〇一二两三四五六七八九十百千万0-9]+\s*[编章节条]/.test(line) && /[…\.·]{2,}\s*\d+$/.test(line)) {
    return true;
  }
  if (/^[-—\s]*\d+\s*[-—\s]*$/.test(line) && line.length <= 12) {
    return true;
  }
  return false;
}

function buildBreadcrumb(parts: {
  bookTitle: string;
  divisionTitle: string;
  chapterTitle: string;
  sectionTitle: string;
  articleNumber?: string;
}): string {
  const list = [
    parts.bookTitle,
    parts.divisionTitle,
    parts.chapterTitle,
    parts.sectionTitle,
    parts.articleNumber || ''
  ].filter(Boolean);
  return list.join(' > ');
}

function buildEmbeddedText(docTitle: string, hierarchyLevel: HierarchyLevel, breadcrumb: string, content: string): string {
  const pathPart = breadcrumb || '正文';
  return `【${docTitle} | ${hierarchyLevel} | ${pathPart}】\n${content}`;
}

function splitOverlongParagraphs(text: string, maxLen = 1500): string[] {
  if (text.length <= maxLen) return [text];

  const paragraphs = text.split(/\n+/).map((p) => p.trim()).filter(Boolean);
  const segments: string[] = [];
  let buffer = '';

  for (const p of paragraphs) {
    if (p.length > maxLen) {
      if (buffer) {
        segments.push(buffer);
        buffer = '';
      }
      for (let i = 0; i < p.length; i += maxLen) {
        segments.push(p.slice(i, i + maxLen));
      }
      continue;
    }

    if (!buffer) {
      buffer = p;
    } else if (buffer.length + 1 + p.length <= maxLen) {
      buffer += `\n${p}`;
    } else {
      segments.push(buffer);
      buffer = p;
    }
  }
  if (buffer) segments.push(buffer);
  return segments;
}

function parseSlidingWindowFallback(params: {
  docTitle: string;
  hierarchyLevel: HierarchyLevel;
  lines: string[];
}): ParseResult {
  const windowSize = 600;
  const overlap = 100;
  const step = windowSize - overlap;

  const chunks: ParsedChunkDraft[] = [];
  let seqIndex = 0;
  let currentHeading = '';
  let buffer = '';

  const flushBuffer = (heading: string, body: string) => {
    const cleanBody = body.trim();
    if (!cleanBody) return;

    if (cleanBody.length <= windowSize) {
      const breadcrumb = heading || '正文段落';
      chunks.push({
        seqIndex,
        bookTitle: '',
        divisionTitle: '',
        chapterTitle: heading,
        sectionTitle: '',
        articleNumber: `片段${seqIndex + 1}`,
        articleNumNorm: `片段${seqIndex + 1}`,
        breadcrumb,
        content: cleanBody,
        embeddedText: buildEmbeddedText(params.docTitle, params.hierarchyLevel, breadcrumb, cleanBody)
      });
      seqIndex++;
      return;
    }

    for (let start = 0; start < cleanBody.length; start += step) {
      const slice = cleanBody.slice(start, start + windowSize).trim();
      if (!slice) break;
      const breadcrumb = heading || '正文段落';
      chunks.push({
        seqIndex,
        bookTitle: '',
        divisionTitle: '',
        chapterTitle: heading,
        sectionTitle: '',
        articleNumber: `片段${seqIndex + 1}`,
        articleNumNorm: `片段${seqIndex + 1}`,
        breadcrumb,
        content: slice,
        embeddedText: buildEmbeddedText(params.docTitle, params.hierarchyLevel, breadcrumb, slice)
      });
      seqIndex++;
      if (start + windowSize >= cleanBody.length) break;
    }
  };

  for (const line of params.lines) {
    const headingMatch = line.match(/^#{1,4}\s+(.+)$/) || line.match(/^([一二三四五六七八九十]+、.+)$/);
    if (headingMatch && line.length <= 60) {
      if (buffer.trim()) {
        flushBuffer(currentHeading, buffer);
        buffer = '';
      }
      currentHeading = headingMatch[1].trim();
      buffer = `${line}\n`;
    } else {
      buffer += `${line}\n`;
      if (buffer.length >= windowSize * 1.5) {
        flushBuffer(currentHeading, buffer);
        buffer = buffer.slice(Math.max(0, buffer.length - overlap));
      }
    }
  }
  if (buffer.trim()) {
    flushBuffer(currentHeading, buffer);
  }

  return {
    parseStrategy: 'sliding_window',
    chunks
  };
}

/**
 * 解析法律法规正文：优先执行“编-分编-章-节-条”树状解析并注入面包屑前缀；
 * 若规范“第X条”少于 3 条则自动降级为段落滑动窗口切分。
 */
export function parseStatuteDocument(params: {
  docTitle: string;
  hierarchyLevel: HierarchyLevel;
  text: string;
}): ParseResult {
  const cleanedRaw = stripDisclaimerFooter(params.text);
  const rawLines = cleanedRaw
    .split(/\r?\n/)
    .map((l) => cleanCjkSpacing(l))
    .filter((l) => l.length > 0 && !isTocOrNoiseLine(l));

  // Detect frequency of "第X条" at line starts (ignoring TOC lines already filtered)
  const articleStartRegex = /^(第\s*[零〇一二两三四五六七八九十百千万0-9]+\s*条)(?:[\s　]+(.*))?$/;
  const articleMatchCount = rawLines.filter((l) => articleStartRegex.test(l)).length;

  if (articleMatchCount < 3) {
    return parseSlidingWindowFallback({
      docTitle: params.docTitle,
      hierarchyLevel: params.hierarchyLevel,
      lines: rawLines
    });
  }

  const bookRegex = /^第\s*[零〇一二两三四五六七八九十百千万0-9]+\s*编(?:\s+.*)?$/;
  const appendixRegex = /^附\s*则$/;
  const divisionRegex = /^第\s*[零〇一二两三四五六七八九十百千万0-9]+\s*分编(?:\s+.*)?$/;
  const chapterRegex = /^第\s*[零〇一二两三四五六七八九十百千万0-9]+\s*章(?:\s+.*)?$/;
  const sectionRegex = /^第\s*[零〇一二两三四五六七八九十百千万0-9]+\s*节(?:\s+.*)?$/;

  let bookTitle = '';
  let divisionTitle = '';
  let chapterTitle = '';
  let sectionTitle = '';

  let activeArticle: {
    bookTitle: string;
    divisionTitle: string;
    chapterTitle: string;
    sectionTitle: string;
    articleNumber: string;
    articleNumNorm: string;
    lines: string[];
  } | null = null;

  const chunks: ParsedChunkDraft[] = [];
  let seqIndex = 0;

  const flushActiveArticle = () => {
    if (!activeArticle) return;
    const fullContent = reflowHardWrappedLines(activeArticle.lines);
    if (!fullContent) {
      activeArticle = null;
      return;
    }

    const hierarchyPath = buildBreadcrumb({
      bookTitle: activeArticle.bookTitle,
      divisionTitle: activeArticle.divisionTitle,
      chapterTitle: activeArticle.chapterTitle,
      sectionTitle: activeArticle.sectionTitle
    });
    const fullBreadcrumb = buildBreadcrumb({
      bookTitle: activeArticle.bookTitle,
      divisionTitle: activeArticle.divisionTitle,
      chapterTitle: activeArticle.chapterTitle,
      sectionTitle: activeArticle.sectionTitle,
      articleNumber: activeArticle.articleNumber
    });

    const segments = splitOverlongParagraphs(fullContent, 1500);
    for (const seg of segments) {
      chunks.push({
        seqIndex,
        bookTitle: activeArticle.bookTitle,
        divisionTitle: activeArticle.divisionTitle,
        chapterTitle: activeArticle.chapterTitle,
        sectionTitle: activeArticle.sectionTitle,
        articleNumber: activeArticle.articleNumber,
        articleNumNorm: activeArticle.articleNumNorm,
        breadcrumb: hierarchyPath || activeArticle.articleNumber,
        content: seg,
        embeddedText: buildEmbeddedText(params.docTitle, params.hierarchyLevel, fullBreadcrumb, seg)
      });
      seqIndex++;
    }
    activeArticle = null;
  };

  for (const line of rawLines) {
    if (bookRegex.test(line)) {
      flushActiveArticle();
      bookTitle = line;
      divisionTitle = '';
      chapterTitle = '';
      sectionTitle = '';
      continue;
    }
    if (appendixRegex.test(line)) {
      flushActiveArticle();
      bookTitle = '附则';
      divisionTitle = '';
      chapterTitle = '';
      sectionTitle = '';
      continue;
    }
    if (divisionRegex.test(line)) {
      flushActiveArticle();
      divisionTitle = line;
      chapterTitle = '';
      sectionTitle = '';
      continue;
    }
    if (chapterRegex.test(line)) {
      flushActiveArticle();
      chapterTitle = line;
      sectionTitle = '';
      continue;
    }
    if (sectionRegex.test(line)) {
      flushActiveArticle();
      sectionTitle = line;
      continue;
    }

    const artMatch = line.match(articleStartRegex);
    if (artMatch) {
      flushActiveArticle();
      const norm = normalizeArticleNumber(artMatch[1]);
      activeArticle = {
        bookTitle,
        divisionTitle,
        chapterTitle,
        sectionTitle,
        articleNumber: norm.articleNumber,
        articleNumNorm: norm.articleNumNorm,
        lines: [line]
      };
      continue;
    }

    if (activeArticle) {
      activeArticle.lines.push(line);
    }
  }

  flushActiveArticle();

  return {
    parseStrategy: 'statutory_tree',
    chunks
  };
}
