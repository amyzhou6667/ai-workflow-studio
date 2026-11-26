const { useState, useEffect, useRef, useMemo } = React;

type UiPersonaMode = 'public' | 'compliance' | 'professional';
type UiTurnStatus = 'completed' | 'refused_ethics' | 'refused_unmatched' | 'degraded_direct' | 'aborted';

interface UiNeighbor {
  chunkId: string;
  seqIndex: number;
  articleNumber: string;
  breadcrumb: string;
  content: string;
  isTarget: boolean;
}

interface UiCitation {
  chunkId: string;
  docId: string;
  docTitle: string;
  hierarchyLevel: string;
  effectiveDate: string;
  articleNumber: string;
  articleNumNorm: string;
  breadcrumb: string;
  content: string;
  neighbors: UiNeighbor[];
  score: number;
  sourceStatus?: 'active' | 'disabled' | 'deleted';
}

interface UiMessage {
  id: string;
  sessionId: string;
  role: 'user' | 'assistant';
  personaMode: UiPersonaMode;
  turnStatus: UiTurnStatus;
  content: string;
  citations: UiCitation[];
  followUps: string[];
  fallbackReason?: string;
  createdAt: string;
}

interface UiSession {
  id: string;
  title: string;
  personaMode: UiPersonaMode;
  scopedDocIds: string[];
  updatedAt: string;
}

interface UiDoc {
  id: string;
  title: string;
  hierarchyLevel: string;
  effectiveDate: string;
  parseStrategy: string;
  status: string;
  totalChunks: number;
  errorMessage?: string;
}

interface UiChunkPreview {
  id: string;
  seqIndex: number;
  articleNumber: string;
  articleNumNorm: string;
  breadcrumb: string;
  content: string;
}

const DISCLAIMER_TEXT =
  '本系统基于您上传的法律法规原文提供信息检索与参考建议，属于非执业律师正式法律意见参考，不构成司法裁判承诺；涉及重大诉讼、财产或合规决策请咨询专业执业律师。';

const PERSONA_OPTIONS: Array<{ id: UiPersonaMode; label: string; desc: string }> = [
  { id: 'public', label: '大众普法', desc: '通俗结论 + 行动步骤 + 证据清单' },
  { id: 'compliance', label: '企业合规', desc: '风险等级 + 制度漏洞 + 整改建议' },
  { id: 'professional', label: '专业法研', desc: '请求权基础 + 构成要件 + 交叉援引' }
];

const HIERARCHY_LEVELS = [
  '宪法',
  '法律',
  '行政法规',
  '司法解释',
  '部门规章',
  '地方性法规',
  '企业规章制度',
  '其他规范性文件'
];

