import type { RetrievalHit, RetrievalMetrics } from '../types/index.ts';
import { normalizeArticleNumber } from './statuteParser.ts';

export interface EthicsCheckResult {
  allowed: boolean;
  reason?: string;
}

export interface CoverageCheckResult {
  covered: boolean;
  reason?: string;
}

export interface CitationValidationResult {
  sanitizedText: string;
  validChunkIds: string[];
  interceptedDetails: string[];
  hadHallucination: boolean;
  fallbackToCardsOnly: boolean;
}

const ILLEGAL_INTENT_PATTERNS: RegExp[] = [
  /(?:如何|怎么|怎样|教我|帮我|帮忙).{0,14}(?:伪造|造假|变造|做假|篡改).{0,16}(?:合同|证据|借条|考勤|病假|公章|发票|流水)/,
  /(?:如何|怎么|怎样|教我|帮我).{0,14}(?:转移|隐匿|藏匿).{0,12}(?:财产|资产).{0,12}(?:逃避|对抗|躲避).{0,10}(?:执行|债务|法院|查封)/,
  /(?:如何|怎么|怎样|教我|帮我).{0,12}(?:偷税|漏税|逃税|洗钱|贿赂|行贿|作伪证|做假证|敲诈|勒索)/,
  /(?:帮我|教我)(?:写|拟定|制作).{0,8}(?:虚假|假冒|阴阳).{0,10}(?:合同|协议|证明)/
];

const VICTIM_DEFENSE_CONTEXT = /(?:对方|老板|公司|房东|他|她|前夫|前妻|原告|被告|别人).{0,12}(?:逼我|强迫|威胁|伪造|篡改|拿假)|(?:怎么维权|如何维权|怎么举报|怎么反驳|怎么应对|怎么办)/;

/**
 * 三重防幻觉与伦理合规门控引擎：
 * 1. 前置伦理拦截：拦截教唆违法与伪造证据，同时放行受害方合法维权咨询；
 * 2. 检索覆盖门控：低于相关性硬阈值时诚实拒答；
 * 3. 后置白名单校验：剔除虚构 [CITE:xxx] 标记及未在召回池内的虚构“第X条”。
 */
export class HallucinationGuard {
  public checkEthics(query: string): EthicsCheckResult {
    const clean = query.replace(/\s+/g, '');
    for (const pat of ILLEGAL_INTENT_PATTERNS) {
      if (pat.test(clean)) {
        // 如果明显属于受害人询问如何应对他人违法/强迫行为（且非询问“教我如何伪造/转移财产”），放行
        const isSelfPerpetratorQuery = /(?:怎么|如何|教我|帮我)(?:伪造|造假|隐匿|转移|偷税|逃税|做假|作伪证)/.test(clean);
        if (!isSelfPerpetratorQuery && VICTIM_DEFENSE_CONTEXT.test(clean)) {
          continue;
        }
        return {
          allowed: false,
          reason:
            '抱歉，我无法为您提供涉及违法违规操作、伪造证据或逃避法定责任的建议。若您遇到合法权益受损情况，请描述真实客观事实并通过合法途径维权。'
        };
      }
    }
    return { allowed: true };
  }

  public checkCoverage(
    hits: RetrievalHit[],
    metrics: RetrievalMetrics,
    threshold = 0.34
  ): CoverageCheckResult {
    if (!hits || hits.length === 0) {
      return {
        covered: false,
        reason:
          '当前已启用的法典知识库中暂未检索到与您问题直接相关的权威依据。为确保法条引用零幻觉，系统已拒绝凭空推测作答，请检查启用范围或补充上传对应法律法规。'
      };
    }

    const hasExactMatch = hits.some((h) => h.exactArticleMatch);
    const maxVector = Math.max(...hits.map((h) => h.vectorScore));
    const hasBm25 = metrics.bm25Hits > 0 && hits.some((h) => h.bm25Rank > 0);

    // If neither exact article match nor meaningful vector similarity nor strong BM25 overlap
    if (!hasExactMatch && maxVector < threshold && (!hasBm25 || maxVector < 0.22)) {
      return {
        covered: false,
        reason:
          '当前已启用的法典知识库对您咨询的问题覆盖度不足（检索相关性低于安全门限）。为严守法条零幻觉原则，系统无法给出无依据推断，建议补充上传相应领域的法律法规后重试。'
      };
    }

    return { covered: true };
  }

  public validateGeneratedCitations(rawText: string, allowedHits: RetrievalHit[]): CitationValidationResult {
    const allowedMap = new Map(allowedHits.map((h) => [h.chunk.id, h]));
    const allowedNormArticles = new Set<string>();
    for (const h of allowedHits) {
      if (h.chunk.articleNumNorm) allowedNormArticles.add(h.chunk.articleNumNorm);
      if (h.chunk.articleNumber) allowedNormArticles.add(h.chunk.articleNumber);
    }

    const validChunkIds: string[] = [];
    const validSet = new Set<string>();
    const interceptedDetails: string[] = [];

    // 1. Validate [CITE:chunk_id] tokens
    let sanitized = rawText.replace(/\[CITE:([^\]]+)\]/g, (_full, idRaw: string) => {
      const id = idRaw.trim();
      if (allowedMap.has(id)) {
        if (!validSet.has(id)) {
          validSet.add(id);
          validChunkIds.push(id);
        }
        return `[CITE:${id}]`;
      }
      interceptedDetails.push(`非法/越界引用标记 [CITE:${id}]`);
      return '';
    });

    // 2. Scan for fabricated "第X条" not present in retrieved whitelist
    const lines = sanitized.split('\n');
    const keptLines: string[] = [];
    for (const line of lines) {
      const artMatches = line.match(/第\s*[零〇一二两三四五六七八九十百千万0-9]+\s*条/g) || [];
      let lineInvalidArt: string | null = null;
      for (const rawArt of artMatches) {
        const norm = normalizeArticleNumber(rawArt);
        if (
          allowedNormArticles.size > 0 &&
          !allowedNormArticles.has(norm.articleNumNorm) &&
          !allowedNormArticles.has(norm.articleNumber)
        ) {
          lineInvalidArt = rawArt;
          break;
        }
      }
      if (lineInvalidArt) {
        interceptedDetails.push(`拦截未在召回池内的法条表述: ${lineInvalidArt}`);
        // Remove the sentence containing the fabricated article number
        const cleanedSentences = line
          .split(/(?<=[。！？；])/)
          .filter((s) => !s.includes(lineInvalidArt!))
          .join('')
          .trim();
        if (cleanedSentences) {
          keptLines.push(cleanedSentences);
        }
      } else {
        keptLines.push(line);
      }
    }

    sanitized = keptLines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    const hadHallucination = interceptedDetails.length > 0;
    const fallbackToCardsOnly =
      hadHallucination && validChunkIds.length === 0 && sanitized.replace(/\s+/g, '').length < 20;

    return {
      sanitizedText: sanitized,
      validChunkIds,
      interceptedDetails,
      hadHallucination,
      fallbackToCardsOnly
    };
  }
}
