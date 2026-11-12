/* Мастер настройки публикации: собирает site-config.json и admin.lock.json.
   Работает целиком в браузере, токен никуда не отправляется. */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var out = $('out'), hint = $('fHint'), built = {};

  function download(name, text) {
    var blob = new Blob([text], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 0);
  }

  function trim(v) { return String(v || '').trim(); }

  $('setupForm').addEventListener('submit', function (e) {
    e.preventDefault();
    hint.textContent = '';

    var owner = trim($('fOwner').value);
    var repo = trim($('fRepo').value);
    var branch = trim($('fBranch').value) || 'main';
    var path = trim($('fPath').value) || 'content.json';
    var token = trim($('fToken').value);
    var pass = $('fPass').value;

    if (owner.indexOf('/') > -1 && !repo) {
      hint.textContent = 'Похоже, в поле «Владелец» вставлен весь адрес. Впишите отдельно логин и имя репозитория.';
      return;
    }
    if (!/^[A-Za-z0-9._-]+$/.test(owner) || !/^[A-Za-z0-9._-]+$/.test(repo)) {
      hint.textContent = 'Логин и имя репозитория — только латиница, цифры, точка, дефис и подчёркивание.';
      return;
    }
    if (pass !== $('fPass2').value) {
      hint.textContent = 'Пароли не совпадают.';
      return;
    }
    if (pass.length < 5) {
      hint.textContent = 'Пароль короче пяти символов.';
      return;
    }
    if (token.length < 20) {
      hint.textContent = 'Не похоже на токен — он длинный, начинается с github_pat_ или ghp_.';
      return;
    }

    $('fBuild').disabled = true;
    hint.textContent = 'Считаю ключ…';

    window.AMStore.makeLock({
      token: token, owner: owner, repo: repo, branch: branch, path: path
    }, pass).then(function (lock) {
      var cfg = {
        store: 'github',
        owner: owner,
        repo: repo,
        branch: branch,
        path: path,
        lock: 'admin.lock.json'
      };
      var cfgText = JSON.stringify(cfg, null, 2) + '\n';
      var lockText = JSON.stringify(lock, null, 2) + '\n';
      built['site-config.json'] = cfgText;
      built['admin.lock.json'] = lockText;
      $('outConfig').textContent = cfgText;
      $('outLock').textContent = lockText;
      out.hidden = false;
      hint.textContent = 'Готово. Скачайте оба файла и положите в корень репозитория.';
      out.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }).catch(function (err) {
      hint.textContent = 'Не получилось: ' + (err && err.message ? err.message : err);
    }).then(function () { $('fBuild').disabled = false; });
  });

  Array.prototype.forEach.call(document.querySelectorAll('[data-save]'), function (b) {
    b.addEventListener('click', function () {
      var name = b.getAttribute('data-save');
      if (built[name]) download(name, built[name]);
    });
  });
})();