function getOrCreateClientId(): string {
  const key = 'lexrag_client_id';
  try {
    const existing = window.localStorage.getItem(key);
    if (existing) return existing;
    const generated =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? `cli_${crypto.randomUUID()}`
        : `cli_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    window.localStorage.setItem(key, generated);
    return generated;
  } catch {
    return `cli_mem_${Date.now()}`;
  }
}

function getStoredAdminToken(): string {
  try {
    return window.localStorage.getItem('lexrag_admin_token') || '';
  } catch {
    return '';
  }
}

function setStoredAdminToken(token: string): void {
  try {
    if (token) window.localStorage.setItem('lexrag_admin_token', token);
    else window.localStorage.removeItem('lexrag_admin_token');
  } catch {
    // ignore storage errors
  }
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const slice = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode.apply(null, Array.from(slice));
  }
  return btoa(binary);
}

function App() {
  const clientId = useMemo(() => getOrCreateClientId(), []);
  const [adminToken, setAdminToken] = useState<string>(() => getStoredAdminToken());
  const [singleUserMode, setSingleUserMode] = useState<boolean>(false);
  const [adminUnlocked, setAdminUnlocked] = useState<boolean>(false);

  const [publicDocs, setPublicDocs] = useState<UiDoc[]>([]);
  const [sessions, setSessions] = useState<UiSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string>('');
  const [messages, setMessages] = useState<UiMessage[]>([]);

  const [personaMode, setPersonaMode] = useState<UiPersonaMode>('public');
  const [scopedDocIds, setScopedDocIds] = useState<string[]>([]);
  const [inputText, setInputText] = useState<string>('');
  const [sending, setSending] = useState<boolean>(false);
  const [streamStage, setStreamStage] = useState<string>('');
  const [streamingContent, setStreamingContent] = useState<string>('');
  const [notice, setNotice] = useState<{ type: 'info' | 'error'; text: string } | null>(null);

  // Right citation context drawer state
  const [activeCitation, setActiveCitation] = useState<{
    snapshot: UiCitation;
    sourceStatus: 'active' | 'disabled' | 'deleted';
    isHistoricalSnapshot: boolean;
  } | null>(null);

  // Admin modal state
  const [modalView, setModalView] = useState<'none' | 'auth' | 'kb' | 'settings'>('none');
  const [passcodeInput, setPasscodeInput] = useState<string>('');
  const [adminDocs, setAdminDocs] = useState<UiDoc[]>([]);
  const [previewDoc, setPreviewDoc] = useState<{ doc: UiDoc; chunks: UiChunkPreview[]; filter: string } | null>(null);

  // Upload state
  const [uploadTitle, setUploadTitle] = useState<string>('');
  const [uploadLevel, setUploadLevel] = useState<string>('法律');
  const [uploadDate, setUploadDate] = useState<string>('2021-01-01');
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState<boolean>(false);
  const [conflictPending, setConflictPending] = useState<boolean>(false);

  // Settings state
  const [llmBaseUrl, setLlmBaseUrl] = useState<string>('');
  const [llmApiKey, setLlmApiKey] = useState<string>('');
  const [llmApiKeyMasked, setLlmApiKeyMasked] = useState<string>('');
  const [llmModel, setLlmModel] = useState<string>('');
  const [embBaseUrl, setEmbBaseUrl] = useState<string>('');
  const [embApiKey, setEmbApiKey] = useState<string>('');
  const [embApiKeyMasked, setEmbApiKeyMasked] = useState<string>('');
  const [embModel, setEmbModel] = useState<string>('');
  const [similarityThreshold, setSimilarityThreshold] = useState<number>(0.34);
  const [testResult, setTestResult] = useState<any>(null);

  const abortCtrlRef = useRef<AbortController | null>(null);
  const chatBottomRef = useRef<HTMLDivElement | null>(null);

  const apiFetch = async (url: string, init: RequestInit = {}) => {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'x-client-id': clientId,
      ...(init.headers as Record<string, string> || {})
    };
    if (adminToken) {
      headers.authorization = `Bearer ${adminToken}`;
    }
    const res = await fetch(url, { ...init, headers });
    return res;
  };

  const refreshAuthAndDocs = async () => {
    try {
      const [authRes, docsRes] = await Promise.all([
        apiFetch('/api/v1/auth/status'),
        apiFetch('/api/v1/documents/public')
      ]);
      if (authRes.ok) {
        const authJson = await authRes.json();
        setSingleUserMode(Boolean(authJson.data?.singleUserMode));
        setAdminUnlocked(Boolean(authJson.data?.authenticated));
      }
      if (docsRes.ok) {
        const docsJson = await docsRes.json();
        setPublicDocs(docsJson.data || []);
      }
    } catch (e) {
      console.error(e);
    }
  };

  const refreshSessions = async (selectFirstIfEmpty = true) => {
    const res = await apiFetch('/api/v1/sessions');
    if (res.ok) {
      const json = await res.json();
      const list: UiSession[] = json.data || [];
      setSessions(list);
      if (selectFirstIfEmpty && list.length > 0 && !activeSessionId) {
        await loadSessionDetail(list[0].id);
      }
    }
  };

  const loadSessionDetail = async (sessionId: string) => {
    const res = await apiFetch(`/api/v1/sessions/${encodeURIComponent(sessionId)}`);
    if (res.ok) {
      const json = await res.json();
      const sess: UiSession = json.data.session;
      setActiveSessionId(sess.id);
      setPersonaMode(sess.personaMode || 'public');
      setScopedDocIds(sess.scopedDocIds || []);
      setMessages(json.data.messages || []);
      setActiveCitation(null);
    }
  };

  useEffect(() => {
    refreshAuthAndDocs();
    refreshSessions(true);
  }, []);

  useEffect(() => {
    if (chatBottomRef.current) {
      chatBottomRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, streamingContent]);

  const handleCreateSession = async () => {
    const res = await apiFetch('/api/v1/sessions', {
      method: 'POST',
      body: JSON.stringify({ personaMode, scopedDocIds })
    });
    if (res.ok) {
      const json = await res.json();
      const created: UiSession = json.data;
      setSessions((prev) => [created, ...prev]);
      setActiveSessionId(created.id);
      setMessages([]);
      setActiveCitation(null);
    }
  };

  const handleRenameSession = async (sess: UiSession) => {
    const nextTitle = window.prompt('请输入新的会话名称：', sess.title);
    if (!nextTitle || !nextTitle.trim()) return;
    const res = await apiFetch(`/api/v1/sessions/${encodeURIComponent(sess.id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ title: nextTitle.trim() })
    });
    if (res.ok) {
      await refreshSessions(false);
    }
  };

  const handleDeleteSession = async (sessId: string) => {
    if (!window.confirm('确定删除该咨询会话记录吗？')) return;
    const res = await apiFetch(`/api/v1/sessions/${encodeURIComponent(sessId)}`, { method: 'DELETE' });
    if (res.ok) {
      if (activeSessionId === sessId) {
        setActiveSessionId('');
        setMessages([]);
      }
      await refreshSessions(true);
    }
  };

  const toggleScopedDoc = (docId: string) => {
    setScopedDocIds((prev) =>
      prev.includes(docId) ? prev.filter((id) => id !== docId) : [...prev, docId]
    );
  };

  const handleSendQuery = async (overrideQuery?: string) => {
    const q = (overrideQuery !== undefined ? overrideQuery : inputText).trim();
    if (!q || sending) return;
    if (q.length > 2000) {
      setNotice({ type: 'error', text: '咨询内容不能超过 2000 字，请精简案情要点。' });
      return;
    }

    setNotice(null);
    let targetSessionId = activeSessionId;
    if (!targetSessionId) {
      const createRes = await apiFetch('/api/v1/sessions', {
        method: 'POST',
        body: JSON.stringify({ personaMode, scopedDocIds })
      });
      if (!createRes.ok) {
        setNotice({ type: 'error', text: '创建咨询会话失败，请重试。' });
        return;
      }
      const created = (await createRes.json()).data as UiSession;
      targetSessionId = created.id;
      setActiveSessionId(created.id);
    }

    if (overrideQuery === undefined) setInputText('');

    const optimisticUserMsg: UiMessage = {
      id: `temp_${Date.now()}`,
      sessionId: targetSessionId,
      role: 'user',
      personaMode,
      turnStatus: 'completed',
      content: q,
      citations: [],
      followUps: [],
      createdAt: new Date().toISOString()
    };
    setMessages((prev) => [...prev, optimisticUserMsg]);
    setSending(true);
    setStreamStage('正在理解案情并检索权威法典...');
    setStreamingContent('');

    const controller = new AbortController();
    abortCtrlRef.current = controller;

    try {
      const res = await apiFetch('/api/v1/chat', {
        method: 'POST',
        signal: controller.signal,
        body: JSON.stringify({
          sessionId: targetSessionId,
          query: q,
          personaMode,
          scopedDocIds,
          stream: true
        })
      });

      if (!res.ok) {
        const errJson = await res.json().catch(() => ({ message: '咨询请求失败' }));
        setNotice({ type: 'error', text: errJson.message || '咨询请求失败' });
        setSending(false);
        return;
      }

      const reader = res.body?.getReader();
      if (!reader) {
        await loadSessionDetail(targetSessionId);
        return;
      }

      const decoder = new TextDecoder('utf-8');
      let buf = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const events = buf.split('\n\n');
        buf = events.pop() || '';
        for (const evtBlock of events) {
          const lines = evtBlock.split('\n');
          let evtName = 'message';
          let dataStr = '';
          for (const line of lines) {
            if (line.startsWith('event:')) evtName = line.slice(6).trim();
            else if (line.startsWith('data:')) dataStr += line.slice(5).trim();
          }
          if (!dataStr) continue;
          try {
            const payload = JSON.parse(dataStr);
            if (evtName === 'status') {
              setStreamStage(payload.stage || '');
            } else if (evtName === 'token') {
              setStreamingContent((prev) => prev + (payload.token || ''));
            } else if (evtName === 'done') {
              if (payload.warning) {
                setNotice({ type: 'info', text: payload.warning });
              }
              await loadSessionDetail(targetSessionId);
              await refreshSessions(false);
            } else if (evtName === 'error') {
              setNotice({ type: 'error', text: payload.message || '生成过程出现异常' });
            }
          } catch {
            // ignore malformed sse frame
          }
        }
      }
    } catch (err: any) {
      if (err?.name === 'AbortError') {
        setNotice({ type: 'info', text: '已停止生成回复。' });
        await loadSessionDetail(targetSessionId);
      } else {
        setNotice({ type: 'error', text: String(err?.message || err) });
      }
    } finally {
      setSending(false);
      setStreamStage('');
      setStreamingContent('');
      abortCtrlRef.current = null;
    }
  };

  const handleStopGenerating = () => {
    if (abortCtrlRef.current) {
      abortCtrlRef.current.abort();
    }
  };

  const handleOpenCitation = async (msg: UiMessage, snap: UiCitation) => {
    try {
      const res = await apiFetch(
        `/api/v1/citations/${encodeURIComponent(msg.id)}/${encodeURIComponent(snap.chunkId)}`
      );
      if (res.ok) {
        const json = await res.json();
        setActiveCitation(json.data);
        return;
      }
    } catch {
      // Fallback to inline snapshot
    }
    setActiveCitation({
      snapshot: snap,
      sourceStatus: snap.sourceStatus || 'active',
      isHistoricalSnapshot: snap.sourceStatus !== 'active'
    });
  };

  const handleCopyCitation = (snap: UiCitation) => {
    const text = `《${snap.docTitle}》（${snap.effectiveDate}）${snap.articleNumber}：“${snap.content}”`;
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      navigator.clipboard.writeText(text).then(
        () => setNotice({ type: 'info', text: '已复制规范法条引用到剪贴板。' }),
        () => setNotice({ type: 'info', text: text })
      );
    } else {
      setNotice({ type: 'info', text: text });
    }
  };

  const openAdminTarget = async (target: 'kb' | 'settings') => {
    if (!adminUnlocked && !singleUserMode) {
      setModalView('auth');
      return;
    }
    setModalView(target);
    if (target === 'kb') {
      await fetchAdminDocs();
    } else if (target === 'settings') {
      await fetchAdminSettings();
    }
  };

  const handleAdminLogin = async () => {
    const res = await apiFetch('/api/v1/auth/login', {
      method: 'POST',
      body: JSON.stringify({ passcode: passcodeInput })
    });
    const json = await res.json();
    if (!res.ok) {
      setNotice({ type: 'error', text: json.message || '口令验证失败' });
      return;
    }
    const tk = json.data.token as string;
    setStoredAdminToken(tk);
    setAdminToken(tk);
    setAdminUnlocked(true);
    setPasscodeInput('');
    setModalView('kb');
    await fetchAdminDocs(tk);
  };

  const fetchAdminDocs = async (overrideToken?: string) => {
    const headers: Record<string, string> = {};
    if (overrideToken) headers.authorization = `Bearer ${overrideToken}`;
    const res = await apiFetch('/api/v1/admin/documents', { headers });
    if (res.status === 401) {
      setAdminUnlocked(false);
      setModalView('auth');
      return;
    }
    if (res.ok) {
      const json = await res.json();
      setAdminDocs(json.data || []);
    }
  };

  const fetchAdminSettings = async () => {
    const res = await apiFetch('/api/v1/admin/settings');
    if (res.status === 401) {
      setAdminUnlocked(false);
      setModalView('auth');
      return;
    }
    if (res.ok) {
      const data = (await res.json()).data;
      setLlmBaseUrl(data.llm.baseUrl || '');
      setLlmApiKey('');
      setLlmApiKeyMasked(data.llm.apiKeyMasked || '');
      setLlmModel(data.llm.model || '');
      setEmbBaseUrl(data.embedding.baseUrl || '');
      setEmbApiKey('');
      setEmbApiKeyMasked(data.embedding.apiKeyMasked || '');
      setEmbModel(data.embedding.model || '');
      setSimilarityThreshold(data.similarityThreshold || 0.34);
    }
  };

  const handleSeedStatutes = async () => {
    if (!adminUnlocked && !singleUserMode) {
      setModalView('auth');
      return;
    }
    setNotice({ type: 'info', text: '正在导入内置示范法典（民法典核心编章 + 劳动合同法）...' });
    const res = await apiFetch('/api/v1/admin/documents/seed', { method: 'POST' });
    if (res.ok) {
      const json = await res.json();
      setNotice({ type: 'info', text: json.message || '示范法典导入成功' });
      await refreshAuthAndDocs();
      if (modalView === 'kb') await fetchAdminDocs();
    } else {
      const err = await res.json().catch(() => ({}));
      setNotice({ type: 'error', text: err.message || '导入失败，请先解锁管理员口令' });
    }
  };

  const handleUploadSubmit = async (conflictResolution: 'reject' | 'replace_old' | 'rename' = 'reject') => {
    if (!uploadFile) {
      setNotice({ type: 'error', text: '请先选择要上传的法典文件 (.txt / .md / .docx / 文字版 .pdf)' });
      return;
    }
    setUploading(true);
    try {
      const buf = await uploadFile.arrayBuffer();
      const contentBase64 = arrayBufferToBase64(buf);
      const res = await apiFetch('/api/v1/admin/documents/upload', {
        method: 'POST',
        body: JSON.stringify({
          fileName: uploadFile.name,
          title: uploadTitle.trim() || undefined,
          hierarchyLevel: uploadLevel,
          effectiveDate: uploadDate,
          conflictResolution,
          contentBase64
        })
      });
      const json = await res.json();
      if (res.status === 409 && json.errorCode === 'TITLE_CONFLICT') {
        setConflictPending(true);
        setNotice({ type: 'error', text: json.message });
        return;
      }
      if (!res.ok) {
        setNotice({ type: 'error', text: json.message || '上传解析失败' });
        return;
      }
      setConflictPending(false);
      setUploadFile(null);
      setUploadTitle('');
      setNotice({ type: 'info', text: `《${json.data.title}》入库成功（共切分 ${json.data.totalChunks} 个条文切片）` });
      await fetchAdminDocs();
      await refreshAuthAndDocs();
    } finally {
      setUploading(false);
    }
  };

  const handleToggleDocStatus = async (doc: UiDoc) => {
    const nextStatus = doc.status === 'active' ? 'disabled' : 'active';
    const res = await apiFetch(`/api/v1/admin/documents/${encodeURIComponent(doc.id)}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status: nextStatus })
    });
    if (res.ok) {
      await fetchAdminDocs();
      await refreshAuthAndDocs();
    }
  };

  const handleDeleteDoc = async (doc: UiDoc) => {
    if (!window.confirm(`确定物理删除《${doc.title}》吗？删除后不可用于新咨询，历史会话已引用的条文快照仍会保留。`)) {
      return;
    }
    const res = await apiFetch(`/api/v1/admin/documents/${encodeURIComponent(doc.id)}`, { method: 'DELETE' });
    if (res.ok) {
      await fetchAdminDocs();
      await refreshAuthAndDocs();
    }
  };

  const handlePreviewChunks = async (doc: UiDoc, filter = '') => {
    const res = await apiFetch(
      `/api/v1/admin/documents/${encodeURIComponent(doc.id)}/chunks?q=${encodeURIComponent(filter)}`
    );
    if (res.ok) {
      const json = await res.json();
      setPreviewDoc({ doc, chunks: json.data || [], filter });
    }
  };

  const handleSaveSettings = async () => {
    const res = await apiFetch('/api/v1/admin/settings', {
      method: 'PUT',
      body: JSON.stringify({
        llm: { baseUrl: llmBaseUrl, apiKey: llmApiKey, model: llmModel },
        embedding: { baseUrl: embBaseUrl, apiKey: embApiKey, model: embModel },
        similarityThreshold
      })
    });
    if (res.ok) {
      const json = await res.json();
      setLlmApiKey('');
      setEmbApiKey('');
      setLlmApiKeyMasked(json.data.llm.apiKeyMasked || '');
      setEmbApiKeyMasked(json.data.embedding.apiKeyMasked || '');
      setNotice({ type: 'info', text: '模型服务配置已保存（密钥已安全脱敏存储）。' });
    }
  };

  const handleTestSettings = async () => {
    const res = await apiFetch('/api/v1/admin/settings/test', { method: 'POST' });
    if (res.ok) {
      const json = await res.json();
      setTestResult(json.data);
    }
  };

  const renderMessageContent = (msg: UiMessage) => {
    const citeMap = new Map<string, UiCitation>();
    for (const c of msg.citations || []) {
      citeMap.set(c.chunkId, c);
    }

    const lines = msg.content.split('\n');
    return lines.map((line, lineIdx) => {
      const parts = line.split(/(\[CITE:[^\]]+\])/g);
      return (
        <div key={lineIdx} style={{ marginBottom: line.trim() ? '6px' : '4px' }}>
          {parts.map((part, pIdx) => {
            const m = part.match(/^\[CITE:([^\]]+)\]$/);
            if (!m) {
              if (line.startsWith('### ')) {
                return (
                  <strong key={pIdx} style={{ color: '#93c5fd', fontSize: '15px', display: 'block', marginTop: '8px' }}>
                    {part.replace(/^###\s*/, '')}
                  </strong>
                );
              }
              return <span key={pIdx}>{part}</span>;
            }
            const chunkId = m[1].trim();
            const snap = citeMap.get(chunkId);
            if (!snap) return null;
            const isSelected = activeCitation?.snapshot.chunkId === snap.chunkId;
            return (
              <button
                key={pIdx}
                type="button"
                className={`cite-inline-btn ${isSelected ? 'active' : ''}`}
                onClick={() => handleOpenCitation(msg, snap)}
              >
                {snap.docTitle.replace(/^中华人民共和国/, '').slice(0, 8)}·{snap.articleNumber}
              </button>
            );
          })}
        </div>
      );
    });
  };

  return (
    <div className="app-shell">
      <header className="top-bar">
        <div className="brand-group">
          <div className="brand-badge">法</div>
          <div>
            <div className="brand-title">LexRAG · 法律法规条文级溯源智能咨询台</div>
            <div className="brand-sub">已启用法典 {publicDocs.length} 部 · 零幻觉白名单校验 · 原文双栏核验</div>
          </div>
        </div>

        <div className="top-actions">
          <div className="persona-segmented" role="group" aria-label="咨询视角切换">
            {PERSONA_OPTIONS.map((opt) => (
              <button
                key={opt.id}
                type="button"
                title={opt.desc}
                className={`persona-btn ${personaMode === opt.id ? 'active' : ''}`}
                onClick={() => setPersonaMode(opt.id)}
              >
                {opt.label}
              </button>
            ))}
          </div>

          <button type="button" className="btn" onClick={handleSeedStatutes}>
            导入示范法典
          </button>
          <button type="button" className="btn" onClick={() => openAdminTarget('kb')}>
            {adminUnlocked || singleUserMode ? '法典库管理' : '🔒 法典库管理'}
          </button>
          <button type="button" className="btn" onClick={() => openAdminTarget('settings')}>
            模型设置
          </button>
        </div>
      </header>

      {notice && (
        <div
          style={{
            padding: '8px 18px',
            background: notice.type === 'error' ? 'rgba(239,68,68,0.18)' : 'rgba(59,130,246,0.16)',
            borderBottom: '1px solid var(--border-subtle)',
            color: notice.type === 'error' ? '#fca5a5' : '#93c5fd',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            fontSize: '13px'
          }}
        >
          <span>{notice.text}</span>
          <button type="button" className="btn btn-sm" onClick={() => setNotice(null)}>
            关闭
          </button>
        </div>
      )}

      <div className="workspace-body">
        <aside className="sidebar">
          <div className="sidebar-header">
            <button type="button" className="btn btn-primary" onClick={handleCreateSession}>
              + 新建法律咨询
            </button>
          </div>
          <div className="session-list">
            {sessions.length === 0 && (
              <div style={{ color: 'var(--text-muted)', fontSize: '12px', padding: '12px' }}>
                暂无历史咨询记录，发送第一条问题即可自动创建会话。
              </div>
            )}
            {sessions.map((s) => (
              <div
                key={s.id}
                className={`session-item ${activeSessionId === s.id ? 'active' : ''}`}
                onClick={() => loadSessionDetail(s.id)}
              >
                <div className="session-item-row">
                  <span className="session-title">{s.title}</span>
                  <div style={{ display: 'flex', gap: '4px' }}>
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={(e: React.ChangeEvent) => {
                        e.stopPropagation();
                        handleRenameSession(s);
                      }}
                    >
                      改名
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm btn-danger"
                      onClick={(e: React.ChangeEvent) => {
                        e.stopPropagation();
                        handleDeleteSession(s.id);
                      }}
                    >
                      删
                    </button>
                  </div>
                </div>
                <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                  {PERSONA_OPTIONS.find((p) => p.id === s.personaMode)?.label || '大众普法'}
                </span>
              </div>
            ))}
          </div>
        </aside>

        <main className="chat-column">
          <div className="scope-bar">
            <div className="scope-chips">
              <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>本次检索法典范围：</span>
              <button
                type="button"
                className={`scope-chip ${scopedDocIds.length === 0 ? 'selected' : ''}`}
                onClick={() => setScopedDocIds([])}
              >
                全部已启用 ({publicDocs.length})
              </button>
              {publicDocs.map((d) => (
                <button
                  key={d.id}
                  type="button"
                  className={`scope-chip ${scopedDocIds.includes(d.id) ? 'selected' : ''}`}
                  onClick={() => toggleScopedDoc(d.id)}
                >
                  {d.title}
                </button>
              ))}
            </div>
          </div>

          <div className="chat-scroll">
            {messages.length === 0 && !sending && (
              <div className="empty-hero">
                <h2 style={{ marginTop: 0, marginBottom: '8px', fontSize: '18px' }}>
                  欢迎使用 LexRAG 法律法规条文级溯源咨询台
                </h2>
                <p style={{ margin: 0, color: 'var(--text-secondary)' }}>
                  所有回答严格锚定您上传且已启用的法律法规原文，支持点击任意法条标签在右侧抽屉即时核验原文及前后上下文。
                </p>
                {publicDocs.length === 0 && (
                  <div className="status-banner degraded" style={{ marginTop: '14px' }}>
                    当前知识库尚未启用任何法典，请点击右上角【导入示范法典】或进入【法典库管理】上传《民法典》等法律文档。
                  </div>
                )}
                <div className="sample-prompts">
                  <button
                    type="button"
                    className="sample-prompt-btn"
                    onClick={() => handleSendQuery('房东租期没到就要赶我走还不退押金怎么办？')}
                  >
                    💬 房东租期没到就要赶我走还不退押金怎么办？
                  </button>
                  <button
                    type="button"
                    className="sample-prompt-btn"
                    onClick={() => handleSendQuery('公司无故辞退员工不给赔偿怎么算？')}
                  >
                    ⚖️ 公司无故辞退员工不给赔偿怎么算？
                  </button>
                  <button
                    type="button"
                    className="sample-prompt-btn"
                    onClick={() => handleSendQuery('请解析民法典第577条的违约责任适用要件')}
                  >
                    📘 请解析民法典第577条的违约责任适用要件
                  </button>
                </div>
              </div>
            )}

            {messages.map((msg) => (
              <div key={msg.id} className={`msg-row ${msg.role}`}>
                <div className="msg-bubble">
                  {msg.role === 'assistant' && msg.turnStatus === 'degraded_direct' && (
                    <div className="status-banner degraded">
                      <span>⚡ 法条直出降级模式：{msg.fallbackReason || '外部模型未配置或不可用'}</span>
                    </div>
                  )}
                  {msg.role === 'assistant' &&
                    (msg.turnStatus === 'refused_ethics' || msg.turnStatus === 'refused_unmatched') && (
                      <div className="status-banner refused">
                        <span>🛡️ 防幻觉/合规守卫拦截</span>
                      </div>
                    )}

                  <div>{msg.role === 'user' ? msg.content : renderMessageContent(msg)}</div>

                  {msg.role === 'assistant' && msg.citations && msg.citations.length > 0 && (
                    <div className="cite-cards-grid">
                      {msg.citations.map((snap) => (
                        <button
                          key={snap.chunkId}
                          type="button"
                          className={`cite-card ${activeCitation?.snapshot.chunkId === snap.chunkId ? 'active' : ''}`}
                          onClick={() => handleOpenCitation(msg, snap)}
                        >
                          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                            <strong style={{ color: '#93c5fd', fontSize: '12px' }}>
                              《{snap.docTitle}》{snap.articleNumber}
                            </strong>
                            <span className="badge badge-level">{snap.hierarchyLevel}</span>
                          </div>
                          <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '4px' }}>
                            {snap.breadcrumb}
                          </div>
                          <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                            {snap.content.slice(0, 72)}...
                          </div>
                        </button>
                      ))}
                    </div>
                  )}

                  {msg.role === 'assistant' && msg.followUps && msg.followUps.length > 0 && (
                    <div className="followup-box">
                      <div style={{ fontSize: '12px', color: '#cbd5e1', fontWeight: 600 }}>
                        关键事实待补充（点击直接追问）：
                      </div>
                      <div className="followup-chips">
                        {msg.followUps.map((fq, idx) => (
                          <button
                            key={idx}
                            type="button"
                            className="followup-chip"
                            onClick={() => handleSendQuery(`补充情况：${fq}`)}
                          >
                            {fq}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            ))}

            {sending && (
              <div className="msg-row assistant">
                <div className="msg-bubble">
                  <div style={{ fontSize: '12px', color: '#93c5fd', marginBottom: '6px' }}>
                    ⏳ {streamStage || '处理中...'}
                  </div>
                  <div style={{ whiteSpace: 'pre-wrap' }}>{streamingContent}</div>
                </div>
              </div>
            )}
            <div ref={chatBottomRef} />
          </div>

          <div className="composer-wrap">
            <div className="composer-inner">
              <div className="composer-box">
                <textarea
                  className="composer-textarea"
                  placeholder="请描述您的具体案情或希望检索的法典条文（例如：试用期被口头辞退如何主张赔偿？）..."
                  value={inputText}
                  onChange={(e: React.ChangeEvent) => setInputText(e.target.value)}
                  onKeyDown={(e: React.KeyboardEvent) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      handleSendQuery();
                    }
                  }}
                />
                {sending ? (
                  <button type="button" className="btn btn-danger" onClick={handleStopGenerating}>
                    停止生成
                  </button>
                ) : (
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={!inputText.trim() || inputText.length > 2000}
                    onClick={() => handleSendQuery()}
                  >
                    发送咨询
                  </button>
                )}
              </div>
              <div className="disclaimer-bar">
                <span>⚖️ {DISCLAIMER_TEXT}</span>
                <span style={{ color: inputText.length > 2000 ? '#fca5a5' : 'var(--text-muted)' }}>
                  {inputText.length} / 2000
                </span>
              </div>
            </div>
          </div>
        </main>

        {activeCitation && (
          <aside className="cite-drawer" aria-label="法条原文溯源对照抽屉">
            <div className="drawer-header">
              <div>
                <div style={{ fontWeight: 700, fontSize: '15px' }}>
                  《{activeCitation.snapshot.docTitle}》
                </div>
                <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: '5px' }}>
                  <span className="badge badge-level">{activeCitation.snapshot.hierarchyLevel}</span>
                  <span className="badge badge-active">{activeCitation.snapshot.effectiveDate}</span>
                  {activeCitation.sourceStatus === 'disabled' && (
                    <span className="badge badge-disabled">源法典当前已停用（历史快照）</span>
                  )}
                  {activeCitation.sourceStatus === 'deleted' && (
                    <span className="badge badge-deleted">源法典已被管理员移除（历史快照）</span>
                  )}
                </div>
                <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '6px' }}>
                  {activeCitation.snapshot.breadcrumb}
                </div>
              </div>
              <div style={{ display: 'flex', gap: '6px' }}>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => handleCopyCitation(activeCitation.snapshot)}
                >
                  复制引用
                </button>
                <button type="button" className="btn btn-sm" onClick={() => setActiveCitation(null)}>
                  ✕
                </button>
              </div>
            </div>
            <div className="drawer-body">
              <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                邻近上下文条文对照（自动包含目标条文前后各 2 条，防断章取义）：
              </div>
              {(activeCitation.snapshot.neighbors && activeCitation.snapshot.neighbors.length > 0
                ? activeCitation.snapshot.neighbors
                : [
                    {
                      chunkId: activeCitation.snapshot.chunkId,
                      seqIndex: 0,
                      articleNumber: activeCitation.snapshot.articleNumber,
                      breadcrumb: activeCitation.snapshot.breadcrumb,
                      content: activeCitation.snapshot.content,
                      isTarget: true
                    }
                  ]
              ).map((nb) => (
                <div key={nb.chunkId} className={`neighbor-article ${nb.isTarget ? 'target' : ''}`}>
                  <div style={{ fontWeight: 700, marginBottom: '4px', color: nb.isTarget ? '#93c5fd' : '#cbd5e1' }}>
                    {nb.articleNumber} {nb.isTarget ? '（当前引用）' : ''}
                  </div>
                  <div style={{ whiteSpace: 'pre-wrap' }}>{nb.content}</div>
                </div>
              ))}
            </div>
          </aside>
        )}
      </div>

      {modalView === 'auth' && (
        <div className="modal-backdrop">
          <div className="modal-panel" style={{ maxWidth: '420px' }}>
            <div className="modal-header">
              <strong>管理员口令解锁</strong>
              <button type="button" className="btn btn-sm" onClick={() => setModalView('none')}>
                关闭
              </button>
            </div>
            <div className="modal-body">
              <div style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>
                为防止误删或篡改权威法典知识库，上传、启停、删除法典及修改模型配置需输入管理员口令（默认 <code>lexrag-admin</code>）。
              </div>
              <input
                type="password"
                className="input"
                placeholder="请输入管理员口令"
                value={passcodeInput}
                onChange={(e: React.ChangeEvent) => setPasscodeInput(e.target.value)}
                onKeyDown={(e: React.KeyboardEvent) => {
                  if (e.key === 'Enter') handleAdminLogin();
                }}
              />
              <button type="button" className="btn btn-primary" onClick={handleAdminLogin}>
                验证解锁
              </button>
            </div>
          </div>
        </div>
      )}

      {modalView === 'kb' && (
        <div className="modal-backdrop">
          <div className="modal-panel">
            <div className="modal-header">
              <strong>权威法典知识库管理台</strong>
              <div style={{ display: 'flex', gap: '8px' }}>
                <button type="button" className="btn btn-sm" onClick={handleSeedStatutes}>
                  一键导入示范法典
                </button>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => {
                    setPreviewDoc(null);
                    setModalView('none');
                  }}
                >
                  关闭
                </button>
              </div>
            </div>
            <div className="modal-body">
              <div style={{ padding: '12px', background: 'var(--bg-card)', borderRadius: '10px', border: '1px solid var(--border-subtle)' }}>
                <div style={{ fontWeight: 600, marginBottom: '8px' }}>上传新法律法规（支持 .txt / .md / .docx / 文字版 .pdf，上限 50MB）</div>
                <div className="form-grid">
                  <input
                    className="input"
                    placeholder="法典标准名称（留空则取文件名）"
                    value={uploadTitle}
                    onChange={(e: React.ChangeEvent) => setUploadTitle(e.target.value)}
                  />
                  <select className="select" value={uploadLevel} onChange={(e: React.ChangeEvent) => setUploadLevel(e.target.value)}>
                    {HIERARCHY_LEVELS.map((lv) => (
                      <option key={lv} value={lv}>
                        {lv}
                      </option>
                    ))}
                  </select>
                  <input
                    className="input"
                    placeholder="施行日期 / 版本号"
                    value={uploadDate}
                    onChange={(e: React.ChangeEvent) => setUploadDate(e.target.value)}
                  />
                  <input
                    type="file"
                    accept=".txt,.md,.docx,.pdf"
                    onChange={(e: React.ChangeEvent) => {
                      setConflictPending(false);
                      setUploadFile(e.target.files?.[0] || null);
                    }}
                  />
                </div>
                <div style={{ display: 'flex', gap: '8px', marginTop: '10px', flexWrap: 'wrap' }}>
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={uploading}
                    onClick={() => handleUploadSubmit('reject')}
                  >
                    {uploading ? '解析入库中...' : '校验并解析入库'}
                  </button>
                  {conflictPending && (
                    <React.Fragment>
                      <button
                        type="button"
                        className="btn btn-primary"
                        onClick={() => handleUploadSubmit('replace_old')}
                      >
                        作为新版本上传并自动停用旧版
                      </button>
                      <button type="button" className="btn" onClick={() => handleUploadSubmit('rename')}>
                        自动重命名并存上传
                      </button>
                    </React.Fragment>
                  )}
                </div>
              </div>

              {adminDocs.map((d) => (
                <div key={d.id} className="doc-row">
                  <div>
                    <div style={{ fontWeight: 600 }}>{d.title}</div>
                    <div style={{ fontSize: '12px', color: 'var(--text-muted)', display: 'flex', gap: '6px', marginTop: '4px', flexWrap: 'wrap' }}>
                      <span className="badge badge-level">{d.hierarchyLevel}</span>
                      <span>{d.effectiveDate}</span>
                      <span>{d.parseStrategy === 'statutory_tree' ? '编章节条树切分' : '段落滑窗切分'}</span>
                      <span>共 {d.totalChunks} 条切片</span>
                      <span className={`badge badge-${d.status}`}>{d.status}</span>
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: '6px' }}>
                    <button type="button" className="btn btn-sm" onClick={() => handlePreviewChunks(d)}>
                      预览条文
                    </button>
                    {(d.status === 'active' || d.status === 'disabled') && (
                      <button type="button" className="btn btn-sm" onClick={() => handleToggleDocStatus(d)}>
                        {d.status === 'active' ? '停用' : '启用'}
                      </button>
                    )}
                    <button type="button" className="btn btn-sm btn-danger" onClick={() => handleDeleteDoc(d)}>
                      删除
                    </button>
                  </div>
                </div>
              ))}

              {previewDoc && (
                <div style={{ padding: '12px', background: 'var(--bg-canvas)', borderRadius: '10px', border: '1px solid var(--border-strong)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                    <strong>条文切分预览：《{previewDoc.doc.title}》（展示 {previewDoc.chunks.length} 条）</strong>
                    <button type="button" className="btn btn-sm" onClick={() => setPreviewDoc(null)}>
                      收起预览
                    </button>
                  </div>
                  <input
                    className="input"
                    placeholder="按条号（如 第577条）或关键字过滤..."
                    value={previewDoc.filter}
                    onChange={(e: React.ChangeEvent) => handlePreviewChunks(previewDoc.doc, e.target.value)}
                    style={{ marginBottom: '8px' }}
                  />
                  <div style={{ maxHeight: '220px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                    {previewDoc.chunks.slice(0, 60).map((c) => (
                      <div key={c.id} className="neighbor-article">
                        <div style={{ fontSize: '12px', color: '#93c5fd', fontWeight: 600 }}>
                          {c.articleNumber} · {c.breadcrumb}
                        </div>
                        <div style={{ fontSize: '12px', marginTop: '3px' }}>{c.content}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {modalView === 'settings' && (
        <div className="modal-backdrop">
          <div className="modal-panel" style={{ maxWidth: '680px' }}>
            <div className="modal-header">
              <strong>OpenAI 兼容多模型与防幻觉阈值配置</strong>
              <button type="button" className="btn btn-sm" onClick={() => setModalView('none')}>
                关闭
              </button>
            </div>
            <div className="modal-body">
              <div>
                <div style={{ fontWeight: 600, marginBottom: '6px' }}>Chat 大模型配置（支持 DeepSeek / 通义千问 / OpenAI / Ollama；留空则启用法条直出降级模式）</div>
                <div className="form-grid">
                  <input className="input" placeholder="Base URL (如 https://api.deepseek.com/v1)" value={llmBaseUrl} onChange={(e: React.ChangeEvent) => setLlmBaseUrl(e.target.value)} />
                  <input className="input" placeholder="Model Name (如 deepseek-chat)" value={llmModel} onChange={(e: React.ChangeEvent) => setLlmModel(e.target.value)} />
                  <input
                    type="password"
                    className="input"
                    placeholder={llmApiKeyMasked ? `已配置密钥 (${llmApiKeyMasked})，留空保持不变` : 'API Key'}
                    value={llmApiKey}
                    onChange={(e: React.ChangeEvent) => setLlmApiKey(e.target.value)}
                  />
                </div>
              </div>

              <div>
                <div style={{ fontWeight: 600, marginBottom: '6px' }}>Embedding 向量模型配置（留空则自动使用本地 256 维法律语义特征向量引擎）</div>
                <div className="form-grid">
                  <input className="input" placeholder="Embedding Base URL" value={embBaseUrl} onChange={(e: React.ChangeEvent) => setEmbBaseUrl(e.target.value)} />
                  <input className="input" placeholder="Embedding Model" value={embModel} onChange={(e: React.ChangeEvent) => setEmbModel(e.target.value)} />
                  <input
                    type="password"
                    className="input"
                    placeholder={embApiKeyMasked ? `已配置密钥 (${embApiKeyMasked})` : 'Embedding API Key'}
                    value={embApiKey}
                    onChange={(e: React.ChangeEvent) => setEmbApiKey(e.target.value)}
                  />
                </div>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                <label style={{ fontSize: '13px' }}>防幻觉最低相关性阈值 ({similarityThreshold})：</label>
                <input
                  type="range"
                  min="0.15"
                  max="0.75"
                  step="0.02"
                  value={similarityThreshold}
                  onChange={(e: React.ChangeEvent) => setSimilarityThreshold(Number(e.target.value))}
                />
              </div>

              <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                <button type="button" className="btn btn-primary" onClick={handleSaveSettings}>
                  保存配置
                </button>
                <button type="button" className="btn" onClick={handleTestSettings}>
                  测试连通性
                </button>
              </div>

              {testResult && (
                <div className="neighbor-article">
                  <div>Chat LLM：{testResult.llm?.ok ? '✅' : '⚠️'} {testResult.llm?.message}</div>
                  <div>Embedding：{testResult.embedding?.ok ? '✅' : '⚠️'} {testResult.embedding?.message}</div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const rootElement = document.getElementById('root');
if (rootElement) {
  if (typeof ReactDOM.createRoot === 'function') {
    ReactDOM.createRoot(rootElement).render(<App />);
  } else {
    ReactDOM.render(<App />, rootElement);
  }
}
