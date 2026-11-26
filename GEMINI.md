# 仓库全局规则与工作流指令 (GEMINI.md)

本仓库采用“**产品 - 开发 - 测试 - 缺陷修复 - 项目库**”一体化闭环结构体系：
1. **产品工作流 (`workflows/product/`)**：负责从构想输入、Superpower 问答拆解到 PRD 产出。
2. **开发工作流 (`workflows/development/`)**：负责从 PRD、TRD 架构设计、微任务拆解到 TDD 编码实现。
3. **测试工作流 (`workflows/test/`)**：负责从 PRD 提取生成六维测试用例文档 (TEST)，驱动自动化测试执行并产出测试报告 (REPORT)。
4. **缺陷修复工作流 (`.agents/skills/bug-fix-workflow/`)**：负责对测试发现或用户反馈的缺陷进行精准复现、测试先行 (Red) 与定向修复 (Green)。
5. **项目介绍与架构提炼工作流 (`.agents/skills/project-intro/`)**：负责依据 `docs/架构.md` 六维标准，对目标工程深入探测并在 `interview-records/<项目名>/project-profile.md` 生成标准化架构介绍与简历画像。
6. **项目库 (`projects/`)**：存放具体项目的需求文档、技术方案、测试资产与源代码（如 `projects/AgentRelay/`）。

---

## 智能体协作行为规范

### 1. 产品阶段指令 (产品经理视角)
当用户提出新构想或产品需求时：
- 严格遵循 `workflows/product/` 下的 Superpower 问答拆解方法。
- 严禁未经问答对齐直接编写 PRD 或代码。
- 3 轮问答对齐后，统一将 PRD 产出至：`projects/<项目名称>/docs/prd/PRD-<项目名称>.md`。

### 2. 开发阶段指令 (研发视角)
当用户输入 `/dev-flow <PRD路径或项目名>`，或指示“根据 PRD 进行开发”时：
- 严格遵循 `workflows/development/` 下的工程闭环自动推进：
  1. **环境预检与风险门控**：检查工作区与安全合规；
  2. **TRD 方案设计与接口契约先行**：产出 TRD 至 `projects/<项目名称>/docs/trd/TRD-<项目名称>.md`，**强制使用 TypeScript 声明接口契约与数据模型**；
  3. **微任务拆解**：产出任务清单至 `projects/<项目名称>/docs/trd/tasks-<项目名称>.md`；
  4. **全局强制 TypeScript (TS) 规约**：
     - **凡涉及 JavaScript/Node.js/前端/脚本/CLI 的内容，强制且固定采用 TypeScript (.ts/.tsx)**，严禁新建或回退为 JavaScript (.js)；
     - 启动项目与执行脚本一律使用 TS 运行时指令（如 Node 22.6+ 原生 TS 支持、tsx 等），测试命令一律为 `*.test.ts`；
  5. **全局强制现代前端框架规约 (Vue / React + TS)**：
     - **凡涉及前端 Web、H5、移动端 UI、可视化控制台或交互界面的开发，强制且固定采用 Vue 3 或 React 实现组件化与状态驱动（搭配 TypeScript，即 `.vue` + TS 或 `.tsx`）**；
     - **严禁新建或回退为纯原生 HTML + 原生 JS/DOM 操控的裸页面**，彻底避免后续项目使用裸 HTML 堆砌交互；
     - 前端工程须支持离线/内网免外部强依赖（支持本地 vendor 或开箱即用运行时），确保局域网与内网环境高可用；
  6. **上下文隔离 TDD 编码**：在 `projects/<项目名称>/src/` 编写 TypeScript 代码，坚持测试先行（Red）与开发隔离（Green）；
  7. **0 失败门禁与原子文档提交**：测试 100% 通过，文档与代码在同一个 Commit 提交；
  8. **测试工作流衔接引导**：开发阶段闭环后，**必须向用户主动询问是否进入自动化测试工作流**：
     - 提示用户可输入 `/test-flow <项目名>` 一键启动自动化测试，或选择暂不测试。

### 3. 测试阶段指令 (QA/测试视角)
当用户输入 `/test-flow <PRD路径或项目名>`，或在开发完毕后选择进入测试工作流时：
- 严格遵循 `workflows/test/` 及 `.agents/skills/test-auto-workflow/` 规范推进：
  1. **依据 PRD 生成测试用例文档**：
     - 读取 `projects/<项目名称>/docs/prd/*.md` 需求文档；
     - 依据六维测试检查表（字段级/操作级/权限级/状态级/异常级/数据级）展开设计；
     - 标准化产出测试用例文档至 `projects/<项目名称>/docs/test/TEST-<项目名称>.md`；
     - 针对自动化测试需求，可选生成 YAML/Playwright 测试脚本至 `projects/<项目名称>/tests/e2e/`；
  2. **依据测试用例文档执行测试验证**：
     - 借助 `../test-auto-workflow` 脚本执行器（可通过环境变量指定路径运行 `python script_runner.py`）或 Playwright / 接口测试工具驱动测试；
     - 严格遵守**非熔断原则**（单条失败不中断后续用例）；
     - 失败用例自动截取屏幕证据并记录错误日志；
  3. **产出测试报告与缺陷回流**：
     - 测试完成后输出结构化报告至 `projects/<项目名称>/docs/test/REPORT-<项目名称>.md`；
     - 梳理缺陷清单，若存在缺陷，主动引导用户输入 `/bug-fix <缺陷编号>` 启动快速修复闭环。

### 4. 缺陷修复阶段指令 (Bug-Fix 视角)
当用户反馈 Bug、报错、异常或测试工作流沉淀缺陷时：
- 严格遵循 `.agents/skills/bug-fix-workflow/` 技能规范：
  1. **精准复现定位根因**：优先通过最小可执行命令/脚本或断言复现故障，捕获底层真实报错与堆栈，禁止未经复现盲猜改代码；
  2. **测试用例先行 (Red)**：若模块已有测试文件（`*.test.ts`），**必须先在测试文件中新增或修改测试用例**，精确复现故障并验证其运行失败（红灯）；若无测试文件则先建立测试基线；
  3. **针对性修复 (Green)**：修改业务源码根除缺陷，验证测试用例转绿；
  4. **全量回归防御**：执行所属项目全量测试套件（`node --test ...`），确保 100% 通过（0 失败门禁）。

### 5. 项目介绍与架构提炼指令 (Project-Intro 视角)
当用户输入 `/project-intro <项目路径>` 时：
- 严格遵循 `docs/架构.md` 的六大核心维度（业务背景与产品目标、系统架构与设计决策、数据模型与状态管理、代码目录结构与核心链路、基础设施与部署运维、依赖管理与周边集成）；
- 深入探测目标项目工程代码（包管理、分层结构、持久化实体、核心链路、部署配置等）；
- 自动生成符合 STAR 法则的双版本简历画像与五大面试考点，落盘归档至：`interview-records/<项目名>/project-profile.md`。

### 6. 项目库归档规范
所有项目均独立保存在 `projects/<项目名称>/` 目录下，包含独立的 README、docs（prd/trd/test）与 src/tests 目录。
- **技术栈固化**：
  - **后端/脚本/CLI**：统一固定为 TypeScript (`.ts`)，必须配置标准 `tsconfig.json`；
  - **前端/Web/UI**：统一固定为 **Vue 3 或 React**（配合 TypeScript，即 `.vue` 或 `.tsx`），禁止纯原生 HTML 交互实现。
