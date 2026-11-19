const providers = [
  ['codex', 'Codex', 'codex'],
  ['antigravity', 'Antigravity', 'antigravity'],
  ['grok', 'Grok Bot', 'cursor'],
  ['deepseek', 'DeepSeek API', 'deepseek']
];

const states = {
  disabled: '已停用', notConfigured: '未连接', unauthorized: '需要登录',
  rateLimited: '查询受限', sourceRateLimited: '查询受限',
  unavailable: '暂不可用', error: '查询失败'
};

const localTime = new Intl.DateTimeFormat('zh-CN', {
  month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
});
const percentFormat = new Intl.NumberFormat('zh-CN', {maximumFractionDigits: 3});

function timeText(value) {
  const instant = Date.parse(value);
  return Number.isFinite(instant) ? localTime.format(instant) : '';
}

function remaining(window) {
  return window?.remainingPercent ?? (window?.usedPercent != null ? 100 - window.usedPercent : null);
}

function percent(window) {
  const value = remaining(window);
  return value == null ? '未知' : `${percentFormat.format(value)}%`;
}

function resetText(window, now) {
  const time = timeText(window?.resetsAt);
  if (!time) return '重置时间未知';
  return Date.parse(window.resetsAt) <= now ? `${time} 已到 · 待刷新` : `${time} 重置`;
}

function sharedWindow(row) {
  // Cursor creates this window only after confirming the unified plan.
  return row.windows.find(w => w.label === 'Included usage' && ['weekly', 'billing'].includes(w.kind));
}

function accountRank(row, id) {
  if (id === 'codex') return row.sourceDetail === 'managed' ? 0 : 1;
  if (id === 'antigravity') return row.source === 'rpc' ? 1 : 0;
  if (id === 'grok') return sharedWindow(row) ? 1 : 0;
  return 0;
}

function reading(id, account, now) {
  const windows = account.windows;
  if (id === 'codex') {
    const canonical = windows.filter(w => !w.additional);
    const short = canonical.find(w => w.kind === 'session');
    const week = canonical.find(w => w.kind === 'weekly');
    if (!short && !week) return {value: '未知', detail: '尚无短时或周额度'};
    const shortLabel = short?.windowMinutes ? `${short.windowMinutes / 60}h` : '短时';
    const items = [[shortLabel, short], ['周', week]].filter(([, w]) => w);
    return {
      value: items.map(([label, w]) => `${label} ${percent(w)}`).join(' · '),
      detail: items.map(([label, w]) => `${label} ${resetText(w, now)}`).join(' ／ ')
    };
  }
  if (id === 'antigravity') {
    const lowest = windows.filter(w => remaining(w) != null)
      .sort((a, b) => remaining(a) - remaining(b))[0];
    if (!lowest) return {value: '未知', detail: '未返回模型组剩余百分比'};
    const group = (lowest.label || lowest.displayLabel || '模型组')
      .replace(/\s+5-hour$/i, ' 5h').replace(/\s+weekly$/i, ' 周');
    return {value: percent(lowest), detail: `${group} · ${resetText(lowest, now)}`};
  }
  if (id === 'grok') {
    const shared = sharedWindow(account);
    if (!shared) return {value: '未知', detail: 'Cursor 尚未返回共享额度'};
    return {value: percent(shared), detail: `X 共享额度 · ${shared.kind === 'weekly' ? '周' : '月'} · ${resetText(shared, now)}`};
  }
  const wallet = windows.find(w => w.metric === 'credits');
  const amount = wallet?.remaining ?? (wallet ? account.balance?.amount : null);
  const currency = wallet?.currency || account.balance?.currency;
  if (amount == null || !currency) return {value: '未知', detail: '未返回完整钱包余额'};
  const unit = currency === 'CNY' ? '¥' : currency === 'USD' ? '$' : currency + ' ';
  return {value: unit + amount.toFixed(2), detail: `${currency} 账户余额`};
}

export function quotaOverview(rows, now = Date.now(), cursorUsage = null) {
  return providers.map(([id, label, provider]) => {
    const accounts = rows.filter(row => row.provider === provider);
    const connected = accounts.filter(row => row.status !== 'notConfigured' && row.status !== 'disabled');
    const ranked = connected.sort((a, b) => accountRank(b, id) - accountRank(a, id));
    if (ranked.length > 1 && accountRank(ranked[0], id) === accountRank(ranked[1], id)) {
      return {id, label, status: 'ambiguous', value: '多个账号', detail: '在额度详情中查看各账号', identity: '', updatedAt: ''};
    }
    const account = ranked[0] || accounts[0];
    const status = account?.status || 'notConfigured';
    if (id === 'grok' && cursorUsage && status !== 'disabled' &&
        (status !== 'ok' || remaining(sharedWindow(account)) == null)) {
      const {usedPercent, resetText, observedAt, live} = cursorUsage;
      return {id, label, status: live ? 'ok' : 'cached', value: percent({usedPercent}),
        detail: `X 共享周额 · ${resetText} 重置${live ? '' : ' · 上次读取'}`,
        identity: '', updatedAt: observedAt};
    }
    const emptyHint = id === 'grok' ? '打开 Cursor 设置 → Plan & Usage'
      : id === 'deepseek' ? '连接 DeepSeek API 账户' : '可在额度详情查看连接状态';
    const data = status === 'ok' ? reading(id, account, now) : {
      value: states[status] || '暂不可用', detail: account?.actionRequired === 'accountVerification' ? '账户需要验证' : emptyHint
    };
    const identity = accounts.length > 1 && account
      ? account.accountName || account.accountEmail || account.accountLabel || '所选账号' : '';
    return {id, label, status, ...data, identity, updatedAt: account?.updatedAt || ''};
  });
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  node.className = className;
  if (text) node.textContent = text;
  return node;
}

