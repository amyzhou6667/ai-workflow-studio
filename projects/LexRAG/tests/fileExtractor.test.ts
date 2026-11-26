import { test, describe } from 'node:test';
import assert from 'node:assert';
import zlib from 'node:zlib';
import {
  computeSha256,
  decodeChineseTextBuffer,
  extractDocxText,
  extractPdfText,
  extractTextFromBuffer,
  MAX_UPLOAD_BYTES
} from '../src/engines/fileExtractor.ts';
import { LexRagError } from '../src/types/index.ts';

function buildMinimalZipDocx(xmlContent: string): Buffer {
  const fileNameBuf = Buffer.from('word/document.xml', 'utf-8');
  const rawXml = Buffer.from(xmlContent, 'utf-8');
  const compressed = zlib.deflateRawSync(rawXml);

  // Local file header (with bit 3 data descriptor flag 0x08 & zeroed sizes to test Central Dir parsing!)
  const localHeader = Buffer.alloc(30 + fileNameBuf.length);
  localHeader.writeUInt32LE(0x04034b50, 0);
  localHeader.writeUInt16LE(20, 4); // version needed
  localHeader.writeUInt16LE(0x0008, 6); // flag: bit 3 set
  localHeader.writeUInt16LE(8, 8); // deflate
  localHeader.writeUInt16LE(0, 10);
  localHeader.writeUInt16LE(0, 12);
  localHeader.writeUInt32LE(0, 14); // crc in descriptor
  localHeader.writeUInt32LE(0, 18); // compressed size 0 in local header
  localHeader.writeUInt32LE(0, 22); // uncompressed size 0 in local header
  localHeader.writeUInt16LE(fileNameBuf.length, 26);
  localHeader.writeUInt16LE(0, 28);
  fileNameBuf.copy(localHeader, 30);

  const dataDesc = Buffer.alloc(16);
  dataDesc.writeUInt32LE(0x08074b50, 0);
  dataDesc.writeUInt32LE(0, 4);
  dataDesc.writeUInt32LE(compressed.length, 8);
  dataDesc.writeUInt32LE(rawXml.length, 12);

  const cdOffset = localHeader.length + compressed.length + dataDesc.length;
  const cdHeader = Buffer.alloc(46 + fileNameBuf.length);
  cdHeader.writeUInt32LE(0x02014b50, 0);
  cdHeader.writeUInt16LE(20, 4);
  cdHeader.writeUInt16LE(20, 6);
  cdHeader.writeUInt16LE(0x0008, 8);
  cdHeader.writeUInt16LE(8, 10); // deflate
  cdHeader.writeUInt16LE(0, 12);
  cdHeader.writeUInt16LE(0, 14);
  cdHeader.writeUInt32LE(0, 16);
  cdHeader.writeUInt32LE(compressed.length, 20);
  cdHeader.writeUInt32LE(rawXml.length, 24);
  cdHeader.writeUInt16LE(fileNameBuf.length, 28);
  cdHeader.writeUInt16LE(0, 30);
  cdHeader.writeUInt16LE(0, 32);
  cdHeader.writeUInt16LE(0, 34);
  cdHeader.writeUInt16LE(0, 36);
  cdHeader.writeUInt32LE(0, 38);
  cdHeader.writeUInt32LE(0, 42); // local header offset
  fileNameBuf.copy(cdHeader, 46);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(cdHeader.length, 12);
  eocd.writeUInt32LE(cdOffset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([localHeader, compressed, dataDesc, cdHeader, eocd]);
}

function buildMinimalTextPdf(textContent: string, options: { encrypted?: boolean; scannedOnly?: boolean } = {}): Buffer {
  if (options.encrypted) {
    return Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Encrypt 2 0 R >>\nendobj\n%%EOF', 'latin1');
  }
  if (options.scannedOnly) {
    return Buffer.from(
      '%PDF-1.4\n1 0 obj\n<< /Type /Page /Contents 2 0 R >>\nendobj\n2 0 obj\n<< /Length 25 >>\nstream\nBT (1) Tj ET\nendstream\nendobj\n%%EOF',
      'latin1'
    );
  }
  const streamBody = Buffer.from(`BT /F1 12 Tf (${textContent}) Tj ET`, 'latin1');
  const deflated = zlib.deflateSync(streamBody);
  const head = Buffer.from(
    `%PDF-1.4\n1 0 obj\n<< /Type /Page /Contents 2 0 R >>\nendobj\n2 0 obj\n<< /Length ${deflated.length} /Filter /FlateDecode >>\nstream\n`,
    'latin1'
  );
  const tail = Buffer.from('\nendstream\nendobj\n%%EOF', 'latin1');
  return Buffer.concat([head, deflated, tail]);
}

describe('FileExtractor 多格式法典抽取与安全校验 (F-01)', () => {
  test('TC-FE-01: 正常解析 UTF-8 TXT 与 Markdown 并计算一致 SHA-256 哈希', () => {
    const content = '第一条 为了保护民事主体的合法权益，制定本法。';
    const buf = Buffer.from(content, 'utf-8');
    const resTxt = extractTextFromBuffer('民法典.txt', buf);
    const resMd = extractTextFromBuffer('民法典.md', buf);

    assert.strictEqual(resTxt.fileExt, '.txt');
    assert.strictEqual(resMd.fileExt, '.md');
    assert.strictEqual(resTxt.text.trim(), content);
    assert.strictEqual(resTxt.fileHash, computeSha256(buf));
    assert.strictEqual(resTxt.fileHash.length, 64);
  });

  test('TC-FE-02: 自动识别 GB18030/GBK 编码中文 TXT 避免乱码', () => {
    // "民法典第一条" in GB18030 bytes
    const gbBytes = Buffer.from([0xc3, 0xf1, 0xb7, 0xa8, 0xb5, 0xe4, 0xb5, 0xda, 0xd2, 0xbb, 0xcc, 0xf5]);
    const decoded = decodeChineseTextBuffer(gbBytes);
    assert.strictEqual(decoded, '民法典第一条');
  });

  test('TC-FE-03: 通过 ZIP Central Directory 成功解析含 Data Descriptor 的 DOCX word/document.xml', () => {
    const xml =
      '<?xml version="1.0" encoding="UTF-8"?>' +
      '<w:document><w:body>' +
      '<w:p><w:r><w:t>第三编 合同</w:t></w:r></w:p>' +
      '<w:p><w:r><w:t>第五百七十七条 当事人一方不履行合同义务的，应当承担继续履行、采取补救措施或者赔偿损失等违约责任。</w:t></w:r></w:p>' +
      '</w:body></w:document>';
    const docxBuf = buildMinimalZipDocx(xml);
    const extracted = extractDocxText(docxBuf);
    assert.ok(extracted.includes('第三编 合同'));
    assert.ok(extracted.includes('第五百七十七条'));

    const res = extractTextFromBuffer('合同编.docx', docxBuf);
    assert.strictEqual(res.fileExt, '.docx');
    assert.ok(res.text.includes('违约责任'));
  });

  test('TC-FE-04: 成功抽取文字版 PDF FlateDecode 内容层', () => {
    const pdfBuf = buildMinimalTextPdf('Article 577 Breach of Contract Liability and Compensation Rules for Parties.');
    const pdfRes = extractPdfText(pdfBuf);
    assert.strictEqual(pdfRes.pageCount, 1);
    assert.ok(pdfRes.text.includes('Article 577 Breach of Contract'));

    const res = extractTextFromBuffer('contract.pdf', pdfBuf);
    assert.strictEqual(res.fileExt, '.pdf');
    assert.ok(res.text.includes('Compensation Rules'));
  });

  test('TC-FE-05: 秒级拦截空文件、超大文件、不支持格式与伪造扩展名文件', () => {
    assert.throws(
      () => extractTextFromBuffer('empty.txt', Buffer.alloc(0)),
      (err: unknown) => err instanceof LexRagError && err.code === 'EMPTY_FILE'
    );

    const fakeOverSized = { length: MAX_UPLOAD_BYTES + 1 } as unknown as Buffer;
    assert.throws(
      () => extractTextFromBuffer('huge.txt', fakeOverSized),
      (err: unknown) => err instanceof LexRagError && err.code === 'FILE_TOO_LARGE'
    );

    assert.throws(
      () => extractTextFromBuffer('script.exe', Buffer.from('hello')),
      (err: unknown) => err instanceof LexRagError && err.code === 'UNSUPPORTED_FORMAT'
    );

    assert.throws(
      () => extractTextFromBuffer('fake.pdf', Buffer.from('not really a pdf document')),
      (err: unknown) => err instanceof LexRagError && err.code === 'MAGIC_MISMATCH'
    );

    assert.throws(
      () => extractTextFromBuffer('fake.docx', Buffer.from('not really a zip archive')),
      (err: unknown) => err instanceof LexRagError && err.code === 'MAGIC_MISMATCH'
    );
  });

  test('TC-FE-06: 拦截加密 PDF 与纯图片扫描件 PDF (平均每页 < 15 字符)', () => {
    const encryptedPdf = buildMinimalTextPdf('', { encrypted: true });
    assert.throws(
      () => extractTextFromBuffer('locked.pdf', encryptedPdf),
      (err: unknown) => err instanceof LexRagError && err.code === 'ENCRYPTED_PDF'
    );

    const scannedPdf = buildMinimalTextPdf('', { scannedOnly: true });
    assert.throws(
      () => extractTextFromBuffer('scan.pdf', scannedPdf),
      (err: unknown) => err instanceof LexRagError && err.code === 'SCANNED_PDF_REJECTED'
    );
  });

  test('TC-FE-07: 多字体 Identity-H ToUnicode (含 bfchar/bfrange 与字面量双字节 CID) 按坐标分行精准抽取中文', () => {
    const cmapFont1 = zlib.deflateSync(
      Buffer.from(
        `/CIDInit /ProcSet findresource begin
12 dict begin
begincmap
1 begincodespacerange
<0000> <FFFF>
endcodespacerange
6 beginbfchar
<0001> <7B2C>
<0002> <4E00>
<0003> <7F16>
<0004> <603B>
<0005> <5219>
<0006> <6761>
endbfchar
1 beginbfrange
<0010> <0012> <6CD5>
endbfrange
endcmap`,
        'latin1'
      )
    );
    const cmapFont2 = zlib.deflateSync(
      Buffer.from(
        `/CIDInit /ProcSet findresource begin
12 dict begin
begincmap
1 begincodespacerange
<0000> <FFFF>
endcodespacerange
2 beginbfchar
<0001> <0032>
<0002> <0030>
endbfchar
endcmap`,
        'latin1'
      )
    );
    const contentStream = zlib.deflateSync(
      Buffer.from(
        'BT\n' +
          '/FXF2 12 Tf 1 0 0 1 0 0 Tm 100 700 TD [(\x00\x01\x00\x02\x00\x01\x00\x02)] TJ\n' +
          '/FXF1 12 Tf 1 0 0 1 0 0 Tm 100 660 TD [(\x00\x01) 0.5 (\x00\x02) -10 (\x00\x03)] TJ\n' +
          '1 0 0 1 0 0 Tm 200 660 TD [(\x00\x04\x00\x05)] TJ\n' +
          '1 0 0 1 0 0 Tm 100 620 TD [(\x00\x01\x00\x02\x00\x06) -10 (\x00\x10\x00\x04\x00\x05\x00\x10\x00\x04\x00\x05\x00\x10\x00\x04\x00\x05\x00\x10\x00\x04\x00\x05\x00\x10\x00\x04\x00\x05)] TJ\n' +
          'ET',
        'latin1'
      )
    );

    const multiFontPdf = Buffer.concat([
      Buffer.from(
        '%PDF-1.7\n' +
          '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n' +
          '2 0 obj\n<< /Type /Pages /Count 1 /Kids [ 7 0 R ] >>\nendobj\n' +
          '3 0 obj\n<< /Type /Font /Subtype /Type0 /BaseFont /ABCDEF+SimSun /Encoding /Identity-H /ToUnicode 4 0 R >>\nendobj\n' +
          `4 0 obj\n<< /Length ${cmapFont1.length} /Filter /FlateDecode >>\nstream\n`,
        'latin1'
      ),
      cmapFont1,
      Buffer.from(
        `\nendstream\nendobj\n` +
          '5 0 obj\n<< /Type /Font /Subtype /Type0 /BaseFont /ABCDEF+TimesNewRoman /Encoding /Identity-H /ToUnicode 6 0 R >>\nendobj\n' +
          `6 0 obj\n<< /Length ${cmapFont2.length} /Filter /FlateDecode >>\nstream\n`,
        'latin1'
      ),
      cmapFont2,
      Buffer.from(
        `\nendstream\nendobj\n` +
          '7 0 obj\n<< /Type /Page /Parent 2 0 R /Resources << /Font << /FXF1 3 0 R /FXF2 5 0 R >> >> /Contents 8 0 R >>\nendobj\n' +
          `8 0 obj\n<< /Length ${contentStream.length} /Filter /FlateDecode >>\nstream\n`,
        'latin1'
      ),
      contentStream,
      Buffer.from('\nendstream\nendobj\n%%EOF', 'latin1')
    ]);

    const res = extractPdfText(multiFontPdf);
    assert.strictEqual(res.pageCount, 1);
    const lines = res.text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    assert.ok(lines.some((l) => l.includes('2020')), `Expected 2020 from FXF2 font, got: ${res.text}`);
    assert.ok(lines.some((l) => l.includes('第一编') && l.includes('总则')), `Expected 第一编 总则 on same line, got: ${res.text}`);
    assert.ok(lines.some((l) => /^第一条\s*法总则/.test(l)), `Expected 第一条 法总则 on new line, got: ${res.text}`);
  });
});
