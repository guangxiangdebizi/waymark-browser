(function(){
  var I = window.WaymarkI18n, t = I.t, th = I.th;
  document.getElementById('language').addEventListener('change', async function(event) {
    event.target.disabled = true;
    try {
      var response = await fetch('/api/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ uiLanguage: event.target.value }) });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      location.reload();
    } catch (error) { event.target.value = I.locale; event.target.disabled = false; alert(t('操作失败：') + error.message); }
  });
  var L = window.AgentLabels;
  var ctx = { home: location.origin + '/home', api: location.origin };
  document.getElementById('search').addEventListener('submit', function(event){
    event.preventDefault();
    var value = document.getElementById('q').value.trim();
    if (!value) return;
    var url;
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value)) url = value;
    else if (/^(localhost|\d{1,3}(\.\d{1,3}){3})(:\d+)?(\/|$)/.test(value)) url = 'http://' + value;
    else if (!/\s/.test(value) && /^[^\s/]+\.[a-z]{2,}(:\d+)?(\/.*)?$/i.test(value)) url = 'https://' + value;
    else url = 'https://www.bing.com/search?q=' + encodeURIComponent(value);
    location.href = url;
  });
  document.querySelectorAll('[data-copy]').forEach(function(button){
    button.addEventListener('click', function(){
      var text = button.dataset.text || document.getElementById(button.dataset.copy).textContent;
      navigator.clipboard.writeText(text).then(function(){ button.textContent = t("已复制"); setTimeout(function(){ button.textContent = t("复制"); }, 1500); });
    });
  });
  function load(){
    fetch('/api/status').then(function(r){ return r.json(); }).then(function(s){
      if (s.uiLanguage && s.uiLanguage !== I.locale) { location.reload(); return; }
      var pending = (s.challenges || []).filter(function(j){ return ['human_required','ai_recovery_required','detected'].indexOf(j.status) >= 0; }).length;
      document.getElementById('s-ai').innerHTML = s.paused ? ("<span class=\"dot warn\"></span>" + th("已暂停（由你控制）") + "") : s.busy ? ("<span class=\"dot ok\"></span>" + th("正在操作") + "") : ("<span class=\"dot ok\"></span>" + th("就绪") + "");
      document.getElementById('s-clip').textContent = String(s.clipboardProvider).indexOf('virtual') >= 0 ? t("隔离（默认）") : t("系统全局");
      document.getElementById('s-mouse').textContent = s.ambientMouse && s.ambientMouse.enabled ? t("开启 · 只悬停不点击") : t("关闭");
      document.getElementById('s-today').textContent = s.todayActions + t(" 次");
      document.getElementById('s-ch').innerHTML = pending ? '<span class="status warn">' + pending + (" " + th("个需要处理") + "</span>") : ("<span class=\"status ok\">" + th("无") + "</span>");
    }).catch(function(){ document.getElementById('s-ai').innerHTML = ("<span class=\"dot bad\"></span>" + th("内核未连接") + ""); });
    fetch('/api/audit/events?limit=60&ambient=0').then(function(r){ return r.json(); }).then(function(events){
      var rows = L.collapseStarted(events).filter(function(e){ return L.ACT_ACTIONS.indexOf(e.action) >= 0; }).slice(0, 6);
      document.getElementById('recent').innerHTML = rows.length ? rows.map(function(e){
        var d = L.describe(e, ctx), where = L.place(e, ctx);
        return '<li><span class="ico">' + L.icon(d.icon) + '</span><span class="t">' + L.esc(d.what) + (where ? ' <span class="muted">· ' + L.esc(where) + '</span>' : '') + '</span>' + (e.status === 'failure' ? ("<span class=\"status failure\">" + th("失败") + "</span>") : '') + '<span class="w">' + L.esc(L.when(e.timestamp)) + '</span></li>';
      }).join('') : ("<li class=\"muted\">" + th("还没有 AI 操作。把上面的 MCP 地址交给 AI，它打开的每个页面、每次点击都会记在这里。") + "</li>");
    }).catch(function(){});
  }
  load(); setInterval(load, 5000);
})();
