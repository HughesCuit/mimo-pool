export const adminHtml = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>小米 Mimo 号池</title>
  <style>
    :root { color-scheme: light; font-family: Inter, "Segoe UI", system-ui, sans-serif; background: #f6f7f9; color: #17202a; }
    * { box-sizing: border-box; }
    body { margin: 0; }
    .hidden { display: none !important; }
    header { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 16px 24px; border-bottom: 1px solid #dfe3e8; background: #fff; }
    h1 { font-size: 20px; margin: 0; letter-spacing: 0; }
    h2 { font-size: 16px; margin: 0 0 14px; }
    main { max-width: 1220px; margin: 0 auto; padding: 22px; display: grid; gap: 18px; }
    section, .panel { background: #fff; border: 1px solid #dfe3e8; border-radius: 8px; padding: 18px; }
    .login-wrap { min-height: 100vh; display: grid; place-items: center; padding: 24px; }
    .login-card { width: min(420px, 100%); background: #fff; border: 1px solid #dfe3e8; border-radius: 8px; padding: 24px; display: grid; gap: 14px; }
    .row { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
    .stack { display: grid; gap: 10px; }
    .toolbar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    input, textarea, select { border: 1px solid #c8d0d9; border-radius: 6px; padding: 8px 10px; font: inherit; background: #fff; min-width: 0; }
    textarea { width: 100%; resize: vertical; }
    button { border: 1px solid #1f6feb; background: #1f6feb; color: #fff; border-radius: 6px; padding: 8px 12px; font: inherit; cursor: pointer; }
    button.secondary { background: #fff; color: #1f2937; border-color: #c8d0d9; }
    button.danger { background: #c2410c; border-color: #c2410c; }
    button.tab { background: #fff; color: #1f2937; border-color: #c8d0d9; }
    button.tab.active { background: #17202a; color: #fff; border-color: #17202a; }
    table { width: 100%; border-collapse: collapse; font-size: 14px; }
    th, td { border-bottom: 1px solid #e5e7eb; padding: 9px 8px; text-align: left; vertical-align: top; }
    th { color: #52606d; font-weight: 600; }
    .status { display: inline-block; border-radius: 999px; padding: 2px 8px; background: #e5e7eb; }
    .active { background: #dcfce7; color: #166534; }
    .disabled { background: #f1f5f9; color: #475569; }
    .exhausted { background: #fee2e2; color: #991b1b; }
    .muted { color: #64748b; }
    .error { color: #b91c1c; white-space: pre-wrap; }
    .ok { color: #166534; }
    .chat-grid { display: grid; grid-template-columns: 260px minmax(0, 1fr); gap: 14px; }
    .session-list { display: grid; gap: 8px; align-content: start; }
    .session-item { width: 100%; text-align: left; background: #fff; color: #17202a; border: 1px solid #dfe3e8; }
    .session-item.active { background: #e8f0fe; border-color: #8ab4f8; color: #17202a; }
    .chat-pane { min-height: 560px; display: grid; grid-template-rows: auto 1fr auto; gap: 12px; }
    .chat-controls { display: grid; grid-template-columns: repeat(4, minmax(140px, 1fr)); gap: 10px; align-items: end; }
    .messages { border: 1px solid #e5e7eb; border-radius: 8px; padding: 12px; overflow-y: auto; background: #fafafa; display: grid; align-content: start; gap: 10px; min-height: 300px; }
    .message { max-width: 86%; border: 1px solid #e5e7eb; border-radius: 8px; padding: 10px 12px; background: #fff; white-space: pre-wrap; line-height: 1.45; }
    .message.user { justify-self: end; background: #e8f0fe; border-color: #bfd5ff; }
    .message.assistant { justify-self: start; }
    .message.system { justify-self: center; max-width: 100%; color: #64748b; background: #f8fafc; }
    .composer { display: grid; gap: 10px; }
    .composer textarea { min-height: 86px; }
    @media (max-width: 900px) {
      main { padding: 14px; }
      header { align-items: flex-start; flex-direction: column; }
      table { display: block; overflow-x: auto; }
      .chat-grid { grid-template-columns: 1fr; }
      .chat-controls { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <div id="loginView" class="login-wrap">
    <form id="loginForm" class="login-card">
      <h1>小米 Mimo 号池</h1>
      <input id="token" type="password" placeholder="Admin token" autocomplete="current-password">
      <button type="submit">登录</button>
      <p id="loginMessage" class="muted"></p>
    </form>
  </div>

  <div id="appShell" class="hidden">
    <header>
      <h1>小米 Mimo 号池</h1>
      <div class="toolbar">
        <button id="poolTab" class="tab active">号池管理</button>
        <button id="chatTab" class="tab">聊天</button>
        <button id="logout" class="secondary">退出</button>
      </div>
    </header>
    <main>
      <div id="poolView" class="stack">
        <section>
          <h2>号池备份</h2>
          <div class="row">
            <button id="exportBackup">导出备份</button>
            <button id="chooseBackup" class="secondary">导入备份</button>
            <input id="backupFile" class="hidden" type="file" accept="application/json,.json">
          </div>
          <p class="muted">备份文件包含真实 API Key，请妥善保管。</p>
        </section>
        <section>
          <h2>服务组顺序</h2>
          <div id="groups"></div>
        </section>
        <section>
          <h2>批量导入 API Key</h2>
          <div class="row">
            <select id="groupCode"><option>CN</option><option>SGP</option><option>AMS</option></select>
            <button id="importKeys">导入</button>
          </div>
          <p class="muted">每行一个 key，会自动去重。</p>
          <textarea id="keys" placeholder="sk-..." rows="5"></textarea>
        </section>
        <section>
          <h2>API Key 状态</h2>
          <div id="keysTable"></div>
        </section>
      </div>

      <div id="chatView" class="chat-grid hidden">
        <aside class="panel session-list">
          <div class="row">
            <button id="newSession">新会话</button>
            <button id="deleteSession" class="secondary">删除</button>
          </div>
          <div id="sessions"></div>
        </aside>
        <section class="chat-pane">
          <div class="chat-controls">
            <label class="stack">接口
              <select id="chatMode">
                <option value="proxy">当前 Proxy</option>
                <option value="direct">直连 API Key</option>
              </select>
            </label>
            <label class="stack">兼容类型
              <select id="apiType">
                <option value="openai-chat">OpenAI Chat Completions</option>
                <option value="openai-responses">OpenAI Responses</option>
                <option value="anthropic-messages">Anthropic Messages</option>
              </select>
            </label>
            <label class="stack">API Key
              <select id="directKey"></select>
            </label>
            <label class="stack">模型
              <select id="model"><option value="mimo">mimo</option></select>
            </label>
          </div>
          <div id="messages" class="messages"></div>
          <div class="composer">
            <textarea id="prompt" placeholder="输入消息，Ctrl+Enter 发送"></textarea>
            <div class="row">
              <button id="sendMessage">发送</button>
              <button id="clearMessages" class="secondary">清空</button>
            </div>
          </div>
        </section>
      </div>
      <p id="message" class="muted"></p>
    </main>
  </div>

  <script>
    const state = {
      token: localStorage.getItem('adminToken') || '',
      groups: [],
      keys: [],
      sessions: loadStoredSessions(),
      activeSessionId: localStorage.getItem('activeSessionId') || ''
    };

    const el = (id) => document.getElementById(id);
    const tokenInput = el('token');
    tokenInput.value = state.token;

    window.addEventListener('error', (event) => {
      const message = String(event.message || '');
      if (message.includes('isUserVerifyingPlatformAuthenticatorAvailable') || String(event.filename || '').includes('webauthnInterceptor')) {
        return;
      }
      const target = el('loginMessage') || el('message');
      if (target) {
        target.className = 'error';
        target.textContent = '页面脚本错误：' + message;
      }
    });

    function loadStoredSessions() {
      try {
        const parsed = JSON.parse(localStorage.getItem('chatSessions') || '[]');
        if (!Array.isArray(parsed)) return [];
        return parsed.filter((session) => session && typeof session === 'object').map((session) => ({
          id: String(session.id || Date.now()),
          title: String(session.title || '新会话'),
          messages: Array.isArray(session.messages) ? session.messages.map((message) => ({
            role: typeof message.role === 'string' ? message.role : 'system',
            content: typeof message.content === 'string' ? message.content : String(message.content || '')
          })) : []
        }));
      } catch {
        localStorage.removeItem('chatSessions');
        localStorage.removeItem('activeSessionId');
        return [];
      }
    }

    const api = async (path, options = {}) => {
      const response = await fetch('/admin/api' + path, {
        ...options,
        headers: { 'authorization': 'Bearer ' + state.token, 'content-type': 'application/json', ...(options.headers || {}) }
      });
      if (!response.ok) throw new Error(await response.text());
      return response.status === 204 ? null : response.json();
    };

    const msg = (text, ok = true) => {
      const target = el('message');
      target.className = ok ? 'ok' : 'error';
      target.textContent = text;
    };

    const loginMsg = (text, ok = false) => {
      const target = el('loginMessage');
      target.className = ok ? 'ok' : 'error';
      target.textContent = text;
    };

    el('loginForm').onsubmit = async (event) => {
      event.preventDefault();
      state.token = tokenInput.value.trim();
      try {
        await loadAll();
        localStorage.setItem('adminToken', state.token);
        showApp();
      } catch (error) {
        loginMsg('登录失败：' + String(error.message || error));
      }
    };

    el('logout').onclick = () => {
      localStorage.removeItem('adminToken');
      state.token = '';
      tokenInput.value = '';
      el('appShell').classList.add('hidden');
      el('loginView').classList.remove('hidden');
    };

    function showApp() {
      el('loginView').classList.add('hidden');
      el('appShell').classList.remove('hidden');
      renderSessions();
      renderMessages();
    }

    async function loadAll() {
      const result = await Promise.all([api('/groups'), api('/keys')]);
      state.groups = result[0].groups;
      state.keys = result[1].keys;
      renderGroups();
      renderKeys();
      renderDirectKeys();
      msg('已连接');
    }

    function renderGroups() {
      el('groups').innerHTML = '<table><thead><tr><th>代码</th><th>名称</th><th>顺序</th><th>启用</th><th>OpenAI</th><th>Anthropic</th><th></th></tr></thead><tbody>' + state.groups.map((group) =>
        '<tr>' +
        '<td>' + group.code + '</td><td>' + group.name + '</td>' +
        '<td><input id="order-' + group.code + '" type="number" value="' + group.sortOrder + '" style="width:70px"></td>' +
        '<td><input id="enabled-' + group.code + '" type="checkbox" ' + (group.enabled ? 'checked' : '') + '></td>' +
        '<td><input id="openai-' + group.code + '" value="' + group.openaiBaseUrl + '" style="min-width:260px"></td>' +
        '<td><input id="anthropic-' + group.code + '" value="' + group.anthropicBaseUrl + '" style="min-width:260px"></td>' +
        '<td><button onclick="saveGroup(\\'' + group.code + '\\')">保存</button></td>' +
        '</tr>').join('') + '</tbody></table>';
    }

    async function saveGroup(code) {
      await api('/groups/' + code, { method: 'PATCH', body: JSON.stringify({
        sortOrder: Number(el('order-' + code).value),
        enabled: el('enabled-' + code).checked,
        openaiBaseUrl: el('openai-' + code).value,
        anthropicBaseUrl: el('anthropic-' + code).value
      })});
      await loadAll();
    }

    function renderKeys() {
      el('keysTable').innerHTML = '<table><thead><tr><th>组</th><th>Key</th><th>顺序</th><th>状态</th><th>请求</th><th>最近错误</th><th>操作</th></tr></thead><tbody>' + state.keys.map((key) =>
        '<tr>' +
        '<td>' + key.groupCode + '</td><td>' + key.maskedKey + '</td><td>' + key.sortOrder + '</td>' +
        '<td><span class="status ' + key.status + '">' + key.status + '</span></td>' +
        '<td>' + key.requestCount + ' / ' + key.successCount + ' / ' + key.failureCount + '</td>' +
        '<td class="muted">' + (key.lastError || key.exhaustedReason || '') + '</td>' +
        '<td class="row">' +
        '<button class="secondary" onclick="setKeyStatus(' + key.id + ', \\'active\\')">启用</button>' +
        '<button class="secondary" onclick="setKeyStatus(' + key.id + ', \\'disabled\\')">禁用</button>' +
        '<button class="secondary" onclick="resetKey(' + key.id + ')">重置</button>' +
        '<button class="danger" onclick="deleteKey(' + key.id + ')">删除</button>' +
        '</td></tr>').join('') + '</tbody></table>';
    }

    function renderDirectKeys() {
      const activeKeys = state.keys.filter((key) => key.status === 'active');
      el('directKey').innerHTML = activeKeys.map((key) => '<option value="' + key.id + '">' + key.groupCode + ' · ' + key.maskedKey + '</option>').join('');
    }

    async function loadModels() {
      const current = el('model').value || 'mimo';
      const params = new URLSearchParams({
        mode: el('chatMode').value,
        apiType: el('apiType').value
      });
      if (el('chatMode').value === 'direct' && el('directKey').value) {
        params.set('keyId', el('directKey').value);
      }
      try {
        const response = await api('/models?' + params.toString());
        const models = response.models && response.models.length ? response.models : [current];
        renderModelOptions(models, current);
        msg('模型列表已更新');
      } catch (error) {
        renderModelOptions([current || 'mimo'], current || 'mimo');
        msg('模型探测失败，可继续使用当前模型：' + String(error.message || error), false);
      }
    }

    function renderModelOptions(models, selected) {
      const unique = Array.from(new Set(models.filter(Boolean)));
      if (selected && !unique.includes(selected)) unique.unshift(selected);
      el('model').innerHTML = unique.map((model) => '<option value="' + escapeAttribute(model) + '" ' + (model === selected ? 'selected' : '') + '>' + escapeHtml(model) + '</option>').join('');
    }

    el('importKeys').onclick = async () => {
      await api('/keys/import', { method: 'POST', body: JSON.stringify({
        groupCode: el('groupCode').value,
        keys: el('keys').value.split(/\\r?\\n/)
      })});
      el('keys').value = '';
      await loadAll();
    };

    el('exportBackup').onclick = async () => {
      try {
        const response = await fetch('/admin/api/export', {
          headers: { 'authorization': 'Bearer ' + state.token }
        });
        if (!response.ok) throw new Error(await response.text());
        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        const disposition = response.headers.get('content-disposition') || '';
        const filename = (disposition.match(/filename="([^"]+)"/) || [])[1] || 'mimo-pool-backup.json';
        link.href = url;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(url);
        msg('备份已导出');
      } catch (error) {
        msg('导出失败：' + String(error.message || error), false);
      }
    };

    el('chooseBackup').onclick = () => el('backupFile').click();
    el('backupFile').onchange = async () => {
      const file = el('backupFile').files[0];
      if (!file) return;
      try {
        const snapshot = JSON.parse(await file.text());
        const response = await api('/import', { method: 'POST', body: JSON.stringify(snapshot) });
        await loadAll();
        msg('导入完成：新增 ' + response.result.keysCreated + ' 个，更新 ' + response.result.keysUpdated + ' 个');
      } catch (error) {
        msg('导入失败：' + String(error.message || error), false);
      } finally {
        el('backupFile').value = '';
      }
    };

    async function setKeyStatus(id, status) { await api('/keys/' + id, { method: 'PATCH', body: JSON.stringify({ status }) }); await loadAll(); }
    async function resetKey(id) { await api('/keys/' + id + '/reset', { method: 'POST' }); await loadAll(); }
    async function deleteKey(id) { await api('/keys/' + id, { method: 'DELETE' }); await loadAll(); }

    el('poolTab').onclick = () => switchPage('pool');
    el('chatTab').onclick = () => {
      switchPage('chat');
      loadModels();
    };
    el('chatMode').onchange = loadModels;
    el('apiType').onchange = loadModels;
    el('directKey').onchange = loadModels;

    function switchPage(page) {
      el('poolTab').classList.toggle('active', page === 'pool');
      el('chatTab').classList.toggle('active', page === 'chat');
      el('poolView').classList.toggle('hidden', page !== 'pool');
      el('chatView').classList.toggle('hidden', page !== 'chat');
    }

    function ensureSession() {
      if (state.sessions.length === 0) {
        const id = String(Date.now());
        state.sessions.push({ id, title: '新会话', messages: [] });
        state.activeSessionId = id;
      }
      if (!state.sessions.find((session) => session.id === state.activeSessionId)) {
        state.activeSessionId = state.sessions[0].id;
      }
      saveSessions();
      return state.sessions.find((session) => session.id === state.activeSessionId);
    }

    function saveSessions() {
      localStorage.setItem('chatSessions', JSON.stringify(state.sessions));
      localStorage.setItem('activeSessionId', state.activeSessionId);
    }

    function renderSessions() {
      ensureSession();
      el('sessions').innerHTML = state.sessions.map((session) =>
        '<button class="session-item ' + (session.id === state.activeSessionId ? 'active' : '') + '" onclick="selectSession(\\'' + session.id + '\\')">' + session.title + '</button>'
      ).join('');
    }

    function renderMessages() {
      const session = ensureSession();
      el('messages').innerHTML = session.messages.length
        ? session.messages.map((message) => '<div class="message ' + message.role + '">' + escapeHtml(message.content) + '</div>').join('')
        : '<div class="message system">暂无消息</div>';
      el('messages').scrollTop = el('messages').scrollHeight;
    }

    function selectSession(id) {
      state.activeSessionId = id;
      saveSessions();
      renderSessions();
      renderMessages();
    }

    el('newSession').onclick = () => {
      const id = String(Date.now());
      state.sessions.unshift({ id, title: '新会话', messages: [] });
      state.activeSessionId = id;
      saveSessions();
      renderSessions();
      renderMessages();
    };

    el('deleteSession').onclick = () => {
      state.sessions = state.sessions.filter((session) => session.id !== state.activeSessionId);
      state.activeSessionId = state.sessions[0] ? state.sessions[0].id : '';
      saveSessions();
      renderSessions();
      renderMessages();
    };

    el('clearMessages').onclick = () => {
      const session = ensureSession();
      session.messages = [];
      saveSessions();
      renderMessages();
    };

    el('sendMessage').onclick = sendMessage;
    el('prompt').onkeydown = (event) => {
      if (event.key === 'Enter' && event.ctrlKey) sendMessage();
    };

    async function sendMessage() {
      const prompt = el('prompt').value.trim();
      if (!prompt) return;
      const session = ensureSession();
      session.messages.push({ role: 'user', content: prompt });
      if (session.title === '新会话') session.title = prompt.slice(0, 24);
      el('prompt').value = '';
      saveSessions();
      renderSessions();
      renderMessages();
      try {
        const body = {
          mode: el('chatMode').value,
          apiType: el('apiType').value,
          keyId: el('chatMode').value === 'direct' ? Number(el('directKey').value) : undefined,
          model: el('model').value || 'mimo',
          messages: session.messages
        };
        const response = await api('/chat', { method: 'POST', body: JSON.stringify(body) });
        session.messages.push({ role: 'assistant', content: response.reply || JSON.stringify(response.raw, null, 2) });
        saveSessions();
        renderMessages();
        await loadAll();
      } catch (error) {
        session.messages.push({ role: 'system', content: '发送失败：' + String(error.message || error) });
        saveSessions();
        renderMessages();
      }
    }

    function escapeHtml(value) {
      return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
    }

    function escapeAttribute(value) {
      return escapeHtml(String(value));
    }

    window.saveGroup = saveGroup;
    window.setKeyStatus = setKeyStatus;
    window.resetKey = resetKey;
    window.deleteKey = deleteKey;
    window.selectSession = selectSession;

    if (state.token) {
      loadAll().then(showApp).catch(() => {
        localStorage.removeItem('adminToken');
        state.token = '';
      });
    }
  </script>
</body>
</html>`;
