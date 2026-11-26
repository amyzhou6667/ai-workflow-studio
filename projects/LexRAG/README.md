# ⚖️ LexRAG - 法律法规条文级溯源与智能咨询系统

> 基于用户上传法律法规构建封闭可控知识库，融合“编-分编-章-节-条”树状解析、SQLite FTS5 + 向量混合检索、三重防幻觉白名单门控与 React TSX 双栏原文溯源工作台，实现“零幻觉、可核验、多视角”的智能法律咨询闭环。

---

## 📚 项目全景与工程文档

- **产品需求文档 (PRD)**：[PRD-LexRAG.md](./docs/prd/PRD-LexRAG.md)
- **技术架构方案 (TRD)**：[TRD-LexRAG.md](./docs/trd/TRD-LexRAG.md)
- **微任务拆解与验收清单 (Tasks)**：[tasks-LexRAG.md](./docs/trd/tasks-LexRAG.md)

---

## 💡 核心工程实现

1. **多格式法典抽取与安全门控 (`src/engines/fileExtractor.ts`)**：
   - 支持 `.txt` / `.md`（UTF-8 与 GB18030 中文编码自动识别）、`.docx`（ZIP Central Directory 解析）、文字版 `.pdf`（FlateDecode 流与 ToUnicode CMap 抽取）；
   - 前置拦截空文件、超 50MB 文件、魔数不符文件、加密 PDF 与无文字层纯图片扫描件 PDF，并基于 SHA-256 实现秒级重复校验。
2. **法典结构感知切分与条号归一化 (`src/engines/statuteParser.ts`)**：
   - 精准解析“编-分编-章-节-条”层级结构，过滤目录页噪音，为每个条文切片注入完整层级面包屑前缀；
   - 实现中文数字与阿拉伯数字条号双向归一化（如 `第五百七十七条` ⇄ `第577条`），非标文档自动降级为 600 字段落滑动窗口切分。
3. **混合检索与三重防幻觉门控 (`src/engines/hybridRetriever.ts` + `hallucinationGuard.ts`)**：
   - 结合近 3 轮上下文口语法律化改写，并行执行本地 256 维语义特征向量（或外部 OpenAI 兼容 Embedding）Top-15 与 SQLite FTS5 BM25 Top-15 检索，经 RRF (`k=60`) 融合重排；
   - 通过前置伦理拦截、低相关性诚实拒答与生成后置 `[CITE:chunkId]` / 条号白名单校验杜绝法条编造。
4. **多视角咨询、引用快照与高可用降级 (`src/engines/consultationEngine.ts`)**：
   - 支持**大众普法 / 企业合规 / 专业法研**三大视角切换及会话级法典范围多选；
   - 每条回答同步持久化 `CitationSnapshot`（含目标条文及前后各 2 条邻近条文），源文档停用或删除后历史会话仍可完整溯源；
   - 外部大模型未配置、超时或限流时自动切换为“法条直出降级模式”。
5. **双栏联动溯源工作台 (`src/ui/app.tsx`)**：
   - 全栈 TypeScript 实现，前端基于 React 18 TSX + 离线 Vendor，支持局域网/内网免外网依赖直接启动。

---

## 🚀 启动与测试指南

### 1. 执行全量自动化测试套件
```bash
node --test projects/LexRAG/tests/*.test.ts
```
> 当前测试门禁：**6 个套件共 22/22 绿灯通过（0 失败）**，严格 TypeScript 类型检查 (`tsc --noEmit`) **0 错误**。

### 2. 启动本地 Web 服务
```bash
node projects/LexRAG/src/server.ts --port 3100
```
浏览器访问 `http://localhost:3100` 即可打开 LexRAG 双栏咨询工作台：
- 管理员默认口令为 `lexrag-admin`（可通过 `ADMIN_PASSCODE` 修改，或设置 `SINGLE_USER_MODE=true` 开启单机免密模式）；
- 点击页面顶部【导入示范法典】即可一键导入内置《中华人民共和国民法典（核心编章）》与《中华人民共和国劳动合同法（核心条款）》体验完整流程。
