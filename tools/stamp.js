/* Проставляет ассетам версию: assets/x.js?v=<отпечаток>.
   GitHub Pages отдаёт файлы с max-age=600, и после правки браузер ещё десять минут
   показывает старый JS. С версией в адресе обычного F5 достаточно: HTML перезапросится,
   а ссылки внутри уже указывают на новый файл.
   Отпечаток считается по содержимому ассетов, поэтому меняется только когда есть правки. */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const root = path.resolve(__dirname, '..');
const assetsDir = path.join(root, 'assets');
const pages = ['index.html', 'admin.html'];

const names = fs.readdirSync(assetsDir)
  .filter((f) => /\.(js|css)$/.test(f))
  .sort();

/* BUILD внутри admin.js сам равен отпечатку — иначе отпечаток «дрожит» от запуска
   к запуску. Берём файл с обнулённой строкой сборки. */
function contentForHash(f) {
  const raw = fs.readFileSync(path.join(assetsDir, f), 'utf8');
  return f === 'admin.js' ? raw.replace(/var BUILD = '[^']*';/, "var BUILD = '';") : raw;
}

const hash = crypto.createHash('sha1');
names.forEach((f) => hash.update(contentForHash(f)));
const stamp = hash.digest('hex').slice(0, 8);

let touched = 0;
pages.forEach((page) => {
  const file = path.join(root, page);
  if (!fs.existsSync(file)) return;
  const before = fs.readFileSync(file, 'utf8');
  const after = before.replace(
    /(href|src)="assets\/([\w.-]+\.(?:js|css))(?:\?v=[0-9a-f]+)?"/g,
    (m, attr, name2) => attr + '="assets/' + name2 + '?v=' + stamp + '"'
  );
  if (after !== before) {
    fs.writeFileSync(file, after, 'utf8');
    touched++;
  }
});

/* строчка «сборка …» в редакторе: сразу видно, старая версия в браузере или новая */
const adminJs = path.join(assetsDir, 'admin.js');
const src = fs.readFileSync(adminJs, 'utf8');
const next = src.replace(/var BUILD = '[^']*';/, "var BUILD = '" + stamp + "';");
if (next !== src) {
  fs.writeFileSync(adminJs, next, 'utf8');
  console.log('BUILD обновлён в admin.js, страниц перезаписано: ' + touched);
} else {
  console.log('страниц перезаписано: ' + touched);
}
console.log('версия ассетов: ' + stamp);