// مساعد الذكاء — يركّب فقط بعد تسجيل الدخول (initChatWidget) وبشكل احترافي
(function () {
  if (window.initChatWidget) return;

  const STORAGE_WELCOME = 'ai_chat_welcomed';

  function t(key, fallback) {
    try { return window.I18N ? I18N.t(key) : (fallback || key); } catch (e) { return fallback || key; }
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  function roleKey(role) {
    if (role === 'admin') return 'admin';
    if (role === 'locality_admin') return 'loc';
    return 'user';
  }

  window.initChatWidget = function () {
    if (document.getElementById('aiChatWidget')) return;

    const role = roleKey((window.currentUser && window.currentUser.role) || 'user');
    const quickChips = {
      admin: ['كم إجمالي النظام؟', 'كيف أصدّر تقريراً؟', 'كيف أنشئ رابط مشاركة؟'],
      loc: ['ما دوري في المراجعة؟', 'كم تقريراً لمحليتي؟', 'كيف أضيف تقريراً؟'],
      user: ['كيف أضيف تقريراً؟', 'كم تقريراً سجّلت؟', 'ماذا أفعل بتقرير مرفوض؟']
    }[role];

    const html = `
      <div id="aiChatWidget" dir="${document.documentElement.dir || 'rtl'}">
        <button id="aiChatWidget-fab" title="${t('chat.tooltip', 'المساعد الذكي')}" aria-label="chat">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H5.17L4 17.17V4h16v12zM8 9h8v2H8V9zm0 4h5v2H8v-2z"/></svg>
        </button>
        <div id="aiChatWidget-panel" class="chat-panel" hidden>
          <div class="chat-head">
            <div class="chat-head-title">
              <strong>${t('chat.title', 'المساعد الذكي')}</strong>
              <span id="aiChatWidget-status" class="chat-status">…</span>
            </div>
            <button id="aiChatWidget-close" aria-label="close" title="${t('close', 'إغلاق')}">&times;</button>
          </div>
          <div id="aiChatWidget-msgs" class="chat-msgs"></div>
          <div id="aiChatWidget-chips" class="chat-chips">${quickChips.map(c => `<button type="button">${escapeHtml(c)}</button>`).join('')}</div>
          <form id="aiChatWidget-form" class="chat-form">
            <input id="aiChatWidget-input" type="text" placeholder="${t('chat.ph', 'اكتب سؤالك هنا...')}" autocomplete="off" maxlength="500">
            <button type="submit">${t('chat.send', 'إرسال')}</button>
          </form>
        </div>
      </div>`;

    document.body.insertAdjacentHTML('beforeend', html);

    const fab = document.getElementById('aiChatWidget-fab');
    const panel = document.getElementById('aiChatWidget-panel');
    const msgs = document.getElementById('aiChatWidget-msgs');
    const form = document.getElementById('aiChatWidget-form');
    const input = document.getElementById('aiChatWidget-input');
    const statusEl = document.getElementById('aiChatWidget-status');
    const chips = document.getElementById('aiChatWidget-chips');
    let open = false;
    let busy = false;

    async function loadStatus() {
      try {
        const s = await API.request('/ai/status');
        statusEl.textContent = s.enabled ? t('chat.status.llm', 'ذكاء Gemini') : t('chat.status.rules', 'منطق القواعد');
        statusEl.className = 'chat-status ' + (s.enabled ? 'on' : 'off');
      } catch (e) {
        statusEl.textContent = '';
        statusEl.className = 'chat-status';
      }
    }
    loadStatus();

    function addMsg(text, who) {
      const el = document.createElement('div');
      el.className = 'chat-msg ' + who;
      el.innerHTML = escapeHtml(text);
      msgs.appendChild(el);
      msgs.scrollTop = msgs.scrollHeight;
      return el;
    }

    function showTyping() {
      const el = document.createElement('div');
      el.className = 'chat-msg bot typing';
      el.innerHTML = '<span></span><span></span><span></span>';
      msgs.appendChild(el);
      msgs.scrollTop = msgs.scrollHeight;
      return el;
    }

    function welcome() {
      const first = !localStorage.getItem(STORAGE_WELCOME);
      if (first) {
        localStorage.setItem(STORAGE_WELCOME, '1');
        const texts = {
          admin: t('chat.welcome.admin', 'مرحباً! أساعدك في مراجعة التقارير والتحليل. جرّب: «كم إجمالي النظام؟» أو «كيف أنشئ رابط مشاركة؟»'),
          loc: t('chat.welcome.loc', 'مرحباً! أساعدك في مراجعة تقارير محليتك. جرّب: «ما دوري في المراجعة؟» أو «كم تقريراً لمحليتي؟»'),
          user: t('chat.welcome.user', 'مرحباً! أساعدك في إدخال التقارير ومتابعتها. جرّب: «كيف أضيف تقريراً؟» أو «كم تقريراً سجّلت؟»')
        };
        setTimeout(() => addMsg(texts[role], 'bot'), 300);
      }
    }

    fab.addEventListener('click', () => {
      open = !open;
      panel.hidden = !open;
      if (open) { welcome(); input.focus(); }
    });
    document.getElementById('aiChatWidget-close').addEventListener('click', () => {
      open = false;
      panel.hidden = true;
    });
    chips.addEventListener('click', (e) => {
      if (e.target.tagName === 'BUTTON' && !busy) {
        input.value = e.target.textContent;
        form.dispatchEvent(new Event('submit'));
      }
    });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const q = input.value.trim();
      if (!q || busy) return;
      input.value = '';
      chips.style.display = 'none';
      addMsg(q, 'user');
      const typing = showTyping();
      busy = true;
      try {
        const r = await API.request('/ai/chat', 'POST', { message: q });
        typing.remove();
        addMsg(r.reply, 'bot');
      } catch (err) {
        typing.remove();
        if (err.status === 401) {
          addMsg(t('chat.err.auth', 'جلسة منتهية — سجّل الدخول مرة أخرى.'), 'bot');
          fab.style.display = 'none';
        } else {
          addMsg(t('chat.err.retry', 'عذراً، تعذر الرد الآن. حاول مرة أخرى بعد قليل.'), 'bot');
        }
      }
      busy = false;
    });
  };
})();
