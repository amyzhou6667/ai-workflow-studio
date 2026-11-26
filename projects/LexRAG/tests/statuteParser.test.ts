import { test, describe } from 'node:test';
import assert from 'node:assert';
import {
  arabicToChinese,
  chineseToArabic,
  normalizeArticleNumber,
  parseStatuteDocument
} from '../src/engines/statuteParser.ts';

describe('StatuteParser 法典结构感知切分与条号归一化 (F-02)', () => {
  test('TC-SP-01: 中文数字与阿拉伯数字条号双向准确转换', () => {
    assert.strictEqual(chineseToArabic('一'), 1);
    assert.strictEqual(chineseToArabic('十'), 10);
    assert.strictEqual(chineseToArabic('十八'), 18);
    assert.strictEqual(chineseToArabic('一百零五'), 105);
    assert.strictEqual(chineseToArabic('五百七十七'), 577);
    assert.strictEqual(chineseToArabic('一千二百六十'), 1260);

    assert.strictEqual(arabicToChinese(1), '一');
    assert.strictEqual(arabicToChinese(10), '十');
    assert.strictEqual(arabicToChinese(18), '十八');
    assert.strictEqual(arabicToChinese(105), '一百零五');
    assert.strictEqual(arabicToChinese(577), '五百七十七');
    assert.strictEqual(arabicToChinese(1260), '一千二百六十');

    assert.deepStrictEqual(normalizeArticleNumber('第五百七十七条'), {
      articleNumber: '第五百七十七条',
      articleNumNorm: '第577条'
    });
    assert.deepStrictEqual(normalizeArticleNumber('第577条'), {
      articleNumber: '第五百七十七条',
      articleNumNorm: '第577条'
    });
  });

  test('TC-SP-02: 准确解析编-分编-章-节-条层级，过滤目录噪音并注入面包屑前缀', () => {
    const sampleCode = `
目录
第一编 总则 …… 1
第五百七十七条 …… 88

第一编 总则
第一章 基本规定
第一条 为了保护民事主体的合法权益，调整民事关系，制定本法。
第二条 民法调整平等主体的自然人、法人和非法人组织之间的人身关系和财产关系。

第三编 合同
第一分编 通则
第八章 违约责任
第五百七十七条 当事人一方不履行合同义务或者履行合同义务不符合约定的，应当承担继续履行、采取补救措施或者赔偿损失等违约责任。
`;
    const parsed = parseStatuteDocument({
      docTitle: '中华人民共和国民法典',
      hierarchyLevel: '法律',
      text: sampleCode
    });

    assert.strictEqual(parsed.parseStrategy, 'statutory_tree');
    assert.strictEqual(parsed.chunks.length, 3);

    assert.strictEqual(parsed.chunks[0].articleNumber, '第一条');
    assert.strictEqual(parsed.chunks[0].articleNumNorm, '第1条');
    assert.strictEqual(parsed.chunks[0].bookTitle, '第一编 总则');
    assert.strictEqual(parsed.chunks[0].chapterTitle, '第一章 基本规定');

    const art577 = parsed.chunks[2];
    assert.strictEqual(art577.articleNumber, '第五百七十七条');
    assert.strictEqual(art577.articleNumNorm, '第577条');
    assert.strictEqual(art577.bookTitle, '第三编 合同');
    assert.strictEqual(art577.divisionTitle, '第一分编 通则');
    assert.strictEqual(art577.chapterTitle, '第八章 违约责任');
    assert.strictEqual(art577.sectionTitle, '');
    assert.ok(art577.breadcrumb.includes('第三编 合同'));
    assert.ok(art577.breadcrumb.includes('第八章 违约责任'));
    assert.ok(art577.embeddedText.startsWith('【中华人民共和国民法典 | 法律 |'));
    assert.ok(art577.embeddedText.includes('第五百七十七条'));
    assert.ok(!art577.content.includes('……'));
  });

  test('TC-SP-03: 超长法条按款段落拆分同时保留相同 articleNumber 与 articleNumNorm', () => {
    const p1 = '第一款规定：' + '合同双方应当诚实守信履行全部约定职责。'.repeat(45);
    const p2 = '第二款规定：' + '违约方未按期补救的应依法赔偿实际经济损失。'.repeat(45);
    const longStatute = `
第一章 总则
第一条 简短第一条。
第二条 ${p1}
${p2}
第三条 简短第三条。
`;
    const parsed = parseStatuteDocument({
      docTitle: '长条文测试法',
      hierarchyLevel: '法律',
      text: longStatute
    });

    assert.strictEqual(parsed.parseStrategy, 'statutory_tree');
    const art2Chunks = parsed.chunks.filter((c) => c.articleNumNorm === '第2条');
    assert.ok(art2Chunks.length >= 2, 'Expected overlong article 2 to split into multiple chunks');
    assert.ok(art2Chunks.every((c) => c.articleNumber === '第二条' && c.articleNumNorm === '第2条'));
  });

  test('TC-SP-04: 非标规范文档 (< 3 条第X条) 自动降级为段落滑动窗口切分', () => {
    const handbook = [
      '# 公司合规报销与考勤指引',
      '一、考勤打卡规范：' + '员工应当按规定时间完成上下班打卡，特殊外勤需提前在OA提交申请并经主管审批。'.repeat(8),
      '二、加班调休办法：' + '工作日延时工作经审批可优先安排等时长调休，法定节假日加班依法核算三倍加班工资。'.repeat(8),
      '三、费用报销时限：' + '所有差旅住宿及交通票据应在出差结束后十五个工作日内提交财务中心审核归档。'.repeat(8)
    ].join('\n\n');

    const parsed = parseStatuteDocument({
      docTitle: '员工合规手册',
      hierarchyLevel: '企业规章制度',
      text: handbook
    });

    assert.strictEqual(parsed.parseStrategy, 'sliding_window');
    assert.ok(parsed.chunks.length >= 2);
    assert.ok(parsed.chunks[0].embeddedText.startsWith('【员工合规手册 | 企业规章制度 |'));
  });

  test('TC-SP-05: 正确清理 PDF 标点空格与硬换行，支持独立“附则”归位及剥离底部免责声明', () => {
    const pdfExtractedText = `
目录
第一编 总则
第一章 基本规定
第七编 侵权责任
第十章 建筑物和物件损害责任

第一编 总则
第一章 基本规定
第一条 为了保护民事主体的合法权益 ， 调整民事关系 ， 适应中国特
色社会主义发展要求。
第二条 民法调整平等主体的自然人之间的人身关系和财产关系。
第七编 侵权责任
第十章 建筑物和物件损害责任
第一千二百五十八条 公共场所挖坑造成损害承担侵权责任。
附则
第一千二百六十条 本法自 2021 年 1 月 1 日起施行。
*** 本信息仅供参考 。 如有争议 ， 以发文单位有关文件为准 。 因使用本信息而造成不良后
果的，我单位不承担任何责任 ***
`;

    const parsed = parseStatuteDocument({
      docTitle: '中华人民共和国民法典',
      hierarchyLevel: '法律',
      text: pdfExtractedText
    });

    assert.strictEqual(parsed.parseStrategy, 'statutory_tree');
    assert.strictEqual(parsed.chunks.length, 4);
    assert.ok(parsed.chunks[0].content.includes('为了保护民事主体的合法权益，调整民事关系'));
    assert.ok(parsed.chunks[0].content.includes('适应中国特色社会主义发展要求。'));

    const art1260 = parsed.chunks[3];
    assert.strictEqual(art1260.articleNumNorm, '第1260条');
    assert.strictEqual(art1260.breadcrumb, '附则');
    assert.ok(!art1260.content.includes('本信息仅供参考'));
    assert.ok(!art1260.content.includes('不承担任何责任'));
  });
});
