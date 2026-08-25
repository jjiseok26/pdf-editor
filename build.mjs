import { readFile, writeFile, mkdir } from 'fs/promises';
import path from 'path';

const root = process.cwd();
const read = p => readFile(path.join(root, p), 'utf8');

const [html, css, core, edit, io, fontkit, pdfjs, pdfLib, workerCode, fontB64, favSvg, favPng] = await Promise.all([
  read('index.html'),
  read('css/style.css'),
  read('js/core.js'),
  read('js/edit.js'),
  read('js/io.js'),
  read('assets/vendor/fontkit.umd.min.js'),
  read('assets/vendor/pdf.min.js'),
  read('assets/vendor/pdf-lib.min.js'),
  read('assets/vendor/pdf.worker.min.js'),
  readFile(path.join(root, 'assets/fonts/NanumGothic-Regular.ttf')).then(b => b.toString('base64')),
  read('assets/favicon.svg').then(s => Buffer.from(s).toString('base64')),
  readFile(path.join(root, 'assets/favicon.png')).then(b => b.toString('base64'))
]);

function toClassic(code) {
  return code
    .replace(/import\s*\{[^}]*\}\s*from\s*['"][^'"]+['"];?/g, '')
    .replace(/export\s+(?=(?:async\s+)?function\b|const\b|let\b|class\b)/g, '');
}

const appJs = [core, edit, io].map(toClassic).join('\n;\n');
await mkdir(path.join(root, 'tmp'), { recursive: true });
await writeFile(path.join(root, 'tmp/combined-check.js'), appJs);

const cssStandalone = css
  .replace(/@font-face\s*\{[^}]*\}\s*/g, '')
  .replace(':root', `@font-face {
  font-family: 'NanumGothic';
  src: url(data:font/ttf;charset=utf-8;base64,${fontB64}) format('truetype');
  font-weight: 400;
}
:root`);

let out = html
  .replace(/<script[^>]*><\/script>\s*\n?/g, '')
  .replace('<link rel="icon" type="image/svg+xml" href="assets/favicon.svg">',
    `<link rel="icon" type="image/svg+xml" href="data:image/svg+xml;base64,${favSvg}">`)
  .replace('<link rel="alternate icon" type="image/png" href="assets/favicon.png">',
    `<link rel="alternate icon" type="image/png" href="data:image/png;base64,${favPng}">`)
  .replace('<link rel="stylesheet" href="css/style.css">', `<style>\n${cssStandalone}\n</style>`)
  .replace('<title>PDF 편집기</title>', '<title>PDF 편집기 (오프라인)</title>');

const scripts = `
<script>${fontkit}</script>
<script>${pdfjs}</script>
<script>${pdfLib}</script>
<script>window.__PDF_WORKER_CODE__=${JSON.stringify(workerCode)};${workerCode};</script>
<script>
try {
  var __wsrc = URL.createObjectURL(new Blob([window.__PDF_WORKER_CODE__], { type: 'text/javascript' }));
  window.pdfjsLib.GlobalWorkerOptions.workerSrc = __wsrc;
} catch (e) { console.warn('워커 blob 생성 실패 - 메인 스레드 폴백 사용', e); }
window.__NANUM_FONT_B64__ = "${fontB64}";
delete window.__PDF_WORKER_CODE__;
</script>
<script>
${appJs}
</script>
`;
out = out.replace('</body>', `${scripts}\n</body>`);

await mkdir(path.join(root, 'dist'), { recursive: true });
const outFile = path.join(root, 'dist', 'PDF편집기.html');
await writeFile(outFile, out);
console.log('생성 완료:', outFile, Math.round(out.length / 1024 / 1024 * 10) / 10 + 'MB');
