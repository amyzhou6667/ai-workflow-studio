# AI 研发工程工作流 — Claude Code 项目配置

面向产品孵化、契约先行设计与上下文隔离 TDD 的多项目工作区，核心技术栈涵盖 TypeScript 全栈（Node.js 22+ / React 18 / Vue 3）及通用后端工程（Java / Python）。

## 文档体系

| 关键词 | 路径 | 说明 |
|--------|------|------|
| PRD | `projects/<项目名>/docs/prd/PRD-<项目名>.md` | 产品需求文档 |
| TRD / TAD | `projects/<项目名>/docs/trd/TRD-<项目名>.md` | 技术架构方案与接口契约 |
| 任务拆解 | `projects/<项目名>/docs/trd/tasks-<项目名>.md` | 微任务拆解与验收清单 |
| TEST | `projects/<项目名>/docs/test/TEST-<项目名>.md` | 六维测试用例文档 |
| REPORT | `projects/<项目名>/docs/test/REPORT-<项目名>.md` | 自动化测试执行报告 |
| 迭代计划 | `docs/superpowers/plans/<YYYY-MM-DD>-<功能>.md` | 专项迭代计划（含验收标准与接口契约） |
| 技术设计 | `docs/superpowers/specs/<YYYY-MM-DD>-<功能>-design.md` | 方案变更的设计文档 |

开始研发或测试前，先定位对应项目的 `docs/prd/`、`docs/trd/` 与 `docs/test/` 文档。

## Superpowers 编排器（通用入口）

**`/superpowers <任务>`** — 通用入口命令，自动执行环境预检 → 风险门 → 路由 → 子技能调度。

适用于任何不确定如何路由的任务，或在开始工作前需要评估环境和风险的情况。

编排器详细定义：`.claude/agents/superpowers-orchestrator.md`

## 多 Agent 体系（接口先行 + TDD 优先）

核心 Agent（通过 slash 命令触发，主 Agent 负责编排调度）：

| Agent | 命令 | 职责 |
|-------|------|------|
| 需求拆分 | `/requirement-design` | 读 PRD/TRD/TEST → 设计摘要 + **接口签名契约** + 迭代计划 |
| 代码开发 | `/code-dev` | 基于接口签名契约 + 验收标准实现代码，**禁读测试实现** |
| TDD | `/tdd` | 基于接口签名契约设计/补全测试 + 执行测试 + 分析失败 |
| Review | `/review` | 只读审查：模块解耦、安全、可维护性 |

辅助 Agent：

| Agent | 命令 | 职责 |
|-------|------|------|
| Superpowers | `/superpowers` | 通用入口：环境预检 → 风险门 → 路由 |
| 头脑风暴 | `/brainstorm` | 多角度方案探索与对比 |
| 计划编写 | `/plan` | 编写结构化迭代/实现计划 |
| 计划执行 | `/execute` | 按计划逐步执行 |
| 系统化调试 | `/systematic-debugging` | 系统化定位 Bug 根因 |
| 回归测试 | `/regression` | 选择并执行回归测试策略 |
| Review 反馈 | `/review-feedback` | 处理 Review 报告，落实修改 |
| 完成验证 | `/verify` | 提交前代码/文档/Git 三维验证 |
| 并行开发 | `/parallel` | 调度多个子 Agent 并行工作 |
| 事故响应 | `/incident` | 生产事故分级响应 |

编排命令：`/dev-flow <PRD/项目>` 研发流程、`/test-flow <项目/PRD>` 自动化测试流程、`/tdd-flow <需求>` TDD全流程、`/bug-fix <Bug>` 修复流程、`/superpowers <任务>` 通用入口。

## 上下文隔离规则（强制）

| Agent | 可读 | 禁读/禁写 |
|-------|------|----------|
| requirement-design | `docs/*`, `projects/*/docs/*`, 现有接口签名文件 | `tests/`, `src/test/`, `*.test.*` |
| code-dev | `docs/prd/*`, `docs/trd/*`, `src/` 业务代码, `docs/test/*`（仅文字用例） | **禁读 `tests/`, `src/test/`, `*.test.*`, `*.spec.*`** |
| tdd | `docs/test/*`, `tests/`, `src/test/`, 接口契约与 `src/`（只读） | **不改 `src/` 业务实现** |
| review | 全部可读 | **不可写任何文件** |

code-dev 与 tdd 之间严格隔离：code-dev 不看测试实现，tdd 不改业务代码。两者通过**接口签名契约**协同。

## 编排流程速查

**需求变更**：① requirement-design（产出接口签名契约）→ ② tdd + code-dev（接口先行，基于契约并行/串行）→ ③ tdd 执行测试 → ④ review

**Bug 修复**：① tdd 确认复现 → ② code-dev 修复 → ③ tdd 确认修复 → ④ review

