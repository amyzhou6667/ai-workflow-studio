import { LexRagError, type EmbeddingAdapter, type ModelEndpointConfig } from '../types/index.ts';
import { normalizeArticleNumber } from './statuteParser.ts';

export const LOCAL_EMBEDDING_DIMENSION = 256;

const LEGAL_SEMANTIC_CLUSTERS: Array<{ id: string; terms: string[]; weight: number }> = [
  { id: 'cluster_breach', terms: ['违约', '履行', '补救', '赔偿损失', '违约金', '合同义务', '不履行'], weight: 2.2 },
  { id: 'cluster_lease', terms: ['租赁', '出租人', '承租人', '房东', '租客', '租期', '不定期租赁', '押金', '转租', '维修'], weight: 2.4 },
  { id: 'cluster_labor_term', terms: ['劳动合同', '解除', '辞退', '开除', '终止', '经济补偿', '赔偿金', '二倍', '第四十七条', '第四十八条', '第八十七条'], weight: 2.5 },
  { id: 'cluster_wage', terms: ['工资', '薪酬', '欠薪', '加班', '报酬', '拖欠', '试用期'], weight: 2.3 },
  { id: 'cluster_tort', terms: ['侵权', '损害赔偿', '过错', '人身损害', '财产损害', '医疗费', '误工费'], weight: 2.2 },
  { id: 'cluster_loan', terms: ['借款', '借条', '欠款', '利息', '民间借贷', '本金', '逾期', '还款'], weight: 2.2 },
  { id: 'cluster_marriage', terms: ['婚姻', '离婚', '夫妻共同财产', '抚养权', '彩礼', '继承', '遗产', '遗嘱'], weight: 2.2 },
  { id: 'cluster_consumer', terms: ['消费者', '网购', '退货', '欺诈', '三倍赔偿', '定金', '买卖合同', '质量'], weight: 2.2 },
  { id: 'cluster_privacy', terms: ['个人信息', '隐私', '肖像权', '名誉权', '泄露'], weight: 2.0 }
];

