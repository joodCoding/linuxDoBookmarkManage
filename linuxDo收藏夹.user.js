// ==UserScript==
// @name         L站收藏夹（分类管理）
// @namespace    http://tampermonkey.net/
// @version      0.1.7
// @description  LINUX DO 书签分类管理：侧边栏入口 + 悬浮按钮 + 右侧抽屉（API模式）
// @author       huanchong
// @match        https://linux.do/*
// @grant        GM_addStyle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        unsafeWindow
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const KEY_PREFIX = 'ld_bm_mgr_v1';
  const STORE_KEYS = {
    CATEGORIES: `${KEY_PREFIX}:categories`,
    ASSIGNMENTS: `${KEY_PREFIX}:assignments`,
    UI: `${KEY_PREFIX}:ui`,
    RATE: `${KEY_PREFIX}:rate`,
    SNAPSHOT: `${KEY_PREFIX}:snapshot`,
    READER_SIZE_OVERRIDES: `${KEY_PREFIX}:reader_size_overrides`,
    USERNAME_CACHE: `${KEY_PREFIX}:username_cache`
  };
  const CROSS_TAB_EVENT_KEY = `${KEY_PREFIX}:cross_tab_event`;
  const TAB_ID = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const READER_TILE_SIZES = Object.freeze(['s', 'm', 'l', 'xl']);
  const READER_TILE_SIZE_LABELS = Object.freeze({ s: 'S', m: 'M', l: 'L', xl: 'XL' });
  const READER_TILE_SIZE_MODES = Object.freeze(['auto', ...READER_TILE_SIZES]);
  const READER_LAYOUT_MODES = Object.freeze(['grid', 'bubble']);
  const BUBBLE_DEPENDENCY_URLS = Object.freeze({
    Muuri: 'https://unpkg.com/muuri@0.9.5/dist/muuri.min.js',
    Panzoom: 'https://unpkg.com/@panzoom/panzoom@4.6.0/dist/panzoom.min.js',
    interact: 'https://unpkg.com/interactjs@1.10.27/dist/interact.min.js'
  });

  const DEFAULT_CATEGORY_ID = 'uncategorized';
  const EXPORT_SCHEMA_VERSION = 1;
  const FIXED_BOOKMARKS_API_URL = '/bookmarks.json';

  const LIMIT_CONFIG = {
    MIN_INTERVAL_MS: 3500,
    WINDOW_MS: 10 * 60 * 1000,
    MAX_IN_WINDOW: 24,
    HARD_MAX_PER_SESSION: 36,
    MANUAL_REFRESH_BURST: 6,
    MANUAL_REFRESH_WINDOW_MS: 30 * 1000,
    RETRY_BACKOFF_MS: 18 * 1000
  };

  const NETWORK_CONFIG = {
    MAX_PAGES_PER_SYNC: 100,
    FETCH_TIMEOUT_MS: 15000
  };

  const SELECTORS = {
    SIDEBAR_CUSTOM_SECTIONS: '.sidebar-custom-sections',
    TOPIC_ID_ATTR: '[data-topic-id]'
  };

  const state = {
    bookmarkUrl: FIXED_BOOKMARKS_API_URL,
    cachedUsername: '',
    drawerOpen: false,
    viewMode: 'reader',
    readerTopCollapsed: true,
    readerLastScrollTop: 0,
    readerTileScale: 1,
    readerColorBoost: 1,
    readerSizeOverrides: {},
    readerLayoutMode: 'grid',
    activeCategoryId: DEFAULT_CATEGORY_ID,
    activeSearch: '',
    bookmarks: [],
    categories: [],
    assignments: {},
    sync: {
      running: false,
      lastStartAt: 0,
      lastFinishAt: 0,
      lastError: null,
      lastSource: 'none',
      pageFetched: 0,
      totalFetched: 0
    },
    rate: {
      requestTimes: [],
      sessionRequestCount: 0,
      manualRefreshHits: []
    },
    draggingCategoryId: null,
    suppressCrossTabEmit: false,
    quickOnlyMode: false,
    fullRuntimeReady: false,
    globalEventsBound: false,
    fullObserver: null,
    pathCheckTimer: 0,
    snapshotRestored: false,
    readerBubbleRuntime: {
      grid: null,
      panzoom: null,
      viewport: null,
      canvas: null,
      wheelHandler: null,
      interactables: [],
      depsLoading: null,
      mountToken: 0
    },
    derived: {
      categoryNameById: Object.create(null),
      bookmarkByKey: Object.create(null),
      bookmarkByTopicPost: Object.create(null),
      bookmarkByTopicAny: Object.create(null)
    },
    refs: {
      fab: null,
      fabQuick: null,
      drawer: null,
      overlay: null,
      sidebarEntry: null
    }
  };
  const bookmarkDerivedMeta = new WeakMap();

  const html = {
    escape(value) {
      return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }
  };

  function now() {
    return Date.now();
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function debounce(fn, delay) {
    let timer = null;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), delay);
    };
  }

  function emitCrossTabEvent(reason = 'data') {
    try {
      localStorage.setItem(CROSS_TAB_EVENT_KEY, JSON.stringify({
        from: TAB_ID,
        reason,
        ts: now()
      }));
    } catch {
      // Ignore localStorage failures (private mode / quota / disabled).
    }
  }

  const scheduleCrossTabEvent = debounce(() => {
    emitCrossTabEvent('data');
  }, 120);

  function runStorageBatch(writeFn) {
    const prevSuppress = state.suppressCrossTabEmit;
    let completed = false;

    state.suppressCrossTabEmit = true;
    try {
      writeFn();
      completed = true;
    } finally {
      state.suppressCrossTabEmit = prevSuppress;
    }

    if (completed && !prevSuppress) {
      scheduleCrossTabEvent();
    }
  }

  function withTimeout(promise, timeoutMs, label = 'request') {
    let timer = null;
    return Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timeout`)), timeoutMs);
      })
    ]).finally(() => clearTimeout(timer));
  }

  function getCsrfToken() {
    return document.querySelector('meta[name="csrf-token"]')?.content || '';
  }

  function getRuntimeWindow() {
    if (typeof unsafeWindow !== 'undefined' && unsafeWindow) {
      return unsafeWindow;
    }
    return window;
  }

  function getPageCspNonce() {
    const script = document.querySelector('script[nonce]');
    if (!script) return '';
    const nonce = script.nonce || script.getAttribute('nonce') || '';
    return String(nonce || '').trim();
  }

  function normalizeCategoryName(name) {
    const value = String(name || '').trim();
    return value.slice(0, 24);
  }

  function normalizeSearch(text) {
    return String(text || '').trim().toLowerCase();
  }

  function rebuildCategoryNameCache() {
    const map = Object.create(null);
    state.categories.forEach(category => {
      if (!category || !category.id) return;
      map[String(category.id)] = String(category.name || '未分类');
    });
    state.derived.categoryNameById = map;
  }

  function clampNumber(value, min, max, fallback = min) {
    const num = Number(value);
    if (!Number.isFinite(num)) return fallback;
    return Math.min(max, Math.max(min, num));
  }

  function isReaderTileSize(value) {
    return READER_TILE_SIZES.includes(String(value || '').toLowerCase());
  }

  function sanitizeReaderSizeOverrides(raw) {
    if (!raw || typeof raw !== 'object') {
      return {};
    }
    const cleaned = {};
    Object.keys(raw).forEach(key => {
      const topicKey = String(key || '').trim();
      const size = String(raw[key] || '').trim().toLowerCase();
      if (!topicKey || !isReaderTileSize(size)) return;
      cleaned[topicKey] = size;
    });
    return cleaned;
  }

  function getReaderTileModeLabel(mode) {
    if (mode === 'auto') return '自动';
    return READER_TILE_SIZE_LABELS[mode] || '自动';
  }

  function getNextReaderTileMode(currentMode) {
    const normalizedMode = currentMode === 'auto'
      ? 'auto'
      : (isReaderTileSize(currentMode) ? String(currentMode).toLowerCase() : 'auto');
    const currentIndex = READER_TILE_SIZE_MODES.indexOf(normalizedMode);
    const safeIndex = currentIndex >= 0 ? currentIndex : 0;
    return READER_TILE_SIZE_MODES[(safeIndex + 1) % READER_TILE_SIZE_MODES.length];
  }

  function isReaderLayoutMode(value) {
    return READER_LAYOUT_MODES.includes(String(value || '').toLowerCase());
  }

  function normalizeReaderLayoutMode(value) {
    const mode = String(value || '').toLowerCase();
    return isReaderLayoutMode(mode) ? mode : 'grid';
  }

  function getReaderBubbleDimensions(size) {
    switch (size) {
      case 'xl':
        return { width: 360, height: 212 };
      case 'l':
        return { width: 312, height: 188 };
      case 'm':
        return { width: 256, height: 156 };
      case 's':
      default:
        return { width: 214, height: 132 };
    }
  }

  function getReaderBubbleSizeByWidth(width) {
    const w = clampNumber(width, 120, 640, 220);
    if (w >= 336) return 'xl';
    if (w >= 288) return 'l';
    if (w >= 240) return 'm';
    return 's';
  }

  const externalDependencyPromises = Object.create(null);
  async function loadExternalDependency(url, globalName) {
    const runtimeWindow = getRuntimeWindow();
    const existing = globalThis[globalName] || runtimeWindow[globalName];
    if (existing) return existing;

    const cacheKey = `${globalName}:${url}`;
    if (externalDependencyPromises[cacheKey]) {
      return externalDependencyPromises[cacheKey];
    }

    externalDependencyPromises[cacheKey] = (async () => {
      await withTimeout(new Promise((resolve, reject) => {
        const script = document.createElement('script');
        const nonce = getPageCspNonce();
        let settled = false;

        const finish = (ok, error) => {
          if (settled) return;
          settled = true;
          script.onload = null;
          script.onerror = null;
          if (!ok) {
            script.remove();
            reject(error);
            return;
          }
          resolve();
        };

        script.src = url;
        script.async = true;
        script.crossOrigin = 'anonymous';
        if (nonce) {
          script.setAttribute('nonce', nonce);
        }

        script.onload = () => finish(true);
        script.onerror = () => finish(false, new Error(`加载 ${globalName} 失败: script onerror`));

        (document.head || document.documentElement).appendChild(script);
      }), 15000, `load ${globalName}`);

      const loaded = runtimeWindow[globalName] || globalThis[globalName];
      if (!loaded) {
        throw new Error(`加载 ${globalName} 失败: 未发现全局对象`);
      }
      if (!globalThis[globalName]) {
        globalThis[globalName] = loaded;
      }
      return loaded;
    })().catch(error => {
      delete externalDependencyPromises[cacheKey];
      throw error;
    });

    return externalDependencyPromises[cacheKey];
  }

  async function ensureReaderBubbleDependencies() {
    if (state.readerBubbleRuntime.depsLoading) {
      return state.readerBubbleRuntime.depsLoading;
    }

    state.readerBubbleRuntime.depsLoading = (async () => {
      const [Muuri, Panzoom, interact] = await Promise.all([
        loadExternalDependency(BUBBLE_DEPENDENCY_URLS.Muuri, 'Muuri'),
        loadExternalDependency(BUBBLE_DEPENDENCY_URLS.Panzoom, 'Panzoom'),
        loadExternalDependency(BUBBLE_DEPENDENCY_URLS.interact, 'interact')
      ]);
      return { Muuri, Panzoom, interact };
    })().catch(error => {
      state.readerBubbleRuntime.depsLoading = null;
      throw error;
    });

    return state.readerBubbleRuntime.depsLoading;
  }

  function destroyReaderBubbleRuntime() {
    const runtime = state.readerBubbleRuntime;
    runtime.mountToken += 1;
    runtime.interactables.forEach(instance => {
      if (instance && typeof instance.unset === 'function') {
        instance.unset();
      }
    });
    runtime.interactables = [];

    if (runtime.viewport && runtime.wheelHandler) {
      runtime.viewport.removeEventListener('wheel', runtime.wheelHandler);
    }
    runtime.wheelHandler = null;

    if (runtime.panzoom && typeof runtime.panzoom.destroy === 'function') {
      runtime.panzoom.destroy();
    }
    runtime.panzoom = null;

    if (runtime.grid && typeof runtime.grid.destroy === 'function') {
      runtime.grid.destroy();
    }
    runtime.grid = null;
    runtime.viewport = null;
    runtime.canvas = null;
  }

  function safeJsonParse(text, fallback) {
    try {
      return JSON.parse(text);
    } catch {
      return fallback;
    }
  }

  function ensureDefaultCategory(categories) {
    const cloned = Array.isArray(categories) ? categories.map(item => ({ ...item })) : [];
    const hasDefault = cloned.some(item => item.id === DEFAULT_CATEGORY_ID);
    if (!hasDefault) {
      cloned.unshift({ id: DEFAULT_CATEGORY_ID, name: '未分类', locked: true, createdAt: now() });
    }
    return cloned;
  }

  function loadStorage() {
    const categories = ensureDefaultCategory(GM_getValue(STORE_KEYS.CATEGORIES, []));
    const assignments = GM_getValue(STORE_KEYS.ASSIGNMENTS, {});
    const ui = GM_getValue(STORE_KEYS.UI, {});
    const rate = GM_getValue(STORE_KEYS.RATE, null);
    const readerSizeOverrides = GM_getValue(STORE_KEYS.READER_SIZE_OVERRIDES, {});
    const cachedUsername = GM_getValue(STORE_KEYS.USERNAME_CACHE, '');

    state.categories = categories;
    state.assignments = typeof assignments === 'object' && assignments ? assignments : {};
    state.readerSizeOverrides = sanitizeReaderSizeOverrides(readerSizeOverrides);
    rebuildDerivedCaches({ categories: true, bookmarks: false });

    if (ui && typeof ui === 'object') {
      state.activeCategoryId = ui.activeCategoryId || DEFAULT_CATEGORY_ID;
      state.activeSearch = ui.activeSearch || '';
      state.viewMode = ui.viewMode === 'manage' ? 'manage' : 'reader';
      state.readerTileScale = clampNumber(ui.readerTileScale, 0.8, 1.8, 1);
      state.readerColorBoost = clampNumber(ui.readerColorBoost, 0.6, 1.8, 1);
      state.readerLayoutMode = normalizeReaderLayoutMode(ui.readerLayoutMode);
    }

    ensureValidActiveCategory();
    state.bookmarkUrl = FIXED_BOOKMARKS_API_URL;
    state.cachedUsername = normalizeDiscourseUsername(cachedUsername);

    if (rate && typeof rate === 'object') {
      const requestTimes = Array.isArray(rate.requestTimes) ? rate.requestTimes : [];
      const manualRefreshHits = Array.isArray(rate.manualRefreshHits) ? rate.manualRefreshHits : [];
      state.rate.requestTimes = requestTimes.filter(ts => Number.isFinite(ts));
      state.rate.sessionRequestCount = Number.isFinite(rate.sessionRequestCount) ? rate.sessionRequestCount : 0;
      state.rate.manualRefreshHits = manualRefreshHits.filter(ts => Number.isFinite(ts));
    }
  }

  function ensureValidActiveCategory() {
    if (state.activeCategoryId === 'all') return;

    const exists = state.categories.some(c => c.id === state.activeCategoryId);
    if (!exists) {
      state.activeCategoryId = DEFAULT_CATEGORY_ID;
    }
  }

  function saveCategories() {
    GM_setValue(STORE_KEYS.CATEGORIES, clone(state.categories));
    if (!state.suppressCrossTabEmit) {
      scheduleCrossTabEvent();
    }
  }

  function saveAssignments() {
    GM_setValue(STORE_KEYS.ASSIGNMENTS, clone(state.assignments));
    if (!state.suppressCrossTabEmit) {
      scheduleCrossTabEvent();
    }
  }

  function saveReaderSizeOverrides() {
    GM_setValue(STORE_KEYS.READER_SIZE_OVERRIDES, clone(state.readerSizeOverrides));
    if (!state.suppressCrossTabEmit) {
      scheduleCrossTabEvent();
    }
  }

  function saveUi() {
    GM_setValue(STORE_KEYS.UI, {
      activeCategoryId: state.activeCategoryId,
      activeSearch: state.activeSearch,
      viewMode: state.viewMode,
      readerTileScale: state.readerTileScale,
      readerColorBoost: state.readerColorBoost,
      readerLayoutMode: state.readerLayoutMode
    });
  }

  function saveRate() {
    GM_setValue(STORE_KEYS.RATE, {
      requestTimes: state.rate.requestTimes.slice(-200),
      sessionRequestCount: state.rate.sessionRequestCount,
      manualRefreshHits: state.rate.manualRefreshHits.slice(-50)
    });
  }

  function saveCachedUsername(username) {
    const normalized = normalizeDiscourseUsername(username);
    if (!normalized) return '';
    if (state.cachedUsername === normalized) return normalized;
    state.cachedUsername = normalized;
    GM_setValue(STORE_KEYS.USERNAME_CACHE, normalized);
    return normalized;
  }

  function clearRateBecauseManualReload() {
    state.rate.requestTimes = [];
    state.rate.sessionRequestCount = 0;
    state.rate.manualRefreshHits = [];
    saveRate();
  }

  function pruneRateTimestamps() {
    const current = now();
    const windowStart = current - LIMIT_CONFIG.WINDOW_MS;
    const burstStart = current - LIMIT_CONFIG.MANUAL_REFRESH_WINDOW_MS;

    state.rate.requestTimes = state.rate.requestTimes.filter(ts => ts >= windowStart);
    state.rate.manualRefreshHits = state.rate.manualRefreshHits.filter(ts => ts >= burstStart);
  }

  async function enforceStrictRateLimit({ bypassBurst = false } = {}) {
    pruneRateTimestamps();

    if (!bypassBurst) {
      if (state.rate.manualRefreshHits.length >= LIMIT_CONFIG.MANUAL_REFRESH_BURST) {
        throw new Error('manual burst limited');
      }
    }

    if (state.rate.sessionRequestCount >= LIMIT_CONFIG.HARD_MAX_PER_SESSION) {
      throw new Error('session hard limit reached');
    }

    if (state.rate.requestTimes.length >= LIMIT_CONFIG.MAX_IN_WINDOW) {
      throw new Error('window limit reached');
    }

    const lastTs = state.rate.requestTimes[state.rate.requestTimes.length - 1] || 0;
    const diff = now() - lastTs;
    if (diff < LIMIT_CONFIG.MIN_INTERVAL_MS) {
      await sleep(LIMIT_CONFIG.MIN_INTERVAL_MS - diff);
    }
  }

  function markRequestConsumed({ manual = false } = {}) {
    const ts = now();
    state.rate.requestTimes.push(ts);
    state.rate.sessionRequestCount += 1;
    if (manual) {
      state.rate.manualRefreshHits.push(ts);
    }
    saveRate();
  }

  function isRetryableRequestError(error) {
    const message = String(error?.message || error || '').toLowerCase();
    return (
      message.includes('timeout') ||
      message.includes('network') ||
      message.includes('failed to fetch') ||
      message.includes('429') ||
      message.includes('cloudflare')
    );
  }

  async function requestJson(path, {
    method = 'GET',
    body = null,
    bodyFormat = 'json',
    manual = false,
    bypassBurst = false,
    retries = 0
  } = {}) {
    const maxRetries = Number.isFinite(retries) ? Math.max(0, retries) : 0;
    let attempt = 0;

    while (true) {
      await enforceStrictRateLimit({ bypassBurst });

      const token = getCsrfToken();
      const headers = {
        accept: 'application/json'
      };

      if (token) {
        headers['x-csrf-token'] = token;
      }

      let requestBody = undefined;
      if (body !== null && body !== undefined) {
        if (bodyFormat === 'form') {
          headers['content-type'] = 'application/x-www-form-urlencoded; charset=UTF-8';
          requestBody = body instanceof URLSearchParams ? body.toString() : String(body);
        } else {
          headers['content-type'] = 'application/json';
          requestBody = JSON.stringify(body);
        }
      }

      let consumed = false;
      const consumeOnce = () => {
        if (consumed) return;
        consumed = true;
        markRequestConsumed({ manual });
      };

      try {
        const response = await withTimeout(fetch(path, {
          method,
          credentials: 'include',
          headers,
          body: requestBody
        }), NETWORK_CONFIG.FETCH_TIMEOUT_MS, path);

        consumeOnce();

        if (response.status === 429) {
          throw new Error('rate limited by server 429');
        }

        const contentType = response.headers.get('content-type') || '';
        const text = await response.text();
        const data = contentType.includes('application/json') ? safeJsonParse(text, null) : null;

        if (!response.ok) {
          const errorMsg = data?.errors?.join('；') || data?.error || `${response.status}`;
          throw new Error(`request failed: ${errorMsg}`);
        }

        if (!data && !String(text || '').trim()) {
          return {};
        }

        if (!data) {
          throw new Error('invalid json response');
        }

        return data;
      } catch (error) {
        consumeOnce();
        if (attempt >= maxRetries || !isRetryableRequestError(error)) {
          throw error;
        }
        attempt += 1;
        await sleep(LIMIT_CONFIG.RETRY_BACKOFF_MS * attempt);
      }
    }
  }

  function parseTopicInfoFromUrl(urlLike) {
    const raw = String(urlLike || '').trim();
    if (!raw) {
      return { topicId: 0, postNumber: 1, slug: 'topic' };
    }

    let pathname = '';
    try {
      pathname = new URL(raw, window.location.origin).pathname || '';
    } catch {
      pathname = raw;
    }

    let match = pathname.match(/\/t\/([^/]+)\/(\d+)(?:\/(\d+))?/);
    if (match) {
      return {
        topicId: Number(match[2] || 0),
        postNumber: Number(match[3] || 1) || 1,
        slug: match[1] || 'topic'
      };
    }

    match = pathname.match(/\/t\/(\d+)(?:\/(\d+))?/);
    if (match) {
      return {
        topicId: Number(match[1] || 0),
        postNumber: Number(match[2] || 1) || 1,
        slug: 'topic'
      };
    }

    return { topicId: 0, postNumber: 1, slug: 'topic' };
  }

  function normalizeDiscourseUsername(value) {
    const name = String(value || '').trim();
    if (!name) return '';
    // Keep username format strict to avoid injecting invalid URL segments.
    if (!/^[A-Za-z0-9_.-]+$/.test(name)) return '';
    return name;
  }

  function extractUsernameFromBookmarksApiUrl(urlLike) {
    const raw = String(urlLike || '').trim();
    if (!raw) return '';

    let pathname = '';
    try {
      pathname = new URL(raw, window.location.origin).pathname || '';
    } catch {
      pathname = raw;
    }

    const match = pathname.match(/\/u\/([^/]+)\/bookmarks\.json(?:\/|$)/i);
    if (!match) return '';
    const encoded = String(match[1] || '').trim();
    if (!encoded) return '';

    try {
      return normalizeDiscourseUsername(decodeURIComponent(encoded));
    } catch {
      return normalizeDiscourseUsername(encoded);
    }
  }

  function buildBookmarksApiUrlByUsername(username) {
    const normalized = normalizeDiscourseUsername(username);
    if (!normalized) return FIXED_BOOKMARKS_API_URL;
    return `https://linux.do/u/${encodeURIComponent(normalized)}/bookmarks.json`;
  }

  function extractUsernameFromCurrentUserPayload(rawCurrentUser) {
    let payload = rawCurrentUser;
    if (typeof payload === 'string') {
      payload = safeJsonParse(payload, null);
    }
    if (!payload || typeof payload !== 'object') return '';
    return normalizeDiscourseUsername(payload.username || payload.user?.username || '');
  }

  function detectUsernameFromPreloadedStore() {
    const preloadedElement = document.getElementById('data-preloaded');
    if (!preloadedElement) return '';

    const attrRaw = String(preloadedElement.getAttribute('data-preloaded') || '').trim();
    const textRaw = String(preloadedElement.textContent || '').trim();
    const rawPreloaded = attrRaw || textRaw;
    if (!rawPreloaded) return '';

    const preloadedPayload = safeJsonParse(rawPreloaded, null);
    if (!preloadedPayload || typeof preloadedPayload !== 'object') return '';

    return extractUsernameFromCurrentUserPayload(
      preloadedPayload.currentUser ?? preloadedPayload.current_user ?? null
    );
  }

  function detectUsernameFromCurrentUserMentionCss() {
    const cssText = String(document.getElementById('current-user-mention-css')?.textContent || '');
    if (!cssText) return '';

    const match = cssText.match(/\/u\/([^"\/\]\s]+)/i);
    if (!match) return '';
    const encoded = String(match[1] || '').trim();
    if (!encoded) return '';

    try {
      return normalizeDiscourseUsername(decodeURIComponent(encoded));
    } catch {
      return normalizeDiscourseUsername(encoded);
    }
  }

  function detectUsernameFromHeaderCurrentUserLink() {
    const selectors = [
      '.d-header .current-user a[href*="/u/"]',
      '.d-header-icons .current-user a[href*="/u/"]',
      '.d-header a.header-dropdown-toggle[href*="/u/"]',
      '.d-header-icons a.header-dropdown-toggle[href*="/u/"]'
    ];

    for (const selector of selectors) {
      const node = document.querySelector(selector);
      if (!node) continue;
      const hrefRaw = String(node.getAttribute('href') || '').trim();
      if (!hrefRaw) continue;

      let pathname = '';
      try {
        pathname = new URL(hrefRaw, window.location.origin).pathname || '';
      } catch {
        pathname = hrefRaw;
      }

      const match = pathname.match(/\/u\/([^/?#]+)/i);
      if (!match) continue;
      const encoded = String(match[1] || '').trim();
      if (!encoded) continue;

      try {
        const decoded = decodeURIComponent(encoded);
        const normalized = normalizeDiscourseUsername(decoded);
        if (normalized) return normalized;
      } catch {
        // Ignore decode errors and keep raw fallback.
      }

      const normalized = normalizeDiscourseUsername(encoded);
      if (normalized) return normalized;
    }

    return '';
  }

  function createResolvedApiContext(username, source, fallback = false) {
    const normalized = normalizeDiscourseUsername(username);
    if (normalized) {
      saveCachedUsername(normalized);
    }
    const url = normalized ? buildBookmarksApiUrlByUsername(normalized) : FIXED_BOOKMARKS_API_URL;
    state.bookmarkUrl = url;
    return { url, username: normalized, source, fallback };
  }

  async function detectUsernameFromSessionApi({ manual = false } = {}) {
    try {
      const payload = await requestJson('/session/current.json', {
        manual,
        retries: 0,
        bypassBurst: false
      });
      return extractUsernameFromCurrentUserPayload(
        payload?.current_user ?? payload?.currentUser ?? null
      );
    } catch {
      return '';
    }
  }

  async function resolveBookmarkApiContext({ manual = false, allowNetwork = true } = {}) {
    const fallbackUsername = normalizeDiscourseUsername(state.cachedUsername)
      || extractUsernameFromBookmarksApiUrl(FIXED_BOOKMARKS_API_URL);

    const preloadedUsername = detectUsernameFromPreloadedStore();
    if (preloadedUsername) {
      return createResolvedApiContext(preloadedUsername, 'preloaded', false);
    }

    const mentionCssUsername = detectUsernameFromCurrentUserMentionCss();
    if (mentionCssUsername) {
      return createResolvedApiContext(mentionCssUsername, 'mention-css', false);
    }

    const headerUsername = detectUsernameFromHeaderCurrentUserLink();
    if (headerUsername) {
      return createResolvedApiContext(headerUsername, 'header-link', false);
    }

    const cachedUsername = normalizeDiscourseUsername(state.cachedUsername);
    if (cachedUsername) {
      return createResolvedApiContext(cachedUsername, 'cache', false);
    }

    if (allowNetwork) {
      const sessionUsername = await detectUsernameFromSessionApi({ manual });
      if (sessionUsername) {
        return createResolvedApiContext(sessionUsername, 'session-api', false);
      }
    }

    return createResolvedApiContext(fallbackUsername, 'fallback', true);
  }

  function isTopicPageRoute(pathnameLike = window.location.pathname) {
    const parsed = parseTopicInfoFromUrl(pathnameLike || '');
    return Number(parsed.topicId || 0) > 0;
  }

  function normalizePositiveInt(value) {
    const num = Number(value);
    if (!Number.isFinite(num) || num <= 0) return 0;
    return Math.floor(num);
  }

  function extractBookmarkIdFromPayload(payload) {
    const candidates = [
      payload?.id,
      payload?.bookmark?.id,
      payload?.user_bookmark?.id,
      payload?.bookmark_id
    ];

    for (const candidate of candidates) {
      const id = normalizePositiveInt(candidate);
      if (id) return id;
    }
    return 0;
  }

  function getPostIdFromTopicDom(topicId, postNumber) {
    const current = parseTopicInfoFromUrl(window.location.pathname || '');
    if (Number(current.topicId || 0) !== Number(topicId || 0)) {
      return 0;
    }

    const candidates = [
      `article#post_${postNumber}[data-post-id]`,
      `#post_${postNumber}[data-post-id]`,
      `.topic-post[data-post-number="${postNumber}"][data-post-id]`,
      `.topic-post[id="post_${postNumber}"]`
    ];

    for (const selector of candidates) {
      const node = document.querySelector(selector);
      if (!node) continue;
      const id = normalizePositiveInt(node.getAttribute('data-post-id') || node.dataset?.postId || '');
      if (id) return id;
    }

    return 0;
  }

  async function fetchTopicPayloadByApi(topicId, slug = 'topic', { manual = false } = {}) {
    const path = `/t/${encodeURIComponent(slug || 'topic')}/${topicId}.json`;
    try {
      const payload = await requestJson(path, { manual, retries: 1, bypassBurst: false });
      if (!payload || !payload.id) return null;
      return payload;
    } catch {
      return null;
    }
  }

  async function resolvePostIdForBookmark(parsed, { manual = false } = {}) {
    const topicId = Number(parsed?.topicId || 0);
    const postNumber = Number(parsed?.postNumber || 1) || 1;
    if (!topicId) {
      throw new Error('无效的话题ID');
    }

    const domPostId = getPostIdFromTopicDom(topicId, postNumber);
    if (domPostId) {
      return domPostId;
    }

    const payload = await fetchTopicPayloadByApi(topicId, parsed?.slug || 'topic', { manual });
    if (!payload) {
      throw new Error('无法获取话题详情，无法定位楼层ID');
    }

    const posts = Array.isArray(payload.post_stream?.posts) ? payload.post_stream.posts : [];
    const matched = posts.find(post => Number(post?.post_number || 0) === postNumber)
      || (postNumber === 1 ? posts[0] : null);
    const postId = normalizePositiveInt(matched?.id);
    if (!postId) {
      throw new Error('无法定位该楼层的服务端ID，请先打开对应楼层后重试');
    }
    return postId;
  }

  async function createBookmarkOnServer(postId, { manual = false } = {}) {
    const bookmarkableId = normalizePositiveInt(postId);
    if (!bookmarkableId) {
      throw new Error('无效的楼层ID');
    }

    const form = new URLSearchParams();
    form.set('reminder_at', '');
    form.set('auto_delete_preference', '3');
    form.set('bookmarkable_id', String(bookmarkableId));
    form.set('bookmarkable_type', 'Post');

    return requestJson('/bookmarks.json', {
      method: 'POST',
      body: form,
      bodyFormat: 'form',
      manual,
      retries: 1,
      bypassBurst: false
    });
  }

  async function deleteBookmarkOnServer(bookmarkId, { manual = false } = {}) {
    const id = normalizePositiveInt(bookmarkId);
    if (!id) {
      throw new Error('无效的服务端书签ID');
    }

    await requestJson(`/bookmarks/${id}.json`, {
      method: 'DELETE',
      manual,
      retries: 1,
      bypassBurst: false
    });
  }

  async function findServerBookmarkByTopic(topicId, postNumber, { manual = false, maxPages = 2 } = {}) {
    const wantedTopicId = Number(topicId || 0);
    const wantedPostNumber = Number(postNumber || 1) || 1;
    const apiContext = await resolveBookmarkApiContext({ manual, allowNetwork: true });
    let currentPath = apiContext.url || FIXED_BOOKMARKS_API_URL;
    let page = 0;

    while (currentPath && page < Math.max(1, Number(maxPages || 1))) {
      page += 1;
      const payload = await requestJson(currentPath, {
        manual,
        retries: 1,
        bypassBurst: false
      });
      const parsed = parseBookmarksFromJsonPayload(payload);
      const found = parsed.bookmarks.find(item => isSameTopicBookmark(item, wantedTopicId, wantedPostNumber));
      if (found) return found;
      currentPath = parsed.nextPath ? normalizeBookmarksApiPath(parsed.nextPath) : null;
    }

    return null;
  }

  async function resolveServerBookmarkIdForItem(item, { manual = false } = {}) {
    const directId = normalizePositiveInt(item?.bookmarkId);
    if (directId) return directId;

    const topicId = Number(item?.topicId || 0);
    const postNumber = Number(item?.postNumber || 1) || 1;
    if (!topicId) return 0;

    const found = await findServerBookmarkByTopic(topicId, postNumber, {
      manual,
      maxPages: 6
    });
    return normalizePositiveInt(found?.bookmarkId);
  }

  function toBookmarkTopicModel(item) {
    const maybeUrl = item?.bookmarkable_url || item?.url || item?.topic?.url || '';
    const normalizedUrl = maybeUrl
      ? (String(maybeUrl).startsWith('http') ? String(maybeUrl) : `https://linux.do${String(maybeUrl).startsWith('/') ? '' : '/'}${String(maybeUrl)}`)
      : '';

    const parsedFromUrl = parseTopicInfoFromUrl(normalizedUrl);

    const topicId = Number(
      item?.topic_id
      || item?.topic?.id
      || item?.topicId
      || item?.bookmarkable_topic_id
      || (item?.bookmarkable_type === 'Topic' ? item?.bookmarkable_id : 0)
      || parsedFromUrl.topicId
      || 0
    );
    if (!topicId) return null;

    const postNumber = Number(item?.linked_post_number || item?.post_number || parsedFromUrl.postNumber || 1) || 1;
    const slug = item?.slug || item?.topic_slug || item?.topic?.slug || parsedFromUrl.slug || 'topic';

    const rawTags = Array.isArray(item?.tags)
      ? item.tags
      : Array.isArray(item?.topic?.tags)
        ? item.topic.tags
        : [];

    const tags = rawTags
      .map(tag => (typeof tag === 'string' ? tag : (tag?.name || tag?.slug || '')))
      .filter(Boolean);

    const finalUrl = normalizedUrl || `https://linux.do/t/${slug}/${topicId}/${postNumber}`;
    const postsCount = normalizePositiveInt(item?.posts_count || item?.topic?.posts_count || 0);
    const replyCount = normalizePositiveInt(
      item?.reply_count
      || item?.topic?.reply_count
      || (postsCount > 0 ? Math.max(0, postsCount - 1) : 0)
    );
    const highestPostNumber = normalizePositiveInt(
      item?.highest_post_number
      || item?.topic?.highest_post_number
      || (postsCount > 0 ? postsCount : 0)
    );
    const likeCount = normalizePositiveInt(item?.like_count || item?.topic?.like_count || 0);

    return {
      bookmarkId: item?.id || `bookmark_${topicId}_${postNumber}`,
      topicId,
      postNumber,
      title: item?.title || item?.fancy_title || item?.topic_title || `话题 ${topicId}`,
      fancyTitle: item?.fancy_title || item?.title || item?.topic_title || '',
      excerpt: item?.excerpt || '',
      categoryId: item?.category_id ?? item?.topic?.category_id ?? null,
      tags,
      bookmarkableType: item?.bookmarkable_type || 'Post',
      bookmarkableId: item?.bookmarkable_id || null,
      bookmarkedAt: item?.created_at || null,
      updatedAt: item?.updated_at || null,
      bumpedAt: item?.bumped_at || null,
      slug,
      url: finalUrl,
      postsCount,
      replyCount,
      highestPostNumber,
      likeCount,
      user: item?.user ? {
        username: item.user.username,
        avatarTemplate: item.user.avatar_template
      } : null,
      deleted: !!item?.deleted,
      hidden: !!item?.hidden
    };
  }

  function getBookmarkUniqueKey(item) {
    if (!item || typeof item !== 'object') return '';

    const bookmarkId = item.bookmarkId;
    if (bookmarkId !== undefined && bookmarkId !== null && String(bookmarkId).trim()) {
      return `bookmark:${String(bookmarkId)}`;
    }

    const topicId = Number(item.topicId || 0);
    if (!topicId) return '';

    const postNumber = Number(item.postNumber || 1) || 1;
    return `topic:${topicId}:${postNumber}`;
  }

  function getTopicPostCacheKey(topicId, postNumber = 1) {
    const normalizedTopicId = Number(topicId || 0);
    const normalizedPostNumber = Number(postNumber || 1) || 1;
    if (!normalizedTopicId) return '';
    return `${normalizedTopicId}:${normalizedPostNumber}`;
  }

  function getBookmarkDerived(item) {
    if (!item || typeof item !== 'object') {
      return { searchText: '', bookmarkedTs: 0, dateText: '' };
    }

    const cached = bookmarkDerivedMeta.get(item);
    if (cached) return cached;

    const tagsText = Array.isArray(item.tags) ? item.tags.join(' ') : '';
    const searchText = `${item.title || ''} ${item.excerpt || ''} ${tagsText}`.toLowerCase();
    const tsRaw = item.bookmarkedAt ? new Date(item.bookmarkedAt).getTime() : 0;
    const bookmarkedTs = Number.isFinite(tsRaw) ? tsRaw : 0;
    const dateText = bookmarkedTs ? new Date(bookmarkedTs).toLocaleString() : '';

    const derived = { searchText, bookmarkedTs, dateText };
    bookmarkDerivedMeta.set(item, derived);
    return derived;
  }

  function rebuildBookmarkCaches() {
    const byKey = Object.create(null);
    const byTopicPost = Object.create(null);
    const byTopicAny = Object.create(null);

    state.bookmarks.forEach(item => {
      if (!item || typeof item !== 'object') return;

      const uniqueKey = getBookmarkUniqueKey(item);
      if (uniqueKey) {
        byKey[uniqueKey] = item;
      }

      const topicId = Number(item.topicId || 0);
      const postNumber = Number(item.postNumber || 1) || 1;
      const topicPostKey = getTopicPostCacheKey(topicId, postNumber);
      if (topicPostKey && !byTopicPost[topicPostKey]) {
        byTopicPost[topicPostKey] = item;
      }
      if (topicId && !byTopicAny[String(topicId)]) {
        byTopicAny[String(topicId)] = item;
      }

      getBookmarkDerived(item);
    });

    state.derived.bookmarkByKey = byKey;
    state.derived.bookmarkByTopicPost = byTopicPost;
    state.derived.bookmarkByTopicAny = byTopicAny;
  }

  function rebuildDerivedCaches({ categories = true, bookmarks = true } = {}) {
    if (categories) {
      rebuildCategoryNameCache();
    }
    if (bookmarks) {
      rebuildBookmarkCaches();
    }
  }

  function isSameTopicBookmark(item, topicId, postNumber = 1) {
    const expectedTopicId = Number(topicId || 0);
    const expectedPostNumber = Number(postNumber || 1) || 1;
    if (!expectedTopicId) return false;
    return (
      Number(item?.topicId || 0) === expectedTopicId
      && (Number(item?.postNumber || 1) || 1) === expectedPostNumber
    );
  }

  function findLocalBookmarkByTopic(topicId, postNumber = 1) {
    const cached = state.derived.bookmarkByTopicPost[getTopicPostCacheKey(topicId, postNumber)];
    if (cached) return cached;
    return state.bookmarks.find(item => isSameTopicBookmark(item, topicId, postNumber)) || null;
  }

  function findLocalBookmarkByTopicAnyPost(topicId, postNumber = 1) {
    const exact = findLocalBookmarkByTopic(topicId, postNumber);
    if (exact) return exact;
    const expectedTopicId = Number(topicId || 0);
    if (!expectedTopicId) return null;
    const cached = state.derived.bookmarkByTopicAny[String(expectedTopicId)];
    if (cached) return cached;
    return state.bookmarks.find(item => Number(item?.topicId || 0) === expectedTopicId) || null;
  }

  function findLocalBookmarkByUniqueKey(topicKey) {
    const key = String(topicKey || '').trim();
    if (!key) return null;
    return state.derived.bookmarkByKey[key] || state.bookmarks.find(item => getBookmarkUniqueKey(item) === key) || null;
  }

  function dedupeBookmarks(list) {
    const map = new Map();
    list.forEach(item => {
      const uniqueKey = getBookmarkUniqueKey(item);
      if (!uniqueKey) return;

      const existing = map.get(uniqueKey);
      if (!existing) {
        map.set(uniqueKey, item);
        return;
      }

      const currentTs = new Date(item.updatedAt || item.bookmarkedAt || 0).getTime();
      const oldTs = new Date(existing.updatedAt || existing.bookmarkedAt || 0).getTime();
      if (currentTs >= oldTs) {
        map.set(uniqueKey, item);
      }
    });
    return Array.from(map.values());
  }

  function parseBookmarksFromJsonPayload(payload) {
    if (!payload || typeof payload !== 'object') {
      return { bookmarks: [], nextPath: null };
    }

    const list = payload.user_bookmark_list?.bookmarks || payload.bookmarks || payload.bookmark_list || [];
    const mapped = Array.isArray(list)
      ? list.map(toBookmarkTopicModel).filter(item => item && item.topicId)
      : [];

    const moreBookmarksUrl = payload.user_bookmark_list?.more_bookmarks_url
      || payload.more_bookmarks_url
      || payload.bookmark_list?.more_bookmarks_url
      || '';

    const nextPath = normalizeBookmarksApiPath(moreBookmarksUrl);
    return { bookmarks: mapped, nextPath };
  }

  function normalizeBookmarksApiPath(path) {
    const raw = String(path || '').trim();
    if (!raw) return null;

    if (/^https?:\/\//i.test(raw)) {
      try {
        const u = new URL(raw);
        return `${u.pathname}${u.search || ''}`;
      } catch {
        return null;
      }
    }

    if (raw.startsWith('/')) return raw;
    return `/${raw}`;
  }

  async function fetchAllBookmarksByApi({ manual = false, basePath = '' } = {}) {
    const basePathResolved = String(basePath || '').trim()
      || (await resolveBookmarkApiContext({ manual, allowNetwork: true })).url
      || '';

    if (!basePathResolved) {
      throw new Error('无法访问书签API，请确认已登录且有权限访问书签');
    }

    const all = [];
    const seen = new Set();

    let currentPath = basePathResolved;
    let page = 0;

    while (currentPath && page < NETWORK_CONFIG.MAX_PAGES_PER_SYNC) {
      page += 1;

      const payload = await requestJson(currentPath, {
        manual,
        retries: 1,
        bypassBurst: false
      });

      const parsed = parseBookmarksFromJsonPayload(payload);

      let newCount = 0;
      parsed.bookmarks.forEach(item => {
        const key = getBookmarkUniqueKey(item);
        if (!key) return;
        if (seen.has(key)) return;
        seen.add(key);
        all.push(item);
        newCount += 1;
      });

      state.sync.pageFetched = page;
      state.sync.totalFetched = all.length;
      const rawCount = parsed.bookmarks.length;
      const duplicatedCount = Math.max(0, rawCount - newCount);
      setStatus(`API同步中: 第 ${page} 页，新增 ${newCount}（原始 ${rawCount}，去重 ${duplicatedCount}），累计 ${all.length} 条`, 'info');

      if (!parsed.bookmarks.length) {
        currentPath = null;
        continue;
      }

      if (parsed.nextPath) {
        currentPath = parsed.nextPath;
        continue;
      }

      currentPath = null;
    }

    return dedupeBookmarks(all);
  }

  function ensureAssignmentForBookmarks({ persist = true } = {}) {
    let changed = false;
    const validTopicIds = new Set(state.bookmarks.map(item => String(item.topicId)));
    const validBookmarkKeys = new Set(state.bookmarks.map(item => getBookmarkUniqueKey(item)).filter(Boolean));
    let readerOverridesChanged = false;

    state.bookmarks.forEach(item => {
      const key = String(item.topicId);
      if (!state.assignments[key]) {
        state.assignments[key] = DEFAULT_CATEGORY_ID;
        changed = true;
      }
    });

    Object.keys(state.assignments).forEach(topicId => {
      if (!validTopicIds.has(topicId)) {
        delete state.assignments[topicId];
        changed = true;
      }
    });

    Object.keys(state.readerSizeOverrides).forEach(topicKey => {
      if (validBookmarkKeys.has(topicKey)) return;
      delete state.readerSizeOverrides[topicKey];
      readerOverridesChanged = true;
    });

    const categorySet = new Set(state.categories.map(c => c.id));
    Object.keys(state.assignments).forEach(topicId => {
      const categoryId = state.assignments[topicId];
      if (!categorySet.has(categoryId)) {
        state.assignments[topicId] = DEFAULT_CATEGORY_ID;
        changed = true;
      }
    });

    if (persist && changed) {
      saveAssignments();
    }
    if (persist && readerOverridesChanged) {
      saveReaderSizeOverrides();
    }

    return {
      assignmentsChanged: changed,
      readerOverridesChanged
    };
  }

  function snapshotBookmarks() {
    GM_setValue(STORE_KEYS.SNAPSHOT, {
      ts: now(),
      count: state.bookmarks.length,
      bookmarks: state.bookmarks
    });
    if (!state.suppressCrossTabEmit) {
      scheduleCrossTabEvent();
    }
  }

  function loadSnapshotBookmarks() {
    const snap = GM_getValue(STORE_KEYS.SNAPSHOT, null);
    if (!snap || !Array.isArray(snap.bookmarks)) {
      return false;
    }
    state.bookmarks = snap.bookmarks;
    ensureAssignmentForBookmarks();
    rebuildDerivedCaches({ categories: false, bookmarks: true });
    return true;
  }

  function refreshDataFromStorage() {
    const oldViewMode = state.viewMode;
    const oldSearch = state.activeSearch;
    const oldActiveCategoryId = state.activeCategoryId;
    const oldReaderLayoutMode = state.readerLayoutMode;

    state.suppressCrossTabEmit = true;
    try {
      const categories = ensureDefaultCategory(GM_getValue(STORE_KEYS.CATEGORIES, []));
      const assignments = GM_getValue(STORE_KEYS.ASSIGNMENTS, {});
      const readerSizeOverrides = GM_getValue(STORE_KEYS.READER_SIZE_OVERRIDES, {});
      state.categories = categories;
      state.assignments = typeof assignments === 'object' && assignments ? assignments : {};
      state.readerSizeOverrides = sanitizeReaderSizeOverrides(readerSizeOverrides);

      if (!loadSnapshotBookmarks()) {
        state.bookmarks = [];
      }

      rebuildDerivedCaches();

      // Keep each tab's own view/search context stable during data sync.
      state.viewMode = oldViewMode;
      state.activeSearch = oldSearch;
      state.activeCategoryId = oldActiveCategoryId;
      state.readerLayoutMode = oldReaderLayoutMode;
      ensureValidActiveCategory();
    } finally {
      state.suppressCrossTabEmit = false;
    }

    updateSidebarCount();
    if (state.drawerOpen) {
      renderAll();
    } else {
      updateFabBadge();
      updateFabQuickAdd();
    }
  }

  function getCategoryCountMap() {
    const map = Object.create(null);
    state.categories.forEach(c => {
      map[c.id] = 0;
    });

    state.bookmarks.forEach(item => {
      const cid = state.assignments[String(item.topicId)] || DEFAULT_CATEGORY_ID;
      if (!map[cid] && map[cid] !== 0) {
        map[cid] = 0;
      }
      map[cid] += 1;
    });

    return map;
  }

  function getFilteredBookmarks() {
    const search = normalizeSearch(state.activeSearch);
    const categoryId = state.activeCategoryId;

    return state.bookmarks.filter(item => {
      const assigned = state.assignments[String(item.topicId)] || DEFAULT_CATEGORY_ID;
      if (categoryId !== 'all' && assigned !== categoryId) {
        return false;
      }

      if (!search) return true;

      return getBookmarkDerived(item).searchText.includes(search);
    });
  }

  function updateFabBadge() {
    if (!state.refs.fab) return;
    const badge = state.refs.fab.querySelector('.ldbm-fab-badge');
    if (!badge) return;
    badge.textContent = String(state.bookmarks.length);
  }

  function setStatus(text, type = 'info') {
    if (!state.refs.drawer) return;
    const node = state.refs.drawer.querySelector('.ldbm-status-text');
    if (!node) return;
    node.textContent = text;
    node.dataset.type = type;
  }

  function renderCategories() {
    if (!state.refs.drawer) return;

    const wrap = state.refs.drawer.querySelector('.ldbm-categories');
    if (!wrap) return;

    const countMap = getCategoryCountMap();

    const allTotal = state.bookmarks.length;
    const allActive = state.activeCategoryId === 'all' ? 'active' : '';
    let htmlText = `
      <button class="ldbm-cat-item ${allActive}" data-category-id="all">
        <span class="name">全部</span>
        <span class="count">${allTotal}</span>
      </button>
    `;

    state.categories.forEach((category, index) => {
      const active = state.activeCategoryId === category.id ? 'active' : '';
      const count = countMap[category.id] || 0;
      const isUncategorized = category.id === DEFAULT_CATEGORY_ID;
      const categoryClasses = ['ldbm-cat-item', active, isUncategorized ? 'ldbm-cat-uncategorized' : '']
        .filter(Boolean)
        .join(' ');
      const lockBadge = category.locked ? `<span class="lock">${isUncategorized ? '重点' : '默认'}</span>` : '';
      const focusBadge = isUncategorized && count > 0 ? '<span class="focus">待归类</span>' : '';
      const dragAttr = category.locked ? '' : ' draggable="true"';
      const topBtn = category.locked
        ? ''
        : `<span class="ldbm-cat-top" data-category-id="${html.escape(category.id)}" title="置顶（支持右键）">↑</span>`;

      htmlText += `
        <button class="${categoryClasses}" data-category-id="${html.escape(category.id)}" data-category-index="${index}"${dragAttr}>
          <span class="name">${html.escape(category.name)}</span>
          ${lockBadge}
          ${focusBadge}
          <span class="count">${count}</span>
          ${topBtn}
        </button>
      `;
    });

    wrap.innerHTML = htmlText;
  }

  function hashStringToHue(text) {
    const value = String(text || 'untagged');
    let hash = 0;
    for (let i = 0; i < value.length; i += 1) {
      hash = (hash * 31 + value.charCodeAt(i)) % 3600;
    }
    return Math.abs(hash) % 360;
  }

  function computeBookmarkScore(item) {
    const highestPostNumber = normalizePositiveInt(
      item?.highestPostNumber
      || item?.highest_post_number
      || item?.postsCount
      || item?.posts_count
      || 0
    );
    const tagsCount = Array.isArray(item?.tags) ? item.tags.length : 0;
    const ts = getBookmarkDerived(item).bookmarkedTs;
    const ageDays = ts ? Math.max(0, (now() - ts) / (24 * 60 * 60 * 1000)) : 30;
    const freshBoost = Math.max(0, 1 - ageDays / 45);

    // User bookmark API has no likes; rank by highest floor first.
    const raw = highestPostNumber * 5;
    const fallback = 1 + tagsCount * 1.2 + freshBoost * 4;
    return Number((raw > 0 ? raw : fallback).toFixed(2));
  }

  function getReaderTileSize(normalized, scale) {
    const sized = normalized * scale;
    if (sized >= 1.35) return 'xl';
    if (sized >= 0.95) return 'l';
    if (sized >= 0.55) return 'm';
    return 's';
  }

  function renderReaderEntryGrid(list) {
    const scored = list.map(item => ({ item, score: computeBookmarkScore(item) }));
    const allScores = scored.map(x => x.score);
    const minScore = Math.min(...allScores);
    const maxScore = Math.max(...allScores);
    const den = Math.max(0.0001, maxScore - minScore);

    const entries = scored
      .sort((a, b) => b.score - a.score)
      .map(({ item, score }) => {
        const normalized = (score - minScore) / den;
        const autoSize = getReaderTileSize(normalized, state.readerTileScale);
        const topicKey = getBookmarkUniqueKey(item) || `topic:${Number(item.topicId || 0)}:${Number(item.postNumber || 1) || 1}`;
        const overrideSize = topicKey ? state.readerSizeOverrides[topicKey] : '';
        const resolvedSize = isReaderTileSize(overrideSize) ? overrideSize : autoSize;
        const sizeMode = isReaderTileSize(overrideSize) ? overrideSize : 'auto';
        const sizeModeLabel = getReaderTileModeLabel(sizeMode);
        const nextModeLabel = getReaderTileModeLabel(getNextReaderTileMode(sizeMode));
        const mainTag = Array.isArray(item.tags) && item.tags.length ? item.tags[0] : '未标注';
        const baseHue = hashStringToHue(mainTag);
        const hueShift = Math.round(normalized * 48 * state.readerColorBoost);
        const hue = (baseHue + hueShift) % 360;
        const sat = Math.round(clampNumber(52 + state.readerColorBoost * 18, 40, 88, 62));
        const light = Math.round(clampNumber(94 - normalized * 18 * state.readerColorBoost, 64, 95, 88));
        const categoryId = state.assignments[String(item.topicId)] || DEFAULT_CATEGORY_ID;
        const categoryName = getCategoryNameById(categoryId);
        const topicText = item.postNumber > 1 ? `#${item.topicId}/${item.postNumber}` : `#${item.topicId}`;
        const title = html.escape(item.title || `话题 ${item.topicId}`);
        const scoreText = Number(score).toFixed(score >= 10 ? 0 : 1);

        return `
          <a class="ldbm-entry-tile" data-size="${resolvedSize}" data-topic-key="${html.escape(topicKey)}" href="${html.escape(item.url)}" target="_blank" rel="noreferrer"
             style="--entry-hue:${hue};--entry-sat:${sat}%;--entry-light:${light}%;" title="${title}">
            <div class="ldbm-entry-top">
              <span class="ldbm-entry-tag">#${html.escape(mainTag)}</span>
              <span class="ldbm-entry-tools">
                <span class="ldbm-entry-size-btn" role="button" tabindex="0"
                  data-topic-key="${html.escape(topicKey)}"
                  data-size-mode="${html.escape(sizeMode)}"
                  title="手动调整大小（当前：${html.escape(sizeModeLabel)}，下一步：${html.escape(nextModeLabel)}）">${html.escape(sizeModeLabel)}</span>
                <span class="ldbm-entry-score">${scoreText}</span>
              </span>
            </div>
            <div class="ldbm-entry-title">${title}</div>
            <div class="ldbm-entry-meta">
              <span>${html.escape(categoryName)}</span>
              <span>${html.escape(topicText)}</span>
            </div>
          </a>
        `;
      })
      .join('');

    return `<div class="ldbm-entry-grid">${entries}</div>`;
  }

  function renderReaderEntryBubbles(list) {
    const scored = list.map(item => ({ item, score: computeBookmarkScore(item) }));
    const allScores = scored.map(x => x.score);
    const minScore = Math.min(...allScores);
    const maxScore = Math.max(...allScores);
    const den = Math.max(0.0001, maxScore - minScore);

    const entries = scored
      .sort((a, b) => b.score - a.score)
      .map(({ item, score }) => {
        const normalized = (score - minScore) / den;
        const autoSize = getReaderTileSize(normalized, state.readerTileScale);
        const topicKey = getBookmarkUniqueKey(item) || `topic:${Number(item.topicId || 0)}:${Number(item.postNumber || 1) || 1}`;
        const overrideSize = topicKey ? state.readerSizeOverrides[topicKey] : '';
        const resolvedSize = isReaderTileSize(overrideSize) ? overrideSize : autoSize;
        const sizeMode = isReaderTileSize(overrideSize) ? overrideSize : 'auto';
        const sizeModeLabel = getReaderTileModeLabel(sizeMode);
        const nextModeLabel = getReaderTileModeLabel(getNextReaderTileMode(sizeMode));
        const dim = getReaderBubbleDimensions(resolvedSize);
        const mainTag = Array.isArray(item.tags) && item.tags.length ? item.tags[0] : '未标注';
        const baseHue = hashStringToHue(mainTag);
        const hueShift = Math.round(normalized * 48 * state.readerColorBoost);
        const hue = (baseHue + hueShift) % 360;
        const sat = Math.round(clampNumber(52 + state.readerColorBoost * 18, 40, 88, 62));
        const light = Math.round(clampNumber(94 - normalized * 18 * state.readerColorBoost, 64, 95, 88));
        const bubbleSat = Math.round(clampNumber(sat - 6, 36, 82, 58));
        const bubbleLight = Math.round(clampNumber(light + 6, 72, 96, 90));
        const categoryId = state.assignments[String(item.topicId)] || DEFAULT_CATEGORY_ID;
        const categoryName = getCategoryNameById(categoryId);
        const topicText = item.postNumber > 1 ? `#${item.topicId}/${item.postNumber}` : `#${item.topicId}`;
        const title = html.escape(item.title || `话题 ${item.topicId}`);
        const scoreText = Number(score).toFixed(score >= 10 ? 0 : 1);

        return `
          <article class="ldbm-bubble-item ldbm-panzoom-exclude" data-size="${resolvedSize}" data-topic-key="${html.escape(topicKey)}"
            style="--entry-hue:${hue};--entry-sat:${bubbleSat}%;--entry-light:${bubbleLight}%;width:${dim.width}px;height:${dim.height}px;">
            <div class="ldbm-bubble-top ldbm-bubble-drag-handle">
              <span class="ldbm-bubble-tag">#${html.escape(mainTag)}</span>
              <span class="ldbm-bubble-tools">
                <span class="ldbm-entry-size-btn ldbm-panzoom-exclude" role="button" tabindex="0"
                  data-topic-key="${html.escape(topicKey)}"
                  data-size-mode="${html.escape(sizeMode)}"
                  title="手动调整大小（当前：${html.escape(sizeModeLabel)}，下一步：${html.escape(nextModeLabel)}）">${html.escape(sizeModeLabel)}</span>
                <span class="ldbm-bubble-score">${scoreText}</span>
              </span>
            </div>
            <a class="ldbm-bubble-title ldbm-panzoom-exclude" href="${html.escape(item.url)}" target="_blank" rel="noreferrer" title="${title}">${title}</a>
            <div class="ldbm-bubble-meta">
              <span>${html.escape(categoryName)}</span>
              <span>${html.escape(topicText)}</span>
            </div>
            <span class="ldbm-bubble-resize ldbm-panzoom-exclude" title="拖拽调整大小"></span>
          </article>
        `;
      })
      .join('');

    return `
      <div class="ldbm-bubble-viewport">
        <div class="ldbm-bubble-canvas">${entries}</div>
      </div>
    `;
  }

  async function mountReaderBubble(listWrap, currentList) {
    const runtime = state.readerBubbleRuntime;
    const mountToken = runtime.mountToken + 1;
    runtime.mountToken = mountToken;

    const viewport = listWrap.querySelector('.ldbm-bubble-viewport');
    const canvas = listWrap.querySelector('.ldbm-bubble-canvas');
    if (!viewport || !canvas) return;

    runtime.viewport = viewport;
    runtime.canvas = canvas;

    const dependency = await ensureReaderBubbleDependencies();
    if (mountToken !== runtime.mountToken) return;
    if (state.viewMode === 'manage' || state.readerLayoutMode !== 'bubble') return;

    const { Muuri, Panzoom, interact } = dependency;
    runtime.grid = new Muuri(canvas, {
      items: '.ldbm-bubble-item',
      layout: { fillGaps: true, rounding: true },
      layoutDuration: 180,
      layoutEasing: 'ease',
      dragEnabled: true,
      dragHandle: '.ldbm-bubble-drag-handle',
      dragStartPredicate: { distance: 3, delay: 0 },
      dragSortHeuristics: { sortInterval: 90, minDragDistance: 5, minBounceBackAngle: Math.PI / 7 }
    });

    runtime.panzoom = Panzoom(canvas, {
      maxScale: 2.25,
      minScale: 0.58,
      step: 0.1,
      contain: 'outside',
      roundPixels: true,
      canvas: true,
      excludeClass: 'ldbm-panzoom-exclude'
    });

    runtime.wheelHandler = event => {
      event.preventDefault();
      runtime.panzoom.zoomWithWheel(event);
    };
    viewport.addEventListener('wheel', runtime.wheelHandler, { passive: false });

    canvas.querySelectorAll('.ldbm-bubble-item').forEach(node => {
      const interactable = interact(node).resizable({
        edges: { right: '.ldbm-bubble-resize', bottom: '.ldbm-bubble-resize' },
        inertia: false,
        modifiers: [
          interact.modifiers.restrictSize({
            min: { width: 176, height: 112 },
            max: { width: 420, height: 260 }
          })
        ],
        listeners: {
          move(event) {
            const target = event.target;
            target.style.width = `${Math.round(event.rect.width)}px`;
            target.style.height = `${Math.round(event.rect.height)}px`;
          },
          end(event) {
            const target = event.target;
            const topicKey = String(target.dataset.topicKey || '').trim();
            if (!topicKey) return;

            const width = clampNumber(parseFloat(target.style.width), 176, 420, 220);
            const nextSize = getReaderBubbleSizeByWidth(width);
            state.readerSizeOverrides[topicKey] = nextSize;
            saveReaderSizeOverrides();
            renderBookmarkList();
          }
        }
      });
      runtime.interactables.push(interactable);
    });

    runtime.grid.refreshItems().layout();
    if (currentList.length) {
      setStatus('气泡模式已启用（支持拖拽、缩放、手动拉伸）', 'ok');
    }
  }

  function renderBookmarkList() {
    if (!state.refs.drawer) return;

    const listWrap = state.refs.drawer.querySelector('.ldbm-list');
    if (!listWrap) return;

    const list = getFilteredBookmarks();

    if (!list.length) {
      destroyReaderBubbleRuntime();
      listWrap.innerHTML = '<div class="ldbm-empty">没有匹配的书签</div>';
      return;
    }

    const isReader = state.viewMode !== 'manage';
    if (isReader) {
      if (state.readerLayoutMode === 'bubble') {
        destroyReaderBubbleRuntime();
        listWrap.innerHTML = renderReaderEntryBubbles(list);
        mountReaderBubble(listWrap, list).catch(error => {
          state.readerLayoutMode = 'grid';
          saveUi();
          destroyReaderBubbleRuntime();
          applyDrawerViewMode();
          const layoutInput = state.refs.drawer?.querySelector('.ldbm-reader-layout');
          if (layoutInput) {
            layoutInput.value = 'grid';
          }
          listWrap.innerHTML = renderReaderEntryGrid(list);
          setStatus(`气泡模式加载失败，已回退网格：${String(error?.message || error)}`, 'warn');
        });
        return;
      }

      destroyReaderBubbleRuntime();
      listWrap.innerHTML = renderReaderEntryGrid(list);
      return;
    }

    destroyReaderBubbleRuntime();

    const options = state.categories
      .map(c => `<option value="${html.escape(c.id)}">${html.escape(c.name)}</option>`)
      .join('');

    listWrap.innerHTML = list.map(item => {
      const topicKey = getBookmarkUniqueKey(item);
      const assigned = state.assignments[String(item.topicId)] || DEFAULT_CATEGORY_ID;
      const categoryName = getCategoryNameById(assigned);
      const badgeTags = item.tags.slice(0, 2);
      const badgeHtml = [
        `<span class="ldbm-item-badge ${assigned === DEFAULT_CATEGORY_ID ? 'uncategorized' : 'category'}">${html.escape(categoryName)}</span>`,
        ...badgeTags.map(tag => `<span class="ldbm-item-badge tag">#${html.escape(tag)}</span>`)
      ].join('');
      const excerpt = html.escape(item.excerpt || '').slice(0, 96);
      const dateText = getBookmarkDerived(item).dateText;
      const topicText = item.postNumber > 1 ? `#${item.topicId}/${item.postNumber}` : `#${item.topicId}`;
      const excerptNode = excerpt ? `<div class="ldbm-item-excerpt">${excerpt}</div>` : '';

      return `
        <article class="ldbm-item" data-topic-id="${item.topicId}">
          <header class="ldbm-item-header">
            <a class="ldbm-item-title" href="${html.escape(item.url)}" target="_blank" rel="noreferrer">
              ${html.escape(item.title)}
            </a>
            <div class="ldbm-item-badges">${badgeHtml}</div>
          </header>
          <div class="ldbm-item-meta">
            <span class="date">${html.escape(dateText)}</span>
            <span class="topic">${html.escape(topicText)}</span>
          </div>
          ${excerptNode}
          <div class="ldbm-item-actions">
            <select class="ldbm-assign" data-topic-id="${item.topicId}">
              ${options}
            </select>
            <button class="ldbm-open" data-url="${html.escape(item.url)}">打开</button>
            <button class="ldbm-delete" data-topic-key="${html.escape(topicKey)}">删除</button>
          </div>
        </article>
      `;
    }).join('');

    listWrap.querySelectorAll('select.ldbm-assign').forEach(select => {
      const topicId = select.dataset.topicId;
      const assigned = state.assignments[String(topicId)] || DEFAULT_CATEGORY_ID;
      select.value = assigned;
    });
  }

  function renderRatePanel() {
    // Keep the internal rate-limit logic but hide diagnostics in production UI.
  }

  function renderReaderCategoryBar() {
    if (!state.refs.drawer) return;

    const wrap = state.refs.drawer.querySelector('.ldbm-reader-cats');
    if (!wrap) return;

    const countMap = getCategoryCountMap();
    const allTotal = state.bookmarks.length;

    let htmlText = `
      <button type="button" class="ldbm-reader-cat ${state.activeCategoryId === 'all' ? 'active' : ''}" data-category-id="all">
        全部 <span class="count">${allTotal}</span>
      </button>
    `;

    state.categories.forEach(category => {
      const active = state.activeCategoryId === category.id ? 'active' : '';
      const count = countMap[category.id] || 0;
      htmlText += `
        <button type="button" class="ldbm-reader-cat ${active}" data-category-id="${html.escape(category.id)}">
          ${html.escape(category.name)} <span class="count">${count}</span>
        </button>
      `;
    });

    wrap.innerHTML = htmlText;
  }

  function applyReaderTopbarState() {
    if (!state.refs.drawer) return;

    const drawer = state.refs.drawer;
    const isReader = state.viewMode !== 'manage';
    const collapsed = isReader && state.readerTopCollapsed;

    drawer.classList.toggle('ldbm-reader-top-collapsed', collapsed);

    const toggleBtn = drawer.querySelector('.ldbm-reader-tools-toggle');
    if (toggleBtn) {
      toggleBtn.hidden = !isReader;
      toggleBtn.textContent = collapsed ? '展开工具' : '收起工具';
      toggleBtn.title = collapsed ? '展开阅读工具栏' : '收起阅读工具栏';
      toggleBtn.setAttribute('aria-label', collapsed ? '展开阅读工具栏' : '收起阅读工具栏');
      toggleBtn.setAttribute('aria-expanded', String(!collapsed));
    }

    const listWrap = drawer.querySelector('.ldbm-list');
    if (listWrap) {
      state.readerLastScrollTop = Number(listWrap.scrollTop || 0);
    }
  }

  function applyDrawerViewMode() {
    if (!state.refs.drawer) return;

    const isReader = state.viewMode !== 'manage';
    state.refs.drawer.classList.toggle('ldbm-reader', isReader);
    state.refs.drawer.classList.toggle('ldbm-reader-bubble', isReader && state.readerLayoutMode === 'bubble');

    const toggleBtn = state.refs.drawer.querySelector('.ldbm-toggle-view');
    if (toggleBtn) {
      toggleBtn.textContent = isReader ? '进入整理' : '返回阅读';
      toggleBtn.title = isReader ? '切换到分类整理视图' : '切换到全屏阅读视图';
    }
  }

  function renderAll() {
    renderCategories();
    renderBookmarkList();
    renderReaderCategoryBar();
    renderRatePanel();
    applyDrawerViewMode();
    applyReaderTopbarState();
    updateFabBadge();
    updateFabQuickAdd();
  }

  function openDrawer() {
    if (!state.refs.drawer || !state.refs.overlay) return;
    state.drawerOpen = true;
    if (state.viewMode !== 'manage') {
      state.readerTopCollapsed = true;
    }
    state.refs.drawer.classList.add('open');
    state.refs.overlay.classList.add('show');
    document.body.classList.add('ldbm-lock');
    renderAll();
  }

  function closeDrawer() {
    if (!state.refs.drawer || !state.refs.overlay) return;
    state.drawerOpen = false;
    destroyReaderBubbleRuntime();
    state.refs.drawer.classList.remove('open');
    state.refs.overlay.classList.remove('show');
    document.body.classList.remove('ldbm-lock');
  }

  function toggleDrawer() {
    if (state.drawerOpen) {
      closeDrawer();
      return;
    }
    openDrawer();
  }

  function makeSidebarEntry() {
    const parent = document.querySelector(SELECTORS.SIDEBAR_CUSTOM_SECTIONS);
    if (!parent) return;

    const existing = parent.querySelector('.ldbm-sidebar-section');
    if (existing) {
      state.refs.sidebarEntry = existing;
      return;
    }

    const wrapper = document.createElement('div');
    wrapper.className = 'sidebar-section sidebar-section-wrapper sidebar-section--expanded ldbm-sidebar-section';

    wrapper.innerHTML = `
      <div class="sidebar-section-header-wrapper sidebar-row">
        <button class="btn no-text sidebar-section-header btn-transparent" type="button">
          <span class="sidebar-section-header-text">收藏夹</span>
        </button>
      </div>
      <ul class="sidebar-section-content">
        <li class="sidebar-section-link-wrapper">
          <button class="sidebar-section-link sidebar-row ldbm-sidebar-open" type="button">
            <span class="sidebar-section-link-content-text">打开收藏夹面板</span>
            <span class="sidebar-section-link-suffix icon unread ldbm-sidebar-count">0</span>
          </button>
        </li>
      </ul>
    `;

    parent.prepend(wrapper);
    state.refs.sidebarEntry = wrapper;

    const openBtn = wrapper.querySelector('.ldbm-sidebar-open');
    openBtn?.addEventListener('click', () => {
      toggleDrawer();
    });
  }

  function updateSidebarCount() {
    const node = state.refs.sidebarEntry?.querySelector('.ldbm-sidebar-count');
    if (node) {
      node.textContent = String(state.bookmarks.length);
    }
  }

  function applyFabMode() {
    const fab = state.refs.fab || document.getElementById('ldbm-fab');
    const quickBtn = state.refs.fabQuick || document.getElementById('ldbm-fab-quick');
    if (fab) {
      fab.style.display = state.quickOnlyMode ? 'none' : '';
    }
    if (quickBtn) {
      quickBtn.classList.toggle('ldbm-fab-quick-only', !!state.quickOnlyMode);
    }
  }

  function makeFab() {
    if (document.getElementById('ldbm-fab')) {
      state.refs.fab = document.getElementById('ldbm-fab');
      state.refs.fabQuick = document.getElementById('ldbm-fab-quick');
      applyFabMode();
      updateFabQuickAdd();
      return;
    }

    const fabWrap = document.createElement('div');
    fabWrap.id = 'ldbm-fab-wrap';
    fabWrap.className = 'ldbm-fab-wrap';

    fabWrap.innerHTML = `
      <button type="button" id="ldbm-fab-quick" class="ldbm-fab-quick" title="快捷加入收藏夹" style="display:none;">+</button>
      <button type="button" id="ldbm-fab" class="ldbm-fab"${state.quickOnlyMode ? ' style="display:none;"' : ''}>
        <span class="ldbm-fab-icon">★</span>
        <span class="ldbm-fab-text">收藏夹</span>
        <span class="ldbm-fab-badge">0</span>
      </button>
    `;

    const fab = fabWrap.querySelector('#ldbm-fab');
    const quickBtn = fabWrap.querySelector('#ldbm-fab-quick');

    fab.addEventListener('click', () => toggleDrawer());

    quickBtn.addEventListener('click', async (event) => {
      event.stopPropagation();
      const info = getCurrentPageTopicInfo();
      if (!info) return;

      const existingItem = findLocalBookmarkByTopicAnyPost(info.topicId, info.postNumber);
      const exists = !!existingItem;

      try {
        quickBtn.disabled = true;

        if (exists) {
          const removeKey = getBookmarkUniqueKey(existingItem) || `topic:${info.topicId}:${info.postNumber}`;
          const removed = await removeBookmarkByTopicKey(removeKey, { manual: true, syncServer: true });
          setStatus(`已取消收藏并同步服务端：${removed.title}`, 'ok');
        } else {
          const bookmark = await addCurrentPageToBookmarks();
          setStatus(`已收藏并同步服务端：${bookmark.title}`, 'ok');
          // 话题页快捷收藏后也弹出轻量分类框，但不打开分类管理抽屉面板。
          openMiniCategoryPicker(bookmark);
        }

        updateSidebarCount();
        updateFabBadge();
        if (state.drawerOpen) {
          renderAll();
        }
        quickBtn.textContent = '✓';
        setTimeout(() => {
          updateFabQuickAdd();
          quickBtn.disabled = false;
        }, 1500);
      } catch (e) {
        const msg = String(e?.message || e);
        quickBtn.title = msg;
        quickBtn.textContent = '×';
        setTimeout(() => {
          updateFabQuickAdd();
          quickBtn.disabled = false;
        }, 2000);
      } finally {
        if (!quickBtn.disabled) {
          updateFabQuickAdd();
        }
      }
    });

    document.body.appendChild(fabWrap);
    state.refs.fab = fab;
    state.refs.fabQuick = quickBtn;

    applyFabMode();
    updateFabQuickAdd();
  }

  function updateFabQuickAdd() {
    const quickBtn = state.refs.fabQuick || document.getElementById('ldbm-fab-quick');
    if (!quickBtn) return;

    const info = getCurrentPageTopicInfo();
    if (!info) {
      quickBtn.style.display = 'none';
      return;
    }

    const alreadyExists = !!findLocalBookmarkByTopicAnyPost(info.topicId, info.postNumber);
    quickBtn.style.display = '';
    quickBtn.classList.toggle('is-remove', alreadyExists);
    quickBtn.textContent = alreadyExists ? '-' : '+';
    quickBtn.title = alreadyExists ? '快捷取消收藏（同步服务端）' : '快捷加入收藏夹（同步服务端）';
  }

  function startFullObserver() {
    if (state.fullObserver) return;

    const rebuildSidebar = debounce(() => {
      makeSidebarEntry();
      updateSidebarCount();
    }, 300);

    const updateQuickAddDebounced = debounce(() => {
      updateFabQuickAdd();
    }, 200);

    const observer = new MutationObserver(() => {
      rebuildSidebar();
      updateQuickAddDebounced();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    state.fullObserver = observer;
  }

  function ensureFullRuntime() {
    if (state.fullRuntimeReady) {
      state.quickOnlyMode = false;
      applyFabMode();
      return;
    }

    state.quickOnlyMode = false;
    applyFabMode();

    makeDrawer();
    makeSidebarEntry();
    startFullObserver();

    state.fullRuntimeReady = true;
    updateSidebarCount();
    renderAll();
    setStatus(
      state.snapshotRestored ? `已加载缓存快照：${state.bookmarks.length} 条` : '待同步（请点击“手动同步”）',
      state.snapshotRestored ? 'warn' : 'info'
    );
  }

  function makeDrawer() {
    if (document.getElementById('ldbm-drawer')) {
      state.refs.drawer = document.getElementById('ldbm-drawer');
      state.refs.overlay = document.getElementById('ldbm-overlay');
      return;
    }

    const overlay = document.createElement('div');
    overlay.id = 'ldbm-overlay';
    overlay.className = 'ldbm-overlay';

    const drawer = document.createElement('aside');
    drawer.id = 'ldbm-drawer';
    drawer.className = 'ldbm-drawer';

    drawer.innerHTML = `
      <header class="ldbm-header">
        <div>
          <h2>收藏夹</h2>
          <p class="ldbm-status-text" data-type="info">待同步</p>
        </div>
        <div class="ldbm-header-actions">
          <button type="button" class="ldbm-btn ldbm-toggle-view">进入整理</button>
          <button type="button" class="ldbm-btn ldbm-sync ldbm-manage-only">手动同步</button>
          <button type="button" class="ldbm-btn ldbm-close">关闭</button>
        </div>
      </header>
      <section class="ldbm-toolbar">
        <div class="ldbm-search-wrap">
          <input type="text" class="ldbm-search" placeholder="搜索标题、摘要、标签" />
        </div>
        <div class="ldbm-reader-controls">
          <label>入口缩放
            <input type="range" class="ldbm-reader-scale" min="80" max="180" step="5" value="${Math.round(state.readerTileScale * 100)}" />
          </label>
          <label>色彩强度
            <input type="range" class="ldbm-reader-color" min="60" max="180" step="5" value="${Math.round(state.readerColorBoost * 100)}" />
          </label>
          <label>阅读布局
            <select class="ldbm-reader-layout">
              <option value="grid"${state.readerLayoutMode === 'grid' ? ' selected' : ''}>网格</option>
              <option value="bubble"${state.readerLayoutMode === 'bubble' ? ' selected' : ''}>气泡(beta)</option>
            </select>
          </label>
        </div>
        <div class="ldbm-category-create ldbm-manage-only">
          <input type="text" class="ldbm-new-category" placeholder="新分类名" />
          <button type="button" class="ldbm-btn ldbm-add-category">新增分类</button>
        </div>
      </section>
      <button type="button" class="ldbm-reader-tools-toggle" hidden title="展开阅读工具栏" aria-label="展开阅读工具栏" aria-expanded="false">展开工具</button>
      <section class="ldbm-reader-cats"></section>
      <section class="ldbm-main">
        <aside class="ldbm-categories"></aside>
        <main class="ldbm-list"></main>
      </section>
      <footer class="ldbm-footer ldbm-manage-only">
        <button type="button" class="ldbm-btn ldbm-rename-category">重命名当前分类</button>
        <button type="button" class="ldbm-btn danger ldbm-remove-category">删除当前分类</button>
        <button type="button" class="ldbm-btn ldbm-export">导出</button>
        <button type="button" class="ldbm-btn ldbm-import">导入</button>
        <input type="file" class="ldbm-import-file" accept="application/json,.json" hidden />
      </footer>
    `;

    overlay.addEventListener('click', () => closeDrawer());

    document.body.appendChild(overlay);
    document.body.appendChild(drawer);

    state.refs.drawer = drawer;
    state.refs.overlay = overlay;

    wireDrawerEvents();
  }

  function ensureOnBookmarksPage() {
    return true;
  }

  function applyCategoryForTopic(topicId, categoryId) {
    const validSet = new Set(state.categories.map(c => c.id));
    const cid = validSet.has(categoryId) ? categoryId : DEFAULT_CATEGORY_ID;
    state.assignments[String(topicId)] = cid;
    saveAssignments();
  }

  function getCategoryNameById(categoryId) {
    const key = String(categoryId || '');
    if (state.derived.categoryNameById[key]) {
      return state.derived.categoryNameById[key];
    }
    const found = state.categories.find(c => String(c.id) === key);
    return found?.name || '未分类';
  }

  function closeMiniCategoryPicker() {
    const old = document.getElementById('ldbm-mini-picker');
    if (old) old.remove();
  }

  function openMiniCategoryPicker(bookmark) {
    if (!bookmark || !bookmark.topicId) return;

    closeMiniCategoryPicker();

    const topicId = Number(bookmark.topicId || 0);
    if (!topicId) return;

    const assigned = state.assignments[String(topicId)] || DEFAULT_CATEGORY_ID;
    const options = state.categories
      .map(c => `<option value="${html.escape(c.id)}"${c.id === assigned ? ' selected' : ''}>${html.escape(c.name)}</option>`)
      .join('');

    const panel = document.createElement('div');
    panel.id = 'ldbm-mini-picker';
    panel.className = 'ldbm-mini-picker';
    panel.innerHTML = `
      <div class="ldbm-mini-title">收藏成功，设置分类</div>
      <div class="ldbm-mini-row">
        <label>已有分类</label>
        <select class="ldbm-mini-select">${options}</select>
      </div>
      <div class="ldbm-mini-row">
        <label>新建分类</label>
        <input type="text" class="ldbm-mini-input" placeholder="输入新分类名（可选）" />
      </div>
      <div class="ldbm-mini-error" hidden></div>
      <div class="ldbm-mini-actions">
        <button type="button" class="ldbm-btn ldbm-mini-skip">跳过</button>
        <button type="button" class="ldbm-btn primary ldbm-mini-confirm">保存</button>
      </div>
    `;

    document.body.appendChild(panel);

    const select = panel.querySelector('.ldbm-mini-select');
    const input = panel.querySelector('.ldbm-mini-input');
    const errorNode = panel.querySelector('.ldbm-mini-error');
    const confirmBtn = panel.querySelector('.ldbm-mini-confirm');
    const skipBtn = panel.querySelector('.ldbm-mini-skip');

    const showError = (text) => {
      if (!errorNode) return;
      errorNode.hidden = !text;
      errorNode.textContent = text || '';
    };

    const closeAndRefresh = () => {
      closeMiniCategoryPicker();
      updateSidebarCount();
      if (state.drawerOpen) {
        renderAll();
      } else {
        updateFabBadge();
        updateFabQuickAdd();
      }
    };

    const confirm = () => {
      try {
        let targetCategoryId = String(select?.value || DEFAULT_CATEGORY_ID);
        const newName = normalizeCategoryName(input?.value || '');

        if (newName) {
          const exists = state.categories.find(c => c.name === newName);
          targetCategoryId = exists ? exists.id : createCategory(newName);
        }

        applyCategoryForTopic(topicId, targetCategoryId);
        const categoryName = getCategoryNameById(targetCategoryId);
        setStatus(`已收藏并归类到「${categoryName}」`, 'ok');
        closeAndRefresh();
      } catch (e) {
        showError(String(e?.message || e));
      }
    };

    confirmBtn?.addEventListener('click', confirm);
    skipBtn?.addEventListener('click', () => {
      closeMiniCategoryPicker();
    });

    panel.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        confirm();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        closeMiniCategoryPicker();
      }
    });

    input?.focus();
  }

  function normalizeCategoryOrder() {
    const defaultIndex = state.categories.findIndex(c => c.id === DEFAULT_CATEGORY_ID);
    if (defaultIndex > 0) {
      const [defaultCategory] = state.categories.splice(defaultIndex, 1);
      state.categories.unshift(defaultCategory);
    }
  }

  function reorderCustomCategory(categoryId, targetCustomIndex) {
    const defaultCategory = state.categories.find(c => c.id === DEFAULT_CATEGORY_ID);
    const customList = state.categories.filter(c => c.id !== DEFAULT_CATEGORY_ID);

    const fromIndex = customList.findIndex(c => c.id === categoryId);
    if (fromIndex < 0) {
      throw new Error('分类不存在');
    }

    const safeTarget = Math.max(0, Math.min(targetCustomIndex, customList.length - 1));
    if (fromIndex === safeTarget) {
      return;
    }

    const [picked] = customList.splice(fromIndex, 1);
    customList.splice(safeTarget, 0, picked);
    state.categories = defaultCategory ? [defaultCategory, ...customList] : customList;
    rebuildDerivedCaches({ categories: true, bookmarks: false });
    saveCategories();
  }

  function moveCustomCategoryToTop(categoryId) {
    reorderCustomCategory(categoryId, 0);
  }

  function createCategory(name) {
    const normalized = normalizeCategoryName(name);
    if (!normalized) {
      throw new Error('分类名不能为空');
    }

    const exists = state.categories.some(c => c.name === normalized);
    if (exists) {
      throw new Error('分类名已存在');
    }

    const id = `cat_${now()}_${Math.random().toString(36).slice(2, 7)}`;
    state.categories.push({
      id,
      name: normalized,
      locked: false,
      createdAt: now()
    });

    normalizeCategoryOrder();
    rebuildDerivedCaches({ categories: true, bookmarks: false });
    saveCategories();
    return id;
  }

  function removeBookmarkFromLocal(topicKey) {
    const key = String(topicKey || '').trim();
    if (!key) {
      throw new Error('无效的书签ID');
    }

    const before = state.bookmarks.length;
    let removedTopicId = null;

    state.bookmarks = state.bookmarks.filter(item => {
      const matched = getBookmarkUniqueKey(item) === key;
      if (matched && removedTopicId === null) {
        removedTopicId = String(item.topicId || '');
      }
      return !matched;
    });

    if (state.bookmarks.length === before) {
      throw new Error('未找到该书签');
    }

    if (removedTopicId) {
      const stillExistsSameTopic = state.bookmarks.some(item => String(item.topicId) === removedTopicId);
      if (!stillExistsSameTopic) {
        delete state.assignments[removedTopicId];
      }
    }

    let readerOverridesChanged = false;
    if (state.readerSizeOverrides[key]) {
      delete state.readerSizeOverrides[key];
      readerOverridesChanged = true;
    }

    rebuildDerivedCaches({ categories: false, bookmarks: true });
    runStorageBatch(() => {
      if (readerOverridesChanged) {
        saveReaderSizeOverrides();
      }
      saveAssignments();
      snapshotBookmarks();
    });
  }

  function buildExportPayload() {
    return {
      schemaVersion: EXPORT_SCHEMA_VERSION,
      exportedAt: new Date().toISOString(),
      source: 'L站收藏夹.user.js',
      data: {
        categories: clone(state.categories),
        assignments: clone(state.assignments),
        bookmarks: clone(state.bookmarks),
        readerSizeOverrides: clone(state.readerSizeOverrides),
        bookmarkUrl: state.bookmarkUrl || ''
      }
    };
  }

  function sanitizeImportPayload(raw) {
    if (!raw || typeof raw !== 'object') {
      throw new Error('导入文件格式错误');
    }

    const data = raw.data && typeof raw.data === 'object' ? raw.data : raw;
    const categories = ensureDefaultCategory(Array.isArray(data.categories) ? data.categories : []);
    const bookmarks = Array.isArray(data.bookmarks) ? data.bookmarks : [];
    const assignmentsRaw = data.assignments && typeof data.assignments === 'object' ? data.assignments : {};
    const readerSizeOverridesRaw = data.readerSizeOverrides && typeof data.readerSizeOverrides === 'object'
      ? data.readerSizeOverrides
      : {};

    const deduped = dedupeBookmarks(
      bookmarks
        .filter(item => item && typeof item === 'object')
        .map(item => ({ ...item }))
        .filter(item => Number(item.topicId || 0) > 0)
    );

    const validTopicIds = new Set(deduped.map(item => String(item.topicId)));
    const validBookmarkKeys = new Set(deduped.map(item => getBookmarkUniqueKey(item)).filter(Boolean));
    const validCategoryIds = new Set(categories.map(c => c.id));
    const assignments = {};
    const readerSizeOverrides = sanitizeReaderSizeOverrides(readerSizeOverridesRaw);

    Object.keys(assignmentsRaw).forEach(topicId => {
      if (!validTopicIds.has(String(topicId))) return;
      const cid = assignmentsRaw[topicId];
      assignments[String(topicId)] = validCategoryIds.has(cid) ? cid : DEFAULT_CATEGORY_ID;
    });

    deduped.forEach(item => {
      const key = String(item.topicId);
      if (!assignments[key]) {
        assignments[key] = DEFAULT_CATEGORY_ID;
      }
    });

    Object.keys(readerSizeOverrides).forEach(topicKey => {
      if (validBookmarkKeys.has(topicKey)) return;
      delete readerSizeOverrides[topicKey];
    });

    const bookmarkUrl = FIXED_BOOKMARKS_API_URL;

    return {
      categories,
      bookmarks: deduped,
      assignments,
      readerSizeOverrides,
      bookmarkUrl
    };
  }

  function exportAllLocalData() {
    const payload = buildExportPayload();
    const content = JSON.stringify(payload, null, 2);
    const blob = new Blob([content], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);

    const ts = new Date();
    const pad = n => String(n).padStart(2, '0');
    const fileName = `linuxdo-bookmarks-backup-${ts.getFullYear()}${pad(ts.getMonth() + 1)}${pad(ts.getDate())}-${pad(ts.getHours())}${pad(ts.getMinutes())}${pad(ts.getSeconds())}.json`;

    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();

    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }

  async function importAllLocalDataFromFile(file) {
    if (!file) {
      throw new Error('未选择导入文件');
    }

    const text = await file.text();
    const parsed = JSON.parse(text);
    const normalized = sanitizeImportPayload(parsed);

    state.categories = normalized.categories;
    state.bookmarks = normalized.bookmarks;
    state.assignments = normalized.assignments;
    state.readerSizeOverrides = normalized.readerSizeOverrides;
    state.bookmarkUrl = FIXED_BOOKMARKS_API_URL;

    ensureValidActiveCategory();
    rebuildDerivedCaches();
    ensureAssignmentForBookmarks({ persist: false });

    runStorageBatch(() => {
      saveCategories();
      saveAssignments();
      saveReaderSizeOverrides();
      saveUi();
      snapshotBookmarks();
    });
  }

  async function fetchTopicInfoByApi(topicId, slug = 'topic') {
    const path = `/t/${encodeURIComponent(slug)}/${topicId}.json`;
    try {
      // Use a simple fetch without rate limiting for topic info lookup
      const token = getCsrfToken();
      const headers = { accept: 'application/json' };
      if (token) headers['x-csrf-token'] = token;

      const response = await withTimeout(fetch(path, {
        method: 'GET',
        credentials: 'include',
        headers
      }), NETWORK_CONFIG.FETCH_TIMEOUT_MS, path);

      if (!response.ok) return null;

      const payload = await response.json();
      if (!payload || !payload.id) {
        return null;
      }

      const rawTags = Array.isArray(payload.tags) ? payload.tags : [];
      const tags = rawTags.map(t => (typeof t === 'string' ? t : '')).filter(Boolean);

      return {
        bookmarkId: `manual_${payload.id}_${Date.now()}`,
        topicId: payload.id,
        postNumber: 1,
        title: payload.title || payload.fancy_title || `话题 ${payload.id}`,
        fancyTitle: payload.fancy_title || payload.title || '',
        excerpt: payload.excerpt || '',
        categoryId: payload.category_id ?? null,
        tags,
        bookmarkableType: 'Topic',
        bookmarkableId: payload.id,
        bookmarkedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        bumpedAt: payload.bumped_at || null,
        slug: payload.slug || slug || 'topic',
        url: `https://linux.do/t/${payload.slug || slug}/${payload.id}`,
        postsCount: normalizePositiveInt(payload.posts_count || 0),
        replyCount: normalizePositiveInt(payload.reply_count || 0),
        highestPostNumber: normalizePositiveInt(payload.highest_post_number || payload.posts_count || 0),
        likeCount: normalizePositiveInt(payload.like_count || 0),
        user: null,
        deleted: false,
        hidden: false
      };
    } catch {
      return null;
    }
  }

  function createMinimalBookmarkFromUrl(urlLike) {
    const parsed = parseTopicInfoFromUrl(urlLike);
    if (!parsed.topicId) {
      return null;
    }

    return {
      bookmarkId: `manual_${parsed.topicId}_${parsed.postNumber}_${Date.now()}`,
      topicId: parsed.topicId,
      postNumber: parsed.postNumber,
      title: `话题 ${parsed.topicId}`,
      fancyTitle: '',
      excerpt: '',
      categoryId: null,
      tags: [],
      bookmarkableType: 'Post',
      bookmarkableId: null,
      bookmarkedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      bumpedAt: null,
      slug: parsed.slug,
      url: `https://linux.do/t/${parsed.slug}/${parsed.topicId}/${parsed.postNumber}`,
      postsCount: 0,
      replyCount: 0,
      highestPostNumber: 0,
      likeCount: 0,
      user: null,
      deleted: false,
      hidden: false
    };
  }

  async function addBookmarkByUrl(urlLike, { manual = true, syncServer = true } = {}) {
    const url = String(urlLike || '').trim();
    if (!url) {
      throw new Error('链接不能为空');
    }

    if (!url.includes('linux.do') && !url.startsWith('/t/')) {
      throw new Error('请输入有效的 linux.do 话题链接');
    }

    const parsed = parseTopicInfoFromUrl(url);
    if (!parsed.topicId) {
      throw new Error('无法解析话题ID，请检查链接格式');
    }

    const alreadyExists = !!findLocalBookmarkByTopicAnyPost(parsed.topicId, parsed.postNumber);
    if (alreadyExists) {
      throw new Error('该书签已存在');
    }

    let createdPayload = null;
    let bookmarkItem = null;
    let postId = 0;

    if (syncServer) {
      postId = await resolvePostIdForBookmark(parsed, { manual });

      try {
        createdPayload = await createBookmarkOnServer(postId, { manual });
      } catch (error) {
        const message = String(error?.message || error);
        const lower = message.toLowerCase();
        const maybeAlreadyExists = lower.includes('already') || lower.includes('已收藏') || lower.includes('has already');
        if (!maybeAlreadyExists) {
          throw error;
        }
      }

      const lookupPages = createdPayload ? 2 : 8;
      bookmarkItem = await findServerBookmarkByTopic(parsed.topicId, parsed.postNumber, {
        manual,
        maxPages: lookupPages
      });

      if (!bookmarkItem && !createdPayload) {
        throw new Error('服务端已存在该书签，但当前未定位到记录，请先手动同步后重试');
      }
    }

    if (!bookmarkItem) {
      bookmarkItem = await fetchTopicInfoByApi(parsed.topicId, parsed.slug);
    }

    if (!bookmarkItem) {
      bookmarkItem = createMinimalBookmarkFromUrl(url);
    }

    if (!bookmarkItem) {
      throw new Error('无法创建书签');
    }

    if (parsed.postNumber > 1) {
      bookmarkItem.postNumber = parsed.postNumber;
      bookmarkItem.url = `https://linux.do/t/${bookmarkItem.slug}/${parsed.topicId}/${parsed.postNumber}`;
    }

    if (syncServer) {
      const serverBookmarkId = extractBookmarkIdFromPayload(createdPayload);
      if (serverBookmarkId) {
        bookmarkItem.bookmarkId = serverBookmarkId;
      } else if (!normalizePositiveInt(bookmarkItem.bookmarkId)) {
        bookmarkItem.bookmarkId = `manual_${parsed.topicId}_${parsed.postNumber}_${Date.now()}`;
      }
      bookmarkItem.bookmarkableType = 'Post';
      if (postId) bookmarkItem.bookmarkableId = postId;
    } else if (!normalizePositiveInt(bookmarkItem.bookmarkId)) {
      bookmarkItem.bookmarkId = `manual_${parsed.topicId}_${parsed.postNumber}_${Date.now()}`;
    }

    bookmarkItem.bookmarkedAt = bookmarkItem.bookmarkedAt || new Date().toISOString();
    bookmarkItem.updatedAt = new Date().toISOString();

    state.bookmarks.unshift(bookmarkItem);
    state.assignments[String(bookmarkItem.topicId)] = DEFAULT_CATEGORY_ID;
    rebuildDerivedCaches({ categories: false, bookmarks: true });
    runStorageBatch(() => {
      saveAssignments();
      snapshotBookmarks();
    });

    return bookmarkItem;
  }

  function getCurrentPageTopicInfo() {
    const path = window.location.pathname || '';
    const parsed = parseTopicInfoFromUrl(path);
    if (!parsed.topicId) {
      return null;
    }

    const titleEl = document.querySelector('.fancy-title, .topic-title h1, h1[data-topic-id]');
    const title = titleEl?.textContent?.trim() || '';

    return {
      topicId: parsed.topicId,
      postNumber: parsed.postNumber,
      slug: parsed.slug,
      title,
      url: window.location.href
    };
  }

  async function addCurrentPageToBookmarks() {
    const info = getCurrentPageTopicInfo();
    if (!info) {
      throw new Error('当前页面不是话题页，无法快捷添加');
    }

    return addBookmarkByUrl(info.url, { manual: true, syncServer: true });
  }

  async function removeBookmarkByTopicKey(topicKey, { manual = true, syncServer = true } = {}) {
    const key = String(topicKey || '').trim();
    if (!key) {
      throw new Error('无效的书签ID');
    }

    const item = findLocalBookmarkByUniqueKey(key);
    if (!item) {
      throw new Error('未找到该书签');
    }

    if (syncServer) {
      const serverBookmarkId = await resolveServerBookmarkIdForItem(item, { manual });
      if (!serverBookmarkId) {
        throw new Error('未找到服务端书签ID，请先手动同步后重试');
      }
      await deleteBookmarkOnServer(serverBookmarkId, { manual });
    }

    removeBookmarkFromLocal(key);
    return item;
  }

  function renameCategory(categoryId, newName) {
    const normalized = normalizeCategoryName(newName);
    if (!normalized) {
      throw new Error('分类名不能为空');
    }

    const target = state.categories.find(c => c.id === categoryId);
    if (!target) {
      throw new Error('分类不存在');
    }

    if (target.locked) {
      throw new Error('默认分类不能重命名');
    }

    const duplicated = state.categories.some(c => c.id !== categoryId && c.name === normalized);
    if (duplicated) {
      throw new Error('分类名已存在');
    }

    target.name = normalized;
    rebuildDerivedCaches({ categories: true, bookmarks: false });
    saveCategories();
  }

  function removeCategory(categoryId) {
    const idx = state.categories.findIndex(c => c.id === categoryId);
    if (idx < 0) {
      throw new Error('分类不存在');
    }

    if (state.categories[idx].locked) {
      throw new Error('默认分类不能删除');
    }

    state.categories.splice(idx, 1);

    Object.keys(state.assignments).forEach(topicId => {
      if (state.assignments[topicId] === categoryId) {
        state.assignments[topicId] = DEFAULT_CATEGORY_ID;
      }
    });

    if (state.activeCategoryId === categoryId) {
      state.activeCategoryId = DEFAULT_CATEGORY_ID;
    }

    rebuildDerivedCaches({ categories: true, bookmarks: false });
    runStorageBatch(() => {
      saveCategories();
      saveAssignments();
      saveUi();
    });
  }

  async function syncBookmarks({ source = 'auto', manual = false } = {}) {
    if (state.sync.running) {
      setStatus('同步进行中，请稍候', 'warn');
      return;
    }

    state.sync.running = true;
    state.sync.lastStartAt = now();
    state.sync.lastError = null;
    state.sync.lastSource = source;

    const apiContext = await resolveBookmarkApiContext({ manual, allowNetwork: true });
    if (apiContext.fallback) {
      setStatus(`未识别当前用户，回退为 ${apiContext.username || '当前会话'}，正在同步...`, 'warn');
    } else {
      setStatus(`已识别当前用户：${apiContext.username}，正在同步...`, 'info');
    }
    renderRatePanel();

    try {
      const list = await fetchAllBookmarksByApi({ manual, basePath: apiContext.url });
      state.bookmarks = list;
      rebuildDerivedCaches({ categories: false, bookmarks: true });
      const ensured = ensureAssignmentForBookmarks({ persist: false });
      runStorageBatch(() => {
        if (ensured.assignmentsChanged) {
          saveAssignments();
        }
        if (ensured.readerOverridesChanged) {
          saveReaderSizeOverrides();
        }
        snapshotBookmarks();
      });
      updateSidebarCount();
      renderAll();
      setStatus(`同步完成:${state.bookmarks.length} 条`, 'ok');
    } catch (error) {
      state.sync.lastError = String(error?.message || error);
      setStatus(`同步失败:${state.sync.lastError}`, 'error');

      if (!state.bookmarks.length) {
        const loaded = loadSnapshotBookmarks();
        if (loaded) {
          updateSidebarCount();
          renderAll();
          setStatus(`已回退到缓存快照:${state.bookmarks.length} 条`, 'warn');
        }
      }
    } finally {
      state.sync.running = false;
      state.sync.lastFinishAt = now();
      renderRatePanel();
    }
  }

  function wireDrawerEvents() {
    if (!state.refs.drawer) return;

    const drawer = state.refs.drawer;

    drawer.querySelector('.ldbm-close')?.addEventListener('click', () => closeDrawer());
    drawer.querySelector('.ldbm-toggle-view')?.addEventListener('click', () => {
      state.viewMode = state.viewMode === 'manage' ? 'reader' : 'manage';
      if (state.viewMode !== 'manage') {
        state.readerTopCollapsed = true;
      }
      saveUi();
      applyDrawerViewMode();
      applyReaderTopbarState();
      renderAll();
      setStatus(state.viewMode === 'manage' ? '已进入整理视图' : '已返回阅读视图', 'ok');
    });

    drawer.querySelector('.ldbm-sync')?.addEventListener('click', async () => {
      try {
        await syncBookmarks({ source: 'manual', manual: true });
      } catch (e) {
        setStatus(String(e?.message || e), 'error');
      }
    });

    drawer.querySelector('.ldbm-reader-tools-toggle')?.addEventListener('click', () => {
      if (state.viewMode === 'manage') return;
      state.readerTopCollapsed = !state.readerTopCollapsed;
      applyReaderTopbarState();
    });

    const searchInput = drawer.querySelector('.ldbm-search');
    if (searchInput) {
      searchInput.value = state.activeSearch || '';
    }

    const scaleInput = drawer.querySelector('.ldbm-reader-scale');
    const colorInput = drawer.querySelector('.ldbm-reader-color');
    const layoutInput = drawer.querySelector('.ldbm-reader-layout');
    if (scaleInput) {
      scaleInput.value = String(Math.round(state.readerTileScale * 100));
    }
    if (colorInput) {
      colorInput.value = String(Math.round(state.readerColorBoost * 100));
    }
    if (layoutInput) {
      layoutInput.value = normalizeReaderLayoutMode(state.readerLayoutMode);
    }

    searchInput?.addEventListener('input', debounce((event) => {
      state.activeSearch = event.target.value || '';
      saveUi();
      renderBookmarkList();
    }, 120));

    scaleInput?.addEventListener('input', event => {
      const value = clampNumber(Number(event.target.value) / 100, 0.8, 1.8, 1);
      state.readerTileScale = value;
      saveUi();
      if (state.viewMode !== 'manage') {
        renderBookmarkList();
      }
    });

    colorInput?.addEventListener('input', event => {
      const value = clampNumber(Number(event.target.value) / 100, 0.6, 1.8, 1);
      state.readerColorBoost = value;
      saveUi();
      if (state.viewMode !== 'manage') {
        renderBookmarkList();
      }
    });

    layoutInput?.addEventListener('change', event => {
      const nextMode = normalizeReaderLayoutMode(event.target.value);
      if (state.readerLayoutMode === nextMode) return;
      state.readerLayoutMode = nextMode;
      saveUi();
      if (state.viewMode !== 'manage') {
        applyDrawerViewMode();
        renderBookmarkList();
        setStatus(nextMode === 'bubble' ? '已切换为气泡布局（beta）' : '已切换为网格布局', 'ok');
      }
    });

    drawer.querySelector('.ldbm-add-category')?.addEventListener('click', () => {
      const input = drawer.querySelector('.ldbm-new-category');
      const value = input?.value || '';

      try {
        const newId = createCategory(value);
        state.activeCategoryId = newId;
        saveUi();
        if (input) input.value = '';
        renderAll();
      } catch (e) {
        setStatus(String(e?.message || e), 'error');
      }
    });

    drawer.querySelector('.ldbm-rename-category')?.addEventListener('click', () => {
      const category = state.categories.find(c => c.id === state.activeCategoryId);
      if (!category) {
        setStatus('请选择要重命名的分类', 'warn');
        return;
      }

      const next = window.prompt('输入新的分类名', category.name);
      if (next === null) return;

      try {
        renameCategory(category.id, next);
        renderAll();
      } catch (e) {
        setStatus(String(e?.message || e), 'error');
      }
    });

    drawer.querySelector('.ldbm-remove-category')?.addEventListener('click', () => {
      const category = state.categories.find(c => c.id === state.activeCategoryId);
      if (!category) {
        setStatus('请选择要删除的分类', 'warn');
        return;
      }

      if (!window.confirm(`确定删除分类「${category.name}」吗？该分类下书签会回到未分类。`)) {
        return;
      }

      try {
        removeCategory(category.id);
        renderAll();
      } catch (e) {
        setStatus(String(e?.message || e), 'error');
      }
    });

    drawer.querySelector('.ldbm-export')?.addEventListener('click', () => {
      try {
        exportAllLocalData();
        setStatus('导出成功：已下载本地备份文件', 'ok');
      } catch (e) {
        setStatus(`导出失败: ${String(e?.message || e)}`, 'error');
      }
    });

    const importInput = drawer.querySelector('.ldbm-import-file');

    drawer.querySelector('.ldbm-import')?.addEventListener('click', () => {
      if (!importInput) {
        setStatus('导入控件初始化失败', 'error');
        return;
      }
      importInput.value = '';
      importInput.click();
    });

    importInput?.addEventListener('change', async event => {
      const file = event.target?.files?.[0];
      if (!file) return;

      if (!window.confirm('确定导入此备份文件吗？这会覆盖当前本地数据。')) {
        event.target.value = '';
        return;
      }

      try {
        await importAllLocalDataFromFile(file);
        updateSidebarCount();
        renderAll();
        setStatus(`导入成功：${state.bookmarks.length} 条书签，${state.categories.length - 1} 个自定义分类`, 'ok');
      } catch (e) {
        setStatus(`导入失败: ${String(e?.message || e)}`, 'error');
      } finally {
        event.target.value = '';
      }
    });

    const listWrap = drawer.querySelector('.ldbm-list');
    listWrap?.addEventListener('scroll', () => {
      if (state.viewMode === 'manage') return;

      const currentTop = Number(listWrap.scrollTop || 0);
      const delta = currentTop - state.readerLastScrollTop;
      state.readerLastScrollTop = currentTop;

      if (delta > 12 && currentTop > 24 && !state.readerTopCollapsed) {
        state.readerTopCollapsed = true;
        applyReaderTopbarState();
      }
    }, { passive: true });

    drawer.addEventListener('click', async event => {
      const readerSizeBtn = event.target.closest('.ldbm-entry-size-btn');
      if (readerSizeBtn) {
        event.preventDefault();
        event.stopPropagation();

        const topicKey = String(readerSizeBtn.dataset.topicKey || '').trim();
        if (!topicKey) return;

        const currentMode = String(readerSizeBtn.dataset.sizeMode || 'auto').toLowerCase();
        const nextMode = getNextReaderTileMode(currentMode);
        if (nextMode === 'auto') {
          delete state.readerSizeOverrides[topicKey];
        } else {
          state.readerSizeOverrides[topicKey] = nextMode;
        }
        saveReaderSizeOverrides();
        renderBookmarkList();
        return;
      }

      const topBtn = event.target.closest('.ldbm-cat-top');
      if (topBtn) {
        const categoryId = topBtn.dataset.categoryId;
        if (!categoryId) return;

        try {
          moveCustomCategoryToTop(categoryId);
          renderAll();
        } catch (e) {
          setStatus(String(e?.message || e), 'error');
        }
        return;
      }

      const deleteBtn = event.target.closest('.ldbm-delete');
      if (deleteBtn) {
        const topicKey = deleteBtn.dataset.topicKey;
        if (!topicKey) return;

        const item = findLocalBookmarkByUniqueKey(topicKey);
        const title = item?.title || '当前书签';

        if (!window.confirm(`确定删除书签「${title}」吗？将同步删除服务端收藏。`)) {
          return;
        }
        if (!window.confirm('请再次确认：该书签会从本地与 linux.do 服务端同时删除。')) {
          return;
        }

        try {
          await removeBookmarkByTopicKey(topicKey, { manual: true, syncServer: true });
          updateSidebarCount();
          renderAll();
          setStatus('已删除书签并同步服务端', 'ok');
        } catch (e) {
          setStatus(String(e?.message || e), 'error');
        }
        return;
      }

      const readerCatBtn = event.target.closest('.ldbm-reader-cat');
      if (readerCatBtn) {
        state.activeCategoryId = readerCatBtn.dataset.categoryId || 'all';
        saveUi();
        renderAll();
        return;
      }

      const catBtn = event.target.closest('.ldbm-cat-item');
      if (catBtn) {
        state.activeCategoryId = catBtn.dataset.categoryId || DEFAULT_CATEGORY_ID;
        saveUi();
        renderAll();
        return;
      }

      const openBtn = event.target.closest('.ldbm-open');
      if (openBtn) {
        const url = openBtn.dataset.url;
        if (url) {
          window.open(url, '_blank', 'noopener,noreferrer');
        }
        return;
      }
    });

    drawer.addEventListener('keydown', event => {
      const readerSizeBtn = event.target.closest('.ldbm-entry-size-btn');
      if (!readerSizeBtn) return;
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      readerSizeBtn.click();
    });

    drawer.addEventListener('contextmenu', event => {
      const topBtn = event.target.closest('.ldbm-cat-top');
      if (!topBtn) return;

      event.preventDefault();

      const categoryId = topBtn.dataset.categoryId;
      if (!categoryId) return;

      try {
        moveCustomCategoryToTop(categoryId);
        renderAll();
      } catch (e) {
        setStatus(String(e?.message || e), 'error');
      }
    });

    drawer.addEventListener('dragstart', event => {
      const catBtn = event.target.closest('.ldbm-cat-item[draggable="true"]');
      if (!catBtn) return;

      const categoryId = catBtn.dataset.categoryId;
      if (!categoryId) return;

      state.draggingCategoryId = categoryId;
      catBtn.classList.add('dragging');
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', categoryId);
      }
    });

    drawer.addEventListener('dragover', event => {
      const targetBtn = event.target.closest('.ldbm-cat-item[draggable="true"]');
      if (!targetBtn || !state.draggingCategoryId) return;

      const targetId = targetBtn.dataset.categoryId;
      if (!targetId || targetId === state.draggingCategoryId) return;

      event.preventDefault();
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = 'move';
      }
    });

    drawer.addEventListener('drop', event => {
      const targetBtn = event.target.closest('.ldbm-cat-item[draggable="true"]');
      const draggingCategoryId = state.draggingCategoryId;
      if (!targetBtn || !draggingCategoryId) return;

      const targetCategoryId = targetBtn.dataset.categoryId;
      if (!targetCategoryId || targetCategoryId === draggingCategoryId) return;

      event.preventDefault();

      const customList = state.categories.filter(c => c.id !== DEFAULT_CATEGORY_ID);
      const targetIndex = customList.findIndex(c => c.id === targetCategoryId);
      if (targetIndex < 0) return;

      try {
        reorderCustomCategory(draggingCategoryId, targetIndex);
        renderAll();
      } catch (e) {
        setStatus(String(e?.message || e), 'error');
      }
    });

    drawer.addEventListener('dragend', () => {
      state.draggingCategoryId = null;
      drawer.querySelectorAll('.ldbm-cat-item.dragging').forEach(node => node.classList.remove('dragging'));
    });

    drawer.addEventListener('change', event => {
      const assign = event.target.closest('select.ldbm-assign');
      if (!assign) return;

      const topicId = assign.dataset.topicId;
      const categoryId = assign.value;
      applyCategoryForTopic(topicId, categoryId);

      const assignedCategoryId = state.assignments[String(topicId)] || DEFAULT_CATEGORY_ID;
      renderAll();
      setStatus(`已归类到「${getCategoryNameById(assignedCategoryId)}」`, 'ok');
    });
  }

  function bindGlobalEvents() {
    if (state.globalEventsBound) return;
    state.globalEventsBound = true;

    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && state.drawerOpen) {
        closeDrawer();
      }
    });

    window.addEventListener('beforeunload', () => {
      saveUi();
      saveRate();
    });

    const refreshFromOtherTabDebounced = debounce(() => {
      refreshDataFromStorage();
    }, 120);

    window.addEventListener('storage', event => {
      if (event.key !== CROSS_TAB_EVENT_KEY || !event.newValue) return;
      const payload = safeJsonParse(event.newValue, null);
      if (!payload || payload.from === TAB_ID) return;
      refreshFromOtherTabDebounced();
    });

    let lastPathname = window.location.pathname;
    const checkUrlChange = () => {
      const nextPathname = window.location.pathname;
      if (nextPathname === lastPathname) return;

      lastPathname = nextPathname;
      if (state.quickOnlyMode && !isTopicPageRoute(nextPathname)) {
        ensureFullRuntime();
      }
      updateFabQuickAdd();
      if (state.fullRuntimeReady) {
        makeSidebarEntry();
        updateSidebarCount();
      }
    };

    window.addEventListener('popstate', checkUrlChange);
    state.pathCheckTimer = window.setInterval(checkUrlChange, state.quickOnlyMode ? 1400 : 900);
  }

  function addStyles() {
    GM_addStyle(`
      .ldbm-overlay {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.32);
        opacity: 0;
        pointer-events: none;
        transition: opacity .18s ease;
        z-index: 2147483000;
      }

      .ldbm-overlay.show {
        opacity: 1;
        pointer-events: auto;
      }

      .ldbm-drawer {
        --ldbm-drawer-width: min(880px, 96vw);
        position: fixed;
        top: 0;
        right: calc(-1 * var(--ldbm-drawer-width));
        width: var(--ldbm-drawer-width);
        height: 100vh;
        background: var(--secondary, #fff);
        border-left: 1px solid var(--primary-low, #ddd);
        box-shadow: -8px 0 24px rgba(0, 0, 0, 0.16);
        z-index: 2147483001;
        display: flex;
        flex-direction: column;
        transition: right .2s ease;
        color: var(--primary, #111);
      }

      .ldbm-drawer.open {
        right: 0;
      }

      body.ldbm-lock {
        overflow: hidden;
      }

      .ldbm-header {
        display: flex;
        justify-content: space-between;
        gap: 12px;
        padding: 14px 14px 10px;
        border-bottom: 1px solid var(--primary-low, #e4e4e4);
      }

      .ldbm-header h2 {
        margin: 0;
        font-size: 16px;
      }

      .ldbm-status-text {
        margin-top: 4px;
        font-size: 12px;
        color: var(--primary-medium, #666);
      }

      .ldbm-status-text[data-type="ok"] { color: #0f9d58; }
      .ldbm-status-text[data-type="error"] { color: #d93025; }
      .ldbm-status-text[data-type="warn"] { color: #b26a00; }

      .ldbm-header-actions,
      .ldbm-category-create {
        display: flex;
        align-items: center;
        gap: 8px;
      }

      .ldbm-reader-tools-toggle {
        display: none;
        align-self: flex-end;
        margin: 10px 24px 8px;
        min-height: 32px;
        border: 1px solid var(--primary-low, #cfd8e3);
        background: #fff;
        border-radius: 999px;
        color: var(--primary, #1f2937);
        cursor: pointer;
        z-index: 3;
        align-items: center;
        justify-content: center;
        padding: 0 12px;
        font-size: 12px;
        font-weight: 600;
        line-height: 1;
        box-shadow: none;
      }

      .ldbm-reader-tools-toggle:hover {
        background: var(--primary-very-low, #f4f4f4);
      }

      .ldbm-category-create .ldbm-btn {
        white-space: nowrap;
        min-width: 88px;
        padding: 0 14px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        text-align: center;
        flex: 0 0 auto;
      }

      .ldbm-btn {
        height: 32px;
        border: 1px solid var(--primary-low, #d0d0d0);
        background: transparent;
        border-radius: 8px;
        padding: 0 10px;
        cursor: pointer;
      }

      .ldbm-btn:hover {
        background: var(--primary-very-low, #f4f4f4);
      }

      .ldbm-btn.danger {
        color: #d93025;
        border-color: rgba(217, 48, 37, 0.45);
      }

      .ldbm-btn.primary {
        color: #fff;
        background: #2563eb;
        border-color: #2563eb;
      }

      .ldbm-btn.primary:hover {
        background: #1d4ed8;
        border-color: #1d4ed8;
      }

      .ldbm-toolbar {
        display: grid;
        gap: 10px;
        padding: 10px 14px;
        border-bottom: 1px solid var(--primary-low, #e4e4e4);
      }

      .ldbm-reader-controls {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 10px;
      }

      .ldbm-reader-controls label {
        display: grid;
        gap: 6px;
        font-size: 12px;
        color: var(--primary-medium, #667085);
      }

      .ldbm-reader-controls input[type="range"] {
        width: 100%;
      }

      .ldbm-reader-controls select {
        width: 100%;
        height: 32px;
        border: 1px solid var(--primary-low, #d0d0d0);
        border-radius: 8px;
        background: transparent;
        color: inherit;
        padding: 0 8px;
      }

      .ldbm-drawer:not(.ldbm-reader) .ldbm-reader-controls {
        display: none;
      }

      .ldbm-reader-cats {
        display: none;
        gap: 8px;
        flex-wrap: wrap;
        padding: 0 14px 10px;
      }

      .ldbm-reader-cat {
        height: 32px;
        border: 1px solid var(--primary-low, #d0d0d0);
        border-radius: 999px;
        background: transparent;
        padding: 0 12px;
        font-size: 13px;
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        gap: 6px;
      }

      .ldbm-reader-cat .count {
        color: var(--primary-medium, #666);
        font-size: 12px;
      }

      .ldbm-reader-cat.active {
        background: var(--tertiary-low, rgba(0, 132, 255, 0.12));
        border-color: rgba(0, 132, 255, 0.35);
      }

      .ldbm-search,
      .ldbm-new-category {
        width: 100%;
        height: 34px;
        border: 1px solid var(--primary-low, #d0d0d0);
        border-radius: 8px;
        padding: 0 10px;
        background: transparent;
        color: inherit;
      }

      .ldbm-main {
        display: grid;
        grid-template-columns: minmax(260px, 34%) minmax(0, 1fr);
        gap: 12px;
        min-height: 0;
        flex: 1;
        padding: 12px 12px 0;
      }

      .ldbm-categories {
        border: 1px solid var(--primary-low, #e4e4e4);
        border-radius: 10px;
        padding: 10px;
        overflow-y: auto;
        min-height: 0;
        background: linear-gradient(180deg, rgba(37, 99, 235, 0.03), transparent 40%);
      }

      .ldbm-cat-item {
        width: 100%;
        border: none;
        background: transparent;
        display: grid;
        grid-template-columns: 1fr auto auto;
        align-items: center;
        gap: 6px;
        padding: 7px 8px;
        border-radius: 8px;
        cursor: pointer;
        text-align: left;
      }

      .ldbm-cat-item[draggable="true"] {
        cursor: grab;
      }

      .ldbm-cat-item.dragging {
        opacity: 0.55;
      }

      .ldbm-cat-top {
        border: 1px solid var(--primary-low, #d0d0d0);
        border-radius: 999px;
        background: transparent;
        color: var(--primary-medium, #666);
        font-size: 12px;
        line-height: 1;
        width: 20px;
        height: 20px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        user-select: none;
      }

      .ldbm-cat-top:hover {
        color: var(--primary, #111);
        background: var(--primary-very-low, #f4f4f4);
      }

      .ldbm-cat-item .name {
        overflow: hidden;
        white-space: nowrap;
        text-overflow: ellipsis;
      }

      .ldbm-cat-item .count {
        font-size: 12px;
        color: var(--primary-medium, #666);
      }

      .ldbm-cat-item .lock {
        font-size: 11px;
        color: #0f9d58;
      }

      .ldbm-cat-item .focus {
        font-size: 11px;
        color: #1d4ed8;
      }

      .ldbm-cat-item.ldbm-cat-uncategorized {
        border: 1px solid rgba(37, 99, 235, 0.42);
        border-left: 4px solid #2563eb;
        background: linear-gradient(90deg, rgba(37, 99, 235, 0.13), rgba(37, 99, 235, 0.04));
        margin-bottom: 8px;
      }

      .ldbm-cat-item.ldbm-cat-uncategorized .name {
        font-weight: 600;
      }

      .ldbm-cat-item.ldbm-cat-uncategorized .count {
        color: #1d4ed8;
        font-weight: 600;
        background: rgba(37, 99, 235, 0.12);
        border-radius: 999px;
        padding: 1px 8px;
      }

      .ldbm-cat-item.active,
      .ldbm-cat-item:hover {
        background: var(--tertiary-low, rgba(0, 132, 255, 0.12));
      }

      .ldbm-cat-item.ldbm-cat-uncategorized.active,
      .ldbm-cat-item.ldbm-cat-uncategorized:hover {
        background: rgba(37, 99, 235, 0.17);
      }

      .ldbm-list {
        border: 1px solid var(--primary-low, #e4e4e4);
        border-radius: 10px;
        padding: 10px;
        overflow-y: auto;
        min-height: 0;
      }

      .ldbm-entry-grid {
        display: grid;
        gap: 10px;
        grid-auto-flow: dense;
        grid-auto-rows: 88px;
        grid-template-columns: repeat(auto-fill, minmax(170px, 1fr));
      }

      .ldbm-bubble-viewport {
        position: relative;
        width: 100%;
        height: clamp(460px, 74vh, 940px);
        min-height: 420px;
        border-radius: 16px;
        border: 1px dashed rgba(15, 23, 42, 0.18);
        background:
          radial-gradient(circle at 18% 16%, rgba(59, 130, 246, 0.08), transparent 38%),
          radial-gradient(circle at 80% 14%, rgba(16, 185, 129, 0.08), transparent 30%),
          linear-gradient(180deg, rgba(15, 23, 42, 0.02), rgba(15, 23, 42, 0.01));
        overflow: hidden;
        touch-action: none;
        cursor: grab;
      }

      .ldbm-bubble-viewport:active {
        cursor: grabbing;
      }

      .ldbm-bubble-canvas {
        position: relative;
        width: 100%;
        height: 100%;
        min-width: 960px;
        min-height: 660px;
        transform-origin: 0 0;
      }

      .ldbm-bubble-item {
        --bubble-font-scale: 1;
        --entry-font-scale: var(--bubble-font-scale);
        --bubble-gap: 8px;
        --bubble-vpad: 10px;
        --bubble-hpad: 11px;
        position: absolute;
        margin: 8px;
        box-sizing: border-box;
        display: grid;
        grid-template-rows: auto minmax(0, 1fr) auto;
        gap: var(--bubble-gap);
        padding: var(--bubble-vpad) var(--bubble-hpad);
        border-radius: 16px;
        border: 1px solid hsl(var(--entry-hue) var(--entry-sat) calc(var(--entry-light) - 12%));
        background: linear-gradient(
          160deg,
          hsl(var(--entry-hue) var(--entry-sat) var(--entry-light)),
          hsl(var(--entry-hue) calc(var(--entry-sat) - 8%) calc(var(--entry-light) - 8%))
        );
        box-shadow: 0 8px 20px rgba(15, 23, 42, 0.1);
        overflow: hidden;
        user-select: none;
        touch-action: none;
      }

      .ldbm-bubble-item::before {
        content: '';
        position: absolute;
        inset: 0;
        background: linear-gradient(180deg, rgba(255, 255, 255, 0.38), rgba(255, 255, 255, 0.18));
        pointer-events: none;
        z-index: 0;
      }

      .ldbm-bubble-item > * {
        position: relative;
        z-index: 1;
      }

      .ldbm-bubble-item[data-size="s"] {
        --bubble-font-scale: 0.9;
        --bubble-gap: 6px;
        --bubble-vpad: 8px;
        --bubble-hpad: 9px;
      }

      .ldbm-bubble-item[data-size="m"] {
        --bubble-font-scale: 1;
      }

      .ldbm-bubble-item[data-size="l"] {
        --bubble-font-scale: 1.12;
        --bubble-gap: 9px;
      }

      .ldbm-bubble-item[data-size="xl"] {
        --bubble-font-scale: 1.22;
        --bubble-gap: 10px;
        --bubble-vpad: 12px;
        --bubble-hpad: 13px;
      }

      .ldbm-bubble-top {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        cursor: move;
      }

      .ldbm-bubble-tools {
        display: inline-flex;
        align-items: center;
        gap: 6px;
      }

      .ldbm-bubble-tag {
        font-size: calc(11px * var(--bubble-font-scale));
        font-weight: 700;
        letter-spacing: .01em;
        color: #0b1220;
      }

      .ldbm-bubble-score {
        font-size: calc(11px * var(--bubble-font-scale));
        color: #0b1220;
        background: rgba(255, 255, 255, 0.9);
        border: 1px solid rgba(15, 23, 42, 0.2);
        border-radius: 999px;
        padding: 0 calc(8px * var(--bubble-font-scale));
        line-height: calc(20px * var(--bubble-font-scale));
      }

      .ldbm-bubble-title {
        display: -webkit-box;
        -webkit-box-orient: vertical;
        -webkit-line-clamp: 2;
        overflow: hidden;
        text-decoration: none;
        color: #020617;
        font-size: calc(14px * var(--bubble-font-scale));
        font-weight: 700;
        line-height: 1.35;
        text-shadow: 0 1px 0 rgba(255, 255, 255, 0.35);
        word-break: break-word;
      }

      .ldbm-bubble-item[data-size="l"] .ldbm-bubble-title {
        -webkit-line-clamp: 3;
      }

      .ldbm-bubble-item[data-size="xl"] .ldbm-bubble-title {
        -webkit-line-clamp: 4;
      }

      .ldbm-bubble-meta {
        display: flex;
        justify-content: space-between;
        gap: 8px;
        align-items: center;
        font-size: calc(11px * var(--bubble-font-scale));
        color: #1f2937;
        font-weight: 500;
      }

      .ldbm-bubble-meta span {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .ldbm-bubble-item[data-size="s"] .ldbm-bubble-meta span:last-child {
        display: none;
      }

      .ldbm-bubble-resize {
        position: absolute;
        right: 5px;
        bottom: 5px;
        width: 14px;
        height: 14px;
        border-right: 2px solid rgba(15, 23, 42, 0.34);
        border-bottom: 2px solid rgba(15, 23, 42, 0.34);
        border-radius: 0 0 3px 0;
        cursor: nwse-resize;
        opacity: 0.65;
        z-index: 2;
      }

      .ldbm-bubble-item:hover .ldbm-bubble-resize {
        opacity: 1;
      }

      .ldbm-entry-tile {
        --entry-font-scale: 1;
        --entry-gap: 8px;
        --entry-vpad: 10px;
        --entry-hpad: 11px;
        text-decoration: none;
        border: 1px solid hsl(var(--entry-hue) var(--entry-sat) calc(var(--entry-light) - 12%));
        background: linear-gradient(
          165deg,
          hsl(var(--entry-hue) var(--entry-sat) var(--entry-light)),
          hsl(var(--entry-hue) calc(var(--entry-sat) - 8%) calc(var(--entry-light) - 6%))
        );
        color: #0f172a;
        border-radius: 14px;
        padding: var(--entry-vpad) var(--entry-hpad);
        display: grid;
        grid-template-rows: auto minmax(0, 1fr) auto;
        gap: var(--entry-gap);
        box-shadow: 0 4px 12px rgba(15, 23, 42, 0.06);
        transition: transform .12s ease, box-shadow .12s ease;
      }

      .ldbm-entry-tile:hover {
        transform: translateY(-1px);
        box-shadow: 0 8px 20px rgba(15, 23, 42, 0.12);
      }

      .ldbm-entry-tile[data-size="s"] {
        grid-column: span 1;
        grid-row: span 1;
        --entry-font-scale: 0.9;
        --entry-gap: 6px;
        --entry-vpad: 8px;
        --entry-hpad: 9px;
      }
      .ldbm-entry-tile[data-size="m"] {
        grid-column: span 2;
        grid-row: span 1;
        --entry-font-scale: 1;
      }
      .ldbm-entry-tile[data-size="l"] {
        grid-column: span 2;
        grid-row: span 2;
        --entry-font-scale: 1.12;
        --entry-gap: 9px;
      }
      .ldbm-entry-tile[data-size="xl"] {
        grid-column: span 3;
        grid-row: span 2;
        --entry-font-scale: 1.22;
        --entry-gap: 10px;
        --entry-vpad: 12px;
        --entry-hpad: 13px;
      }

      .ldbm-entry-top {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
      }

      .ldbm-entry-tools {
        display: inline-flex;
        align-items: center;
        gap: 6px;
      }

      .ldbm-entry-size-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: 34px;
        height: calc(20px * var(--entry-font-scale));
        padding: 0 7px;
        border-radius: 999px;
        border: 1px solid rgba(15, 23, 42, 0.2);
        background: rgba(255, 255, 255, 0.62);
        color: #0f172a;
        font-size: calc(10px * var(--entry-font-scale));
        font-weight: 600;
        line-height: 1;
        user-select: none;
        cursor: pointer;
      }

      .ldbm-entry-size-btn:hover {
        background: rgba(255, 255, 255, 0.86);
      }

      .ldbm-entry-size-btn:focus-visible {
        outline: 2px solid rgba(29, 78, 216, 0.45);
        outline-offset: 1px;
      }

      .ldbm-entry-tag {
        font-size: calc(11px * var(--entry-font-scale));
        font-weight: 600;
        letter-spacing: .01em;
      }

      .ldbm-entry-score {
        font-size: calc(11px * var(--entry-font-scale));
        color: #0f172a;
        background: rgba(255, 255, 255, 0.65);
        border: 1px solid rgba(15, 23, 42, 0.14);
        border-radius: 999px;
        padding: 0 calc(8px * var(--entry-font-scale));
        line-height: calc(20px * var(--entry-font-scale));
      }

      .ldbm-entry-title {
        font-size: calc(14px * var(--entry-font-scale));
        font-weight: 650;
        line-height: 1.35;
        padding-bottom: 1px;
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
        word-break: break-word;
      }

      .ldbm-entry-tile[data-size="s"] .ldbm-entry-title {
        display: block;
        white-space: nowrap;
        text-overflow: ellipsis;
        overflow: hidden;
      }

      .ldbm-entry-tile[data-size="l"] .ldbm-entry-title {
        -webkit-line-clamp: 3;
      }

      .ldbm-entry-tile[data-size="xl"] .ldbm-entry-title {
        -webkit-line-clamp: 4;
      }

      .ldbm-entry-tile[data-size="m"] {
        grid-template-rows: auto minmax(0, 1fr);
      }

      .ldbm-entry-tile[data-size="m"] .ldbm-entry-meta {
        display: none;
      }

      .ldbm-entry-meta {
        display: flex;
        justify-content: space-between;
        gap: 8px;
        font-size: calc(11px * var(--entry-font-scale));
        color: rgba(15, 23, 42, 0.78);
      }

      .ldbm-entry-tile[data-size="s"] .ldbm-entry-meta span:last-child {
        display: none;
      }

      .ldbm-item {
        border: 1px solid var(--primary-low, #e4e4e4);
        border-radius: 10px;
        padding: 10px;
        margin-bottom: 8px;
      }

      .ldbm-item:last-child {
        margin-bottom: 0;
      }

      .ldbm-item-title {
        font-weight: 600;
        color: inherit;
        text-decoration: none;
      }

      .ldbm-item-title:hover {
        text-decoration: underline;
      }

      .ldbm-item-header {
        display: grid;
        gap: 8px;
      }

      .ldbm-item-badges {
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: 6px;
      }

      .ldbm-item-badge {
        display: inline-flex;
        align-items: center;
        height: 22px;
        border-radius: 999px;
        border: 1px solid var(--primary-low, #d0d0d0);
        background: var(--secondary, #fff);
        padding: 0 9px;
        font-size: 11px;
        color: var(--primary-medium, #667085);
      }

      .ldbm-item-badge.uncategorized {
        border-color: rgba(37, 99, 235, 0.4);
        background: rgba(37, 99, 235, 0.1);
        color: #1d4ed8;
      }

      .ldbm-item-badge.category {
        border-color: rgba(15, 23, 42, 0.2);
        color: #334155;
      }

      .ldbm-item-badge.tag {
        border-style: dashed;
      }

      .ldbm-item-meta {
        margin-top: 6px;
        font-size: 12px;
        display: flex;
        justify-content: space-between;
        gap: 8px;
        color: var(--primary-medium, #666);
      }

      .ldbm-item-excerpt {
        margin-top: 6px;
        font-size: 13px;
        color: var(--primary-medium, #666);
        line-height: 1.4;
      }

      .ldbm-item-actions {
        margin-top: 8px;
        display: flex;
        gap: 8px;
      }

      .ldbm-assign {
        flex: 1;
        min-width: 0;
        height: 30px;
        border: 1px solid var(--primary-low, #d0d0d0);
        border-radius: 8px;
        background: transparent;
        color: inherit;
        padding: 0 8px;
      }

      .ldbm-open,
      .ldbm-delete {
        height: 30px;
        border: 1px solid var(--primary-low, #d0d0d0);
        border-radius: 8px;
        background: transparent;
        cursor: pointer;
        padding: 0 10px;
      }

      .ldbm-delete {
        color: #d93025;
        border-color: rgba(217, 48, 37, 0.45);
      }

      .ldbm-empty {
        color: var(--primary-medium, #666);
        text-align: center;
        padding: 24px 10px;
      }

      .ldbm-footer {
        border-top: 1px solid var(--primary-low, #e4e4e4);
        display: flex;
        gap: 8px;
        padding: 10px 14px 14px;
        flex-wrap: wrap;
      }

      .ldbm-drawer.ldbm-reader .ldbm-manage-only {
        display: none !important;
      }

      .ldbm-drawer.ldbm-reader .ldbm-main {
        grid-template-columns: 1fr;
        padding: 14px 20px 0;
      }

      .ldbm-drawer.ldbm-reader {
        --ldbm-drawer-width: 100vw;
        border-left: none;
        box-shadow: none;
      }

      .ldbm-drawer.ldbm-reader .ldbm-reader-tools-toggle {
        display: inline-flex;
        border-color: rgba(15, 23, 42, 0.14);
        background: rgba(255, 255, 255, 0.95);
      }

      .ldbm-drawer.ldbm-reader.ldbm-reader-top-collapsed .ldbm-header,
      .ldbm-drawer.ldbm-reader.ldbm-reader-top-collapsed .ldbm-toolbar {
        display: none;
      }

      .ldbm-drawer.ldbm-reader .ldbm-header {
        padding: 16px 24px 12px;
      }

      .ldbm-drawer.ldbm-reader .ldbm-categories {
        display: none;
      }

      .ldbm-drawer.ldbm-reader .ldbm-toolbar {
        border-bottom: none;
        padding: 16px 24px 12px;
        background: linear-gradient(180deg, rgba(15, 23, 42, 0.03), rgba(15, 23, 42, 0));
      }

      .ldbm-drawer.ldbm-reader .ldbm-reader-cats {
        display: flex;
        border-bottom: 1px solid var(--primary-low, #e4e4e4);
        padding: 0 24px 14px;
        position: sticky;
        top: 0;
        z-index: 2;
        background: var(--secondary, #fff);
      }

      .ldbm-drawer.ldbm-reader .ldbm-reader-cat {
        height: 38px;
        padding: 0 16px;
        font-size: 14px;
      }

      .ldbm-drawer.ldbm-reader .ldbm-search {
        height: 44px;
        font-size: 15px;
        border-radius: 12px;
      }

      .ldbm-drawer.ldbm-reader .ldbm-list {
        width: 100%;
        max-width: 1040px;
        margin: 0 auto;
        border: none;
        background: transparent;
        padding: 0 0 24px;
      }

      .ldbm-drawer.ldbm-reader.ldbm-reader-bubble .ldbm-list {
        max-width: none;
        padding: 0;
        overflow: hidden;
      }

      .ldbm-drawer.ldbm-reader .ldbm-item {
        padding: 12px 14px;
        border-radius: 12px;
        margin-bottom: 8px;
        border-color: rgba(15, 23, 42, 0.12);
        box-shadow: 0 4px 14px rgba(15, 23, 42, 0.05);
      }

      .ldbm-drawer.ldbm-reader .ldbm-item-title {
        font-size: 18px;
        line-height: 1.45;
      }

      .ldbm-drawer.ldbm-reader .ldbm-item-meta {
        justify-content: flex-start;
        gap: 10px;
        font-size: 12px;
        margin-top: 4px;
      }

      .ldbm-drawer.ldbm-reader .ldbm-item-excerpt {
        font-size: 13px;
        line-height: 1.45;
        color: var(--primary, #1f2937);
        margin-top: 6px;
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
      }

      .ldbm-drawer.ldbm-reader .ldbm-item-badges {
        gap: 4px;
      }

      .ldbm-drawer.ldbm-reader .ldbm-item-badge {
        height: 20px;
        font-size: 10px;
        padding: 0 8px;
      }

      .ldbm-drawer.ldbm-reader .ldbm-item-actions {
        display: none;
      }

      .ldbm-mini-picker {
        position: fixed;
        right: 18px;
        bottom: 72px;
        width: min(320px, calc(100vw - 24px));
        background: var(--secondary, #fff);
        border: 1px solid var(--primary-low, #d7d7d7);
        border-radius: 12px;
        box-shadow: 0 10px 28px rgba(0, 0, 0, 0.2);
        padding: 12px;
        z-index: 2147483102;
        display: grid;
        gap: 8px;
      }

      .ldbm-mini-title {
        font-size: 13px;
        font-weight: 600;
      }

      .ldbm-mini-row {
        display: grid;
        gap: 4px;
      }

      .ldbm-mini-row label {
        font-size: 12px;
        color: var(--primary-medium, #666);
      }

      .ldbm-mini-select,
      .ldbm-mini-input {
        width: 100%;
        height: 32px;
        border: 1px solid var(--primary-low, #d0d0d0);
        border-radius: 8px;
        padding: 0 10px;
        background: transparent;
        color: inherit;
      }

      .ldbm-mini-error {
        font-size: 12px;
        color: #dc2626;
      }

      .ldbm-mini-actions {
        display: flex;
        justify-content: flex-end;
        gap: 8px;
      }

      .ldbm-fab-wrap {
        position: fixed;
        right: 18px;
        bottom: 22px;
        z-index: 2147482999;
        display: flex;
        align-items: center;
        gap: 8px;
      }

      .ldbm-fab-quick {
        width: 38px;
        height: 38px;
        border-radius: 999px;
        border: 2px solid #2563eb;
        background: #fff;
        color: #2563eb;
        font-size: 22px;
        font-weight: 600;
        line-height: 1;
        cursor: pointer;
        box-shadow: 0 2px 8px rgba(37, 99, 235, 0.25);
        transition: transform .12s ease, background .12s ease;
      }

      .ldbm-fab-quick:hover {
        background: #2563eb;
        color: #fff;
        transform: scale(1.08);
      }

      .ldbm-fab-quick.is-remove {
        border-color: #dc2626;
        color: #dc2626;
        box-shadow: 0 2px 8px rgba(220, 38, 38, 0.25);
      }

      .ldbm-fab-quick.is-remove:hover {
        background: #dc2626;
        color: #fff;
      }

      .ldbm-fab-quick:disabled {
        cursor: default;
        opacity: 0.7;
      }

      .ldbm-fab {
        position: relative;
        height: 44px;
        border-radius: 999px;
        border: 1px solid var(--primary-low, #d0d0d0);
        background: var(--secondary, #fff);
        color: inherit;
        display: inline-flex;
        align-items: center;
        gap: 8px;
        padding: 0 14px;
        cursor: pointer;
        box-shadow: 0 2px 10px rgba(0, 0, 0, 0.14);
      }

      .ldbm-fab-badge {
        min-width: 20px;
        height: 20px;
        border-radius: 10px;
        background: #2563eb;
        color: #fff;
        font-size: 12px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        padding: 0 6px;
      }

      .ldbm-sidebar-open {
        width: 100%;
        border: none;
        background: transparent;
        cursor: pointer;
      }

      @media (max-width: 980px) {
        .ldbm-reader-controls {
          grid-template-columns: 1fr;
        }

        .ldbm-main {
          grid-template-columns: 1fr;
        }

        .ldbm-categories {
          max-height: 170px;
        }

        .ldbm-footer {
          flex-wrap: wrap;
        }

        .ldbm-drawer.ldbm-reader .ldbm-header,
        .ldbm-drawer.ldbm-reader .ldbm-toolbar {
          padding-left: 12px;
          padding-right: 12px;
        }

        .ldbm-drawer.ldbm-reader .ldbm-reader-tools-toggle {
          margin: 8px 12px 6px;
        }

        .ldbm-drawer.ldbm-reader .ldbm-main {
          padding: 12px 12px 0;
        }

        .ldbm-drawer.ldbm-reader .ldbm-reader-cats {
          padding: 0 12px 10px;
        }

        .ldbm-drawer.ldbm-reader .ldbm-list {
          max-width: none;
          padding-bottom: 16px;
        }

        .ldbm-drawer.ldbm-reader.ldbm-reader-bubble .ldbm-list {
          padding-bottom: 0;
        }

        .ldbm-bubble-viewport {
          height: clamp(380px, 66vh, 680px);
          min-height: 360px;
          border-radius: 12px;
        }

        .ldbm-bubble-canvas {
          min-width: 720px;
          min-height: 520px;
        }

        .ldbm-drawer.ldbm-reader .ldbm-item-title {
          font-size: 16px;
        }

        .ldbm-entry-grid {
          grid-template-columns: 1fr;
          grid-auto-rows: auto;
        }

        .ldbm-entry-tile[data-size="m"],
        .ldbm-entry-tile[data-size="l"],
        .ldbm-entry-tile[data-size="xl"] {
          grid-column: span 1;
          grid-row: span 1;
        }
      }
    `);
  }

  async function bootstrap() {
    if (!ensureOnBookmarksPage()) {
      return;
    }

    addStyles();
    loadStorage();
    clearRateBecauseManualReload();
    state.snapshotRestored = loadSnapshotBookmarks();
    rebuildDerivedCaches();
    state.quickOnlyMode = isTopicPageRoute(window.location.pathname);

    makeFab();
    bindGlobalEvents();

    if (state.quickOnlyMode) {
      updateFabQuickAdd();
      return;
    }

    ensureFullRuntime();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrap);
  } else {
    bootstrap();
  }
})();
