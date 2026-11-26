export type HierarchyLevel =
  | '宪法'
  | '法律'
  | '行政法规'
  | '司法解释'
  | '部门规章'
  | '地方性法规'
  | '企业规章制度'
  | '其他规范性文件';

export type DocumentStatus =
  | 'pending'
  | 'indexing'
  | 'active'
  | 'disabled'
  | 'failed'
  | 'deleted';

export type ParseStrategy = 'statutory_tree' | 'sliding_window';
export type PersonaMode = 'public' | 'compliance' | 'professional';
export type TurnStatus =
  | 'completed'
  | 'refused_ethics'
  | 'refused_unmatched'
  | 'degraded_direct'
  | 'aborted';

export type ConflictResolution = 'reject' | 'replace_old' | 'rename';

export type LexRagErrorCode =
  | 'INVALID_INPUT'
  | 'EMPTY_FILE'
  | 'FILE_TOO_LARGE'
  | 'UNSUPPORTED_FORMAT'
  | 'MAGIC_MISMATCH'
  | 'ENCRYPTED_PDF'
  | 'SCANNED_PDF_REJECTED'
  | 'DUPLICATE_HASH'
  | 'TITLE_CONFLICT'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'TOO_MANY_ATTEMPTS'
  | 'NOT_FOUND'
  | 'STATE_CONFLICT'
  | 'LLM_UNAVAILABLE'
  | 'EMBEDDING_UNAVAILABLE';

export class LexRagError extends Error {
  public readonly code: LexRagErrorCode;
  public readonly statusCode: number;
  public readonly details?: unknown;

  constructor(code: LexRagErrorCode, message: string, statusCode = 400, details?: unknown) {
    super(message);
    this.name = 'LexRagError';
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

export interface LegalDocument {
  id: string;
  title: string;
  hierarchyLevel: HierarchyLevel;
  effectiveDate: string;
  fileName: string;
  fileExt: string;
  fileSize: number;
  fileHash: string;
  storedPath: string;
  parseStrategy: ParseStrategy;
  status: DocumentStatus;
  totalChunks: number;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
}

export interface PublicDocumentSummary {
  id: string;
  title: string;
  hierarchyLevel: HierarchyLevel;
  effectiveDate: string;
  parseStrategy: ParseStrategy;
  status: DocumentStatus;
  totalChunks: number;
}

export interface StatuteChunk {
  id: string;
  docId: string;
  seqIndex: number;
  bookTitle: string;
  divisionTitle: string;
  chapterTitle: string;
  sectionTitle: string;
  articleNumber: string;
  articleNumNorm: string;
  breadcrumb: string;
  content: string;
  embeddedText: string;
  embedding: number[];
}

export interface ParsedChunkDraft {
  seqIndex: number;
  bookTitle: string;
  divisionTitle: string;
  chapterTitle: string;
  sectionTitle: string;
  articleNumber: string;
  articleNumNorm: string;
  breadcrumb: string;
  content: string;
  embeddedText: string;
}

export interface ParseResult {
  parseStrategy: ParseStrategy;
  chunks: ParsedChunkDraft[];
}

export interface ExtractedFileResult {
  fileName: string;
  fileExt: string;
  fileSize: number;
  fileHash: string;
  text: string;
  pageCount?: number;
}

export interface NeighborArticle {
  chunkId: string;
  seqIndex: number;
  articleNumber: string;
  breadcrumb: string;
  content: string;
  isTarget: boolean;
}

export interface CitationSnapshot {
  chunkId: string;
  docId: string;
  docTitle: string;
  hierarchyLevel: HierarchyLevel;
  effectiveDate: string;
  articleNumber: string;
  articleNumNorm: string;
  breadcrumb: string;
  content: string;
  neighbors: NeighborArticle[];
  score: number;
  sourceStatus?: 'active' | 'disabled' | 'deleted';
}

export interface RetrievalHit {
  chunk: StatuteChunk;
  doc: LegalDocument;
  vectorScore: number;
  bm25Rank: number;
  rrfScore: number;
  exactArticleMatch: boolean;
}

export interface RetrievalMetrics {
  originalQuery: string;
  rewrittenQuery: string;
  rewriteUsed: boolean;
  exactArticles: string[];
  vectorTopScore: number;
  bm25Hits: number;
  finalK: number;
  costMs: number;
}

export interface ChatMessage {
  id: string;
  sessionId: string;
  role: 'user' | 'assistant';
  personaMode: PersonaMode;
  turnStatus: TurnStatus;
  content: string;
  citations: CitationSnapshot[];
  followUps: string[];
  retrievalMetrics?: RetrievalMetrics;
  fallbackReason?: string;
  createdAt: string;
}

export interface ConsultationSession {
  id: string;
  clientId: string;
  title: string;
  personaMode: PersonaMode;
  scopedDocIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface ModelEndpointConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
}

export interface ModelSettings {
  llm: ModelEndpointConfig;
  embedding: ModelEndpointConfig;
  similarityThreshold: number;
  embeddingDimension?: number;
}

export interface MaskedEndpointConfig {
  baseUrl: string;
  apiKeyMasked: string;
  hasApiKey: boolean;
  model: string;
  timeoutMs: number;
}

export interface MaskedModelSettings {
  llm: MaskedEndpointConfig;
  embedding: MaskedEndpointConfig;
  similarityThreshold: number;
  embeddingDimension?: number;
}

export interface ChatRequest {
  sessionId: string;
  clientId: string;
  query: string;
  personaMode: PersonaMode;
  scopedDocIds?: string[];
  stream?: boolean;
}

export interface ChatResponse {
  userMessage: ChatMessage;
  assistantMessage: ChatMessage;
  session: ConsultationSession;
  warning?: string;
}

export interface CitationContextResponse {
  snapshot: CitationSnapshot;
  sourceStatus: 'active' | 'disabled' | 'deleted';
  isHistoricalSnapshot: boolean;
}

export interface TelemetryEvent {
  id: string;
  eventId:
    | 'doc_upload_result'
    | 'chat_query_submit'
    | 'rag_retrieval_metrics'
    | 'hallucination_guard_intercept'
    | 'citation_drawer_open'
    | 'llm_fallback_triggered';
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface LlmAdapter {
  complete(params: {
    systemPrompt: string;
    messages: Array<{ role: 'user' | 'assistant'; content: string }>;
    temperature?: number;
    timeoutMs?: number;
    signal?: AbortSignal;
    onToken?: (token: string) => void;
  }): Promise<string>;
}

export interface EmbeddingAdapter {
  embedBatch(texts: string[]): Promise<number[][]>;
  getDimension(): number;
  isExternal(): boolean;
}

export interface ApiResponse<T> {
  code: number;
  message: string;
  data: T;
  errorCode?: LexRagErrorCode;
}