function fnv1aHash(token: string, seed = 2166136261): number {
  let hash = seed;
  for (let i = 0; i < token.length; i++) {
    hash ^= token.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/**
 * 确定性 256 维本地法律语义特征向量：结合字符 Bigram、双格式归一化条号与核心法律语义簇映射，
 * 在离线或未配置外部 Embedding API 时保证稳定的语义检索精度。
 */
export function createLocalSemanticEmbedding(text: string): number[] {
  const vec = new Array<number>(LOCAL_EMBEDDING_DIMENSION).fill(0);
  const cleaned = text.replace(/[\s\p{P}\p{S}]+/gu, ' ').trim().toLowerCase();
  if (!cleaned) return vec;

  const addFeature = (feat: string, weight: number) => {
    const h1 = fnv1aHash(feat, 2166136261) % LOCAL_EMBEDDING_DIMENSION;
    const h2 = fnv1aHash(feat, 16777619) % LOCAL_EMBEDDING_DIMENSION;
    const sign = (fnv1aHash(feat, 97) & 1) === 0 ? 1 : -1;
    vec[h1] += weight * sign;
    vec[h2] += weight * 0.5;
  };

  // 1. CJK bigrams and alphanumeric tokens
  const parts = cleaned.split(/\s+/);
  for (const part of parts) {
    if (!part) continue;
    if (/^[a-z0-9_]+$/.test(part)) {
      addFeature(`w:${part}`, 1.2);
      continue;
    }
    const chars = Array.from(part);
    for (let i = 0; i < chars.length; i++) {
      addFeature(`c1:${chars[i]}`, 0.35);
      if (i + 1 < chars.length) {
        addFeature(`c2:${chars[i]}${chars[i + 1]}`, 1.0);
      }
      if (i + 2 < chars.length) {
        addFeature(`c3:${chars[i]}${chars[i + 1]}${chars[i + 2]}`, 0.8);
      }
    }
  }

  // 2. Article number dual-normalization anchoring
  const artMatches = text.match(/第\s*[零〇一二两三四五六七八九十百千万0-9]+\s*条/g) || [];
  for (const rawArt of artMatches) {
    const norm = normalizeArticleNumber(rawArt);
    addFeature(`art:${norm.articleNumNorm}`, 3.2);
    addFeature(`art:${norm.articleNumber}`, 2.5);
  }

  // 3. Shared legal concept cluster anchors
  for (const cluster of LEGAL_SEMANTIC_CLUSTERS) {
    let hitCount = 0;
    for (const term of cluster.terms) {
      if (text.includes(term)) hitCount++;
    }
    if (hitCount > 0) {
      addFeature(`sem:${cluster.id}`, cluster.weight * Math.min(2, 1 + hitCount * 0.25));
    }
  }

  // L2 Normalize
  let normSq = 0;
  for (let i = 0; i < vec.length; i++) {
    normSq += vec[i] * vec[i];
  }
  const norm = Math.sqrt(normSq);
  if (norm > 0) {
    for (let i = 0; i < vec.length; i++) {
      vec[i] = Number((vec[i] / norm).toFixed(6));
    }
  }
  return vec;
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (!a.length || !b.length || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 可配置 OpenAI 兼容 Embedding 适配器（单批 20 条，支持 3 次指数退避重试；未配置外部 Key/URL 时使用离线向量引擎）。
 */
export class ConfigurableEmbeddingAdapter implements EmbeddingAdapter {
  private readonly getConfig: () => ModelEndpointConfig;
  private lastDimension = LOCAL_EMBEDDING_DIMENSION;

  constructor(getConfig: () => ModelEndpointConfig) {
    this.getConfig = getConfig;
  }

  public isExternal(): boolean {
    const cfg = this.getConfig();
    return Boolean(cfg.baseUrl?.trim() && cfg.model?.trim() && (cfg.apiKey?.trim() || cfg.baseUrl.includes('localhost') || cfg.baseUrl.includes('127.0.0.1')));
  }

  public getDimension(): number {
    return this.lastDimension;
  }

  public async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const cfg = this.getConfig();

    if (!this.isExternal()) {
      this.lastDimension = LOCAL_EMBEDDING_DIMENSION;
      return texts.map((t) => createLocalSemanticEmbedding(t));
    }

    const endpoint = `${cfg.baseUrl.replace(/\/+$/, '')}/embeddings`;
    const batchSize = 20;
    const allVectors: number[][] = [];

    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize);
      const vectors = await this.requestWithRetry(endpoint, cfg, batch);
      for (const v of vectors) {
        this.lastDimension = v.length;
        allVectors.push(v);
      }
    }

    return allVectors;
  }

  private async requestWithRetry(
    endpoint: string,
    cfg: ModelEndpointConfig,
    input: string[]
  ): Promise<number[][]> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), cfg.timeoutMs || 15000);
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {})
          },
          body: JSON.stringify({ model: cfg.model, input }),
          signal: controller.signal
        });
        clearTimeout(timer);

        if (!res.ok) {
          const text = await res.text().catch(() => '');
          throw new LexRagError('EMBEDDING_UNAVAILABLE', `Embedding HTTP ${res.status}: ${text.slice(0, 200)}`, 502);
        }
        const json = (await res.json()) as { data?: Array<{ index: number; embedding: number[] }> };
        if (!json?.data || json.data.length !== input.length) {
          throw new LexRagError('EMBEDDING_UNAVAILABLE', 'Embedding 接口返回结构不完整', 502);
        }
        return json.data.sort((a, b) => a.index - b.index).map((item) => item.embedding);
      } catch (err) {
        clearTimeout(timer);
        lastError = err;
        if (attempt < 2) {
          await sleep(150 * Math.pow(2, attempt));
        }
      }
    }
    throw lastError instanceof LexRagError
      ? lastError
      : new LexRagError('EMBEDDING_UNAVAILABLE', `Embedding 调用失败: ${String(lastError)}`, 502);
  }
}
