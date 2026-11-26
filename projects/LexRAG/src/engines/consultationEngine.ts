import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  LexRagError,
  type ChatMessage,
  type ChatRequest,
  type ChatResponse,
  type CitationSnapshot,
  type ConflictResolution,
  type EmbeddingAdapter,
  type HierarchyLevel,
  type LegalDocument,
  type LlmAdapter,
  type ModelEndpointConfig,
  type PersonaMode,
  type RetrievalHit,
  type StatuteChunk
} from '../types/index.ts';
import type { SqliteStore } from '../storage/sqliteStore.ts';
import { extractTextFromBuffer } from './fileExtractor.ts';
import { parseStatuteDocument } from './statuteParser.ts';
import type { HybridRetriever } from './hybridRetriever.ts';
import type { HallucinationGuard } from './hallucinationGuard.ts';

export function buildPersonaSystemPrompt(personaMode: PersonaMode, hits: RetrievalHit[]): string {
  const personaInstruction =
    personaMode === 'public'
      ? `【当前咨询视角：大众普法模式】
请使用通俗易懂的日常语言，避免晦涩法学黑话，必须严格按以下四段 Markdown 标题输出：
### 核心结论与定性
### 分步行动建议
### 建议保留的证据清单
### 参考法条依据`
      : personaMode === 'compliance'
        ? `【当前咨询视角：企业合规模式】
请站在企业 HR/法务/合规管理负责人视角，识别管理漏洞与用工/经营风险，必须严格按以下四段 Markdown 标题输出：
### 合规风险等级评估
### 潜在违法点与管理漏洞剖析
### 制度整改与操作建议
### 合规对照依据`
        : `【当前咨询视角：专业法研模式】
请采用严谨规范的法言法语与请求权基础分析方法，必须严格按以下四段 Markdown 标题输出：
### 请求权基础与法律关系定性
### 法定构成要件逐项拆解与事实涵摄
### 抗辩事由与举证责任分配
### 多法典交叉援引与原文对照`;

  const evidenceBlock = hits
    .map(
      (h, idx) =>
        `[${idx + 1}] [CITE:${h.chunk.id}] 《${h.doc.title}》（${h.doc.hierarchyLevel}，${h.doc.effectiveDate}）${h.chunk.breadcrumb} ${h.chunk.articleNumber}\n原文：${h.chunk.content}`
    )
    .join('\n\n');

  return `你是 LexRAG 权威法律法规智能咨询助手。
${personaInstruction}

【绝对硬性约束（违者拦截）】：
1. 你只能依据下方【召回权威法典原文】进行解答，严禁凭参数记忆补充或编造任何未在下方出现的法典名称、条号、期限、金额或赔偿倍数！
2. 每引用一条依据，必须在对应句子末尾使用格式 [CITE:chunkId] 标注出处（chunkId 必须与下方方括号标记完全一致）。
3. 本回答仅作法律信息参考，不构成执业律师正式法律意见。

【召回权威法典原文】：
${evidenceBlock}`;
}

export function detectMissingFactFollowUps(query: string, hits: RetrievalHit[]): string[] {
  const clean = query.trim();
  const hasSpecificDetails = clean.length > 65 || /(\d+年|\d+个月|\d+天|\d+元|已签订|未签|书面|有录音|有聊天记录)/.test(clean);
  if (hasSpecificDetails) return [];

  const combinedContext = `${clean} ${hits.map((h) => h.chunk.content).join(' ')}`;
  if (/劳动|辞退|解除|开除|工资|欠薪|试用期|补偿/.test(combinedContext)) {
    return [
      '是否签订了书面劳动合同，以及在该单位已连续工作多少年？',
      '公司解除劳动关系时是否出具了书面通知，给出的具体理由是什么？',
      '目前是否保留了考勤记录、工资流水或沟通录音聊天截图？'
    ];
  }
  if (/租赁|房东|押金|退房|租金|承租/.test(combinedContext)) {
    return [
      '是否签署了书面租赁合同，约定的租期及提前解约违约条款是什么？',
      '目前已交押金及剩余未到期租金金额是多少，是否有转账凭证？',
      '房东通知收房或拒退押金时是否有明确书面通知或聊天记录？'
    ];
  }
  if (/借款|借条|欠款|还款|民间借贷/.test(combinedContext)) {
    return [
      '双方是否签署借条/借款协议，约定的还款期限与利息标准是什么？',
      '出借款项是通过银行转账、微信/支付宝还是现金支付，保留凭证了吗？'
    ];
  }
  return [
    '争议发生的具体时间节点是什么，是否已超过相关法定时效？',
    '双方是否签有书面合同/协议，目前手中已留存哪些关键证据？'
  ];
}