export function activate(ctx) {
  return {
    mount(container, context) {
      const panel = element('section', 'pq-panel');
      panel.setAttribute('aria-label', '我的 AI 额度');
      const heading = element('header', 'pq-heading');
      const more = element('button', 'pq-more', '额度详情 ›');
      more.type = 'button';
      more.onclick = () => ctx.navigate('limits');
      heading.append(element('h2', 'pq-title', '剩余额度'), more);
      const list = element('div', 'pq-list');
      panel.append(heading, list, element('p', 'pq-footer', 'ChatGPT iOS 聊天额度 · 在 ChatGPT 中查看'));
      container.append(panel);

      let snapshot;
      let source = context.source || 'local';
      let visible = context.visible !== false;
      let cursorUsage = null;
      let syncing = false;
      let revision = 0;
      let closed = false;
      let stop;
      function render() {
        const local = source === 'local';
        const available = local && snapshot?.availability === 'available';
        const rows = quotaOverview(available ? snapshot.rows : [], Date.now(), local ? cursorUsage : null);
        list.replaceChildren(...rows.map(row => {
          const item = element('article', 'pq-row');
          item.dataset.provider = row.id;
          const present = available || (local && row.id === 'grok' && cursorUsage);
          item.dataset.ready = String(Boolean(present && ['ok', 'cached'].includes(row.status) && row.value !== '未知'));
          let {value, detail} = row;
          if (!present) {
            value = local ? (snapshot ? '暂无数据' : '读取中') : '未显示';
            detail = local ? '等待本机额度快照' : '切换为本机数据查看';
          }
          const name = element('strong', 'pq-name', row.label);
          const number = element('span', 'pq-value', value);
          const hint = element('div', 'pq-detail', detail);
          const updated = timeText(row.updatedAt);
          if (row.identity) hint.append(element('span', 'pq-identity', ' · ' + row.identity));
          const subline = element('div', 'pq-subline');
          subline.append(hint);
          if (present && (updated || row.status === 'ok')) {
            const stamp = element('span', 'pq-stamp', updated ? `${updated} 采集` : '采集时间未知');
            subline.append(stamp);
          }
          item.append(name, number, subline);
          return item;
        }));
      }
      const query = {resource: 'limits', page: {limit: 500}};
      function receive(result) {
        snapshot = result;
        render();
      }
      async function refresh() {
        const pending = ++revision;
        try {
          const next = await ctx.data.query(query);
          if (!closed && pending === revision) receive(next);
        } catch {
          if (!closed && pending === revision) receive({availability: 'temporarilyUnavailable'});
        }
      }
      async function syncCursor() {
        if (closed || syncing || source !== 'local' || !visible || document.hidden) return;
        syncing = true;
        try {
          if (!cursorUsage) {
            cursorUsage = await ctx.backend.call('getCursorUsage');
            if (cursorUsage && !closed) render();
          }
          cursorUsage = await ctx.backend.call('syncCursorUsage');
        } catch {
          if (cursorUsage) cursorUsage = {...cursorUsage, live: false};
        } finally {
          syncing = false;
          if (!closed) render();
        }
      }
      render();
      void syncCursor();
      document.addEventListener('visibilitychange', syncCursor);
      const clock = setInterval(() => { render(); void syncCursor(); }, 60_000);
      ctx.data.subscribe(query, event => {
        if (closed) return;
        if (event.type === 'snapshot') { ++revision; receive(event.value); }
        else if (event.type === 'invalidate') {
          if (event.reset) { ++revision; receive(null); }
          if (event.refetch) void refresh();
        }
      }).then(unsubscribe => { if (closed) unsubscribe(); else stop = unsubscribe; })
        .catch(() => { if (!closed) receive({availability: 'temporarilyUnavailable'}); });
      return {
        update(next) {
          const previousVisible = visible;
          visible = next.visible !== false;
          const nextSource = next.source || 'local';
          if (source !== nextSource) {
            ++revision;
            source = nextSource;
            receive(null);
            if (source === 'local') { void refresh(); void syncCursor(); }
          } else if (!previousVisible && visible) void syncCursor();
        },
        dispose() {
          closed = true;
          clearInterval(clock);
          document.removeEventListener('visibilitychange', syncCursor);
          stop?.();
          panel.remove();
        }
      };
    }
  };
}
