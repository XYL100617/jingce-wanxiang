(() => {
  const $ = id => document.getElementById(id);
  const form = $('loginForm');
  const error = $('loginError');
  let registering = false;

  function setMode(next) {
    registering = next;
    $('registerConfirmRow').hidden = !registering;
    $('registerNameRow').hidden = !registering;
    $('loginPasswordConfirm').required = registering;
    $('loginPassword').autocomplete = registering ? 'new-password' : 'current-password';
    $('loginSubmit').textContent = registering ? '创建游客账号' : '登录';
    $('loginMode').textContent = registering ? '返回登录' : '注册游客账号';
    $('loginTitle').textContent = registering ? '创建游客账号' : '欢迎回来';
    $('loginSubtitle').textContent = registering ? '注册后即可保存路线与游览足迹' : '登录账号，继续你的游览计划';
    $('loginSwitchPrompt').textContent = registering ? '已经有账号？' : '还没有账号？';
    $('loginPasswordHint').textContent = registering ? '请设置至少 8 位密码' : '密码至少 8 位';
    error.hidden = true;
  }

  $('loginMode').addEventListener('click', () => setMode(!registering));
  form.addEventListener('submit', async event => {
    event.preventDefault();
    error.hidden = true;
    if (!form.reportValidity()) return;
    if (registering && $('loginPassword').value !== $('loginPasswordConfirm').value) {
      error.textContent = '两次输入的密码不一致'; error.hidden = false; return;
    }
    const button = $('loginSubmit');
    button.disabled = true; button.textContent = registering ? '正在创建…' : '正在登录…';
    try {
      const payload = { username: $('loginUsername').value.trim(), password: $('loginPassword').value };
      if (registering && $('loginDisplayName').value.trim()) payload.displayName = $('loginDisplayName').value.trim();
      const response = await fetch(registering ? '/api/account/register' : '/api/account/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify(payload)
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || `请求失败（${response.status}）`);
      location.replace('/');
    } catch (cause) {
      error.textContent = cause.message || '暂时无法连接服务，请稍后重试'; error.hidden = false;
      button.disabled = false; button.textContent = registering ? '创建游客账号' : '登录';
    }
  });

  fetch('/api/account/me', { credentials: 'same-origin' })
    .then(response => response.ok ? response.json() : null)
    .then(result => { if (result?.user && result.user.role !== 'guest') location.replace('/'); })
    .catch(() => {});
})();