export class ConfigurableLlmAdapter implements LlmAdapter {
  private readonly getConfig: () => ModelEndpointConfig;

  constructor(getConfig: () => ModelEndpointConfig) {
    this.getConfig = getConfig;
  }

  public isConfigured(): boolean {
    const cfg = this.getConfig();
    return Boolean(cfg.baseUrl?.trim() && cfg.model?.trim() && (cfg.apiKey?.trim() || cfg.baseUrl.includes('localhost') || cfg.baseUrl.includes('127.0.0.1')));
  }

  public async complete(params: {
    systemPrompt: string;
    messages: Array<{ role: 'user' | 'assistant'; content: string }>;
    temperature?: number;
    timeoutMs?: number;
    signal?: AbortSignal;
    onToken?: (token: string) => void;
  }): Promise<string> {
    const cfg = this.getConfig();
    if (!this.isConfigured()) {
      throw new LexRagError('LLM_UNAVAILABLE', '尚未配置外部 Chat 大模型接口 (Base URL / Model / API Key)', 503);
    }

    const endpoint = `${cfg.baseUrl.replace(/\/+$/, '')}/chat/completions`;
    const controller = new AbortController();
    const timeout = params.timeoutMs ?? cfg.timeoutMs ?? 20000;
    const timer = setTimeout(() => controller.abort(new Error(`LLM 请求超时 (>${timeout}ms)`)), timeout);

    if (params.signal) {
      if (params.signal.aborted) {
        controller.abort(params.signal.reason);
      } else {
        params.signal.addEventListener('abort', () => controller.abort(params.signal?.reason), { once: true });
      }
    }

    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {})
        },
        body: JSON.stringify({
          model: cfg.model,
          temperature: params.temperature ?? 0.2,
          stream: Boolean(params.onToken),
          messages: [{ role: 'system', content: params.systemPrompt }, ...params.messages]
        }),
        signal: controller.signal
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        throw new LexRagError('LLM_UNAVAILABLE', `LLM 服务返回 HTTP ${res.status}: ${errText.slice(0, 200)}`, 502);
      }

      if (params.onToken && res.body) {
        const reader = res.body.getReader();
        const decoder = new TextDecoder('utf-8');
        let buffer = '';
        let fullText = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop() || '';
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data:')) continue;
            const payload = trimmed.slice(5).trim();
            if (payload === '[DONE]') continue;
            try {
              const parsed = JSON.parse(payload) as any;
              const delta = parsed?.choices?.[0]?.delta?.content;
              if (typeof delta === 'string' && delta.length > 0) {
                fullText += delta;
                params.onToken(delta);
              }
            } catch {
              // Ignore partial chunk JSON parse error
            }
          }
        }
        return fullText;
      }

      const json = (await res.json()) as any;
      const content = json?.choices?.[0]?.message?.content;
      if (typeof content !== 'string') {
        throw new LexRagError('LLM_UNAVAILABLE', 'LLM 响应格式无效，缺少 choices[0].message.content', 502);
      }
      return content;
    } finally {
      clearTimeout(timer);
    }
  }
}

function inferStatuteTitleFromText(fallbackStem: string, text: string): string {
  const isOpaqueStem = /^[A-Za-z0-9_-]{8,}$/.test(fallbackStem);
  if (!isOpaqueStem) return fallbackStem;
  const headerLines = text
    .split(/\r?\n/)
    .slice(0, 35)
    .map((l) => l.trim())
    .filter(Boolean);
  for (const line of headerLines) {
    const exactMatch = line.match(/^《?(中华人民共和国[\u4e00-\u9fa5]{2,30})》?$/);
    if (exactMatch) {
      return exactMatch[1];
    }
  }
  return fallbackStem;
}

export class ConsultationEngine {
  private readonly store: SqliteStore;
  private readonly embeddingAdapter: EmbeddingAdapter;
  private readonly retriever: HybridRetriever;
  private readonly guard: HallucinationGuard;
  private readonly llmAdapter?: LlmAdapter;

