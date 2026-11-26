# 自动化测试执行与验证指南

本指南说明如何在工作流中调度执行自动化测试，依托 Playwright 驱动及 `test-auto-workflow` 引擎进行用例执行、截图留证与结果汇总。

---

## 1. 测试执行基础架构

本工作区测试工作流集成了 `../test-auto-workflow` 自动化测试能力，支持双重执行模式：

### 模式 A：测试用例对照驱动执行 (LLM / Agent 协同测试)
- **适用场景**：通过浏览器自动化能力、真实 HTTP 接口或者 CLI 工具逐条验证生成的 `TEST-<项目名>.md`。
- **核心操作**：
  1. 打开被测目标服务（前端页面或后端接口）；
  2. 针对每个测试用例（`TC-xxx`），模拟用户操作或发送网络请求；
  3. 捕获实际返回（UI 状态、网络响应数据包、控制台输出）；
  4. 遇到断言失败时截取关键屏幕并记录详细错误；
  5. 记录执行结果（✅ 通过 / ❌ 失败 / ⚠️ 阻塞或跳过）。

### 模式 B：YAML 脚本与自动化引擎批量执行 (Pipe 自动化)
- **适用场景**：针对已生成 YAML 自动化测试脚本的批量快速回归。
- **执行命令**：
  ```powershell
  # 步骤 1：利用 yaml_generator 从需求文档生成测试脚本
  python ../test-auto-workflow/yaml_generator.py projects/<项目名>/docs/prd/PRD-<项目名>.md --output projects/<项目名>/tests/e2e/test_script.yaml

  # 步骤 2：执行测试脚本（Playwright 驱动，非熔断执行）
  python ../test-auto-workflow/script_runner.py projects/<项目名>/tests/e2e/test_script.yaml --url http://<服务地址> --api-base http://<API基地址> --project <项目名>
  ```

---

## 2. 核心执行准则

1. **非熔断设计 (Fail-Safe)**：
   - 单条测试用例的失败绝不能导致整个测试套件中断退出。
   - 每条测试用例使用独立捕获与隔离机制，确保全量用例遍历执行完毕。

2. **多维留证 (Evidence-First)**：
   - 界面测试失败时，必须保存失败时刻的屏幕截图（存入 `projects/<项目名>/docs/test/screenshots/` 或 reports 目录）。
   - 接口验证失败时，记录完整的请求 URL、Request Payload、Response Status 与 Response Body。

3. **测试数据安全与隔离**：
   - 敏感认证信息（Token、密钥、密码）优先通过环境变量（`.env`）注入，禁止明文提交。
   - 产生测试脏数据时，尽量具备清理机制（teardown）或使用独立隔离租户。
