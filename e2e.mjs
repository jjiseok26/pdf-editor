import puppeteer from 'puppeteer-core';
import path from 'path';
import fs from 'fs';
import os from 'os';

const target = process.argv[2] || 'http://localhost:5174/';
const dlDir = path.join(os.tmpdir(), 'pdf-e2e-dl');
fs.rmSync(dlDir, { recursive: true, force: true });
fs.mkdirSync(dlDir, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  headless: 'new', args: ['--no-sandbox', '--disable-gpu']
});
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 1000 });
const errors = [];
let step = '부팅';
page.on('pageerror', e => errors.push(`[${step}] 페이지오류: ` + e.message.slice(0, 200)));
page.on('console', m => { if ((m.type() === 'error' || m.type() === 'warn') && !m.text().includes('favicon')) errors.push(`[${step}] 콘솔: ` + m.text().slice(0, 200)); });
const cdp = await page.createCDPSession();
const bcdp = await browser.target().createCDPSession();
await bcdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dlDir });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = m => console.log('  ✓ ' + m);
const elCount = () => page.evaluate(() => document.querySelectorAll('#annoLayer .ael').length);

try {
  await page.goto(target, { waitUntil: 'networkidle2', timeout: 60000 });
  await sleep(2000);
  if (!await page.evaluate(() => !!(window.pdfjsLib && window.PDFLib && window.fontkit))) throw new Error('라이브러리 로드 실패');
  log('라이브러리 로드');

  step = 'PDF 열기';
  const [chooser] = await Promise.all([page.waitForFileChooser({ timeout: 8000 }), page.click('#btnOpen')]);
  await chooser.accept([path.resolve('test-input.pdf')]);
  await sleep(2500);
  const d1 = await page.evaluate(() => ({
    thumbs: document.querySelectorAll('#thumbs .th').length,
    canvas: document.querySelector('#pageCanvas').width > 0,
    workspace: !document.querySelector('#workspace').hidden
  }));
  if (d1.thumbs !== 2 || !d1.canvas || !d1.workspace) throw new Error('문서 로드 실패 ' + JSON.stringify(d1));
  log('PDF 열기 → 2페이지 렌더링');

  step = '텍스트 편집';
  await page.click('#chkTextMode');
  await sleep(1200);
  const spanCount = await page.evaluate(() => document.querySelectorAll('#textLayer .tl-span').length);
  if (!spanCount) throw new Error('텍스트 인식 실패');
  log('텍스트 인식: ' + spanCount + '개 스팬');
  const span = await page.$('#textLayer .tl-span');
  const sb = await span.boundingBox();
  const scx = sb.x + sb.width / 2, scy = sb.y + sb.height / 2;
  await page.mouse.click(scx, scy);
  await page.mouse.down({ clickCount: 2 });
  await page.mouse.up({ clickCount: 2 });
  await sleep(400);
  await page.keyboard.type('수정됨');
  await page.keyboard.press('Enter');
  await sleep(600);
  const edited = await page.evaluate(() => {
    const s = document.querySelector('#textLayer .tl-span.changed');
    return s ? s.textContent : null;
  });
  if (!edited || !edited.includes('수정됨')) throw new Error('텍스트 수정 실패: ' + edited);
  log('텍스트 수정 커밋: "' + edited.slice(0, 20) + '"');

  step = '도구 그리기';
  await page.click('#chkTextMode');
  await sleep(300);
  const pw = await (await page.$('#pageWrap')).boundingBox();
  async function drag(x1, y1, x2, y2) {
    await page.mouse.move(x1, y1); await page.mouse.down();
    await page.mouse.move((x1 + x2) / 2, (y1 + y2) / 2, { steps: 4 });
    await page.mouse.move(x2, y2, { steps: 4 }); await page.mouse.up();
    await sleep(250);
  }
  await page.click('[data-tool="rect"]');   await drag(pw.x + 50, pw.y + 300, pw.x + 180, pw.y + 380);
  await page.click('[data-tool="ellipse"]');await drag(pw.x + 220, pw.y + 300, pw.x + 320, pw.y + 380);
  await page.click('[data-tool="line"]');   await drag(pw.x + 340, pw.y + 310, pw.x + 480, pw.y + 370);
  await page.click('[data-tool="pen"]');    await drag(pw.x + 60, pw.y + 430, pw.x + 260, pw.y + 470);
  await page.click('[data-tool="hl"]');     await drag(pw.x + 55, pw.y + 695, pw.x + 350, pw.y + 700);
  let ec = await elCount();
  if (ec < 5) throw new Error('도구 그리기 실패: ' + ec + '개');
  log('도형/펜/형광펜 ' + ec + '개 생성');

  step = '텍스트 상자';
  await page.click('[data-tool="text"]');
  await page.mouse.click(pw.x + 100, pw.y + 540);
  await sleep(300);
  await page.keyboard.type('새 텍스트 박스');
  await page.keyboard.press('Escape');
  await sleep(500);
  const txt = await page.evaluate(() => document.querySelector('.ael-txt')?.textContent || '');
  if (!txt.includes('새 텍스트')) throw new Error('텍스트 상자 커밋 실패: ' + txt);
  log('텍스트 상자 추가');

  step = '이미지 삽입';
  fs.writeFileSync(path.join(os.tmpdir(), 'dot.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));
  await (await page.$('#fileImg')).uploadFile(path.join(os.tmpdir(), 'dot.png'));
  await sleep(800);
  if (!await page.evaluate(() => !!document.querySelector('#annoLayer img'))) throw new Error('이미지 삽입 실패');
  log('이미지 삽입');

  step = '서명';
  await page.click('#btnSig'); await sleep(400);
  const pad = await (await page.$('#sigPad')).boundingBox();
  await drag(pad.x + 30, pad.y + 60, pad.x + 200, pad.y + 90);
  await page.click('#sigOk'); await sleep(700);
  const imgs = await page.evaluate(() => document.querySelectorAll('#annoLayer img').length);
  if (imgs < 2) throw new Error('서명 삽입 실패');
  log('서명 삽입 (이미지 ' + imgs + '개)');

  step = '선택/삭제/실행취소';
  await page.click('[data-tool="select"]');
  const before = await elCount();
  await (await page.$('#annoLayer .ael')).click();
  await page.keyboard.press('Delete'); await sleep(400);
  const mid = await elCount();
  await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control');
  await sleep(400);
  const after = await elCount();
  if (!(mid === before - 1 && after === before)) throw new Error(`삭제/실행취소 실패 ${before}→${mid}→${after}`);
  log('삭제 후 Ctrl+Z 복원 (' + before + ')');

  step = '페이지 연산';
  await page.click('#btnAddPage'); await sleep(800);
  let n = await page.evaluate(() => document.querySelectorAll('#thumbs .th').length);
  if (n !== 3) throw new Error('빈 페이지 추가 실패');
  await page.hover('#thumbs .th');
  await page.click('#thumbs .th .th-del'); await sleep(600);
  n = await page.evaluate(() => document.querySelectorAll('#thumbs .th').length);
  if (n !== 2) throw new Error('페이지 삭제 실패');
  await page.click('#btnNext'); await sleep(900);
  const pn = await page.evaluate(() => document.querySelector('#pageNum').value);
  if (pn !== '2') throw new Error('페이지 이동 실패: ' + pn);
  log('페이지 추가/삭제/이동');

  step = 'PNG 저장';
  await page.click('#btnPng');
  let pngOk = false;
  for (let i = 0; i < 12; i++) { await sleep(500); if (fs.readdirSync(dlDir).some(f => f.endsWith('.png'))) { pngOk = true; break; } }
  if (!pngOk) throw new Error('PNG 저장 실패. dlDir: ' + fs.readdirSync(dlDir).join(', '));
  if (!fs.readdirSync(dlDir).some(f => f.endsWith('.png'))) throw new Error('PNG 저장 실패');
  log('PNG 다운로드');

  step = 'PDF 저장';
  await page.click('#btnSavePdf'); await sleep(3000);
  const pdfs = fs.readdirSync(dlDir).filter(f => f.endsWith('.pdf'));
  if (!pdfs.length) throw new Error('PDF 저장 실패');
  const bytes = fs.readFileSync(path.join(dlDir, pdfs[0]));
  if (bytes.subarray(0, 5).toString() !== '%PDF-') throw new Error('잘못된 PDF 시그니처');
  log('PDF 다운로드: ' + bytes.length + ' bytes (%PDF-)');
} catch (e) {
  errors.push(`[중단] ${step}: ` + String(e.message).slice(0, 300));
}
console.log(errors.length ? '\n=== 발견된 오류 (' + target + ') ===\n' + errors.join('\n') : '\n=== [' + target + '] 전체 기능 정상 ===');
await browser.close();








