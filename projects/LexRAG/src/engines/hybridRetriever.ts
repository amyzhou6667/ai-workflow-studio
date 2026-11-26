import type { ChatMessage, EmbeddingAdapter, RetrievalHit, RetrievalMetrics } from '../types/index.ts';
import type { SqliteStore } from '../storage/sqliteStore.ts';
import { cosineSimilarity } from './embeddingService.ts';
import type { QueryRewriter } from './queryRewriter.ts';

/**
 * 向量语义 Top-15 + SQLite FTS5 BM25 Top-15 + 精确条号强加权 + RRF (k=60) 混合检索引擎。
 */
export class HybridRetriever {
  private readonly store: SqliteStore;
  private readonly embeddingAdapter: EmbeddingAdapter;
  private readonly queryRewriter: QueryRewriter;

  constructor(
    store: SqliteStore,
    embeddingAdapter: EmbeddingAdapter,
    queryRewriter: QueryRewriter
  ) {
    this.store = store;
    this.embeddingAdapter = embeddingAdapter;
    this.queryRewriter = queryRewriter;
  }

  public async retrieve(params: {
    query: string;
    recentMessages?: ChatMessage[];
    scopedDocIds?: string[];
    topK?: number;
  }): Promise<{ hits: RetrievalHit[]; metrics: RetrievalMetrics }> {
    const startMs = Date.now();
    const topK = params.topK ?? 8;

    const rewriteRes = await this.queryRewriter.rewrite(params.query, params.recentMessages || []);
    const activeEntries = this.store.getActiveChunks(params.scopedDocIds);

    if (activeEntries.length === 0) {
      return {
        hits: [],
        metrics: {
          originalQuery: rewriteRes.originalQuery,
          rewrittenQuery: rewriteRes.rewrittenQuery,
          rewriteUsed: rewriteRes.rewriteUsed,
          exactArticles: rewriteRes.exactArticles,
          vectorTopScore: 0,
          bm25Hits: 0,
          finalK: 0,
          costMs: Date.now() - startMs
        }
      };
    }

    // 1. Vector semantic retrieval (degrade gracefully to empty vector ranking if external embedding fails)
    let vectorScored: Array<{ chunkId: string; score: number }> = [];
    try {
      const [queryVec] = await this.embeddingAdapter.embedBatch([rewriteRes.rewrittenQuery]);
      if (queryVec && queryVec.length > 0) {
        vectorScored = activeEntries
          .map((entry) => ({
            chunkId: entry.chunk.id,
            score: cosineSimilarity(queryVec, entry.chunk.embedding)
          }))
          .sort((a, b) => b.score - a.score)
          .slice(0, 15);
      }
    } catch {
      vectorScored = [];
    }

    // 2. FTS5 BM25 retrieval
    const ftsResults = this.store.searchFts(rewriteRes.rewrittenQuery, params.scopedDocIds, 15);

    // Build lookup maps
    const entryMap = new Map(activeEntries.map((e) => [e.chunk.id, e]));
    const vectorRankMap = new Map<string, { rank: number; score: number }>();
    vectorScored.forEach((v, idx) => vectorRankMap.set(v.chunkId, { rank: idx + 1, score: v.score }));

    const ftsRankMap = new Map<string, number>();
    ftsResults.forEach((f) => ftsRankMap.set(f.chunkId, f.rank));

    const exactSet = new Set(rewriteRes.exactArticles);
    const candidateIds = new Set<string>([
      ...vectorScored.map((v) => v.chunkId),
      ...ftsResults.map((f) => f.chunkId)
    ]);

    // Ensure exact article numbers inside active scope are always included in candidate pool
    if (exactSet.size > 0) {
      for (const entry of activeEntries) {
        if (exactSet.has(entry.chunk.articleNumNorm) || exactSet.has(entry.chunk.articleNumber)) {
          candidateIds.add(entry.chunk.id);
        }
      }
    }

    const rrfK = 60;
    const hits: RetrievalHit[] = [];

    for (const chunkId of candidateIds) {
      const entry = entryMap.get(chunkId);
      if (!entry) continue;

      const vecInfo = vectorRankMap.get(chunkId);
      const bm25Rank = ftsRankMap.get(chunkId) ?? 0;
      const exactArticleMatch =
        exactSet.size > 0 &&
        (exactSet.has(entry.chunk.articleNumNorm) || exactSet.has(entry.chunk.articleNumber));

      let rrfScore = 0;
      if (vecInfo) rrfScore += 1 / (rrfK + vecInfo.rank);
      if (bm25Rank > 0) rrfScore += 1 / (rrfK + bm25Rank);
      if (exactArticleMatch) rrfScore += 0.25;

      // Also compute direct cosine fallback score if not in top 15 vector list
      const vecScore = vecInfo?.score ?? 0;

      hits.push({
        chunk: entry.chunk,
        doc: entry.doc,
        vectorScore: Number(vecScore.toFixed(4)),
        bm25Rank,
        rrfScore: Number(rrfScore.toFixed(6)),
        exactArticleMatch
      });
    }

    hits.sort((a, b) => {
      if (a.exactArticleMatch !== b.exactArticleMatch) {
        return a.exactArticleMatch ? -1 : 1;
      }
      return b.rrfScore - a.rrfScore;
    });

    const finalHits = hits.slice(0, topK);
    const vectorTopScore = finalHits.length > 0 ? Math.max(...finalHits.map((h) => h.vectorScore)) : 0;

    return {
      hits: finalHits,
      metrics: {
        originalQuery: rewriteRes.originalQuery,
        rewrittenQuery: rewriteRes.rewrittenQuery,
        rewriteUsed: rewriteRes.rewriteUsed,
        exactArticles: rewriteRes.exactArticles,
        vectorTopScore,
        bm25Hits: ftsResults.length,
        finalK: finalHits.length,
        costMs: Date.now() - startMs
      }
    };
  }
}
