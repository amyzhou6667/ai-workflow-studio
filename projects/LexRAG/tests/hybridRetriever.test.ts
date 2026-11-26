import { test, describe, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SqliteStore, tokenizeForFts } from '../src/storage/sqliteStore.ts';
import { ConfigurableEmbeddingAdapter } from '../src/engines/embeddingService.ts';
import { QueryRewriter } from '../src/engines/queryRewriter.ts';
import { HybridRetriever } from '../src/engines/hybridRetriever.ts';
import { parseStatuteDocument } from '../src/engines/statuteParser.ts';
import type { StatuteChunk } from '../src/types/index.ts';

describe('SqliteStore & HybridRetriever 混合检索与实时过滤 (F-02, F-03, F-05)', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lexrag-retriever-test-'));
  const store = new SqliteStore(path.join(tmpDir, 'lexrag.sqlite'), tmpDir);
  const embedder = new ConfigurableEmbeddingAdapter(() => store.getSettings().embedding);
  const rewriter = new QueryRewriter();
  const retriever = new HybridRetriever(store, embedder, rewriter);

  let civilDocId = '';
  let laborDocId = '';

  after(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function seedDoc(docId: string, title: string, rawText: string) {
    store.createDocument({
      id: docId,
      title,
      hierarchyLevel: '法律',
      effectiveDate: '2021-01-01',
      fileName: `${title}.txt`,
      fileExt: '.txt',
      fileSize: Buffer.byteLength(rawText),
      fileHash: `hash_${docId}`,
      storedPath: path.join(tmpDir, `${docId}.txt`),
      status: 'indexing'
    });
    const parsed = parseStatuteDocument({ docTitle: title, hierarchyLevel: '法律', text: rawText });
    const embeddings = await embedder.embedBatch(parsed.chunks.map((c) => c.embeddedText));
    const chunks: StatuteChunk[] = parsed.chunks.map((draft, idx) => ({
      id: `${docId}_c_${idx}`,
      docId,
      ...draft,
      embedding: embeddings[idx]
    }));
    store.replaceDocumentChunks(docId, chunks);
    store.updateDocumentStatus(docId, 'active', {
      parseStrategy: parsed.parseStrategy,
      totalChunks: chunks.length
    });
  }

  test('TC-HR-01: FTS5 中文二元分词及正反归一化条号索引构建', () => {
    const tokens = tokenizeForFts('第五百七十七条 第577条 违约责任 押金退还');
    assert.ok(tokens.includes('违约'));
    assert.ok(tokens.includes('第577条'));
    assert.ok(tokens.includes('第五百七十七条'));
  });

  test('TC-HR-02: 口语案情改写检索精准命中租赁违约与押金条文', async () => {
    civilDocId = 'doc_civil';
    await seedDoc(
      civilDocId,
      '中华人民共和国民法典',
      `
第三编 合同
第八章 违约责任
第五百七十七条 当事人一方不履行合同义务或者履行合同义务不符合约定的，应当承担继续履行、采取补救措施或者赔偿损失等违约责任。
第十四章 租赁合同
第七百零八条 出租人应当按照约定将租赁物交付承租人，并在租赁期限内保持租赁物符合约定的用途。
第七百一十二条 出租人应当履行租赁物的维修义务，但是当事人另有约定的除外。
第七百三十条 当事人对租赁期限没有约定或者约定不明确，依照本法第五百一十条的规定仍不能确定的，视为不定期租赁；当事人可以随时解除合同，但是应当在合理期限之前通知对方。
第七百三十四条 租赁期限届满，承租人继续使用租赁物，出租人没有提出异议的，原租赁合同继续有效，但是租赁期限为不定期。押金等担保条款约定应当返还。
`
    );

    laborDocId = 'doc_labor';
    await seedDoc(
      laborDocId,
      '中华人民共和国劳动合同法',
      `
第四章 劳动合同的解除和终止
第四十七条 经济补偿按劳动者在本单位工作的年限，每满一年支付一个月工资的标准向劳动者支付。
第四十八条 用人单位违反本法规定解除或者终止劳动合同，劳动者不要求继续履行劳动合同的，用人单位应当依照本法第八十七条规定支付赔偿金。
第八十七条 用人单位违反本法规定解除或者终止劳动合同的，应当依照本法第四十七条规定的经济补偿标准的二倍向劳动者支付赔偿金。
`
    );

    const { hits, metrics } = await retriever.retrieve({
      query: '房东租期没到就要赶我走还不退押金怎么办',
      topK: 5
    });

    assert.ok(hits.length > 0);
    assert.ok(metrics.rewriteUsed);
    assert.ok(
      hits.some((h) => h.doc.id === civilDocId && ['第577条', '第708条', '第730条', '第734条'].includes(h.chunk.articleNumNorm)),
      'Expected Civil Code lease/breach articles to be retrieved'
    );
  });

  test('TC-HR-03: 阿拉伯数字与中文数字精确条号查询均置顶命中目标条文', async () => {
    const res1 = await retriever.retrieve({ query: '民法典第577条怎么规定的', topK: 5 });
    assert.strictEqual(res1.hits[0].chunk.articleNumNorm, '第577条');
    assert.strictEqual(res1.hits[0].exactArticleMatch, true);

    const res2 = await retriever.retrieve({ query: '劳动合同法第八十七条赔偿标准', topK: 5 });
    assert.strictEqual(res2.hits[0].chunk.articleNumNorm, '第87条');
    assert.strictEqual(res2.hits[0].doc.id, laborDocId);
  });

  test('TC-HR-04: 实时停用文档与会话级 scopedDocIds 过滤立即生效', async () => {
    // Scope exclusively to labor law
    const scoped = await retriever.retrieve({
      query: '违约责任 赔偿损失 第577条',
      scopedDocIds: [laborDocId],
      topK: 5
    });
    assert.ok(scoped.hits.every((h) => h.doc.id === laborDocId));

    // Disable civil code without deleting or re-embedding
    store.updateDocumentStatus(civilDocId, 'disabled');
    const afterDisable = await retriever.retrieve({
      query: '房东租赁合同第577条',
      topK: 5
    });
    assert.ok(afterDisable.hits.every((h) => h.doc.id !== civilDocId));

    // Re-enable civil code
    store.updateDocumentStatus(civilDocId, 'active');
    const afterEnable = await retriever.retrieve({
      query: '第577条',
      topK: 5
    });
    assert.ok(afterEnable.hits.some((h) => h.doc.id === civilDocId && h.chunk.articleNumNorm === '第577条'));
  });
});
