// Editorial reading surface. Native CSS/DOM; no external scripts, analytics or account service.
export const TOPICS = Object.freeze({
  physical: '物理海洋', climate: '海洋与气候', biology: '生物与生态', chemistry: '海洋化学',
  policy: '政策与治理', engineering: '工程与观测', deepsea: '深海与极地', fisheries: '渔业与蓝色经济',
});

const STORAGE_KEY = 'ocean-reader:v1';
const PAGE_SIZE = 30;
const MAX_BOOKMARKS = 1000;
const MAX_IMPORT_BYTES = 2 * 1024 * 1024;
const STATUS_LABELS = { ok: '成功', stale: '保留旧内容', error: '失败', manual: '手工来源', disabled: '未启用', unknown: '暂无状态' };

function privateHost(host) {
  const name = host.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (name === 'localhost' || name.endsWith('.localhost') || name.endsWith('.local') || name.endsWith('.internal')) return true;
  if (name === '::' || name === '::1' || /^(?:fc|fd|fe8|fe9|fea|feb)/.test(name) && name.includes(':')) return true;
  if (name.includes(':')) return name.startsWith('::ffff:') || name.startsWith('0:0:0:0:0:ffff:');
  const parts = name.split('.');
  if (parts.length !== 4 || parts.some(part => !/^\d+$/.test(part))) return false;
  const [a, b] = parts.map(Number);
  return a === 0 || a === 10 || a === 127 || a >= 224 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && (b === 168 || b === 0) || a === 100 && b >= 64 && b <= 127 || a === 198 && (b === 18 || b === 19);
}

export function safeHttpUrl(value) {
  if (typeof value !== 'string' || value.length > 4096 || /[\u0000-\u001f\u007f]/.test(value)) return null;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || privateHost(url.hostname)) return null;
    return url.href;
  } catch { return null; }
}

function validDate(value) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return false;
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|([+-])(\d{2}):(\d{2}))$/);
  if (!match) return false;
  const [, year, month, day, hour, minute, second, , offsetHour = '0', offsetMinute = '0'] = match;
  const days = new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate();
  return Number(month) >= 1 && Number(month) <= 12 && Number(day) >= 1 && Number(day) <= days && Number(hour) < 24 && Number(minute) < 60 && Number(second) < 60 && Number(offsetHour) <= 23 && Number(offsetMinute) < 60;
}

