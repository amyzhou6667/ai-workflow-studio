# 【研发实施任务拆解与测试计划】LexRAG - 法律法规条文级溯源与智能咨询系统

| 责任人 | 关联 PRD | 关联 TRD | 计划周期 |
| :--- | :--- | :--- | :--- |
| 架构师 / 全栈研发 | [PRD-LexRAG.md](../prd/PRD-LexRAG.md) | [TRD-LexRAG.md](./TRD-LexRAG.md) | 2026-11-25 |

---

## 🎯 拆解原则
- **微任务化**：每个任务聚焦单一模块职责，可在 2~5 分钟内完成并独立验证。
- **契约先行与上下文隔离**：先冻结 `src/types/index.ts` 类型契约与桩函数，按 TDD 红-绿-重构推进。
- **零失败门禁**：TypeScript 严格类型检查与 `node --test` 全量测试用例必须达到 100% 通过。

---

## 📝 任务清单 (Task Checklist)

### 阶段一：工程脚手架与 TypeScript 契约冻结
- [x] **Task 1.1: 创建工程目录、配置与离线 React Vendor 资产**
  - **改动范围**：`package.json`, `tsconfig.json`, `.gitignore`, `src/ui/vendor/*`, `src/ui/globals.d.ts`
  - **目标**：配置适配 Node v24 原生 TS 与 React 18 TSX 的双兼容编译环境，保证内网离线运行。
  - **验收结果**：`tsc -p projects/LexRAG/tsconfig.json --noEmit` 0 错误通过。
- [x] **Task 1.2: 编写核心领域模型与接口契约 (`src/types/index.ts`) 与模块桩导出**
  - **改动范围**：`src/types/index.ts`, `src/engines/*.ts`, `src/storage/sqliteStore.ts`, `src/fixtures/seedStatutes.ts`, `src/server.ts`
  - **目标**：锁定全部可擦除 TS 实体接口、错误码类 `LexRagError` 与服务导出签名。

### 阶段二：文件解析、树状切分与混合检索 TDD 闭环
- [x] **Task 2.1: 多格式法典提取器与安全校验 TDD (`fileExtractor`)**
  - **测试用例**：`tests/fileExtractor.test.ts`（6/6 通过）
  - **实现文件**：`src/engines/fileExtractor.ts`
  - **目标**：支持 UTF-8/GB18030 TXT/MD、ZIP Central Directory DOCX 解析、文字版 PDF 文本抽取，拦截空文件/超限/假后缀/加密 PDF/无文本层扫描件 PDF，计算 SHA-256。
- [x] **Task 2.2: 法典层级树状解析器 TDD (`statuteParser`)**
  - **测试用例**：`tests/statuteParser.test.ts`（4/4 通过）
  - **实现文件**：`src/engines/statuteParser.ts`
  - **目标**：实现中文/阿拉伯数字条号双向转换、目录去噪、编-分编-章-节-条树状状态机、面包屑前缀注入、超长条拆分及非标文档滑动窗口降级。
- [x] **Task 2.3: SQLite FTS5 存储、向量服务与混合检索 RRF 引擎 TDD**
  - **测试用例**：`tests/hybridRetriever.test.ts`（4/4 通过）
  - **实现文件**：`src/storage/sqliteStore.ts`, `src/engines/embeddingService.ts`, `src/engines/queryRewriter.ts`, `src/engines/hybridRetriever.ts`
  - **目标**：实现 7 表 Schema、CJK Bigram + 归一化条号 FTS5 分词检索、口语改写、Vector+BM25 RRF 重排与文档范围实时过滤。

### 阶段三：防幻觉双门控、多视角咨询与 API 服务 TDD 闭环
- [x] **Task 3.1: 三重防幻觉门控与伦理风控 TDD (`hallucinationGuard`)**
  - **测试用例**：`tests/hallucinationGuard.test.ts`（3/3 通过）
  - **实现文件**：`src/engines/hallucinationGuard.ts`
  - **目标**：实现违法/伪造证据意图拦截（放行维权咨询）、低相关性诚实拒答门控、后置 `[CITE:id]` 与虚构条号白名单校验。
- [x] **Task 3.2: 三视角咨询引擎、追问引导、引用快照与模型降级 TDD (`consultationEngine`)**
  - **测试用例**：`tests/consultationEngine.test.ts`（2/2 通过）
  - **实现文件**：`src/engines/consultationEngine.ts`, `src/fixtures/seedStatutes.ts`
  - **目标**：实现大众普法/企业合规/专业法研视角差异化输出、缺失要素追问、`CitationSnapshot`（含前后 2 条邻居）固化、LLM 故障无缝切换“法条直出降级模式”。
- [x] **Task 3.3: HTTP/SSE 网关与轻量级管理鉴权 TDD (`authGuard` & `server`)**
  - **测试用例**：`tests/webServerAndUi.test.ts`（3/3 通过）
  - **实现文件**：`src/engines/authGuard.ts`, `src/server.ts`
  - **目标**：实现 REST & SSE 全路由、管理员口令防爆破（5 次锁定 60 秒）与单机免密模式、`client_id` 会话强隔离、同哈希/同名版本冲突处理、API Key 脱敏回显。

### 阶段四：React 18 TSX 双栏溯源工作台与全量回归验收
- [x] **Task 4.1: 实现 React 18 TSX 双栏联动工作台 (`src/ui/index.html`, `styles.css`, `app.tsx`)**
  - **验收结果**：Babel Standalone TSX 离线编译通过，严格 `tsc --noEmit` 0 错误通过。
- [x] **Task 4.2: 全量测试门禁、实时端口探活与原子文档同步提交**
  - **验收结果**：`node --test` 6 个测试套件共 **22/22 测试用例 100% 绿灯通过（0 失败）**；实时 HTTP 服务探活 `GET /` 与 `GET /api/v1/health` 均返回 `200 OK`。