  constructor(
    store: SqliteStore,
    embeddingAdapter: EmbeddingAdapter,
    retriever: HybridRetriever,
    guard: HallucinationGuard,
    llmAdapter?: LlmAdapter
  ) {
    this.store = store;
    this.embeddingAdapter = embeddingAdapter;
    this.retriever = retriever;
    this.guard = guard;
    this.llmAdapter = llmAdapter;
  }

  public async ingestUploadedFile(params: {
    fileName: string;
    buffer: Buffer;
    title?: string;
    hierarchyLevel: HierarchyLevel;
    effectiveDate: string;
    conflictResolution?: ConflictResolution;
  }): Promise<LegalDocument> {
    let extracted;
    try {
      extracted = extractTextFromBuffer(params.fileName, params.buffer);
    } catch (err) {
      this.store.recordTelemetry('doc_upload_result', {
        fileName: params.fileName,
        status: 'rejected',
        errorCode: err instanceof LexRagError ? err.code : 'INVALID_INPUT'
      });
      throw err;
    }

    const dupHashDoc = this.store.findActiveDocumentByHash(extracted.fileHash);
    if (dupHashDoc) {
      throw new LexRagError(
        'DUPLICATE_HASH',
        `知识库中已存在完全相同内容的文件《${dupHashDoc.title}》`,
        409,
        { existingDocId: dupHashDoc.id, existingTitle: dupHashDoc.title }
      );
    }

    const rawStem = path.basename(params.fileName, path.extname(params.fileName)).trim();
    const baseTitle = (params.title?.trim() || inferStatuteTitleFromText(rawStem, extracted.text)).trim();
    const conflictDocs = this.store.findEnabledDocumentsByTitle(baseTitle);
    let finalTitle = baseTitle;

    if (conflictDocs.length > 0) {
      const mode = params.conflictResolution || 'reject';
      if (mode === 'reject') {
        throw new LexRagError(
          'TITLE_CONFLICT',
          `已存在同名已启用法典《${baseTitle}》，请选择“作为新版本并自动停用旧版”或修改名称`,
          409,
          { existingDocIds: conflictDocs.map((d) => d.id), title: baseTitle }
        );
      } else if (mode === 'replace_old') {
        for (const old of conflictDocs) {
          this.store.updateDocumentStatus(old.id, 'disabled');
        }
      } else if (mode === 'rename') {
        finalTitle = `${baseTitle} (${params.effectiveDate || '新版本'})`;
      }
    }

    const docId = `doc_${crypto.randomUUID().slice(0, 12)}`;
    const safeDiskPath = path.join(this.store.uploadDir, `${docId}${extracted.fileExt}`);
    fs.writeFileSync(safeDiskPath, params.buffer);

    this.store.createDocument({
      id: docId,
      title: finalTitle,
      hierarchyLevel: params.hierarchyLevel,
      effectiveDate: params.effectiveDate || new Date().toISOString().slice(0, 10),
      fileName: params.fileName,
      fileExt: extracted.fileExt,
      fileSize: extracted.fileSize,
      fileHash: extracted.fileHash,
      storedPath: safeDiskPath,
      status: 'pending'
    });

    return await this.parseAndIndexDocument(docId, finalTitle, params.hierarchyLevel, extracted.text);
  }

  public async retryDocument(docId: string): Promise<LegalDocument> {
    const doc = this.store.getDocumentById(docId);
    if (!doc) {
      throw new LexRagError('NOT_FOUND', `法典文档不存在: ${docId}`, 404);
    }
    if (doc.status === 'indexing') {
      throw new LexRagError('STATE_CONFLICT', '文档正在解析向量化中，请勿重复重试', 409);
    }
    if (!fs.existsSync(doc.storedPath)) {
      throw new LexRagError('NOT_FOUND', '原始存储文件已缺失，无法重试解析', 404);
    }
    const buffer = fs.readFileSync(doc.storedPath);
    const extracted = extractTextFromBuffer(doc.fileName, buffer);
    return await this.parseAndIndexDocument(doc.id, doc.title, doc.hierarchyLevel, extracted.text);
  }

  public async reindexAllDocuments(): Promise<{ reindexedDocs: number; totalChunks: number }> {
    const docs = this.store.listDocuments(false).filter((d) => d.status === 'active' || d.status === 'disabled');
    let reindexedDocs = 0;
    let totalChunks = 0;
    for (const d of docs) {
      if (!fs.existsSync(d.storedPath)) continue;
      const prevStatus = d.status;
      const buf = fs.readFileSync(d.storedPath);
      const extracted = extractTextFromBuffer(d.fileName, buf);
      const updated = await this.parseAndIndexDocument(d.id, d.title, d.hierarchyLevel, extracted.text);
      if (prevStatus === 'disabled') {
        this.store.updateDocumentStatus(d.id, 'disabled');
      }
      reindexedDocs++;
      totalChunks += updated.totalChunks;
    }
    return { reindexedDocs, totalChunks };
  }

