import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AuthGuard } from './engines/authGuard.ts';
import { ConfigurableLlmAdapter, ConsultationEngine } from './engines/consultationEngine.ts';
import { ConfigurableEmbeddingAdapter } from './engines/embeddingService.ts';
import { HallucinationGuard } from './engines/hallucinationGuard.ts';
import { HybridRetriever } from './engines/hybridRetriever.ts';
import { QueryRewriter } from './engines/queryRewriter.ts';
import { SEED_STATUTES } from './fixtures/seedStatutes.ts';
import { SqliteStore } from './storage/sqliteStore.ts';
import {
  LexRagError,
  type ConflictResolution,
  type EmbeddingAdapter,
  type HierarchyLevel,
  type LlmAdapter,
  type PersonaMode
} from './types/index.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface ServerOptions {
  port?: number;
  dataDir?: string;
  adminPasscode?: string;
  singleUserMode?: boolean;
  llmAdapter?: LlmAdapter;
  embeddingAdapter?: EmbeddingAdapter;
}

export interface SimulatedResponse {
  status: number;
  headers: Record<string, string>;
  text: string;
  json: () => any;
}

export function createLexRagApp(options: ServerOptions = {}): {
  handler: (req: any, res: any) => Promise<void>;
  close: () => void;
} {
  const defaultDataDir = process.env.LEXRAG_DATA_DIR || path.resolve(__dirname, '..', 'data');
  const dataDir = options.dataDir || defaultDataDir;
  const dbPath = path.join(dataDir, 'lexrag.sqlite');
  const uploadDir = path.join(dataDir, 'uploads');
  const uiDir = path.resolve(__dirname, 'ui');

  const store = new SqliteStore(dbPath, uploadDir);
  const authGuard = new AuthGuard({
    passcode: options.adminPasscode,
    singleUserMode: options.singleUserMode
  });

  const embeddingAdapter =
    options.embeddingAdapter || new ConfigurableEmbeddingAdapter(() => store.getSettings().embedding);
  const llmAdapter =
    options.llmAdapter ||
    new ConfigurableLlmAdapter(() => store.getSettings().llm);

  const rewriter = new QueryRewriter(llmAdapter);
  const retriever = new HybridRetriever(store, embeddingAdapter, rewriter);
  const guard = new HallucinationGuard();
  const consultEngine = new ConsultationEngine(store, embeddingAdapter, retriever, guard, llmAdapter);

  const sendJson = (res: any, statusCode: number, data: unknown) => {
    res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(data));
  };

  const sendError = (res: any, err: unknown) => {
    if (err instanceof LexRagError) {
      return sendJson(res, err.statusCode, {
        code: -1,
        errorCode: err.code,
        message: err.message,
        data: err.details ?? null
      });
    }
    const msg = err instanceof Error ? err.message : String(err);
    return sendJson(res, 500, {
      code: -1,
      errorCode: 'INTERNAL_ERROR',
      message: msg,
      data: null
    });
  };

  const parseBody = (req: any): Promise<Record<string, any>> => {
    return new Promise((resolve, reject) => {
      if (req._bodyParsed !== undefined) {
        return resolve(req._bodyParsed || {});
      }
      const chunks: Buffer[] = [];
      let total = 0;
      const limit = 75 * 1024 * 1024; // Allow base64 payload for up to 50MB files
      req.on('data', (chunk: any) => {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
        total += buf.length;
        if (total > limit) {
          reject(new LexRagError('FILE_TOO_LARGE', '请求体超出最大大小限制', 413));
          return;
        }
        chunks.push(buf);
      });
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf-8');
        if (!raw) return resolve({});
        try {
          resolve(JSON.parse(raw));
        } catch {
          reject(new LexRagError('INVALID_INPUT', '请求体必须为有效 JSON', 400));
        }
      });
      req.on('error', (err: any) => reject(err));
    });
  };

  const getHeader = (req: any, name: string): string | undefined => {
    const val = req.headers?.[name] ?? req.headers?.[name.toLowerCase()];
    return Array.isArray(val) ? val[0] : val;
  };

  const requireAdmin = (req: any) => {
    const token = getHeader(req, 'authorization') || getHeader(req, 'x-admin-token');
    if (!authGuard.verifyToken(token)) {
      throw new LexRagError('UNAUTHORIZED', '需要管理员口令解锁后方可执行该操作', 401);
    }
  };

  const requireClientId = (req: any): string => {
    const clientId = (getHeader(req, 'x-client-id') || '').trim();
    if (!clientId) {
      throw new LexRagError('INVALID_INPUT', '请求头缺少 x-client-id 会话隔离标识', 400);
    }
    return clientId;
  };

  const serveStatic = (res: any, filePath: string, contentType: string): boolean => {
    const resolved = path.resolve(filePath);
    if (!resolved.startsWith(uiDir) || !fs.existsSync(resolved)) {
      return false;
    }
    const content = fs.readFileSync(resolved);
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(content);
    return true;
  };

  const handler = async (req: any, res: any): Promise<void> => {
    const url = new URL(req.url || '/', `http://${req.headers?.host || 'localhost'}`);
    const pathname = url.pathname;
    const method = (req.method || 'GET').toUpperCase();

    try {
      // 1. Static React TSX UI routes
      if (method === 'GET') {
        if (pathname === '/' || pathname === '/index.html') {
          if (serveStatic(res, path.join(uiDir, 'index.html'), 'text/html; charset=utf-8')) return;
        }
        if (pathname === '/styles.css') {
          if (serveStatic(res, path.join(uiDir, 'styles.css'), 'text/css; charset=utf-8')) return;
        }
        if (pathname === '/app.tsx') {
          if (serveStatic(res, path.join(uiDir, 'app.tsx'), 'text/plain; charset=utf-8')) return;
        }
        if (pathname.startsWith('/vendor/')) {
          const safeVendorName = path.basename(pathname);
          const contentType = safeVendorName.endsWith('.css')
            ? 'text/css; charset=utf-8'
            : 'application/javascript; charset=utf-8';
          if (serveStatic(res, path.join(uiDir, 'vendor', safeVendorName), contentType)) return;
        }
      }

      // 2. Health & Auth endpoints
      if (pathname === '/api/v1/health' && method === 'GET') {
        const publicDocs = store.listPublicDocuments();
        const settings = store.getMaskedSettings();
        return sendJson(res, 200, {
          code: 0,
          message: 'ok',
          data: {
            status: 'healthy',
            activeDocumentCount: publicDocs.length,
            singleUserMode: authGuard.isSingleUserMode(),
            llmConfigured: Boolean(settings.llm.baseUrl && settings.llm.model),
            embeddingMode: embeddingAdapter.isExternal() ? 'external' : 'local_semantic'
          }
        });
      }

      if (pathname === '/api/v1/auth/status' && method === 'GET') {
        const token = getHeader(req, 'authorization') || getHeader(req, 'x-admin-token');
        return sendJson(res, 200, { code: 0, message: 'ok', data: authGuard.getStatus(token) });
      }

      if (pathname === '/api/v1/auth/login' && method === 'POST') {
        const body = await parseBody(req);
        const sourceKey =
          getHeader(req, 'x-forwarded-for') ||
          req.socket?.remoteAddress ||
          'local_client';
        const result = authGuard.login(String(body.passcode || ''), String(sourceKey));
        return sendJson(res, 200, { code: 0, message: 'ok', data: result });
      }

      // 3. Public Document List
      if (pathname === '/api/v1/documents/public' && method === 'GET') {
        return sendJson(res, 200, {
          code: 0,
          message: 'ok',
          data: store.listPublicDocuments()
        });
      }

      // 4. Admin Knowledge Base Management
      if (pathname === '/api/v1/admin/documents' && method === 'GET') {
        requireAdmin(req);
        return sendJson(res, 200, {
          code: 0,
          message: 'ok',
          data: store.listDocuments(false)
        });
      }

      if (pathname === '/api/v1/admin/documents/seed' && method === 'POST') {
        requireAdmin(req);
        const imported: any[] = [];
        for (const seed of SEED_STATUTES) {
          try {
            const doc = await consultEngine.ingestUploadedFile({
              fileName: seed.fileName,
              buffer: Buffer.from(seed.content, 'utf-8'),
              title: seed.title,
              hierarchyLevel: seed.hierarchyLevel,
              effectiveDate: seed.effectiveDate,
              conflictResolution: 'replace_old'
            });
            imported.push(doc);
          } catch (err) {
            if (err instanceof LexRagError && err.code === 'DUPLICATE_HASH') {
              continue;
            }
            throw err;
          }
        }
        return sendJson(res, 200, {
          code: 0,
          message: `已同步示范法典库（新增 ${imported.length} 部）`,
          data: store.listDocuments(false)
        });
      }

      if (pathname === '/api/v1/admin/documents/upload' && method === 'POST') {
        requireAdmin(req);
        const body = await parseBody(req);
        const fileName = String(body.fileName || '');
        const hierarchyLevel = (body.hierarchyLevel || '法律') as HierarchyLevel;
        const effectiveDate = String(body.effectiveDate || new Date().toISOString().slice(0, 10));
        const title = body.title ? String(body.title) : undefined;
        const conflictResolution = (body.conflictResolution || 'reject') as ConflictResolution;

        let buffer: Buffer;
        if (typeof body.contentBase64 === 'string') {
          buffer = Buffer.from(body.contentBase64, 'base64');
        } else if (typeof body.contentText === 'string') {
          buffer = Buffer.from(body.contentText, 'utf-8');
        } else {
          throw new LexRagError('INVALID_INPUT', '请提供文件内容 (contentBase64 或 contentText)', 400);
        }

        const doc = await consultEngine.ingestUploadedFile({
          fileName,
          buffer,
          title,
          hierarchyLevel,
          effectiveDate,
          conflictResolution
        });
        return sendJson(res, 201, { code: 0, message: '法典解析与入库成功', data: doc });
      }

      if (pathname === '/api/v1/admin/documents/reindex' && method === 'POST') {
        requireAdmin(req);
        const result = await consultEngine.reindexAllDocuments();
        return sendJson(res, 200, { code: 0, message: '全量重建向量索引完成', data: result });
      }

      const chunksMatch = pathname.match(/^\/api\/v1\/admin\/documents\/([^/]+)\/chunks$/);
      if (chunksMatch && method === 'GET') {
        requireAdmin(req);
        const docId = decodeURIComponent(chunksMatch[1]);
        const filterText = url.searchParams.get('q') || undefined;
        const chunks = store.getDocumentChunks(docId, filterText);
        return sendJson(res, 200, {
          code: 0,
          message: 'ok',
          data: chunks.map((c) => ({
            id: c.id,
            seqIndex: c.seqIndex,
            articleNumber: c.articleNumber,
            articleNumNorm: c.articleNumNorm,
            breadcrumb: c.breadcrumb,
            content: c.content
          }))
        });
      }

      const statusMatch = pathname.match(/^\/api\/v1\/admin\/documents\/([^/]+)\/status$/);
      if (statusMatch && method === 'PATCH') {
        requireAdmin(req);
        const docId = decodeURIComponent(statusMatch[1]);
        const body = await parseBody(req);
        const targetStatus = body.status;
        if (targetStatus !== 'active' && targetStatus !== 'disabled') {
          throw new LexRagError('INVALID_INPUT', '状态仅允许切换为 active 或 disabled', 400);
        }
        const existing = store.getDocumentById(docId);
        if (!existing) throw new LexRagError('NOT_FOUND', '法典文档不存在', 404);
        if (existing.status === 'indexing' || existing.status === 'failed' || existing.status === 'pending') {
          throw new LexRagError('STATE_CONFLICT', `当前状态 (${existing.status}) 不可直接启停`, 409);
        }
        const updated = store.updateDocumentStatus(docId, targetStatus);
        return sendJson(res, 200, { code: 0, message: 'ok', data: updated });
      }

      const retryMatch = pathname.match(/^\/api\/v1\/admin\/documents\/([^/]+)\/retry$/);
      if (retryMatch && method === 'POST') {
        requireAdmin(req);
        const docId = decodeURIComponent(retryMatch[1]);
        const updated = await consultEngine.retryDocument(docId);
        return sendJson(res, 200, { code: 0, message: '重试解析成功', data: updated });
      }

      const docDelMatch = pathname.match(/^\/api\/v1\/admin\/documents\/([^/]+)$/);
      if (docDelMatch && method === 'DELETE') {
        requireAdmin(req);
        const docId = decodeURIComponent(docDelMatch[1]);
        const existing = store.getDocumentById(docId);
        if (!existing) throw new LexRagError('NOT_FOUND', '法典文档不存在', 404);
        if (existing.status === 'indexing') {
          throw new LexRagError('STATE_CONFLICT', '文档正在解析向量化中，请等待完成后再删除', 409);
        }
        store.deleteDocument(docId);
        return sendJson(res, 200, { code: 0, message: '已删除法典文档（历史消息引用快照已保留）', data: { docId } });
      }

      // 5. Admin Model Settings & Telemetry
      if (pathname === '/api/v1/admin/settings' && method === 'GET') {
        requireAdmin(req);
        return sendJson(res, 200, { code: 0, message: 'ok', data: store.getMaskedSettings() });
      }

      if (pathname === '/api/v1/admin/settings' && method === 'PUT') {
        requireAdmin(req);
        const body = await parseBody(req);
        store.saveSettings(body);
        return sendJson(res, 200, { code: 0, message: '配置已保存', data: store.getMaskedSettings() });
      }

      if (pathname === '/api/v1/admin/settings/test' && method === 'POST') {
        requireAdmin(req);
        const result: Record<string, any> = {
          llm: { ok: false, message: '' },
          embedding: { ok: false, dimension: 256, message: '' }
        };
        try {
          if (llmAdapter instanceof ConfigurableLlmAdapter && !llmAdapter.isConfigured()) {
            result.llm = { ok: false, message: '未配置外部 Chat LLM，当前将使用法条直出降级模式' };
          } else {
            const reply = await llmAdapter.complete({
              systemPrompt: '只回复 OK',
              messages: [{ role: 'user', content: 'ping' }],
              timeoutMs: 8000
            });
            result.llm = { ok: true, message: `连通正常 (${reply.slice(0, 20)})` };
          }
        } catch (err) {
          result.llm = { ok: false, message: err instanceof Error ? err.message : String(err) };
        }

        try {
          const vecs = await embeddingAdapter.embedBatch(['中华人民共和国民法典连通性测试']);
          const dim = vecs[0]?.length || 0;
          const prevDim = store.getSettings().embeddingDimension;
          result.embedding = {
            ok: dim > 0,
            dimension: dim,
            dimensionChanged: Boolean(prevDim && prevDim !== dim),
            message: embeddingAdapter.isExternal()
              ? `外部 Embedding 连通正常（维度 ${dim}）`
              : `本地法律语义向量引擎就绪（维度 ${dim}）`
          };
        } catch (err) {
          result.embedding = { ok: false, dimension: 0, message: err instanceof Error ? err.message : String(err) };
        }

        return sendJson(res, 200, { code: 0, message: 'ok', data: result });
      }

      if (pathname === '/api/v1/admin/telemetry' && method === 'GET') {
        requireAdmin(req);
        return sendJson(res, 200, { code: 0, message: 'ok', data: store.getTelemetrySummary() });
      }

      // 6. Client-isolated Session & Message APIs
      if (pathname === '/api/v1/sessions' && method === 'GET') {
        const clientId = requireClientId(req);
        return sendJson(res, 200, { code: 0, message: 'ok', data: store.listSessions(clientId) });
      }

      if (pathname === '/api/v1/sessions' && method === 'POST') {
        const clientId = requireClientId(req);
        const body = await parseBody(req);
        const sess = store.createSession({
          clientId,
          title: body.title,
          personaMode: (body.personaMode || 'public') as PersonaMode,
          scopedDocIds: Array.isArray(body.scopedDocIds) ? body.scopedDocIds : []
        });
        return sendJson(res, 201, { code: 0, message: 'ok', data: sess });
      }

      const sessMatch = pathname.match(/^\/api\/v1\/sessions\/([^/]+)$/);
      if (sessMatch && method === 'GET') {
        const clientId = requireClientId(req);
        const sessionId = decodeURIComponent(sessMatch[1]);
        const session = store.getSession(sessionId, clientId);
        const messages = store.listMessages(sessionId, clientId);
        return sendJson(res, 200, { code: 0, message: 'ok', data: { session, messages } });
      }

      if (sessMatch && method === 'PATCH') {
        const clientId = requireClientId(req);
        const sessionId = decodeURIComponent(sessMatch[1]);
        const body = await parseBody(req);
        const session = store.updateSession(sessionId, clientId, {
          title: body.title,
          personaMode: body.personaMode,
          scopedDocIds: body.scopedDocIds
        });
        return sendJson(res, 200, { code: 0, message: 'ok', data: session });
      }

      if (sessMatch && method === 'DELETE') {
        const clientId = requireClientId(req);
        const sessionId = decodeURIComponent(sessMatch[1]);
        store.deleteSession(sessionId, clientId);
        return sendJson(res, 200, { code: 0, message: '会话已删除', data: { sessionId } });
      }

      // 7. Chat / Consultation Endpoint (JSON or SSE stream)
      if (pathname === '/api/v1/chat' && method === 'POST') {
        const clientId = requireClientId(req);
        const body = await parseBody(req);
        const sessionId = String(body.sessionId || '');
        const query = String(body.query || '');
        const personaMode = (body.personaMode || 'public') as PersonaMode;
        const scopedDocIds = Array.isArray(body.scopedDocIds) ? body.scopedDocIds.map(String) : undefined;
        const useStream = Boolean(body.stream);

        if (!useStream) {
          const result = await consultEngine.consult({
            sessionId,
            clientId,
            query,
            personaMode,
            scopedDocIds
          });
          return sendJson(res, 200, { code: 0, message: 'ok', data: result });
        }

        // Pre-validate session and input before switching response into SSE stream
        store.getSession(sessionId, clientId);
        if (!query.trim()) {
          throw new LexRagError('INVALID_INPUT', '咨询内容不能为空', 400);
        }

        const abortController = new AbortController();
        if (typeof req.on === 'function') {
          req.on('close', () => {
            if (!res.writableEnded) {
              abortController.abort(new Error('客户端断开连接'));
            }
          });
        }

        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive'
        });

        const sendSse = (event: string, data: unknown) => {
          res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        };

        try {
          const result = await consultEngine.consult(
            { sessionId, clientId, query, personaMode, scopedDocIds, stream: true },
            {
              signal: abortController.signal,
              onStatus: (stage) => sendSse('status', { stage }),
              onToken: (token) => sendSse('token', { token })
            }
          );
          sendSse('done', result);
        } catch (err) {
          sendSse('error', {
            errorCode: err instanceof LexRagError ? err.code : 'INTERNAL_ERROR',
            message: err instanceof Error ? err.message : String(err)
          });
        } finally {
          res.end();
        }
        return;
      }

      // 8. Citation Context / Historical Snapshot Lookup
      const citeMatch = pathname.match(/^\/api\/v1\/citations\/([^/]+)\/([^/]+)$/);
      if (citeMatch && method === 'GET') {
        const clientId = requireClientId(req);
        const messageId = decodeURIComponent(citeMatch[1]);
        const chunkId = decodeURIComponent(citeMatch[2]);
        const ctx = store.getCitationContext(messageId, chunkId, clientId);
        store.recordTelemetry('citation_drawer_open', {
          messageId,
          chunkId,
          docId: ctx.snapshot.docId,
          articleNumber: ctx.snapshot.articleNumber,
          isSnapshot: ctx.isHistoricalSnapshot
        });
        return sendJson(res, 200, { code: 0, message: 'ok', data: ctx });
      }

      return sendJson(res, 404, { code: -1, errorCode: 'NOT_FOUND', message: `未找到路由: ${method} ${pathname}`, data: null });
    } catch (err) {
      return sendError(res, err);
    }
  };

  return {
    handler,
    close: () => store.close()
  };
}

