import type { ChatMessage, LlmAdapter } from '../types/index.ts';
import { normalizeArticleNumber } from './statuteParser.ts';

export interface QueryRewriteResult {
  originalQuery: string;
  rewrittenQuery: string;
  rewriteUsed: boolean;
  exactArticles: string[];
}

const COLLOQUIAL_LEGAL_SYNONYMS: Array<{ patterns: string[]; expansions: string }> = [
  {
    patterns: ['房东', '租客', '租房', '赶我走', '收房', '退租', '房租'],
    expansions: '租赁合同 出租人 承租人 不定期租赁 违约责任 提前解除合同'
  },
  {
    patterns: ['押金', '保证金', '定金', '不退'],
    expansions: '押金 返还 定金 违约责任 担保'
  },
  {
    patterns: ['辞退', '开除', '裁员', '踢走', '解除劳动', '不给赔偿', 'N+1', 'n+1'],
    expansions: '劳动合同 解除 终止 经济补偿 赔偿金 违法解除 第四十七条 第四十八条 第八十七条'
  },
  {
    patterns: ['试用期', '转正', '不合适'],
    expansions: '试用期 录用条件 劳动合同解除 违法解除'
  },
  {
    patterns: ['欠薪', '拖欠工资', '不发工资', '加班费'],
    expansions: '劳动报酬 工资 拖欠 加班工资 经济补偿'
  },
  {
    patterns: ['没签合同', '未签劳动合同', '双倍工资'],
    expansions: '书面劳动合同 二倍工资 第十条 第八十二条'
  },
  {
    patterns: ['违约', '毁约', '不按约定', '赔钱'],
    expansions: '违约责任 继续履行 采取补救措施 赔偿损失 第五百七十七条'
  },
  {
    patterns: ['借钱', '欠钱', '借条', '不还钱', '催款'],
    expansions: '借款合同 民间借贷 利息 逾期还款'
  },
  {
    patterns: ['网购', '假货', '欺诈', '退款'],
    expansions: '买卖合同 消费者 欺诈 撤销 违约责任'
  },
  {
    patterns: ['离婚', '孩子抚养', '分财产', '彩礼'],
    expansions: '婚姻家庭 离婚 夫妻共同财产 子女抚养'
  }
];

/**
 * 提取查询文本中显式包含的法典条号，并统一生成“第X条”双向规范锚点。
 */
export function extractExactArticles(text: string): string[] {
  const matches = text.match(/第\s*[零〇一二两三四五六七八九十百千万0-9]+\s*条/g) || [];
  const results = new Set<string>();
  for (const m of matches) {
    const norm = normalizeArticleNumber(m);
    results.add(norm.articleNumNorm);
    results.add(norm.articleNumber);
  }
  return Array.from(results);
}

/**
 * 本地口语-法言同义映射扩展，支持离线零延时改写。
 */
export function expandColloquialLegalTerms(query: string): { expanded: string; matched: boolean } {
  const extraParts: string[] = [];
  for (const entry of COLLOQUIAL_LEGAL_SYNONYMS) {
    if (entry.patterns.some((p) => query.includes(p))) {
      extraParts.push(entry.expansions);
    }
  }
  const exact = extractExactArticles(query);
  if (exact.length > 0) {
    extraParts.push(exact.join(' '));
  }

  if (extraParts.length === 0) {
    return { expanded: query, matched: false };
  }
  return {
    expanded: `${query} ${extraParts.join(' ')}`.trim(),
    matched: true
  };
}

/**
 * 口语案情法律化改写器：结合近 3 轮对话上下文调用 LLM 改写（3 秒超时熔断并自动降级为本地法律同义词扩展）。
 */
export class QueryRewriter {
  private readonly llmAdapter?: LlmAdapter;

  constructor(llmAdapter?: LlmAdapter) {
    this.llmAdapter = llmAdapter;
  }

  public async rewrite(
    query: string,
    recentMessages: ChatMessage[],
    timeoutMs = 3000
  ): Promise<QueryRewriteResult> {
    const cleanQuery = query.trim();
    const exactArticles = extractExactArticles(cleanQuery);
    const local = expandColloquialLegalTerms(cleanQuery);

    if (!this.llmAdapter) {
      return {
        originalQuery: cleanQuery,
        rewrittenQuery: local.expanded,
        rewriteUsed: local.matched || exactArticles.length > 0,
        exactArticles
      };
    }

    try {
      const historyLines = recentMessages
        .slice(-6)
        .map((m) => `${m.role === 'user' ? '咨询人' : '助手'}: ${m.content.slice(0, 180)}`)
        .join('\n');

      const rewritten = await this.llmAdapter.complete({
        systemPrompt:
          '你是中国法律检索 Query 改写器。请根据历史对话将咨询人的口语问题提取出最精准的3~8个中国法律规范检索词（如法律关系、案由、请求权、条号），仅输出一行空格分隔的关键词，不要解释。',
        messages: [
          {
            role: 'user',
            content: historyLines ? `历史上下文:\n${historyLines}\n当前问题:\n${cleanQuery}` : cleanQuery
          }
        ],
        temperature: 0.1,
        timeoutMs
      });

      const trimmed = rewritten.replace(/[\r\n]+/g, ' ').trim();
      if (trimmed) {
        return {
          originalQuery: cleanQuery,
          rewrittenQuery: `${cleanQuery} ${trimmed} ${exactArticles.join(' ')}`.trim(),
          rewriteUsed: true,
          exactArticles
        };
      }
    } catch {
      // 超时或外部模型异常时无缝降级至本地口语法律词扩展，不阻塞检索主链路
    }

    return {
      originalQuery: cleanQuery,
      rewrittenQuery: local.expanded,
      rewriteUsed: local.matched || exactArticles.length > 0,
      exactArticles
    };
  }
}