  private async parseAndIndexDocument(
    docId: string,
    title: string,
    hierarchyLevel: HierarchyLevel,
    rawText: string
  ): Promise<LegalDocument> {
    const startMs = Date.now();
    this.store.updateDocumentStatus(docId, 'indexing');

    try {
      const parsed = parseStatuteDocument({ docTitle: title, hierarchyLevel, text: rawText });
      if (parsed.chunks.length === 0) {
        throw new LexRagError('EMPTY_FILE', '未能从该法典中切分出任何有效条款片段', 422);
      }

      const embeddings = await this.embeddingAdapter.embedBatch(parsed.chunks.map((c) => c.embeddedText));
      const chunks: StatuteChunk[] = parsed.chunks.map((draft, idx) => ({
        id: `${docId}_c_${idx}`,
        docId,
        ...draft,
        embedding: embeddings[idx]
      }));

      this.store.replaceDocumentChunks(docId, chunks);
      const dim = this.embeddingAdapter.getDimension();
      this.store.saveSettings({ embeddingDimension: dim });

      const updated = this.store.updateDocumentStatus(docId, 'active', {
        parseStrategy: parsed.parseStrategy,
        totalChunks: chunks.length
      });

      this.store.recordTelemetry('doc_upload_result', {
        docId,
        parseStrategy: parsed.parseStrategy,
        chunkCount: chunks.length,
        durationMs: Date.now() - startMs,
        status: 'active'
      });

      return updated;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.store.updateDocumentStatus(docId, 'failed', { errorMessage: msg });
      this.store.recordTelemetry('doc_upload_result', {
        docId,
        durationMs: Date.now() - startMs,
        status: 'failed',
        errorCode: err instanceof LexRagError ? err.code : 'EMBEDDING_UNAVAILABLE'
      });
      throw err;
    }
  }

  private buildSnapshots(hits: RetrievalHit[]): CitationSnapshot[] {
    return hits.map((h) => ({
      chunkId: h.chunk.id,
      docId: h.doc.id,
      docTitle: h.doc.title,
      hierarchyLevel: h.doc.hierarchyLevel,
      effectiveDate: h.doc.effectiveDate,
      articleNumber: h.chunk.articleNumber,
      articleNumNorm: h.chunk.articleNumNorm,
      breadcrumb: h.chunk.breadcrumb,
      content: h.chunk.content,
      neighbors: this.store.getNeighbors(h.doc.id, h.chunk.seqIndex, 2),
      score: h.vectorScore,
      sourceStatus: 'active'
    }));
  }

