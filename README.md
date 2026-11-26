# 🌟 AI 全栈工程研发与工作流资产库

本仓库采用**“产品工作流 + 开发工作流 + 测试工作流 + 缺陷修复 + 项目库”**一体化闭环架构，实现从业务构想孵化、严谨需求定义、TDD 工程代码落地到自动化测试与缺陷闭环的完整敏捷研发流程。

---

## 🏛️ 仓库顶层架构

```text
ai-workflow-studio/
├── workflows/                          # 🛠️ 工作流体系
│   ├── product/                        # 1. 产品工作流 (PM Superpower 需求拆解与 PRD 产出)
│   │   ├── README.md                   # 产品工作流使用指南
│   │   ├── templates/                  # 标准 PRD 文档模板
│   │   └── references/                 # Superpower 苏格拉底启发式提问方法论
│   ├── development/                    # 2. 开发工作流 (研发架构、微任务拆解与 TDD 落地)
│   │   ├── README.md                   # 开发工作流使用指南
│   │   ├── templates/                  # TRD 架构设计 / 任务拆解模板
│   │   └── references/                 # TDD 与工程最佳实践规范
│   └── test/                           # 3. 测试工作流 (六维测试用例设计、自动化执行与报告)
│       ├── README.md                   # 测试工作流使用指南
│       ├── templates/                  # TEST / REPORT 文档模板
│       └── references/                 # 六维检查表与执行指南
│
├── projects/                           # 📦 4. 项目库 (独立实战工程资产)
│   ├── README.md                       # 项目库索引与管理规范
│   ├── AgentRelay/                     # 远程 AI 任务守望伴侣 (CLI + React 18 H5 + Win32)
│   ├── AI-StoryBoard-Studio/           # 剧创 AI 智能分镜工场 (4 阶 Multi-Agent + AntD/React)
│   ├── LexRAG/                         # 法律法规条文级溯源与智能咨询系统 (混合检索 + 防幻觉)
│   └── ToneRelay/                      # 智能影调迁移与批量修图伴侣 (Pitié 3D + 导向滤波)
│
├── .agents/                            # 🤖 AI 智能体协同技能 (Skills)
│   └── skills/
│       ├── pm-superpower-prd/          # 产品经理技能
│       ├── dev-superpower-workflow/    # 研发工程师技能
│       ├── test-auto-workflow/         # 自动化测试技能
│       └── bug-fix-workflow/           # TDD 缺陷修复技能
│
├── GEMINI.md                           # 仓库全局工作流执行规则
└── README.md                           # 顶层主索引导航 (当前文件)
```

---

## 🧭 模块导航与快速入口

### 1. [产品工作流 (workflows/product/)](./workflows/product/README.md)
- **面向人群**：产品经理 (PM)、业务架构师。
- **核心理念**：基于 **Superpower 启发式问答**，分 3 轮（价值与边界 ➡️ 场景与动线 ➡️ 规则与异常）深度拆解需求，杜绝“未想清先动手”。
- **标准化产物**：输出工业级 [PRD 产品需求文档](./workflows/product/templates/prd-template.md)。

### 2. [开发工作流 (workflows/development/)](./workflows/development/README.md)
- **面向人群**：研发工程师、技术负责人。
- **核心理念**：基于 **Superpower 工程闭环**，严格遵循 `TRD 方案设计 ➡️ 微任务拆解 ➡️ TDD 测试驱动 ➡️ 隔离开发 ➡️ 门禁验证`。
- **标准化产物**：输出 [TRD 技术方案](./workflows/development/templates/trd-template.md) 与 [任务拆解表](./workflows/development/templates/task-breakdown-template.md)。

### 3. [测试工作流 (workflows/test/)](./workflows/test/README.md)
- **面向人群**：QA 工程师、全栈开发者。
- **核心理念**：基于 PRD 自动提取六维检查点，生成结构化测试用例并驱动自动化执行与失败留证，形成缺陷修复闭环。

### 4. [项目库 (projects/)](./projects/README.md)
- **管理方式**：每个项目均作为独立单元管理，拥有专属的 `docs/`（PRD/TRD/Tasks）、`src/` 与 `tests/`。
- **现有项目**：
  - **[AgentRelay 远程 AI 任务伴侣](./projects/AgentRelay/README.md)**：面向长耗时本地 AI 编程任务的轻量守望中继工具，支持无侵入多引擎监听与手机端一键人工裁决（HITL）。
  - **[AI-StoryBoard-Studio 剧创 AI 智能分镜工场](./projects/AI-StoryBoard-Studio/README.md)**：基于四阶可插拔 Multi-Agent 工作流的小说分镜拆解、多生图模型 Prompt 适配与剪映 SRT 生成台。
  - **[LexRAG 法律法规条文级溯源与智能咨询系统](./projects/LexRAG/README.md)**：融合法典树结构化切分、SQLite FTS5 + 向量 RRF 混合检索与三重防幻觉白名单的本地智能咨询工作台。
  - **[ToneRelay 智能影调迁移与批量修图伴侣](./projects/ToneRelay/README.md)**：端侧实现 Pitié 3D 色彩概率分布传输、导向滤波与智能肤色保护的移动修图引擎。