export function formatDate(value, includeTime = false) {
  if (!validDate(value)) return '日期未提供';
  const options = { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' };
  if (includeTime) Object.assign(options, { hour: '2-digit', minute: '2-digit', hour12: false });
  return new Intl.DateTimeFormat('zh-CN', options).format(new Date(value));
}

export function normalizeItem(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (typeof raw.id !== 'string' || !raw.id.trim() || raw.id.length > 256 || typeof raw.title !== 'string' || !raw.title.trim() || raw.title.length > 1500) return null;
  const url = safeHttpUrl(raw.url);
  if (!url) return null;
  const basis = raw.editorial?.basis ?? raw.editorialBasis;
  const chineseText = (value, limit) => typeof value === 'string' && value.length <= limit && /[\u3400-\u9fff]/.test(value) && !/[<>\u0000-\u001f\u007f]/.test(value);
  const localized = ['abstract', 'source_excerpt', 'title_only'].includes(basis) && chineseText(raw.titleZh, 120) && chineseText(raw.summaryZh, 500);
  const titleOriginal = typeof raw.titleOriginal === 'string' ? raw.titleOriginal.slice(0, 1500) : raw.title.trim();
  const summaryOriginal = typeof raw.summaryOriginal === 'string' ? raw.summaryOriginal.slice(0, 240) : typeof raw.summary === 'string' ? raw.summary.slice(0, 240) : '';
  return {
    id: raw.id, title: localized ? raw.titleZh.trim() : raw.title.trim(), titleOriginal, url,
    sourceId: typeof raw.sourceId === 'string' ? raw.sourceId.slice(0, 200) : 'unknown',
    sourceName: typeof raw.sourceName === 'string' && raw.sourceName.trim() ? raw.sourceName.slice(0, 250) : '未注明来源',
    publishedAt: validDate(raw.publishedAt) ? raw.publishedAt : null,
    collectedAt: validDate(raw.collectedAt) ? raw.collectedAt : null,
    summary: localized ? raw.summaryZh.trim() : typeof raw.summary === 'string' ? raw.summary.slice(0, 240) : '',
    summaryOriginal, localized,
    ...(localized ? { titleZh: raw.titleZh.trim(), summaryZh: raw.summaryZh.trim(), editorialBasis: basis } : {}),
    topics: [...new Set(Array.isArray(raw.topics) ? raw.topics.filter(key => Object.hasOwn(TOPICS, key)) : [])],
    ruleMatched: raw.ruleMatched === true,
    ruleHits: Array.isArray(raw.ruleHits) ? raw.ruleHits.filter(hit => typeof hit === 'string').slice(0, 12).map(hit => hit.slice(0, 60)) : [],
    ...(typeof raw.doi === 'string' && raw.doi.length <= 250 ? { doi: raw.doi } : {}),
  };
}

export function validateBookmarkImport(raw) {
  if (!raw || raw.schema !== 'ocean-bookmarks.v1' || !Array.isArray(raw.bookmarks)) throw new Error('文件格式不符，请选择本页导出的收藏 JSON。');
  if (raw.bookmarks.length > MAX_BOOKMARKS) throw new Error(`单次最多导入 ${MAX_BOOKMARKS} 条收藏。`);
  const unique = new Map();
  for (const item of raw.bookmarks) {
    const safe = normalizeItem(item);
    if (!safe) throw new Error('文件中有无效条目或不安全的原文链接，未导入任何收藏。');
    unique.set(safe.id, safe);
  }
  return [...unique.values()];
}

export function filterItems(items, { query = '', topic = 'all', source = 'all', view = 'all', onlyChinese = false, savedIds = new Set(), readIds = new Set() } = {}) {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return items.filter(item => {
    if (onlyChinese && !item.localized) return false;
    if (topic !== 'all' && !item.topics.includes(topic)) return false;
    if (source !== 'all' && item.sourceId !== source) return false;
    if (view === 'saved' && !savedIds.has(item.id) || view === 'unread' && readIds.has(item.id)) return false;
    const haystack = [item.title, item.summary, item.titleOriginal ?? '', item.summaryOriginal ?? '', item.sourceName, ...item.topics.map(key => TOPICS[key]), item.doi ?? ''].join(' ').toLocaleLowerCase();
    return terms.every(term => haystack.includes(term));
  });
}

function byDate(a, b) {
  return (Date.parse(b.publishedAt ?? '') || 0) - (Date.parse(a.publishedAt ?? '') || 0) || a.id.localeCompare(b.id);
}

function friendlySourceError(value) {
  const error = typeof value === 'string' ? value : '';
  if (/timeout|timed out|deadline/i.test(error)) return '访问超时，本轮未取得更新。';
  if (/\b403\b|forbidden/i.test(error)) return '来源暂时拒绝自动访问，本轮未取得更新。';
  if (/\b404\b|not found/i.test(error)) return '订阅地址暂时不可用（404）。';
  if (/\b429\b|too many requests/i.test(error)) return '来源限制了访问频率，本轮未取得更新；稍后更新时会再尝试。';
  if (/SSL|TLS|certificate/i.test(error)) return '安全连接未建立，本轮未取得更新。';
  if (/socket|WinError|connection|network|DNS|urlopen/i.test(error)) return '网络连接未成功，本轮未取得更新。';
  if (/parse|syntax|XML|JSON|format/i.test(error)) return '来源返回的订阅格式暂时无法读取。';
  return '本轮抓取未成功，请稍后重试；详细诊断保留在更新记录中。';
}

if (typeof document !== 'undefined') {
  const $ = id => document.getElementById(id);
  const state = { items: [], sources: [], metadata: {}, readIds: new Set(), bookmarks: new Map(), query: '', topic: 'all', source: 'all', view: 'all', onlyChinese: false, visible: PAGE_SIZE, loaded: false, loadError: false, storageWarning: '', dataWarning: '' };
  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const link = (url, label, className) => {
    const safe = safeHttpUrl(url);
    if (!safe) return el('span', className, label);
    const node = el('a', className, label);
    node.href = safe; node.target = '_blank'; node.rel = 'noopener noreferrer';
    return node;
  };

  function readLocal() {
    try {
      const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
      if (!raw || raw.version !== 1) return;
      if (Array.isArray(raw.readIds)) state.readIds = new Set(raw.readIds.filter(id => typeof id === 'string' && id.length <= 256).slice(-10000));
      if (Array.isArray(raw.bookmarks)) for (const item of raw.bookmarks.slice(0, MAX_BOOKMARKS)) {
        const safe = normalizeItem(item);
        if (safe) state.bookmarks.set(safe.id, safe);
      }
    } catch { state.storageWarning = '当前浏览器无法读取本地阅读记录。收藏只在本次打开期间保留，请及时导出。'; }
  }

  function saveLocal() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, readIds: [...state.readIds].slice(-10000), bookmarks: [...state.bookmarks.values()] }));
    } catch { state.storageWarning = '浏览器未能保存阅读记录。当前操作仍可使用，请导出收藏以免丢失。'; renderNotice(); }
  }

  function renderNotice() {
    const messages = [state.storageWarning, state.dataWarning].filter(Boolean);
    $('notice').hidden = !messages.length;
    $('notice').textContent = messages.join(' ');
  }

  function availableItems() {
    if (state.view !== 'saved') return state.items;
    const merged = new Map(state.bookmarks);
    for (const item of state.items) if (merged.has(item.id)) merged.set(item.id, item);
    return [...merged.values()].sort(byDate);
  }

  function resetVisible() { state.visible = PAGE_SIZE; }
  function resetFilters() {
    state.query = ''; state.topic = 'all'; state.source = 'all'; state.view = 'all'; resetVisible();
    $('search').value = ''; $('source-filter').value = 'all'; renderTopics(); renderArticles();
  }

  function renderTopics() {
    const container = $('topic-filters');
    container.replaceChildren();
    const items = availableItems().filter(item => !state.onlyChinese || item.localized);
    for (const [key, label] of [['all', '全部主题'], ...Object.entries(TOPICS)]) {
      const count = key === 'all' ? items.length : items.filter(item => item.topics.includes(key)).length;
      const button = el('button'); button.type = 'button'; button.dataset.topic = key;
      button.setAttribute('aria-pressed', String(state.topic === key));
      button.append(el('span', '', label), el('span', 'topic-count', String(count)));
      button.addEventListener('click', () => {
        state.topic = key; resetVisible(); renderTopics(); renderArticles();
        [...container.querySelectorAll('button')].find(candidate => candidate.dataset.topic === key)?.focus({ preventScroll: true });
      });
      container.append(button);
    }
  }

  function renderSourceOptions() {
    const select = $('source-filter');
    const known = new Map(state.sources.map(source => [source.id, source.name]));
    for (const item of state.bookmarks.values()) if (!known.has(item.sourceId)) known.set(item.sourceId, item.sourceName);
    select.replaceChildren();
    const first = el('option', '', '全部来源'); first.value = 'all'; select.append(first);
    for (const [id, name] of [...known].sort((a, b) => a[1].localeCompare(b[1], 'zh-CN'))) {
      const option = el('option', '', name); option.value = id; select.append(option);
    }
    select.value = state.source;
  }

  function showEmpty(container, title, message, reset = false) {
    const empty = el('div', 'empty-state');
    empty.append(el('h2', '', title), el('p', '', message));
    if (reset) {
      const button = el('button', 'secondary-button', '清除筛选'); button.type = 'button';
      button.addEventListener('click', resetFilters); empty.append(button);
    }
    container.append(empty);
  }

  function renderArticle(item) {
    const saved = state.bookmarks.has(item.id);
    const isRead = state.readIds.has(item.id);
    const article = el('article', `article-row${isRead ? ' is-read' : ''}`);
    const sourceState = state.metadata.sourceStatus?.find(source => source.id === item.sourceId);
    const stale = sourceState?.status === 'stale' || sourceState?.status === 'error';
    const meta = el('div', 'article-meta');
    meta.append(el('span', 'source-name', item.sourceName), el('span', 'meta-divider', '·'));
    const time = el('time', '', item.publishedAt ? formatDate(item.publishedAt) : '原文日期未提供');
    if (item.publishedAt) time.dateTime = item.publishedAt;
    time.title = item.publishedAt ? `原文日期 ${formatDate(item.publishedAt, true)}（北京时间）` : '来源未提供可信日期；不以采集时间替代原文日期';
    meta.append(time);
    if (stale) meta.append(el('span', 'source-stale', '来源本轮失败 · 上次内容'));
    article.append(meta);
    const title = el('h2', 'article-title');
    const original = link(item.url, item.title);
    original.addEventListener('click', () => {
      state.readIds.add(item.id); saveLocal(); article.classList.add('is-read'); readButton.textContent = '标为未读'; readButton.setAttribute('aria-pressed', 'true'); readButton.setAttribute('aria-label', `标为未读：${item.title}`);
      // Allow the original link's default navigation before updating the unread list.
      setTimeout(renderArticles, 0);
    });
    title.append(original); article.append(title);
    if (item.summary) article.append(el('p', 'article-summary', item.summary));
    const labels = { abstract: '论文摘要整理', source_excerpt: '来源摘要整理', title_only: '仅据标题 · 未提供摘要' };
    const rule = el('span', 'rule-indicator', item.localized ? labels[item.editorialBasis] : '原文待中文整理');
    if (item.ruleMatched && item.ruleHits.length) rule.title = `相关性关键词：${item.ruleHits.join('、')}。关键词命中不代表事实成立或重要程度。`;
    article.append(rule);
    const bottom = el('div', 'article-bottom'); const topics = el('div', 'article-topics');
    for (const key of item.topics) topics.append(el('span', 'topic-label', TOPICS[key]));
    if (!item.topics.length) topics.append(el('span', 'topic-label', '未分类'));
    const actions = el('div', 'article-actions');
    const readButton = el('button', '', isRead ? '标为未读' : '标为已读'); readButton.type = 'button';
    readButton.dataset.itemId = item.id; readButton.dataset.action = 'read';
    readButton.setAttribute('aria-pressed', String(isRead)); readButton.setAttribute('aria-label', `${isRead ? '标为未读' : '标为已读'}：${item.title}`);
    readButton.addEventListener('click', () => {
      state.readIds.has(item.id) ? state.readIds.delete(item.id) : state.readIds.add(item.id);
      saveLocal(); renderArticles(); restoreActionFocus(item.id, 'read');
    });
    const saveButton = el('button', '', saved ? '已收藏' : '收藏'); saveButton.type = 'button';
    saveButton.dataset.itemId = item.id; saveButton.dataset.action = 'save';
    saveButton.setAttribute('aria-pressed', String(saved)); saveButton.setAttribute('aria-label', `${saved ? '取消收藏' : '收藏'}：${item.title}`);
    saveButton.addEventListener('click', () => {
      if (state.bookmarks.has(item.id)) state.bookmarks.delete(item.id);
      else {
        if (state.bookmarks.size >= MAX_BOOKMARKS) { $('backup-status').textContent = `当前最多保存 ${MAX_BOOKMARKS} 条收藏，请先导出并整理。`; return; }
        state.bookmarks.set(item.id, item);
      }
      saveLocal(); renderTopics(); renderArticles(); restoreActionFocus(item.id, 'save');
    });
    actions.append(saveButton, readButton); bottom.append(topics, actions); article.append(bottom);
    return article;
  }

  function restoreActionFocus(itemId, action) {
    const target = [...$('article-list').querySelectorAll('button')].find(button => button.dataset.itemId === itemId && button.dataset.action === action);
    if (target) target.focus({ preventScroll: true });
    else {
      $('reader-title').setAttribute('tabindex', '-1');
      $('reader-title').focus({ preventScroll: true });
    }
  }

  function renderArticles() {
    const container = $('article-list'); container.replaceChildren(); container.setAttribute('aria-busy', 'false');
    const items = availableItems();
    const filtered = filterItems(items, { ...state, savedIds: new Set(state.bookmarks.keys()) });
    $('result-count').textContent = `${filtered.length} 条`;
    for (const button of $('view-filters').querySelectorAll('button')) button.setAttribute('aria-pressed', String(button.dataset.view === state.view));
    $('export-bookmarks').disabled = state.bookmarks.size === 0;
    const descriptions = [];
    if (state.topic !== 'all') descriptions.push(TOPICS[state.topic]);
    if (state.source !== 'all') descriptions.push(state.sources.find(source => source.id === state.source)?.name ?? '所选来源');
    if (state.query.trim()) descriptions.push(`搜索“${state.query.trim()}”`);
    if (state.view === 'saved') descriptions.push('包含已离开订阅列表的本机收藏');
    $('filter-description').textContent = descriptions.join(' · ');
    $('pagination').hidden = filtered.length <= state.visible;
    if (!filtered.length) {
      const hasFilter = state.query.trim() || state.topic !== 'all' || state.source !== 'all';
      if (hasFilter) showEmpty(container, '没有找到匹配的资讯', '可以换个关键词、主题或来源。', true);
      else if (state.view === 'saved') showEmpty(container, '还没有收藏', '在感兴趣的资讯旁点击“收藏”。收藏会保存在当前浏览器，也可以从 JSON 备份导入。');
      else if (state.view === 'unread' && state.items.length) showEmpty(container, '当前列表都已读过', '切换到“全部”继续查看，下一次采集到的新资讯会出现在这里。', true);
      else if (state.loadError) showEmpty(container, '订阅文件暂时无法读取', location.protocol === 'file:' ? '请使用项目的本机启动入口打开此页。直接双击 HTML 无法读取订阅文件。' : '请稍后刷新页面。已有本机收藏仍可在“收藏”中查看。');
      else if (state.onlyChinese && state.items.length) showEmpty(container, '资料正在等待中文整理', '可勾选“也看待整理原文”直接查阅来源；已有中文整理会在输入内容变化时重新核对。');
      else showEmpty(container, '还没有可阅读的更新', '请先运行一次订阅更新。这里不会用演示文章充当真实资讯，具体原因可在信源状态中查看。');
      return;
    }
    const fragment = document.createDocumentFragment();
    for (const item of filtered.slice(0, state.visible)) fragment.append(renderArticle(item));
    container.append(fragment);
  }

  function renderUpdate() {
    const metadata = state.metadata;
    const publicFeed = safeHttpUrl(metadata.publicFeedUrl);
    $('public-rss').href = publicFeed || './feed.xml';
    const statuses = Array.isArray(metadata.sourceStatus) ? metadata.sourceStatus : [];
    const auto = statuses.filter(source => source.mode !== 'manual' && source.status !== 'disabled');
    const successes = auto.filter(source => source.status === 'ok').length;
    const problems = auto.filter(source => ['error', 'stale'].includes(source.status)).length;
    const lastSuccess = metadata.lastSuccessAt;
    const olderThanDay = validDate(lastSuccess) && Date.now() - Date.parse(lastSuccess) > 24 * 3600000;
    $('update-status').classList.toggle('has-problem', state.loadError || problems > 0 || olderThanDay || !validDate(lastSuccess));
    $('update-label').textContent = state.loadError ? '订阅文件读取失败' : problems ? `本轮 ${successes} 个来源成功，${problems} 个来源暂时失败` : !validDate(lastSuccess) ? '尚无成功采集记录' : olderThanDay ? '最近一次成功采集已超过一天' : `已取得 ${state.items.length} 条原始订阅`;
    $('last-success').textContent = validDate(lastSuccess) ? `最近成功采集：${formatDate(lastSuccess, true)}（北京时间）` : '最近成功采集：尚无记录';
    const attempt = validDate(metadata.lastAttemptAt) ? `最近尝试：${formatDate(metadata.lastAttemptAt, true)}` : '';
    $('update-detail').textContent = [attempt, problems ? '失败来源保留旧内容；下方可查看具体状态。' : '原文日期与采集时间分别保存。'].filter(Boolean).join(' · ');
    const chineseMode = metadata.editorial?.enabled === true;
    $('editorial-controls').hidden = !chineseMode;
    if (chineseMode) {
      const ready = state.items.filter(item => item.localized).length;
      $('editorial-status').textContent = `${ready} 条中文整理 · ${state.items.length - ready} 条待整理。标题直达原文；仅有标题的资料会单独标注。`;
    }
  }

  function renderSources() {
    const statuses = new Map((state.metadata.sourceStatus ?? []).filter(source => source && typeof source.id === 'string').map(source => [source.id, source]));
    const sources = state.sources.length ? state.sources : [...statuses.values()].map(source => ({ id: source.id, name: source.name, kind: source.kind, mode: source.mode }));
    const auto = sources.filter(source => source.mode !== 'manual').length;
    const manual = sources.filter(source => source.mode === 'manual').length;
    $('source-summary').textContent = sources.length ? `${auto} 个自动来源 · ${manual} 个手工来源` : '暂无来源配置';
    const container = $('source-status-list'); container.replaceChildren();
    if (!sources.length) { container.append(el('p', 'subtle', '当前没有来源配置或状态文件尚未生成。')); return; }
    for (const source of sources) {
      const data = statuses.get(source.id) ?? {};
      const status = source.mode === 'manual' ? 'manual' : source.enabled === false ? 'disabled' : Object.hasOwn(STATUS_LABELS, data.status) ? data.status : 'unknown';
      const entry = el('div', 'source-status-entry'); const heading = el('h3', 'source-status-title');
      heading.append(link(source.url, source.name), el('span', `source-state${['error', 'stale'].includes(status) ? ' problem' : ''}`, STATUS_LABELS[status])); entry.append(heading);
      if (status === 'manual') entry.append(el('p', 'source-status-info', '只列出来源，需要人工核对或另接采集，不计作自动成功。'));
      else if (status === 'disabled') entry.append(el('p', 'source-status-info', '此来源当前未启用自动采集。'));
      else {
        const count = Number.isInteger(data.itemCount) && data.itemCount >= 0 ? `${data.itemCount} 条保留内容` : '条数尚未提供';
        entry.append(el('p', 'source-status-info', `${count} · 上次成功：${validDate(data.lastSuccessAt) ? formatDate(data.lastSuccessAt, true) : '尚无记录'}`));
        if (['error', 'stale'].includes(status)) entry.append(el('p', 'source-error', friendlySourceError(data.error)));
      }
      container.append(entry);
    }
  }

  function downloadJson(value, name) {
    const blob = new Blob([JSON.stringify(value, null, 2) + '\n'], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob); const anchor = document.createElement('a');
    anchor.href = url; anchor.download = name; document.body.append(anchor); anchor.click(); anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  $('search').addEventListener('input', event => { state.query = event.target.value; resetVisible(); renderArticles(); });
  $('source-filter').addEventListener('change', event => { state.source = event.target.value; resetVisible(); renderArticles(); });
  $('show-pending').addEventListener('change', event => { state.onlyChinese = !event.target.checked; resetVisible(); renderTopics(); renderArticles(); });
  for (const button of $('view-filters').querySelectorAll('button')) button.addEventListener('click', () => {
    state.view = button.dataset.view; resetVisible(); renderTopics(); renderArticles();
  });
  $('load-more').addEventListener('click', () => { state.visible += PAGE_SIZE; renderArticles(); });
  $('export-bookmarks').addEventListener('click', () => {
    if (!state.bookmarks.size) return;
    downloadJson({ schema: 'ocean-bookmarks.v1', exportedAt: new Date().toISOString(), bookmarks: [...state.bookmarks.values()] }, `ocean-bookmarks-${new Date().toISOString().slice(0, 10)}.json`);
    $('backup-status').textContent = `已准备 ${state.bookmarks.size} 条收藏的 JSON 备份。`;
  });
  $('import-bookmarks').addEventListener('click', () => { $('bookmark-file').click(); });
  $('bookmark-file').addEventListener('change', async event => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      if (file.size > MAX_IMPORT_BYTES) throw new Error('文件超过 2 MB，未导入。');
      const imported = validateBookmarkImport(JSON.parse(await file.text()));
      const additions = imported.filter(item => !state.bookmarks.has(item.id));
      if (state.bookmarks.size + additions.length > MAX_BOOKMARKS) throw new Error(`合并后超过 ${MAX_BOOKMARKS} 条，未导入。请先整理备份。`);
      for (const item of additions) state.bookmarks.set(item.id, item);
      saveLocal(); renderSourceOptions(); renderTopics(); renderArticles();
      $('backup-status').textContent = `导入完成：新增 ${additions.length} 条，已有 ${imported.length - additions.length} 条未覆盖。`;
    } catch (error) {
      $('backup-status').textContent = error instanceof SyntaxError ? '不是有效的 JSON 文件，未导入任何收藏。' : error.message;
    } finally { event.target.value = ''; }
  });

  async function loadData() {
    try {
      const response = await fetch('./data.json', { cache: 'no-cache', credentials: 'omit', signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error('data unavailable');
      const raw = await response.json();
      if (!raw || raw.schemaVersion !== 1 || !Array.isArray(raw.items) || !Array.isArray(raw.sources) || !raw.metadata || typeof raw.metadata !== 'object') throw new Error('unexpected data schema');
      const unique = new Map(); let skipped = 0;
      for (const rawItem of raw.items.slice(0, 20000)) {
        const item = normalizeItem(rawItem);
        if (item) unique.set(item.id, item); else skipped++;
      }
      state.items = [...unique.values()].sort(byDate);
      state.sources = raw.sources.filter(source => source && typeof source.id === 'string' && typeof source.name === 'string').map(source => ({ id: source.id, name: source.name, url: source.url, kind: source.kind, mode: source.mode === 'manual' ? 'manual' : 'auto', enabled: source.enabled !== false }));
      state.metadata = { ...raw.metadata, sourceStatus: Array.isArray(raw.metadata.sourceStatus) ? raw.metadata.sourceStatus.filter(source => source && typeof source.id === 'string') : [] };
      state.onlyChinese = state.metadata.editorial?.enabled === true;
      $('show-pending').checked = !state.onlyChinese;
      if (skipped || raw.items.length > 20000) state.dataWarning = '部分格式异常、链接不安全或超过本页读取上限的条目未显示，请核对订阅更新结果。';
    } catch {
      state.loadError = true;
      state.dataWarning = location.protocol === 'file:' ? '请通过项目启动入口打开网页；直接双击 HTML 无法载入订阅。' : '未读到有效的订阅文件。可以稍后刷新；本机收藏仍可查看和导出。';
    }
    state.loaded = true; renderSourceOptions(); renderTopics(); renderArticles(); renderUpdate(); renderSources(); renderNotice();
  }

  readLocal(); renderNotice(); renderTopics();
  if (location.protocol === 'file:') { state.loadError = true; state.loaded = true; renderArticles(); }
  void loadData();
}