/**
 * 测试辅助工具：在内存中模拟 Node HTTP 请求/响应流，支持普通 JSON 与 SSE 流式响应。
 */
export async function simulateRequest(
  handler: (req: any, res: any) => Promise<void>,
  method: string,
  urlPath: string,
  body?: unknown,
  headers: Record<string, string> = {}
): Promise<SimulatedResponse> {
  const req: any = new EventEmitter();
  req.method = method;
  req.url = urlPath;
  req.headers = { host: 'localhost', ...headers };
  req.socket = { remoteAddress: headers['x-forwarded-for'] || '127.0.0.1' };
  if (body !== undefined) {
    req._bodyParsed = body;
  }

  let statusCode = 200;
  let respHeaders: Record<string, string> = {};
  const chunks: Buffer[] = [];

  return await new Promise<SimulatedResponse>((resolve, reject) => {
    const res: any = new EventEmitter();
    res.writableEnded = false;
    res.writeHead = (code: number, hdrs: Record<string, string> = {}) => {
      statusCode = code;
      respHeaders = { ...respHeaders, ...hdrs };
    };
    res.write = (chunk: string | Buffer) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf-8'));
    };
    res.end = (chunk?: string | Buffer) => {
      if (chunk !== undefined) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf-8'));
      }
      res.writableEnded = true;
      const text = Buffer.concat(chunks).toString('utf-8');
      resolve({
        status: statusCode,
        headers: respHeaders,
        text,
        json: () => JSON.parse(text)
      });
    };

    handler(req, res).catch(reject);
  });
}

// CLI Entrypoint when run directly via `node src/server.ts`
const isDirectRun =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename);

if (isDirectRun) {
  const portArgIdx = process.argv.indexOf('--port');
  const port = portArgIdx >= 0 && process.argv[portArgIdx + 1]
    ? Number(process.argv[portArgIdx + 1])
    : Number(process.env.PORT || 3100);

  const app = createLexRagApp({ port });
  const server = http.createServer((req, res) => {
    app.handler(req, res).catch((err) => {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ code: -1, message: String(err) }));
    });
  });

  server.listen(port, () => {
    console.log(`[LexRAG] 服务已启动: http://localhost:${port}`);
    console.log(`[LexRAG] 管理员口令: ${process.env.SINGLE_USER_MODE === 'true' ? '单机免密模式' : (process.env.ADMIN_PASSCODE || 'lexrag-admin')}`);
  });
}