详细编排见 `.claude/workflows/tdd-orchestration.md`，文档同步见 `.claude/workflows/doc-sync.md`，风险门见 `.claude/workflows/risk-gate.md`，环境预检见 `.claude/workflows/environment-precheck.md`。

## Agent 定义与命令

- Agent 定义 = Slash 命令定义：`.claude/agents/*.md`（文件名 = 命令名，头部 `command:` 标注）
- 薄壳型命令（指向 Agent 定义）：`.claude/commands/*.md`（与 Agent 同名，仅含参数引用）
- 编排型命令（含独立编排逻辑）：`.claude/commands/tdd-flow.md`、`.claude/commands/bug-fix.md`、`.claude/commands/doc-sync.md`
- 编排规则：`.claude/workflows/*.md`

## 项目约定

- **TypeScript 全栈工程（主栈）**：
  - 运行与测试：Node.js 22+ 原生 TS 运行时（`node --test projects/<项目名>/tests/*.test.ts`）或 `tsx`
  - 类型检查：`tsc --noEmit`
  - 前端规约：Vue 3 或 React + TSX 组件化驱动，支持离线/局域网免外部 CDN 运行
- **通用后端工程（Java / Python 等扩展栈）**：
  - Java：Java 21 + Spring Boot / Maven（`mvn test`、`mvn -q -DskipTests compile`）
  - Python：Python 3.11+ / FastAPI / `pytest`
- **分层约定**：路由/控制器 → 领域服务 → 存储/适配器，遵循统一的响应格式、异常处理、鉴权与日志脱敏约定
- 始终使用汉语回复

## 测试门控（强制，不可跳过）

**全量测试必须 0 失败才能提交和推送。不允许“容忍已有失败”。**

- 如果存在非本次引入的失败用例，**必须先修复旧失败**（可合并到当前 commit），然后再提交
- **提交前验证**：
  1. 执行对应项目全量自动化测试（如 `node --test projects/<项目名>/tests/*.test.ts` / `mvn test` / `pytest`），确认 100% 通过
  2. 执行类型检查或编译检查（如 `tsc --noEmit`）
  3. 同步更新关联文档后执行提交

> 历史教训：曾因“容忍无关失败”导致破窗效应，失败用例长期未修复。
> 唯一有效规则：**0 失败 = 通过，>0 失败 = 不通过，无例外。**

## 代码变更完成后强制文档检查（不可跳过）

**文档同步与 `git commit` 是同一个动作，不是两个步骤。**
每次准备提交时，按以下顺序执行，缺一不可：

```
① 全量测试与编译检查（必须 0 失败，有旧失败则先修复）
② 文档同步（见 .claude/workflows/doc-sync.md，有一项为「是」则必须先同步文档）
③ git add + git commit（文档和代码一起提交，同一个 commit）
```

**强制检查清单**（详见 `.claude/workflows/doc-sync.md`）：

| 检查项 | 若为「是」→ 必须同步的目标 |
|--------|--------------------------|
| 引入了新类 / 新模块 / 新文件？ | 对应项目 `TRD-<项目名>.md` 与 `README.md` |
| 修改了接口、数据模型或存储结构？ | 对应项目 `TRD-<项目名>.md` 接口契约与数据模型章节 |
| 改变了某个功能的行为或边界？ | 对应项目 `TEST-<项目名>.md`；必要时更新 `PRD-<项目名>.md` |
| 是独立功能迭代或 Bug Fix 升级为方案变更？ | 同步更新 `tasks-<项目名>.md` 或专题设计文档 |

**适用于所有流程（`/dev-flow`、`/tdd-flow`、`/plan`、手动实现），无例外。**

## 工程文件整理规则

当用户提到“工程文件整理”、“临时文件整理”时：

1. **删除临时性文档**：开发过程中的临时文件、预览文件、临时计划
2. **归档总结性文档**：已完成功能的实现总结归档
3. **代码清理**：删除调试日志，清理过时注释与敏感占位符
4. **更新 README**：确保文档索引准确

## 运行模式与环境配置

重大功能变更必须在测试阶段覆盖关键运行模式：

| 模式 | 验证重点 |
|------|---------|
| local（本地/内存/SQLite 隔离） | 基础逻辑校验、单元测试、离线降级与边界条件 |
| integration（容器/外部服务联调） | 数据库/向量库/LLM 网关连通性、集成测试、配置校验 |
| production（生产/离线部署） | 权限拦截、鉴权脱敏、静态资源离线可用性、稳定性 |

## 需求与功能开发核心规程

**Documents First**：严禁在未更新技术规格说明前直接修改核心逻辑。

1. **方案先行**：PRD 更新 → TRD/接口契约更新 → 测试用例更新
2. **实现**：基于契约与验收标准实现（TDD 上下文隔离）
3. **回归验证**：覆盖 local / integration / production 关键链路
4. **交付**：代码 + 文档同一 commit 提交
