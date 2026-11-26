import { test, describe, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { createLexRagApp, simulateRequest } from '../src/server.ts';
import type { LlmAdapter } from '../src/types/index.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const uiDir = path.resolve(__dirname, '..', 'src', 'ui');

describe('LexRAG Web Server, AuthGuard & React TSX UI 端到端集成测试 (F-01~F-10)', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lexrag-web-test-'));
  const mockLlm: LlmAdapter = {
    async complete({ systemPrompt, onToken }) {
      const m = systemPrompt.match(/\[CITE:(doc_[^\]]+)\]/);
      const cite = m ? m[1] : '';
      const out = `### 核心结论与定性\n根据已上传法典依据[CITE:${cite}]，违约方应当依法承担继续履行或赔偿损失责任。\n### 分步行动建议\n1. 固定合同及转账证据。\n### 建议保留的证据清单\n1. 书面合同、沟通记录。`;
      onToken?.(out);
      return out;
    }
  };

  const app = createLexRagApp({
    dataDir: tmpDir,
    adminPasscode: 'secret-2026',
    singleUserMode: false,
    llmAdapter: mockLlm
  });

  after(() => {
    app.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('TC-WEB-01: 静态页面与离线 React TSX 资产返回 200 且 app.tsx 可经 Babel 无错编译', async () => {
    const htmlRes = await simulateRequest(app.handler, 'GET', '/');
    assert.strictEqual(htmlRes.status, 200);
    assert.ok(htmlRes.text.includes('LexRAG'));
    assert.ok(htmlRes.text.includes('app.tsx'));

    const cssRes = await simulateRequest(app.handler, 'GET', '/styles.css');
    assert.strictEqual(cssRes.status, 200);
    assert.ok(cssRes.text.includes('--bg-canvas'));

    const tsxRes = await simulateRequest(app.handler, 'GET', '/app.tsx');
    assert.strictEqual(tsxRes.status, 200);
    assert.ok(tsxRes.text.includes('大众普法'));
    assert.ok(tsxRes.text.includes('企业合规'));
    assert.ok(tsxRes.text.includes('专业法研'));
    assert.ok(tsxRes.text.includes('非执业律师'));

    const vendorRes = await simulateRequest(app.handler, 'GET', '/vendor/react.production.min.js');
    assert.strictEqual(vendorRes.status, 200);

    const babelCode = fs.readFileSync(path.join(uiDir, 'vendor', 'babel.min.js'), 'utf-8');
    const context: Record<string, any> = {
      window: {},
      self: {},
      console,
      setTimeout,
      clearTimeout
    };
    context.window = context;
    context.self = context;
    vm.createContext(context);
    vm.runInContext(babelCode, context);

    const transformed = context.Babel.transform(tsxRes.text, {
      presets: ['react', 'typescript'],
      filename: 'app.tsx'
    });
    assert.ok(transformed.code && transformed.code.includes('React.createElement'));
  });

  test('TC-WEB-02: 管理员口令鉴权、5次错误冷却锁定及 API Key 掩码脱敏', async () => {
    const unauthDocs = await simulateRequest(app.handler, 'GET', '/api/v1/admin/documents');
    assert.strictEqual(unauthDocs.status, 401);

    for (let i = 0; i < 5; i++) {
      const badLogin = await simulateRequest(app.handler, 'POST', '/api/v1/auth/login', { passcode: 'wrong' });
      assert.strictEqual(badLogin.status, 401);
    }
    const locked = await simulateRequest(app.handler, 'POST', '/api/v1/auth/login', { passcode: 'secret-2026' });
    assert.strictEqual(locked.status, 429);

    const okLogin = await simulateRequest(
      app.handler,
      'POST',
      '/api/v1/auth/login',
      { passcode: 'secret-2026' },
      { 'x-forwarded-for': '10.0.0.99' }
    );
    assert.strictEqual(okLogin.status, 200);
    const token = okLogin.json().data.token as string;
    assert.ok(token.length > 10);

    const putCfg = await simulateRequest(
      app.handler,
      'PUT',
      '/api/v1/admin/settings',
      {
        llm: { baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-supersecret123456', model: 'deepseek-chat', timeoutMs: 15000 }
      },
      { authorization: `Bearer ${token}` }
    );
    assert.strictEqual(putCfg.status, 200);
    assert.ok(!putCfg.text.includes('sk-supersecret123456'));
    assert.ok(putCfg.json().data.llm.apiKeyMasked.includes('****'));
  });

  test('TC-WEB-03: 法典上传去重、同名冲突覆盖、会话 client_id 隔离与 SSE 咨询流', async () => {
    const loginRes = await simulateRequest(
      app.handler,
      'POST',
      '/api/v1/auth/login',
      { passcode: 'secret-2026' },
      { 'x-forwarded-for': '10.0.0.88' }
    );
    const token = loginRes.json().data.token as string;
    const authHeaders = { authorization: `Bearer ${token}` };

    const lawV1 = `
第三编 合同
第八章 违约责任
第五百七十七条 当事人一方不履行合同义务的，应当承担违约责任。
第五百七十八条 当事人一方明确表示不履行合同义务的，对方可以在履行期限届满前请求其承担违约责任。
第五百七十九条 当事人一方未支付价款的，对方可以请求其支付。
`;
    const up1 = await simulateRequest(
      app.handler,
      'POST',
      '/api/v1/admin/documents/upload',
      {
        fileName: '民法典.txt',
        title: '中华人民共和国民法典',
        hierarchyLevel: '法律',
        effectiveDate: '2021-01-01',
        contentBase64: Buffer.from(lawV1, 'utf-8').toString('base64')
      },
      authHeaders
    );
    assert.strictEqual(up1.status, 201);
    const doc1Id = up1.json().data.id as string;

    // Duplicate hash rejection
    const dupHash = await simulateRequest(
      app.handler,
      'POST',
      '/api/v1/admin/documents/upload',
      {
        fileName: '民法典副本.txt',
        title: '民法典副本',
        hierarchyLevel: '法律',
        effectiveDate: '2021-01-01',
        contentBase64: Buffer.from(lawV1, 'utf-8').toString('base64')
      },
      authHeaders
    );
    assert.strictEqual(dupHash.status, 409);
    assert.strictEqual(dupHash.json().errorCode, 'DUPLICATE_HASH');

    // Title conflict -> replace_old auto-disables previous version
    const lawV2 = lawV1 + '\n第五百八十条 当事人一方不履行非金钱债务的，对方可以请求履行。';
    const conflict = await simulateRequest(
      app.handler,
      'POST',
      '/api/v1/admin/documents/upload',
      {
        fileName: '民法典2025.txt',
        title: '中华人民共和国民法典',
        hierarchyLevel: '法律',
        effectiveDate: '2025-01-01',
        contentBase64: Buffer.from(lawV2, 'utf-8').toString('base64')
      },
      authHeaders
    );
    assert.strictEqual(conflict.status, 409);
    assert.strictEqual(conflict.json().errorCode, 'TITLE_CONFLICT');

    const replaced = await simulateRequest(
      app.handler,
      'POST',
      '/api/v1/admin/documents/upload',
      {
        fileName: '民法典2025.txt',
        title: '中华人民共和国民法典',
        hierarchyLevel: '法律',
        effectiveDate: '2025-01-01',
        conflictResolution: 'replace_old',
        contentBase64: Buffer.from(lawV2, 'utf-8').toString('base64')
      },
      authHeaders
    );
    assert.strictEqual(replaced.status, 201);

    const allDocs = await simulateRequest(app.handler, 'GET', '/api/v1/admin/documents', undefined, authHeaders);
    const oldDoc = allDocs.json().data.find((d: any) => d.id === doc1Id);
    assert.strictEqual(oldDoc.status, 'disabled');

    // Client session isolation & SSE chat
    const sessRes = await simulateRequest(
      app.handler,
      'POST',
      '/api/v1/sessions',
      { personaMode: 'public' },
      { 'x-client-id': 'client_user_1' }
    );
    assert.strictEqual(sessRes.status, 201);
    const sessionId = sessRes.json().data.id as string;

    const hijack = await simulateRequest(
      app.handler,
      'GET',
      `/api/v1/sessions/${sessionId}`,
      undefined,
      { 'x-client-id': 'client_attacker_2' }
    );
    assert.strictEqual(hijack.status, 403);

    const sseChat = await simulateRequest(
      app.handler,
      'POST',
      '/api/v1/chat',
      {
        sessionId,
        query: '对方合同违约第577条怎么处理',
        personaMode: 'public',
        stream: true
      },
      { 'x-client-id': 'client_user_1' }
    );
    assert.strictEqual(sseChat.status, 200);
    assert.ok(sseChat.text.includes('event: done'));
    assert.ok(sseChat.text.includes('核心结论与定性'));
  });
});
