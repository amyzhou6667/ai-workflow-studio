import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  LexRagError,
  type ChatMessage,
  type CitationContextResponse,
  type CitationSnapshot,
  type ConsultationSession,
  type DocumentStatus,
  type HierarchyLevel,
  type LegalDocument,
  type MaskedModelSettings,
  type ModelSettings,
  type NeighborArticle,
  type ParseStrategy,
  type PersonaMode,
  type PublicDocumentSummary,
  type StatuteChunk,
  type TelemetryEvent
} from '../types/index.ts';
import { normalizeArticleNumber } from '../engines/statuteParser.ts';

/**
 * 为 SQLite FTS5 生成空间分隔的中文二元词元 (Bigram) + 英文/数字词 + 双向归一化条号词。
 */
export function tokenizeForFts(text: string): string {
  const tokens = new Set<string>();

  // 1. Add normalized article numbers (both Chinese and Arabic forms)
  const artMatches = text.match(/第\s*[零〇一二两三四五六七八九十百千万0-9]+\s*条/g) || [];
  for (const rawArt of artMatches) {
    const norm = normalizeArticleNumber(rawArt);
    tokens.add(norm.articleNumber);
    tokens.add(norm.articleNumNorm);
  }

  // 2. Extract CJK continuous runs and generate bigrams
  const cjkRuns = text.match(/[\u4e00-\u9fff]+/g) || [];
  for (const run of cjkRuns) {
    if (run.length === 1) {
      tokens.add(run);
    } else {
      for (let i = 0; i < run.length - 1; i++) {
        tokens.add(run.slice(i, i + 2));
      }
      if (run.length >= 2 && run.length <= 6) {
        tokens.add(run);
      }
    }
  }

  // 3. Extract ASCII alphanumeric tokens
  const asciiRuns = text.toLowerCase().match(/[a-z0-9_]+/g) || [];
  for (const w of asciiRuns) {
    tokens.add(w);
  }

  return Array.from(tokens).join(' ');
}

/**
 * 将检索词安全转换为 FTS5 MATCH 查询字符串（OR 组合并剥离 FTS 保留字符防语法报错）。
 */
