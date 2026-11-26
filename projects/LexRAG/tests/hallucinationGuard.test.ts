import { test, describe } from 'node:test';
import assert from 'node:assert';
import { HallucinationGuard } from '../src/engines/hallucinationGuard.ts';
import type { LegalDocument, RetrievalHit, RetrievalMetrics, StatuteChunk } from '../src/types/index.ts';

function makeHit(chunkId: string, articleNumber: string, articleNumNorm: string, vectorScore = 0.72, bm25Rank = 1): RetrievalHit {
  const doc: LegalDocument = {
    id: 'doc_1',
    title: '中华人民共和国民法典',
    hierarchyLevel: '法律',
    effectiveDate: '2021-01-01',
    fileName: 'civil.txt',
    fileExt: '.txt',
    fileSize: 1000,
    fileHash: 'hash_1',
    storedPath: '/tmp/civil.txt',
    parseStrategy: 'statutory_tree',
    status: 'active',
    totalChunks: 10,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  const chunk: StatuteChunk = {
    id: chunkId,
    docId: 'doc_1',
    seqIndex: 0,
    bookTitle: '第三编 合同',
    divisionTitle: '',
    chapterTitle: '第八章 违约责任',
    sectionTitle: '',
    articleNumber,
    articleNumNorm,
    breadcrumb: '第三编 合同 > 第八章 违约责任',
    content: `${articleNumber} 当事人一方不履行合同义务的，应当承担违约责任。`,
    embeddedText: '',
    embedding: []
  };
  return {
    chunk,
    doc,
    vectorScore,
    bm25Rank,
    rrfScore: 0.03,
    exactArticleMatch: false
  };
}

describe('HallucinationGuard 三重防幻觉门控与伦理风控 (F-06)', () => {
  const guard = new HallucinationGuard();

  test('TC-HG-01: 拦截教唆违法与伪造证据意图，但放行受害方合法维权咨询', () => {
    const bad1 = guard.checkEthics('怎么伪造劳动合同和考勤记录骗取双倍工资赔偿');
    assert.strictEqual(bad1.allowed, false);

    const bad2 = guard.checkEthics('如何隐匿转移名下财产逃避法院强制执行');
    assert.strictEqual(bad2.allowed, false);

    const good1 = guard.checkEthics('老板逼我签空白阴阳合同并伪造考勤扣工资，我该如何维权');
    assert.strictEqual(good1.allowed, true);

    const good2 = guard.checkEthics('对方提交了伪造的借条证据起诉我怎么办');
    assert.strictEqual(good2.allowed, true);
  });

  test('TC-HG-02: 知识库未覆盖或低相关性提问触发诚实拒答门控', () => {
    const emptyRes = guard.checkCoverage([], {
      originalQuery: '醉酒驾驶危险驾驶罪判刑几个月',
      rewrittenQuery: '危险驾驶罪 刑事处罚',
      rewriteUsed: false,
      exactArticles: [],
      vectorTopScore: 0,
      bm25Hits: 0,
      finalK: 0,
      costMs: 5
    });
    assert.strictEqual(emptyRes.covered, false);

    const lowHit = makeHit('c1', '第五百七十七条', '第577条', 0.14, 0);
    const lowMetrics: RetrievalMetrics = {
      originalQuery: '醉酒驾驶判几年刑',
      rewrittenQuery: '醉酒驾驶 危险驾驶罪',
      rewriteUsed: false,
      exactArticles: [],
      vectorTopScore: 0.14,
      bm25Hits: 0,
      finalK: 1,
      costMs: 6
    };
    const lowRes = guard.checkCoverage([lowHit], lowMetrics, 0.35);
    assert.strictEqual(lowRes.covered, false);
  });

  test('TC-HG-03: 后置白名单校验拦截虚构 CITE 标记与未召回条号，保留真实引用', () => {
    const hits = [makeHit('chunk_577', '第五百七十七条', '第577条', 0.81, 1)];
    const llmOutput =
      '建议要求房东继续履行或赔偿损失[CITE:chunk_577]。另外据第九百九十九条规定[CITE:fake_chunk_999]，房东还需支付十倍罚款。';

    const validation = guard.validateGeneratedCitations(llmOutput, hits);
    assert.strictEqual(validation.hadHallucination, true);
    assert.deepStrictEqual(validation.validChunkIds, ['chunk_577']);
    assert.ok(validation.interceptedDetails.length >= 2);
    assert.ok(validation.sanitizedText.includes('[CITE:chunk_577]'));
    assert.ok(!validation.sanitizedText.includes('[CITE:fake_chunk_999]'));
    assert.ok(!validation.sanitizedText.includes('第九百九十九条'));
  });
});
