// مساعد الذكاء — ويدجت محادثة مشترك بين صفحات المستخدم والمدير
(function () {
  if (window.ChatWidgetLoaded) return;
  window.ChatWidgetLoaded = true;

  const ID = 'aiChatWidget';
  let open = false;
  let busy = false;

  function t(key, fallback) {
    try { return window.I18N ? I18N.t(key) : (fallback || key); } catch (e) { return fallback || key; }
  }

  const html = `
    <div id="${ID}" dir="${document.documentElement.dir || 'rtl'}">
      <button id="${ID}-fab" title="${t('chat.tooltip', 'المساعد الذكي')}" aria-label="chat">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H5.17L4 17.17V4h16v12zM8 9h8v2H8V9zm0 4h5v2H8v-2z"/></svg>
      </button>
      <div id="${ID}-panel" class="chat-panel" hidden>
        <div class="chat-head">
          <strong>🤖 ${t('chat.title', 'المساعد الذكي')}</strong>
          <button id="${ID}-close" aria-label="close">&times;</button>
        </div>
        <div id="${ID}-msgs" class="chat-msgs">
          <div class="chat-msg bot">${t('chat.welcome', 'مرحباً! اسألني عن النظام: كيف أضيف تقريراً؟ ما حالة تقاريري؟')}</div>
        </div>
        <form id="${ID}-form" class="chat-form">
          <input id="${ID}-input" type="text" placeholder="${t('chat.ph', 'اكتب سؤالك هنا...')}" autocomplete="off" maxlength="500">
          <button type="submit">${t('chat.send', 'إرسال')}</button>
        </form>
      </div>
    </div>`;

  document.body.insertAdjacentHTML('beforeend', html);

  const fab = document.getElementById(ID + '-fab');
  const panel = document.getElementById(ID + '-panel');
  const msgs = document.getElementById(ID + '-msgs');
  const form = document.getElementById(ID + '-form');
  const input = document.getElementById(ID + '-input');

  fab.addEventListener('click', () => {
    open = !open;
    panel.hidden = !open;
    if (open) input.focus();
  });
  document.getElementById(ID + '-close').addEventListener('click', () => {
    open = false;
    panel.hidden = true;
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const q = input.value.trim();
    if (!q || busy) return;
    input.value = '';
    msgs.insertAdjacentHTML('beforeend', `<div class="chat-msg user">${escapeHtml(q)}</div>`);
    msgs.scrollTop = msgs.scrollHeight;
    busy = true;
    try {
      const r = await API.request('/ai/chat', 'POST', { message: q });
      msgs.insertAdjacentHTML('beforeend', `<div class="chat-msg bot">${escapeHtml(r.reply)}</div>`);
    } catch (err) {
      msgs.insertAdjacentHTML('beforeend', `<div class="chat-msg bot">${escapeHtml(err.message || t('chat.err', 'حدث خطأ، حاول لاحقاً'))}</div>`);
    }
    busy = false;
    msgs.scrollTop = msgs.scrollHeight;
  });
})();