  public async consult(
    req: ChatRequest,
    callbacks?: {
      onStatus?: (stage: string) => void;
      onToken?: (token: string) => void;
      signal?: AbortSignal;
    }
  ): Promise<ChatResponse> {
    const query = (req.query || '').trim();
    if (!query) {
      throw new LexRagError('INVALID_INPUT', '咨询内容不能为空', 400);
    }
    if (query.length > 2000) {
      throw new LexRagError('INVALID_INPUT', '咨询描述超出 2000 字上限，请精简案情要点', 400);
    }

    let session = this.store.getSession(req.sessionId, req.clientId);
    const history = this.store.listMessages(session.id, req.clientId);

    // Filter requested scopedDocIds against currently active documents (F-04 Edge Case)
    const activeDocIds = new Set(this.store.listPublicDocuments().map((d) => d.id));
    let effectiveScope = req.scopedDocIds ?? session.scopedDocIds;
    let warning: string | undefined;

    if (effectiveScope && effectiveScope.length > 0) {
      const removedCount = effectiveScope.filter((id) => !activeDocIds.has(id)).length;
      effectiveScope = effectiveScope.filter((id) => activeDocIds.has(id));
      if (removedCount > 0) {
        warning = '此前限定的部分法典已被管理员停用或移除，本次检索已自动排除失效法典。';
        if (effectiveScope.length === 0) {
          throw new LexRagError('STATE_CONFLICT', `${warning}当前有效范围为空，请重新勾选已启用法典。`, 409);
        }
      }
    }

    // Auto-name session on first user message
    if (history.length === 0 && (session.title === '新法律咨询' || !session.title)) {
      const autoTitle = query.replace(/\s+/g, ' ').slice(0, 20);
      session = this.store.updateSession(session.id, req.clientId, {
        title: autoTitle,
        personaMode: req.personaMode,
        scopedDocIds: effectiveScope
      });
    } else {
      session = this.store.updateSession(session.id, req.clientId, {
        personaMode: req.personaMode,
        scopedDocIds: effectiveScope
      });
    }

    const userMsg: ChatMessage = this.store.appendMessage({
      id: `msg_${crypto.randomUUID().slice(0, 12)}`,
      sessionId: session.id,
      role: 'user',
      personaMode: req.personaMode,
      turnStatus: 'completed',
      content: query,
      citations: [],
      followUps: [],
      createdAt: new Date().toISOString()
    });

    this.store.recordTelemetry('chat_query_submit', {
      sessionId: session.id,
      personaMode: req.personaMode,
      scopedDocCount: effectiveScope.length,
      queryLength: query.length
    });

    // 1. Pre-check Ethics Gate
    const ethics = this.guard.checkEthics(query);
    if (!ethics.allowed) {
      this.store.recordTelemetry('hallucination_guard_intercept', {
        guardType: 'ethics',
        detail: 'blocked_illegal_intent'
      });
      const assistantMsg = this.store.appendMessage({
        id: `msg_${crypto.randomUUID().slice(0, 12)}`,
        sessionId: session.id,
        role: 'assistant',
        personaMode: req.personaMode,
        turnStatus: 'refused_ethics',
        content: ethics.reason!,
        citations: [],
        followUps: [],
        createdAt: new Date().toISOString()
      });
      callbacks?.onToken?.(assistantMsg.content);
      return { userMessage: userMsg, assistantMessage: assistantMsg, session, warning };
    }

    // 2. Hybrid Retrieval (Query Rewrite + Vector + FTS5 BM25 + RRF)
    callbacks?.onStatus?.('正在理解案情并检索法典条文...');
    const { hits, metrics } = await this.retriever.retrieve({
      query,
      recentMessages: history,
      scopedDocIds: effectiveScope.length > 0 ? effectiveScope : undefined,
      topK: 8
    });

    this.store.recordTelemetry('rag_retrieval_metrics', {
      rewriteUsed: metrics.rewriteUsed,
      vectorTopScore: metrics.vectorTopScore,
      bm25Hits: metrics.bm25Hits,
      finalK: metrics.finalK,
      costMs: metrics.costMs
    });

    // 3. Coverage Gate
    const threshold = this.store.getSettings().similarityThreshold;
    const coverage = this.guard.checkCoverage(hits, metrics, threshold);
    if (!coverage.covered) {
      this.store.recordTelemetry('hallucination_guard_intercept', {
        guardType: 'low_score',
        vectorTopScore: metrics.vectorTopScore,
        bm25Hits: metrics.bm25Hits
      });
      const assistantMsg = this.store.appendMessage({
        id: `msg_${crypto.randomUUID().slice(0, 12)}`,
        sessionId: session.id,
        role: 'assistant',
        personaMode: req.personaMode,
        turnStatus: 'refused_unmatched',
        content: coverage.reason!,
        citations: [],
        followUps: [],
        retrievalMetrics: metrics,
        createdAt: new Date().toISOString()
      });
      callbacks?.onToken?.(assistantMsg.content);
      return { userMessage: userMsg, assistantMessage: assistantMsg, session, warning };
    }

    // Prepare candidate top-5 snapshots for guaranteed fallback or validated citations
    const topSnapshots = this.buildSnapshots(hits.slice(0, 5));
    const snapshotMap = new Map(topSnapshots.map((s) => [s.chunkId, s]));
    const fullSnapshotMap = new Map(this.buildSnapshots(hits).map((s) => [s.chunkId, s]));
    const followUps = detectMissingFactFollowUps(query, hits);

    // 4. LLM Generation with Post-Whitelist Validation & Direct Degradation Fallback
    callbacks?.onStatus?.('已匹配权威法条，正在结合视角生成参考建议...');
    let streamedRaw = '';
    try {
      if (!this.llmAdapter) {
        throw new LexRagError('LLM_UNAVAILABLE', '未配置外部大模型适配器', 503);
      }

      const systemPrompt = buildPersonaSystemPrompt(req.personaMode, hits);
      const chatContext = history
        .slice(-4)
        .filter((m) => m.turnStatus === 'completed')
        .map((m) => ({ role: m.role, content: m.content.slice(0, 600) }));

      const rawReply = await this.llmAdapter.complete({
        systemPrompt,
        messages: [...chatContext, { role: 'user', content: query }],
        temperature: 0.2,
        signal: callbacks?.signal,
        onToken: (tk) => {
          streamedRaw += tk;
          callbacks?.onToken?.(tk);
        }
      });

      const validation = this.guard.validateGeneratedCitations(rawReply, hits);
      if (validation.hadHallucination) {
        this.store.recordTelemetry('hallucination_guard_intercept', {
          guardType: 'invalid_cite',
          intercepted: validation.interceptedDetails
        });
      }

      const citedSnapshots: CitationSnapshot[] = validation.validChunkIds
        .map((id) => fullSnapshotMap.get(id))
        .filter((s): s is CitationSnapshot => Boolean(s));

      // Keep top retrieved cards available even if LLM omitted explicit [CITE:id] tags
      const finalCitations = citedSnapshots.length > 0 ? citedSnapshots : topSnapshots.slice(0, 3);

      const finalText = validation.fallbackToCardsOnly
        ? `系统已拦截不准确条文生成，以下为您展示本次检索命中的真实权威法典依据，请点击右侧卡片核对完整上下文：`
        : validation.sanitizedText;

      const assistantMsg = this.store.appendMessage({
        id: `msg_${crypto.randomUUID().slice(0, 12)}`,
        sessionId: session.id,
        role: 'assistant',
        personaMode: req.personaMode,
        turnStatus: 'completed',
        content: finalText,
        citations: finalCitations,
        followUps,
        retrievalMetrics: metrics,
        createdAt: new Date().toISOString()
      });

      return { userMessage: userMsg, assistantMessage: assistantMsg, session, warning };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);

      // Handle explicit user abort mid-stream
      if (callbacks?.signal?.aborted) {
        const abortedContent = streamedRaw
          ? `${streamedRaw}\n\n（已中止生成，下方为您保留本次命中的权威法典原文依据）`
          : '（已中止本次生成，下方为您保留本次检索命中的权威法典原文依据）';
        const assistantMsg = this.store.appendMessage({
          id: `msg_${crypto.randomUUID().slice(0, 12)}`,
          sessionId: session.id,
          role: 'assistant',
          personaMode: req.personaMode,
          turnStatus: 'aborted',
          content: abortedContent,
          citations: topSnapshots,
          followUps: [],
          retrievalMetrics: metrics,
          fallbackReason: '用户主动中止生成',
          createdAt: new Date().toISOString()
        });
        return { userMessage: userMsg, assistantMessage: assistantMsg, session, warning };
      }

      // F-09 Rule 2: Graceful degradation to Direct Statute Retrieval Mode
      this.store.recordTelemetry('llm_fallback_triggered', {
        error: errMsg.slice(0, 160),
        fallbackHits: topSnapshots.length
      });

      const directSummary = topSnapshots
        .map(
          (s, i) =>
            `${i + 1}. **《${s.docTitle}》${s.articleNumber}**（${s.breadcrumb}）[CITE:${s.chunkId}]\n> ${s.content}`
        )
        .join('\n\n');

      const fallbackContent = streamedRaw
        ? `${streamedRaw}\n\n（网络连接中断：${errMsg}，已为您保留下方检索命中的原始法条依据）`
        : `AI 综合分析服务当前暂不可用（原因：${errMsg}），已为您自动切换为【法条直出降级模式】，以下为您直接匹配到的最相关权威法典条文供参考：\n\n${directSummary}`;

      if (!streamedRaw) {
        callbacks?.onToken?.(fallbackContent);
      }

      const usedSnapshots = topSnapshots.filter((s) => snapshotMap.has(s.chunkId));
      const assistantMsg = this.store.appendMessage({
        id: `msg_${crypto.randomUUID().slice(0, 12)}`,
        sessionId: session.id,
        role: 'assistant',
        personaMode: req.personaMode,
        turnStatus: 'degraded_direct',
        content: fallbackContent,
        citations: usedSnapshots,
        followUps,
        retrievalMetrics: metrics,
        fallbackReason: errMsg,
        createdAt: new Date().toISOString()
      });

      return { userMessage: userMsg, assistantMessage: assistantMsg, session, warning };
    }
  }
}
