import { test, describe, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SqliteStore } from '../src/storage/sqliteStore.ts';
import { ConfigurableEmbeddingAdapter } from '../src/engines/embeddingService.ts';
import { QueryRewriter } from '../src/engines/queryRewriter.ts';
import { HybridRetriever } from '../src/engines/hybridRetriever.ts';
import { HallucinationGuard } from '../src/engines/hallucinationGuard.ts';
import { ConsultationEngine } from '../src/engines/consultationEngine.ts';
import type { LlmAdapter } from '../src/types/index.ts';

describe('ConsultationEngine 三视角咨询、追问引导、快照与降级模式 (F-04, F-07, F-08, F-09)', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lexrag-consult-test-'));
  const store = new SqliteStore(path.join(tmpDir, 'lexrag.sqlite'), tmpDir);
  const embedder = new ConfigurableEmbeddingAdapter(() => store.getSettings().embedding);
  const rewriter = new QueryRewriter();
  const retriever = new HybridRetriever(store, embedder, rewriter);
  const guard = new HallucinationGuard();

  const laborLawText = `
第四章 劳动合同的解除和终止
第四十六条 有下列情形之一的，用人单位应当向劳动者支付经济补偿。
第四十七条 经济补偿按劳动者在本单位工作的年限，每满一年支付一个月工资的标准向劳动者支付。六个月以上不满一年的，按一年计算；不满六个月的，向劳动者支付半个月工资的经济补偿。
第四十八条 用人单位违反本法规定解除或者终止劳动合同，劳动者要求继续履行劳动合同的，用人单位应当继续履行；劳动者不要求继续履行劳动合同或者劳动合同已经不能继续履行的，用人单位应当依照本法第八十七条规定支付赔偿金。
第八十七条 用人单位违反本法规定解除或者终止劳动合同的，应当依照本法第四十七条规定的经济补偿标准的二倍向劳动者支付赔偿金。
第八十八条 用人单位有侮辱体罚强迫劳动情形的，依法给予行政处罚。
`;

  after(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('TC-CE-01: 入库真实法典并基于三大视角差异化输出，同时附带缺失要素主动追问', async () => {
    let lastPromptSeen = '';
    const mockLlm: LlmAdapter = {
      async complete({ systemPrompt, onToken }) {
        lastPromptSeen = systemPrompt;
        const firstChunkIdMatch = systemPrompt.match(/\[CITE:(doc_[^\]]+)\]/);
        const citeId = firstChunkIdMatch ? firstChunkIdMatch[1] : 'missing';
        let reply = '';
        if (systemPrompt.includes('大众普法')) {
          reply = `### 核心结论与定性\n公司无故辞退构成违法解除，您有权主张二倍经济补偿赔偿金[CITE:${citeId}]。\n### 分步行动建议\n1. 保留辞退通知与考勤。\n### 建议保留的证据清单\n1. 劳动合同及工资流水。`;
        } else if (systemPrompt.includes('企业合规')) {
          reply = `### 合规风险等级评估\n高风险：单方无据解除劳动合同将触发二倍赔偿金[CITE:${citeId}]。\n### 制度整改与操作建议\n完善绩效考核民主程序与书面送达流程。`;
        } else {
          reply = `### 请求权基础与法律关系定性\n请求权基础为《劳动合同法》第四十八条与第八十七条[CITE:${citeId}]。\n### 法定构成要件逐项拆解与事实涵摄\n1. 存在劳动关系；2. 用人单位缺乏法定解除事由。`;
        }
        onToken?.(reply);
        return reply;
      }
    };

    const engine = new ConsultationEngine(store, embedder, retriever, guard, mockLlm);
    const doc = await engine.ingestUploadedFile({
      fileName: '中华人民共和国劳动合同法.txt',
      buffer: Buffer.from(laborLawText, 'utf-8'),
      title: '中华人民共和国劳动合同法',
      hierarchyLevel: '法律',
      effectiveDate: '2013-07-01'
    });
    assert.strictEqual(doc.status, 'active');

    const session = store.createSession({
      clientId: 'client_a',
      title: '辞退赔偿咨询',
      personaMode: 'public'
    });

    const resPublic = await engine.consult({
      sessionId: session.id,
      clientId: 'client_a',
      query: '公司突然辞退我不给赔偿怎么办',
      personaMode: 'public'
    });
    assert.strictEqual(resPublic.assistantMessage.turnStatus, 'completed');
    assert.ok(lastPromptSeen.includes('大众普法'));
    assert.ok(resPublic.assistantMessage.content.includes('核心结论与定性'));
    assert.ok(resPublic.assistantMessage.citations.length >= 1);
    assert.ok(resPublic.assistantMessage.followUps.length >= 1, 'Expected follow-up questions for vague facts');

    const resCompliance = await engine.consult({
      sessionId: session.id,
      clientId: 'client_a',
      query: '企业单方辞退员工有哪些合规风险',
      personaMode: 'compliance'
    });
    assert.ok(lastPromptSeen.includes('企业合规'));
    assert.ok(resCompliance.assistantMessage.content.includes('合规风险等级评估'));

    const resProf = await engine.consult({
      sessionId: session.id,
      clientId: 'client_a',
      query: '用人单位违法解除劳动合同请求权基础与构成要件',
      personaMode: 'professional'
    });
    assert.ok(lastPromptSeen.includes('专业法研'));
    assert.ok(resProf.assistantMessage.content.includes('请求权基础'));

    // Verify F-08 Rule 3: Citation snapshots survive document disable & physical deletion
    const citedMsg = resPublic.assistantMessage;
    const citedChunkId = citedMsg.citations[0].chunkId;
    const liveCtx = store.getCitationContext(citedMsg.id, citedChunkId, 'client_a');
    assert.strictEqual(liveCtx.sourceStatus, 'active');
    assert.strictEqual(liveCtx.isHistoricalSnapshot, false);
    assert.ok(liveCtx.snapshot.neighbors.length >= 2);

    store.updateDocumentStatus(doc.id, 'disabled');
    const disabledCtx = store.getCitationContext(citedMsg.id, citedChunkId, 'client_a');
    assert.strictEqual(disabledCtx.sourceStatus, 'disabled');
    assert.strictEqual(disabledCtx.isHistoricalSnapshot, true);
    assert.ok(disabledCtx.snapshot.content.length > 0);

    store.deleteDocument(doc.id);
    const deletedCtx = store.getCitationContext(citedMsg.id, citedChunkId, 'client_a');
    assert.strictEqual(deletedCtx.sourceStatus, 'deleted');
    assert.strictEqual(deletedCtx.isHistoricalSnapshot, true);
    assert.ok(deletedCtx.snapshot.neighbors.length >= 2);
  });

  test('TC-CE-02: 外部大模型超时/限流异常时无缝切换为“法条直出降级模式”', async () => {
    const failingLlm: LlmAdapter = {
      async complete() {
        throw new Error('429 Too Many Requests / Gateway Timeout');
      }
    };
    const engine = new ConsultationEngine(store, embedder, retriever, guard, failingLlm);
    await engine.ingestUploadedFile({
      fileName: '劳动法降级测试.txt',
      buffer: Buffer.from(laborLawText, 'utf-8'),
      title: '劳动法降级测试',
      hierarchyLevel: '法律',
      effectiveDate: '2013-07-01'
    });

    const session = store.createSession({ clientId: 'client_fallback', personaMode: 'public' });
    const res = await engine.consult({
      sessionId: session.id,
      clientId: 'client_fallback',
      query: '违法解除劳动合同二倍赔偿金第八十七条',
      personaMode: 'public'
    });

    assert.strictEqual(res.assistantMessage.turnStatus, 'degraded_direct');
    assert.ok(res.assistantMessage.content.includes('法条直出降级模式'));
    assert.ok(res.assistantMessage.citations.length >= 1);
    assert.ok(res.assistantMessage.fallbackReason?.includes('429'));
  });
});