export function buildFtsMatchQuery(queryText: string): string {
  const tokenized = tokenizeForFts(queryText);
  const terms = tokenized
    .split(/\s+/)
    .map((t) => t.replace(/["'*^:()+-]/g, '').trim())
    .filter((t) => t.length >= 2 && !['AND', 'OR', 'NOT', 'NEAR'].includes(t.toUpperCase()));

  const unique = Array.from(new Set(terms)).slice(0, 32);
  if (unique.length === 0) return '';
  return unique.map((t) => `"${t}"`).join(' OR ');
}

export function maskSecret(secret: string): string {
  const s = (secret || '').trim();
  if (!s) return '';
  if (s.length <= 8) return '****';
  return `${s.slice(0, 4)}****${s.slice(-4)}`;
}

function defaultModelSettings(): ModelSettings {
  return {
    llm: {
      baseUrl: process.env.LLM_BASE_URL || '',
      apiKey: process.env.LLM_API_KEY || '',
      model: process.env.LLM_MODEL || '',
      timeoutMs: 20000
    },
    embedding: {
      baseUrl: process.env.EMBEDDING_BASE_URL || '',
      apiKey: process.env.EMBEDDING_API_KEY || '',
      model: process.env.EMBEDDING_MODEL || '',
      timeoutMs: 15000
    },
    similarityThreshold: 0.34,
    embeddingDimension: 256
  };
}

function mapDocRow(row: Record<string, any>): LegalDocument {
  return {
    id: String(row.id),
    title: String(row.title),
    hierarchyLevel: row.hierarchy_level as HierarchyLevel,
    effectiveDate: String(row.effective_date),
    fileName: String(row.file_name),
    fileExt: String(row.file_ext),
    fileSize: Number(row.file_size),
    fileHash: String(row.file_hash),
    storedPath: String(row.stored_path),
    parseStrategy: row.parse_strategy as ParseStrategy,
    status: row.status as DocumentStatus,
    totalChunks: Number(row.total_chunks),
    errorMessage: row.error_message ? String(row.error_message) : undefined,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

function mapChunkRow(row: Record<string, any>): StatuteChunk {
  return {
    id: String(row.id),
    docId: String(row.doc_id),
    seqIndex: Number(row.seq_index),
    bookTitle: String(row.book_title || ''),
    divisionTitle: String(row.division_title || ''),
    chapterTitle: String(row.chapter_title || ''),
    sectionTitle: String(row.section_title || ''),
    articleNumber: String(row.article_number || ''),
    articleNumNorm: String(row.article_num_norm || ''),
    breadcrumb: String(row.breadcrumb || ''),
    content: String(row.content),
    embeddedText: String(row.embedded_text),
    embedding: JSON.parse(String(row.embedding_json || '[]')) as number[]
  };
}

function mapSessionRow(row: Record<string, any>): ConsultationSession {
  return {
    id: String(row.id),
    clientId: String(row.client_id),
    title: String(row.title),
    personaMode: row.persona_mode as PersonaMode,
    scopedDocIds: JSON.parse(String(row.scoped_doc_ids_json || '[]')) as string[],
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

function mapMessageRow(row: Record<string, any>): ChatMessage {
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    role: row.role as 'user' | 'assistant',
    personaMode: row.persona_mode as PersonaMode,
    turnStatus: row.turn_status as ChatMessage['turnStatus'],
    content: String(row.content),
    citations: JSON.parse(String(row.citations_json || '[]')) as CitationSnapshot[],
    followUps: JSON.parse(String(row.follow_ups_json || '[]')) as string[],
    retrievalMetrics: row.retrieval_metrics_json ? JSON.parse(String(row.retrieval_metrics_json)) : undefined,
    fallbackReason: row.fallback_reason ? String(row.fallback_reason) : undefined,
    createdAt: String(row.created_at)
  };
}

export class SqliteStore {
  private readonly db: DatabaseSync;
  public readonly uploadDir: string;

  constructor(dbPath: string, uploadDir?: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.uploadDir = uploadDir || path.join(path.dirname(dbPath), 'uploads');
    fs.mkdirSync(this.uploadDir, { recursive: true });

    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS documents (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        hierarchy_level TEXT NOT NULL,
        effective_date TEXT NOT NULL,
        file_name TEXT NOT NULL,
        file_ext TEXT NOT NULL,
        file_size INTEGER NOT NULL,
        file_hash TEXT NOT NULL,
        stored_path TEXT NOT NULL,
        parse_strategy TEXT NOT NULL DEFAULT 'statutory_tree',
        status TEXT NOT NULL,
        total_chunks INTEGER NOT NULL DEFAULT 0,
        error_message TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_documents_active_hash
        ON documents(file_hash) WHERE status != 'deleted';

      CREATE TABLE IF NOT EXISTS chunks (
        id TEXT PRIMARY KEY,
        doc_id TEXT NOT NULL,
        seq_index INTEGER NOT NULL,
        book_title TEXT NOT NULL DEFAULT '',
        division_title TEXT NOT NULL DEFAULT '',
        chapter_title TEXT NOT NULL DEFAULT '',
        section_title TEXT NOT NULL DEFAULT '',
        article_number TEXT NOT NULL DEFAULT '',
        article_num_norm TEXT NOT NULL DEFAULT '',
        breadcrumb TEXT NOT NULL,
        content TEXT NOT NULL,
        embedded_text TEXT NOT NULL,
        embedding_json TEXT NOT NULL,
        FOREIGN KEY(doc_id) REFERENCES documents(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_chunks_doc_seq ON chunks(doc_id, seq_index);
      CREATE INDEX IF NOT EXISTS idx_chunks_art_norm ON chunks(article_num_norm);

      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
        chunk_id UNINDEXED,
        doc_id UNINDEXED,
        tokens
      );

      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        client_id TEXT NOT NULL,
        title TEXT NOT NULL,
        persona_mode TEXT NOT NULL DEFAULT 'public',
        scoped_doc_ids_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_client ON sessions(client_id, updated_at DESC);

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        persona_mode TEXT NOT NULL,
        turn_status TEXT NOT NULL,
        content TEXT NOT NULL,
        citations_json TEXT NOT NULL DEFAULT '[]',
        follow_ups_json TEXT NOT NULL DEFAULT '[]',
        retrieval_metrics_json TEXT,
        fallback_reason TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, created_at ASC);

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS telemetry_events (
        id TEXT PRIMARY KEY,
        event_id TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_telemetry_event ON telemetry_events(event_id, created_at DESC);
    `);
  }

  public close(): void {
    this.db.close();
  }

  public findActiveDocumentByHash(fileHash: string): LegalDocument | null {
    const row = this.db
      .prepare(`SELECT * FROM documents WHERE file_hash = ? AND status != 'deleted' LIMIT 1`)
      .get(fileHash) as Record<string, any> | undefined;
    return row ? mapDocRow(row) : null;
  }

  public findEnabledDocumentsByTitle(title: string): LegalDocument[] {
    const rows = this.db
      .prepare(`SELECT * FROM documents WHERE title = ? AND status = 'active'`)
      .all(title) as Array<Record<string, any>>;
    return rows.map(mapDocRow);
  }

  public createDocument(doc: {
    id: string;
    title: string;
    hierarchyLevel: HierarchyLevel;
    effectiveDate: string;
    fileName: string;
    fileExt: string;
    fileSize: number;
    fileHash: string;
    storedPath: string;
    status: DocumentStatus;
  }): LegalDocument {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO documents (
          id, title, hierarchy_level, effective_date, file_name, file_ext, file_size,
          file_hash, stored_path, parse_strategy, status, total_chunks, error_message, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'statutory_tree', ?, 0, NULL, ?, ?)`
      )
      .run(
        doc.id,
        doc.title,
        doc.hierarchyLevel,
        doc.effectiveDate,
        doc.fileName,
        doc.fileExt,
        doc.fileSize,
        doc.fileHash,
        doc.storedPath,
        doc.status,
        now,
        now
      );

    return this.getDocumentById(doc.id)!;
  }

  public updateDocumentStatus(
    docId: string,
    status: DocumentStatus,
    extra?: { parseStrategy?: ParseStrategy; totalChunks?: number; errorMessage?: string }
  ): LegalDocument {
    const existing = this.getDocumentById(docId);
    if (!existing) {
      throw new LexRagError('NOT_FOUND', `法典文档不存在: ${docId}`, 404);
    }
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE documents
         SET status = ?,
             parse_strategy = COALESCE(?, parse_strategy),
             total_chunks = COALESCE(?, total_chunks),
             error_message = ?,
             updated_at = ?
         WHERE id = ?`
      )
      .run(
        status,
        extra?.parseStrategy ?? null,
        extra?.totalChunks ?? null,
        extra?.errorMessage ?? null,
        now,
        docId
      );
    return this.getDocumentById(docId)!;
  }

  public getDocumentById(docId: string): LegalDocument | null {
    const row = this.db.prepare(`SELECT * FROM documents WHERE id = ?`).get(docId) as Record<string, any> | undefined;
    return row ? mapDocRow(row) : null;
  }

  public listDocuments(includeDeleted = false): LegalDocument[] {
    const sql = includeDeleted
      ? `SELECT * FROM documents ORDER BY created_at DESC`
      : `SELECT * FROM documents WHERE status != 'deleted' ORDER BY created_at DESC`;
    const rows = this.db.prepare(sql).all() as Array<Record<string, any>>;
    return rows.map(mapDocRow);
  }

  public listPublicDocuments(): PublicDocumentSummary[] {
    const rows = this.db
      .prepare(
        `SELECT id, title, hierarchy_level, effective_date, parse_strategy, status, total_chunks
         FROM documents WHERE status = 'active' ORDER BY created_at DESC`
      )
      .all() as Array<Record<string, any>>;
    return rows.map((r) => ({
      id: String(r.id),
      title: String(r.title),
      hierarchyLevel: r.hierarchy_level as HierarchyLevel,
      effectiveDate: String(r.effective_date),
      parseStrategy: r.parse_strategy as ParseStrategy,
      status: r.status as DocumentStatus,
      totalChunks: Number(r.total_chunks)
    }));
  }

  public deleteDocument(docId: string): void {
    const existing = this.getDocumentById(docId);
    if (!existing) {
      throw new LexRagError('NOT_FOUND', `法典文档不存在: ${docId}`, 404);
    }
    this.db.exec('BEGIN');
    try {
      this.db.prepare(`DELETE FROM chunks_fts WHERE doc_id = ?`).run(docId);
      this.db.prepare(`DELETE FROM chunks WHERE doc_id = ?`).run(docId);
      this.db.prepare(`DELETE FROM documents WHERE id = ?`).run(docId);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    if (existing.storedPath && fs.existsSync(existing.storedPath)) {
      try {
        fs.unlinkSync(existing.storedPath);
      } catch {
        // Ignore non-fatal file cleanup failure
      }
    }
  }

  public replaceDocumentChunks(docId: string, chunks: StatuteChunk[]): void {
    this.db.exec('BEGIN');
    try {
      this.db.prepare(`DELETE FROM chunks_fts WHERE doc_id = ?`).run(docId);
      this.db.prepare(`DELETE FROM chunks WHERE doc_id = ?`).run(docId);

      const insertChunk = this.db.prepare(
        `INSERT INTO chunks (
          id, doc_id, seq_index, book_title, division_title, chapter_title, section_title,
          article_number, article_num_norm, breadcrumb, content, embedded_text, embedding_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      const insertFts = this.db.prepare(
        `INSERT INTO chunks_fts (chunk_id, doc_id, tokens) VALUES (?, ?, ?)`
      );

      for (const c of chunks) {
        insertChunk.run(
          c.id,
          docId,
          c.seqIndex,
          c.bookTitle,
          c.divisionTitle,
          c.chapterTitle,
          c.sectionTitle,
          c.articleNumber,
          c.articleNumNorm,
          c.breadcrumb,
          c.content,
          c.embeddedText,
          JSON.stringify(c.embedding)
        );
        const tokens = tokenizeForFts(`${c.embeddedText} ${c.articleNumber} ${c.articleNumNorm}`);
        insertFts.run(c.id, docId, tokens);
      }

      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  public getDocumentChunks(docId: string, filterText?: string): StatuteChunk[] {
    const doc = this.getDocumentById(docId);
    if (!doc) {
      throw new LexRagError('NOT_FOUND', `法典文档不存在: ${docId}`, 404);
    }
    if (filterText && filterText.trim()) {
      const like = `%${filterText.trim()}%`;
      const rows = this.db
        .prepare(
          `SELECT * FROM chunks
           WHERE doc_id = ? AND (article_number LIKE ? OR article_num_norm LIKE ? OR breadcrumb LIKE ? OR content LIKE ?)
           ORDER BY seq_index ASC`
        )
        .all(docId, like, like, like, like) as Array<Record<string, any>>;
      return rows.map(mapChunkRow);
    }
    const rows = this.db
      .prepare(`SELECT * FROM chunks WHERE doc_id = ? ORDER BY seq_index ASC`)
      .all(docId) as Array<Record<string, any>>;
    return rows.map(mapChunkRow);
  }

  public getActiveChunks(scopedDocIds?: string[]): Array<{ chunk: StatuteChunk; doc: LegalDocument }> {
    const hasScope = Array.isArray(scopedDocIds) && scopedDocIds.length > 0;
    let sql = `
      SELECT
        c.*,
        d.id AS d_id, d.title AS d_title, d.hierarchy_level AS d_hierarchy_level,
        d.effective_date AS d_effective_date, d.file_name AS d_file_name, d.file_ext AS d_file_ext,
        d.file_size AS d_file_size, d.file_hash AS d_file_hash, d.stored_path AS d_stored_path,
        d.parse_strategy AS d_parse_strategy, d.status AS d_status, d.total_chunks AS d_total_chunks,
        d.error_message AS d_error_message, d.created_at AS d_created_at, d.updated_at AS d_updated_at
      FROM chunks c
      JOIN documents d ON c.doc_id = d.id
      WHERE d.status = 'active'
    `;
    const params: string[] = [];
    if (hasScope) {
      const placeholders = scopedDocIds!.map(() => '?').join(', ');
      sql += ` AND d.id IN (${placeholders})`;
      params.push(...scopedDocIds!);
    }

    const rows = this.db.prepare(sql).all(...params) as Array<Record<string, any>>;
    return rows.map((row) => ({
      chunk: mapChunkRow(row),
      doc: {
        id: String(row.d_id),
        title: String(row.d_title),
        hierarchyLevel: row.d_hierarchy_level as HierarchyLevel,
        effectiveDate: String(row.d_effective_date),
        fileName: String(row.d_file_name),
        fileExt: String(row.d_file_ext),
        fileSize: Number(row.d_file_size),
        fileHash: String(row.d_file_hash),
        storedPath: String(row.d_stored_path),
        parseStrategy: row.d_parse_strategy as ParseStrategy,
        status: row.d_status as DocumentStatus,
        totalChunks: Number(row.d_total_chunks),
        errorMessage: row.d_error_message ? String(row.d_error_message) : undefined,
        createdAt: String(row.d_created_at),
        updatedAt: String(row.d_updated_at)
      }
    }));
  }

  public searchFts(queryText: string, scopedDocIds?: string[], limit = 15): Array<{ chunkId: string; rank: number }> {
    const matchQuery = buildFtsMatchQuery(queryText);
    if (!matchQuery) return [];

    const hasScope = Array.isArray(scopedDocIds) && scopedDocIds.length > 0;
    let sql = `
      SELECT f.chunk_id, bm25(chunks_fts) AS bm25_score
      FROM chunks_fts f
      JOIN documents d ON f.doc_id = d.id
      WHERE d.status = 'active' AND chunks_fts MATCH ?
    `;
    const params: Array<string | number> = [matchQuery];
    if (hasScope) {
      const placeholders = scopedDocIds!.map(() => '?').join(', ');
      sql += ` AND d.id IN (${placeholders})`;
      params.push(...scopedDocIds!);
    }
    sql += ` ORDER BY bm25_score ASC LIMIT ?`;
    params.push(limit);

    const rows = this.db.prepare(sql).all(...params) as Array<Record<string, any>>;
    return rows.map((r, idx) => ({
      chunkId: String(r.chunk_id),
      rank: idx + 1
    }));
  }

  public getNeighbors(docId: string, seqIndex: number, radius = 2): NeighborArticle[] {
    const rows = this.db
      .prepare(
        `SELECT id, seq_index, article_number, breadcrumb, content
         FROM chunks
         WHERE doc_id = ? AND seq_index BETWEEN ? AND ?
         ORDER BY seq_index ASC`
      )
      .all(docId, Math.max(0, seqIndex - radius), seqIndex + radius) as Array<Record<string, any>>;

    return rows.map((r) => ({
      chunkId: String(r.id),
      seqIndex: Number(r.seq_index),
      articleNumber: String(r.article_number),
      breadcrumb: String(r.breadcrumb),
      content: String(r.content),
      isTarget: Number(r.seq_index) === seqIndex
    }));
  }

  public getCitationContext(messageId: string, chunkId: string, clientId: string): CitationContextResponse {
    const row = this.db
      .prepare(
        `SELECT m.*, s.client_id
         FROM messages m
         JOIN sessions s ON m.session_id = s.id
         WHERE m.id = ?`
      )
      .get(messageId) as Record<string, any> | undefined;

    if (!row) {
      throw new LexRagError('NOT_FOUND', '咨询消息不存在', 404);
    }
    if (String(row.client_id) !== clientId) {
      throw new LexRagError('FORBIDDEN', '无权访问其他用户的咨询引用上下文', 403);
    }

    const msg = mapMessageRow(row);
    const snapshot = msg.citations.find((c) => c.chunkId === chunkId);
    if (!snapshot) {
      throw new LexRagError('NOT_FOUND', '该消息中不包含指定的法条引用快照', 404);
    }

    const doc = this.getDocumentById(snapshot.docId);
    if (!doc) {
      return {
        snapshot: { ...snapshot, sourceStatus: 'deleted' },
        sourceStatus: 'deleted',
        isHistoricalSnapshot: true
      };
    }

    if (doc.status === 'disabled') {
      return {
        snapshot: { ...snapshot, sourceStatus: 'disabled' },
        sourceStatus: 'disabled',
        isHistoricalSnapshot: true
      };
    }

    if (doc.status === 'active') {
      const liveChunk = this.db.prepare(`SELECT * FROM chunks WHERE id = ?`).get(chunkId) as Record<string, any> | undefined;
      if (liveChunk) {
        const mapped = mapChunkRow(liveChunk);
        const liveNeighbors = this.getNeighbors(doc.id, mapped.seqIndex, 2);
        return {
          snapshot: {
            ...snapshot,
            content: mapped.content,
            breadcrumb: mapped.breadcrumb,
            neighbors: liveNeighbors,
            sourceStatus: 'active'
          },
          sourceStatus: 'active',
          isHistoricalSnapshot: false
        };
      }
    }

    return {
      snapshot: { ...snapshot, sourceStatus: 'deleted' },
      sourceStatus: 'deleted',
      isHistoricalSnapshot: true
    };
  }

  public createSession(params: {
    id?: string;
    clientId: string;
    title?: string;
    personaMode?: PersonaMode;
    scopedDocIds?: string[];
  }): ConsultationSession {
    if (!params.clientId?.trim()) {
      throw new LexRagError('INVALID_INPUT', '缺少客户端会话标识 clientId', 400);
    }
    const id = params.id || `sess_${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    const title = (params.title || '新法律咨询').trim();
    const personaMode: PersonaMode = params.personaMode || 'public';
    const scopedDocIds = params.scopedDocIds || [];

    this.db
      .prepare(
        `INSERT INTO sessions (id, client_id, title, persona_mode, scoped_doc_ids_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(id, params.clientId, title, personaMode, JSON.stringify(scopedDocIds), now, now);

    return this.getSession(id, params.clientId);
  }

  public listSessions(clientId: string): ConsultationSession[] {
    const rows = this.db
      .prepare(`SELECT * FROM sessions WHERE client_id = ? ORDER BY updated_at DESC`)
      .all(clientId) as Array<Record<string, any>>;
    return rows.map(mapSessionRow);
  }

  public getSession(sessionId: string, clientId: string): ConsultationSession {
    const row = this.db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(sessionId) as Record<string, any> | undefined;
    if (!row) {
      throw new LexRagError('NOT_FOUND', '咨询会话不存在', 404);
    }
    if (String(row.client_id) !== clientId) {
      throw new LexRagError('FORBIDDEN', '无权访问其他客户端的会话', 403);
    }
    return mapSessionRow(row);
  }

  public updateSession(
    sessionId: string,
    clientId: string,
    patch: { title?: string; personaMode?: PersonaMode; scopedDocIds?: string[] }
  ): ConsultationSession {
    const existing = this.getSession(sessionId, clientId);
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE sessions
         SET title = ?, persona_mode = ?, scoped_doc_ids_json = ?, updated_at = ?
         WHERE id = ? AND client_id = ?`
      )
      .run(
        patch.title !== undefined ? patch.title.trim() || existing.title : existing.title,
        patch.personaMode ?? existing.personaMode,
        JSON.stringify(patch.scopedDocIds ?? existing.scopedDocIds),
        now,
        sessionId,
        clientId
      );
    return this.getSession(sessionId, clientId);
  }

  public deleteSession(sessionId: string, clientId: string): void {
    this.getSession(sessionId, clientId);
    this.db.prepare(`DELETE FROM sessions WHERE id = ? AND client_id = ?`).run(sessionId, clientId);
  }

  public appendMessage(msg: ChatMessage): ChatMessage {
    this.db
      .prepare(
        `INSERT INTO messages (
          id, session_id, role, persona_mode, turn_status, content,
          citations_json, follow_ups_json, retrieval_metrics_json, fallback_reason, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        msg.id,
        msg.sessionId,
        msg.role,
        msg.personaMode,
        msg.turnStatus,
        msg.content,
        JSON.stringify(msg.citations || []),
        JSON.stringify(msg.followUps || []),
        msg.retrievalMetrics ? JSON.stringify(msg.retrievalMetrics) : null,
        msg.fallbackReason ?? null,
        msg.createdAt
      );
    this.db
      .prepare(`UPDATE sessions SET updated_at = ? WHERE id = ?`)
      .run(msg.createdAt, msg.sessionId);
    return msg;
  }

  public listMessages(sessionId: string, clientId: string): ChatMessage[] {
    this.getSession(sessionId, clientId);
    const rows = this.db
      .prepare(`SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC, rowid ASC`)
      .all(sessionId) as Array<Record<string, any>>;
    return rows.map(mapMessageRow);
  }

  public getSettings(): ModelSettings {
    const row = this.db
      .prepare(`SELECT value_json FROM settings WHERE key = 'model_settings'`)
      .get() as { value_json: string } | undefined;
    const base = defaultModelSettings();
    if (!row) return base;
    try {
      const saved = JSON.parse(row.value_json) as Partial<ModelSettings>;
      return {
        llm: { ...base.llm, ...(saved.llm || {}) },
        embedding: { ...base.embedding, ...(saved.embedding || {}) },
        similarityThreshold: saved.similarityThreshold ?? base.similarityThreshold,
        embeddingDimension: saved.embeddingDimension ?? base.embeddingDimension
      };
    } catch {
      return base;
    }
  }

  public getMaskedSettings(): MaskedModelSettings {
    const cfg = this.getSettings();
    return {
      llm: {
        baseUrl: cfg.llm.baseUrl,
        apiKeyMasked: maskSecret(cfg.llm.apiKey),
        hasApiKey: Boolean(cfg.llm.apiKey),
        model: cfg.llm.model,
        timeoutMs: cfg.llm.timeoutMs
      },
      embedding: {
        baseUrl: cfg.embedding.baseUrl,
        apiKeyMasked: maskSecret(cfg.embedding.apiKey),
        hasApiKey: Boolean(cfg.embedding.apiKey),
        model: cfg.embedding.model,
        timeoutMs: cfg.embedding.timeoutMs
      },
      similarityThreshold: cfg.similarityThreshold,
      embeddingDimension: cfg.embeddingDimension
    };
  }

  public saveSettings(patch: Partial<ModelSettings>): ModelSettings {
    const current = this.getSettings();
    const mergeEndpoint = (cur: ModelSettings['llm'], next?: Partial<ModelSettings['llm']>) => {
      if (!next) return cur;
      const apiKey = next.apiKey && !next.apiKey.includes('****') ? next.apiKey : cur.apiKey;
      return {
        baseUrl: next.baseUrl !== undefined ? next.baseUrl.trim() : cur.baseUrl,
        apiKey: next.apiKey === '' ? '' : apiKey,
        model: next.model !== undefined ? next.model.trim() : cur.model,
        timeoutMs: next.timeoutMs !== undefined ? Math.max(2000, Number(next.timeoutMs)) : cur.timeoutMs
      };
    };

    const merged: ModelSettings = {
      llm: mergeEndpoint(current.llm, patch.llm),
      embedding: mergeEndpoint(current.embedding, patch.embedding),
      similarityThreshold:
        patch.similarityThreshold !== undefined
          ? Math.min(0.9, Math.max(0.1, Number(patch.similarityThreshold)))
          : current.similarityThreshold,
      embeddingDimension: patch.embeddingDimension ?? current.embeddingDimension
    };

    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO settings (key, value_json, updated_at)
         VALUES ('model_settings', ?, ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`
      )
      .run(JSON.stringify(merged), now);
    return merged;
  }

  public recordTelemetry(eventId: TelemetryEvent['eventId'], payload: Record<string, unknown>): TelemetryEvent {
    const evt: TelemetryEvent = {
      id: `evt_${crypto.randomUUID()}`,
      eventId,
      payload,
      createdAt: new Date().toISOString()
    };
    this.db
      .prepare(`INSERT INTO telemetry_events (id, event_id, payload_json, created_at) VALUES (?, ?, ?, ?)`)
      .run(evt.id, evt.eventId, JSON.stringify(evt.payload), evt.createdAt);
    return evt;
  }

  public getTelemetrySummary(): Record<string, number> & { recent: TelemetryEvent[] } {
    const counts = this.db
      .prepare(`SELECT event_id, COUNT(*) AS cnt FROM telemetry_events GROUP BY event_id`)
      .all() as Array<{ event_id: string; cnt: number }>;

    const summary: Record<string, any> = {
      doc_upload_result: 0,
      chat_query_submit: 0,
      rag_retrieval_metrics: 0,
      hallucination_guard_intercept: 0,
      citation_drawer_open: 0,
      llm_fallback_triggered: 0,
      recent: []
    };
    for (const c of counts) {
      summary[c.event_id] = Number(c.cnt);
    }

    const recentRows = this.db
      .prepare(`SELECT * FROM telemetry_events ORDER BY created_at DESC LIMIT 20`)
      .all() as Array<Record<string, any>>;

    summary.recent = recentRows.map((r) => ({
      id: String(r.id),
      eventId: r.event_id as TelemetryEvent['eventId'],
      payload: JSON.parse(String(r.payload_json)),
      createdAt: String(r.created_at)
    }));

    return summary as Record<string, number> & { recent: TelemetryEvent[] };
  }
}
