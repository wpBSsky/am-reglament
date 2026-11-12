/* =============================================================================
   ХРАНИЛИЩЕ КОНТЕНТА

   Три режима, выбираются сами:
     local    — рядом работает server.py (или любой Python-хостинг): пароль
                проверяется на сервере, запись идёт на диск.
     github   — статический хостинг (GitHub Pages и подобное): чтение обычное,
                запись — коммит через API по токену. Токен лежит в admin.lock.json
                зашифрованным паролем (AES-GCM, ключ из PBKDF2), поэтому пароль
                остаётся единственным секретом, а lock-файл можно публиковать.
     readonly — ничего не настроено: страница читается, правка недоступна.

   У всех режимов один интерфейс: mode, load(), auth(password), publish(doc).
   ============================================================================= */
(function (global) {
  'use strict';

  var enc = new TextEncoder();
  var dec = new TextDecoder();

  function fail(status, message) {
    var e = new Error(message || ('HTTP ' + status));
    e.status = status;
    return e;
  }

  function readJson(url, opts) {
    return fetch(url, Object.assign({ cache: 'no-store' }, opts || {}))
      .then(function (r) {
        if (!r.ok) throw fail(r.status);
        return r.json();
      });
  }

  /* --- base64 <-> байты ---------------------------------------------------- */
  function b64Of(buf) {
    var bytes = new Uint8Array(buf), out = '';
    for (var i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
    return btoa(out);
  }

  function bufOf(b64) {
    var raw = atob(b64), bytes = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    return bytes;
  }

  function utf8B64(text) {
    return b64Of(enc.encode(text).buffer);
  }

  /* Blob -> base64 без FileReader (так проще ждать) */
  function blobToB64(blob) {
    if (blob && typeof blob.arrayBuffer === 'function') {
      return blob.arrayBuffer().then(function (buf) { return b64Of(buf); });
    }
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () {
        var res = String(fr.result || '');
        resolve(res.slice(res.indexOf(',') + 1));
      };
      fr.onerror = function () { reject(fail(500, 'Не смог прочитать файл')); };
      fr.readAsDataURL(blob);
    });
  }

  /* --- пароль → ключ ------------------------------------------------------- */
  function subtle() {
    var c = global.crypto;
    if (!c || !c.subtle) {
      throw fail(0, 'Браузер не даёт шифрование (нужен https или localhost)');
    }
    return c.subtle;
  }

  function deriveKey(password, salt, iter) {
    var s = subtle();
    return s.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey'])
      .then(function (base) {
        return s.deriveKey(
          { name: 'PBKDF2', salt: salt, iterations: iter, hash: 'SHA-256' },
          base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
      });
  }

  /* --- lock-файл ----------------------------------------------------------- */
  /* Собирает содержимое admin.lock.json: секрет (токен и адрес репозитория)
     шифруется паролем. Без пароля файл бесполезен даже при публичном доступе. */
  function makeLock(secret, password) {
    var s = subtle();
    var salt = global.crypto.getRandomValues(new Uint8Array(16));
    var iv = global.crypto.getRandomValues(new Uint8Array(12));
    var iter = 210000;
    return deriveKey(password, salt, iter).then(function (key) {
      return s.encrypt({ name: 'AES-GCM', iv: iv }, key, enc.encode(JSON.stringify(secret)));
    }).then(function (cipher) {
      return {
        v: 1,
        kdf: { name: 'PBKDF2-SHA256', iter: iter, salt: b64Of(salt.buffer) },
        cipher: { name: 'AES-GCM', iv: b64Of(iv.buffer) },
        data: b64Of(cipher)
      };
    });
  }

  function openLock(lock, password) {
    if (!lock || !lock.kdf || !lock.data) throw fail(401, 'Файл admin.lock.json испорчен');
    return deriveKey(password, bufOf(lock.kdf.salt), lock.kdf.iter)
      .then(function (key) {
        return subtle().decrypt(
          { name: 'AES-GCM', iv: bufOf(lock.cipher.iv) }, key, bufOf(lock.data));
      })
      .then(function (plain) {
        return JSON.parse(dec.decode(plain));
      })
      .catch(function () {
        throw fail(401, 'Пароль не подошёл');
      });
  }

  /* --- локальный сервер (server.py) --------------------------------------- */
  function localStore() {
    var pass = '';
    return {
      mode: 'local',
      canUpload: true,
      load: function () { return readJson('api/content?t=' + Date.now()); },
      auth: function (password) {
        return readJson('api/auth', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: password })
        }).then(function () { pass = password; return true; }, function () {
          throw fail(401, 'Пароль не подошёл');
        });
      },
      publish: function (doc) {
        return readJson('api/content?t=' + Date.now(), {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', 'X-AM-Pass': pass },
          body: JSON.stringify(doc)
        }).then(function (res) { return res; }, function (e) {
          if (e.status === 401) throw fail(401, 'Сессия истекла — войдите заново');
          throw e;
        });
      },

      /* картинки и версии — есть только там, где есть сервер */
      upload: function (blob, name) {
        return fetch('api/upload', {
          method: 'POST',
          cache: 'no-store',
          headers: {
            'X-AM-Pass': pass,
            'X-File-Name': encodeURIComponent(name || 'image'),
            'Content-Type': blob.type || 'application/octet-stream'
          },
          body: blob
        }).then(function (r) {
          return r.json().then(function (data) {
            if (!r.ok || !data.ok) throw fail(r.status, data.error || 'не загрузилось');
            return data;
          });
        });
      },
      images: function () {
        return readJson('api/uploads', { headers: { 'X-AM-Pass': pass } })
          .then(function (res) { return res.items || []; });
      },
      removeImage: function (name) {
        return fetch('api/uploads?name=' + encodeURIComponent(name), {
          method: 'DELETE',
          headers: { 'X-AM-Pass': pass }
        }).then(function (r) { if (!r.ok) throw fail(r.status, 'не удалилось'); return true; });
      },
      history: function () {
        return readJson('api/history', { headers: { 'X-AM-Pass': pass } })
          .then(function (res) { return res.items || []; });
      },
      historyDoc: function (name) {
        return readJson('api/history/' + encodeURIComponent(name), { headers: { 'X-AM-Pass': pass } });
      },
      restore: function (name) {
        return readJson('api/restore', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-AM-Pass': pass },
          body: JSON.stringify({ name: name })
        });
      }
    };
  }

  /* --- статический хостинг: запись через API GitHub ----------------------- */
  function githubStore(cfg) {
    var api = (cfg.apiBase || 'https://api.github.com').replace(/\/+$/, '');
    var token = null;
    var repo = null;   /* {owner, repo, branch, path} — из lock-файла или конфига */

    function call(path, init) {
      return fetch(api + path, Object.assign({
        cache: 'no-store',
        headers: {
          Authorization: 'Bearer ' + token,
          Accept: 'application/vnd.github+json'
        }
      }, init || {})).then(function (r) {
        if (r.ok) return r.json().catch(function () { return {}; });
        if (r.status === 401 || r.status === 403) {
          throw fail(401, 'GitHub не принял токен: проверьте срок и право Contents: write');
        }
        if (r.status === 404) {
          throw fail(404, 'Репозиторий или файл не найден — проверьте адрес и права токена');
        }
        if (r.status === 409) throw fail(409, 'Конфликт: файл успели изменить, повторяю');
        return r.text().then(function (body) {
          throw fail(r.status, 'GitHub ответил ' + r.status + ': ' + body.slice(0, 140));
        });
      });
    }

    function contentsPath() {
      return '/repos/' + repo.owner + '/' + repo.repo + '/contents/' + repo.path;
    }

    var UPLOADS_DIR = 'assets/uploads/';

    function dirPath() {
      var dir = repo.path.replace(/[^/]+$/, '') + UPLOADS_DIR;
      return ('/repos/' + repo.owner + '/' + repo.repo + '/contents/' + dir).replace(/\/+$/, '');
    }

    /* кириллица в имени файла: приводим к латинице, иначе имя станет «.png» */
    function translit(text) {
      var map = {
        'а': 'a', 'б': 'b', 'в': 'v', 'г': 'g', 'д': 'd', 'е': 'e', 'ё': 'e', 'ж': 'zh',
        'з': 'z', 'и': 'i', 'й': 'y', 'к': 'k', 'л': 'l', 'м': 'm', 'н': 'n', 'о': 'o',
        'п': 'p', 'р': 'r', 'с': 's', 'т': 't', 'у': 'u', 'ф': 'f', 'х': 'h', 'ц': 'c',
        'ч': 'ch', 'ш': 'sh', 'щ': 'sch', 'ъ': '', 'ы': 'y', 'ь': '', 'э': 'e', 'ю': 'yu',
        'я': 'ya', 'і': 'i', 'ї': 'i', 'є': 'e', 'ґ': 'g'
      };
      return String(text || '').toLowerCase().split('').map(function (ch) {
        return Object.prototype.hasOwnProperty.call(map, ch) ? map[ch] : ch;
      }).join('');
    }

    function putFile(path, name, b64, sha, message) {
      var body = { message: message, content: b64, branch: repo.branch };
      if (sha) body.sha = sha;
      return call(path + '/' + encodeURIComponent(name), {
        method: 'PUT',
        headers: {
          Authorization: 'Bearer ' + token,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
      });
    }

    function readSha() {
      return call(contentsPath() + '?ref=' + encodeURIComponent(repo.branch))
        .then(function (res) { return res && res.sha ? res.sha : null; })
        .catch(function (e) {
          if (e.status === 404) return null;   /* файла ещё нет — создадим */
          throw e;
        });
    }

    function push(doc, attempt) {
      return readSha().then(function (sha) {
        var body = {
          message: 'Регламент: правка через встроенный редактор',
          content: utf8B64(JSON.stringify(doc, null, 2) + '\n'),
          branch: repo.branch
        };
        if (sha) body.sha = sha;
        return call(contentsPath(), {
          method: 'PUT',
          headers: {
            Authorization: 'Bearer ' + token,
            Accept: 'application/vnd.github+json',
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(body)
        }).catch(function (e) {
          if (e.status === 409 && (attempt || 0) < 1) return push(doc, (attempt || 0) + 1);
          throw e;
        });
      });
    }

    return {
      mode: 'github',
      load: function () { return readJson('content.json?t=' + Date.now()); },
      auth: function (password) {
        return readJson(cfg.lock || 'admin.lock.json', { cache: 'no-store' })
          .catch(function () { throw fail(500, 'Нет файла admin.lock.json рядом со страницей'); })
          .then(function (lock) { return openLock(lock, password); })
          .then(function (secret) {
            if (!secret || !secret.token) throw fail(401, 'В lock-файле нет токена');
            token = secret.token;
            repo = {
              owner: secret.owner || cfg.owner,
              repo: secret.repo || cfg.repo,
              branch: secret.branch || cfg.branch || 'main',
              path: secret.path || cfg.path || 'content.json'
            };
            if (!repo.owner || !repo.repo) throw fail(500, 'В настройках нет владельца или имени репозитория');
            return readSha();   /* заодно проверяем, что токен действительно работает */
          })
          .then(function () { return true; });
      },
      publish: function (doc) {
        if (!token) return Promise.reject(fail(401, 'Сначала войдите'));
        return push(doc).then(function (res) { return { savedAt: res && res.commit ? res.commit.sha : null }; });
      },
      canUpload: true,
      /* картинки — тоже коммитом в репозиторий (каждая загрузка = коммит) */
      upload: function (blob, name) {
        if (!token) return Promise.reject(fail(401, 'Сначала войдите'));
        var clean = translit(name || 'image').replace(/[^a-z0-9.\-]+/g, '-').replace(/^-+|-+$/g, '');
        var stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
        var fileName = stamp + '-' + (clean || 'image');
        return blobToB64(blob).then(function (b64) {
          return putFile(dirPath(), fileName, b64, null, 'Картинка: ' + fileName);
        }).then(function () {
          return { ok: true, name: fileName, url: UPLOADS_DIR + fileName, bytes: blob.size };
        });
      },
      images: function () {
        if (!token) return Promise.reject(fail(401, 'Сначала войдите'));
        return call(dirPath() + '?ref=' + encodeURIComponent(repo.branch))
          .then(function (list) {
            if (!Array.isArray(list)) return [];
            return list.filter(function (it) {
              return it.type === 'file' && /\.(png|jpe?g|webp|gif|avif)$/i.test(it.name);
            }).map(function (it) {
              return { name: it.name, url: UPLOADS_DIR + it.name, bytes: it.size, sha: it.sha };
            });
          })
          .catch(function (e) {
            if (e.status === 404) return [];   /* папки ещё нет */
            throw e;
          });
      },
      removeImage: function (name) {
        if (!token) return Promise.reject(fail(401, 'Сначала войдите'));
        var fileName = String(name || '').replace(/^.*\//, '');
        return call(dirPath() + '/' + encodeURIComponent(fileName) + '?ref=' + encodeURIComponent(repo.branch))
          .then(function (file) {
            return call(dirPath() + '/' + encodeURIComponent(fileName), {
              method: 'DELETE',
              headers: {
                Authorization: 'Bearer ' + token,
                Accept: 'application/vnd.github+json',
                'Content-Type': 'application/json'
              },
              body: JSON.stringify({
                message: 'Картинка удалена: ' + fileName,
                sha: file && file.sha,
                branch: repo.branch
              })
            });
          });
      },
      /* история версий — это история коммитов GitHub, своей ленты тут нет */
      history: noServer().history,
      historyDoc: noServer().historyDoc,
      restore: noServer().restore
    };
  }

  /* --- только чтение ------------------------------------------------------ */
  function readonlyStore() {
    return {
      mode: 'readonly',
      load: function () { return readJson('content.json?t=' + Date.now()); },
      auth: function () { return Promise.reject(fail(501, 'Публикация не настроена: соберите site-config.json')); },
      publish: function () { return Promise.reject(fail(501, 'Публикация не настроена: соберите site-config.json')); },
      canUpload: false,
      upload: noServer().upload,
      images: noServer().images,
      removeImage: noServer().removeImage,
      history: noServer().history,
      historyDoc: noServer().historyDoc,
      restore: noServer().restore
    };
  }

  function readConfig() {
    return fetch('site-config.json?t=' + Date.now(), { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; });
  }

  /* --- то, чего без сервера не бывает -------------------------------------- */
  function noServer() {
    var no = function () {
      return Promise.reject(fail(501, 'В этом режиме нет сервера: картинки и история версий недоступны'));
    };
    return { upload: no, images: no, removeImage: no, history: no, historyDoc: no, restore: no };
  }

  function init() {
    return readConfig().then(function (cfg) {
      if (cfg && (cfg.store === 'github' || cfg.github)) {
        return githubStore(cfg.github || cfg);
      }
      return fetch('api/ping?t=' + Date.now(), { cache: 'no-store' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .catch(function () { return null; })
        .then(function (ping) {
          return ping && ping.ok ? localStore() : readonlyStore();
        });
    });
  }

  global.AMStore = {
    init: init,
    makeLock: makeLock,
    openLock: openLock,
    utf8B64: utf8B64
  };
})(window);