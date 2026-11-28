(() => {
  'use strict';

  const STORAGE_KEY = 'pcremote.settings.v1';
  const HOTKEYS_KEY = 'pcremote.hotkeys.v1';
  const UPDATE_KEY = 'pcremote.update.v1';
  const SHUTDOWN_KEY = 'pcremote.shutdown.v1';
  const DEFAULTS = { ip: '', mac: '', port: 8765, token: '', name: '' };
  const hasNativeBridge = Boolean(window.PcBridge);

  const DEFAULT_HOTKEYS = [
    { id: 'desktop', name: 'Свернуть всё', combo: 'win+d' },
    { id: 'taskmgr', name: 'Диспетчер задач', combo: 'ctrl+shift+esc' },
    { id: 'explorer', name: 'Проводник', combo: 'win+e' },
    { id: 'switch', name: 'Переключить окно', combo: 'alt+tab' },
    { id: 'close', name: 'Закрыть окно', combo: 'alt+f4' },
    { id: 'copy', name: 'Копировать', combo: 'ctrl+c' },
    { id: 'paste', name: 'Вставить', combo: 'ctrl+v' },
  ];

  const MODIFIERS = new Set(['ctrl', 'control', 'alt', 'shift', 'win', 'windows', 'meta']);
  const SPECIAL_KEYS = new Set([
    'enter', 'return', 'esc', 'escape', 'tab', 'space', 'backspace', 'delete', 'del',
    'insert', 'ins', 'home', 'end', 'pageup', 'pgup', 'pagedown', 'pgdn', 'up', 'down',
    'left', 'right', 'printscreen', 'prtsc', 'pause', 'capslock', 'numlock', 'scrolllock',
    'minus', '-', 'plus', '=', 'comma', ',', 'period', '.', 'slash', '/', 'backslash', '\\',
    'semicolon', ';', 'quote', "'", 'bracketleft', '[', 'bracketright', ']', 'grave', '`',
  ]);

  const Bridge =
    window.PcBridge ||
    {
      getVersion: () => 'web',
      getVersionCode: () => 0,
      getNetworkInfo: () => JSON.stringify({ ip: '', broadcast: '' }),
      wake: () => showToast('Wake-on-LAN работает только в приложении', 'error'),
      httpRequest: (url, method, token, body, callbackId, timeoutMs) => {
        setTimeout(
          () => window.__nativeHttp(callbackId, false, 'Это предпросмотр в браузере. Откройте приложение'),
          250
        );
      },
      discover: (callbackId) => {
        setTimeout(
          () => window.__nativeDiscover(callbackId, false, 'Поиск работает только в приложении'),
          250
        );
      },
      checkUpdate: (callbackId) => {
        setTimeout(
          () => window.__nativeUpdate(callbackId, false, 'Обновления работают только в приложении'),
          250
        );
      },
      downloadUpdate: (versionName, callbackId) => {
        setTimeout(
          () => window.__nativeDownload(callbackId, false, 'Обновления работают только в приложении'),
          250
        );
      },
      vibrate: () => {},
      toast: () => {},
    };

  const CONFIRM = {
    shutdown: {
      title: 'Выключить ПК?',
      text: 'Все программы будут закрыты. Включить компьютер обратно можно этой же кнопкой через Wake-on-LAN.',
      button: 'Выключить',
      danger: true,
      icon: '!',
    },
    abort: {
      title: 'Отменить выключение?',
      text: 'Таймер будет снят, компьютер продолжит работать.',
      button: 'Отменить',
      danger: false,
      icon: '↺',
    },
    restart: {
      title: 'Перезагрузить ПК?',
      text: 'Компьютер перезагрузится. Через некоторое время он снова появится в сети.',
      button: 'Перезагрузить',
      danger: false,
      icon: '↻',
    },
    sleep: {
      title: 'Отправить ПК в сон?',
      text: 'Компьютер уснёт. Разбудить его можно кнопкой питания через Wake-on-LAN.',
      button: 'В сон',
      danger: false,
      icon: '☾',
    },
  };

  const els = {};
  const pending = new Map();
  let sequence = 0;
  let toastTimer = null;
  let appsSearchTimer = null;

  const state = {
    settings: loadSettings(),
    online: false,
    checking: false,
    busy: false,
    info: null,
    lastError: '',
    net: { ip: '', broadcast: '' },
    bootWatch: null,
    bootStartedAt: 0,
    pendingAction: null,
    sheetOpen: false,
    confirmOpen: false,
    appVisible: true,
    pollTimer: null,
    currentVersion: '1.1.4',
    currentVersionCode: 0,
    shotOpen: false,
    shotBusy: false,
    shotData: null,
    shutdownChoice: 0,
    shutdown: loadShutdown(),
    monitor: {
      known: false,
      on: true,
      explicitOff: false,
      idleSeconds: 0,
      timeoutSeconds: 900,
      checking: false,
      busy: false,
      lastAt: 0,
    },
    appsOpen: false,
    appsBusy: false,
    apps: [],
    appsError: '',
    appsLoadedAt: 0,
    appsRequest: 0,
    hotkeysOpen: false,
    hotkeys: loadHotkeys(),
    editingHotkey: '',
    bt: {
      loading: false,
      checked: false,
      running: false,
      state: '',
      openEnabled: false,
      closeEnabled: false,
      error: '',
      lastAt: 0,
    },
    update: {
      checking: false,
      downloading: false,
      checked: false,
      available: false,
      info: null,
      error: '',
    },
  };

  // ------------------------------------------------------------------
  // Настройки
  // ------------------------------------------------------------------

  function loadSettings() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return { ...DEFAULTS };
      const parsed = JSON.parse(raw);
      return {
        ip: String(parsed.ip || '').trim(),
        mac: normalizeMac(parsed.mac || ''),
        port: Number(parsed.port) || 8765,
        token: String(parsed.token || '').trim(),
        name: String(parsed.name || '').trim(),
      };
    } catch (error) {
      return { ...DEFAULTS };
    }
  }

  function saveSettings(settings) {
    state.settings = settings;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch (error) {
      // Приватный режим WebView может запрещать запись — настройки останутся в памяти.
    }
  }

  function loadShutdown() {
    try {
      const raw = localStorage.getItem(SHUTDOWN_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        const at = Number(parsed.at) || 0;
        if (at > Date.now()) {
          return { at, seconds: Number(parsed.seconds) || 0 };
        }
      }
      localStorage.removeItem(SHUTDOWN_KEY);
    } catch (error) {
      // Некорректная запись не должна мешать запуску.
    }
    return { at: 0, seconds: 0 };
  }

  function saveShutdown() {
    try {
      if (state.shutdown.at > Date.now()) {
        localStorage.setItem(SHUTDOWN_KEY, JSON.stringify(state.shutdown));
      } else {
        localStorage.removeItem(SHUTDOWN_KEY);
      }
    } catch (error) {
      // Таймер останется в памяти.
    }
  }

  function formatDelay(seconds) {
    const total = Math.max(0, Math.round(Number(seconds) || 0));
    if (total < 60) return total + ' с';
    const minutes = Math.floor(total / 60);
    if (minutes < 60) return minutes + ' мин';
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return rest ? hours + ' ч ' + rest + ' мин' : hours + ' ч';
  }

  function versionAtLeast(actual, required) {
    const left = String(actual || '').split('.').map((part) => parseInt(part, 10) || 0);
    const right = String(required || '').split('.').map((part) => parseInt(part, 10) || 0);
    for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
      const a = left[index] || 0;
      const b = right[index] || 0;
      if (a > b) return true;
      if (a < b) return false;
    }
    return true;
  }

  function agentSupportsShutdownTimer() {
    return Boolean(state.info && versionAtLeast(state.info.agent_version, '1.1.4'));
  }

  function setShutdownTimer(seconds) {
    const delay = Math.max(1, Math.min(86400, Math.round(Number(seconds) || 0)));
    state.shutdown = { at: Date.now() + delay * 1000, seconds: delay };
    saveShutdown();
    renderShutdownTimer();
  }

  function clearShutdownTimer() {
    state.shutdown = { at: 0, seconds: 0 };
    saveShutdown();
    renderShutdownTimer();
  }

  function renderShutdownTimer() {
    if (!els.shutdownStatus) return;
    const left = state.shutdown.at - Date.now();
    if (left <= 0) {
      els.shutdownStatus.hidden = true;
      return;
    }
    els.shutdownStatus.hidden = false;
    els.shutdownStatusText.textContent = 'Выключение через ' + formatDelay(Math.ceil(left / 1000));
  }

  function normalizeMac(value) {
    const hex = String(value || '').replace(/[^0-9a-fA-F]/g, '').toUpperCase();
    if (hex.length !== 12) return '';
    return hex.match(/.{2}/g).join(':');
  }

  function isValidIp(value) {
    const parts = String(value || '').trim().split('.');
    if (parts.length !== 4) return false;
    return parts.every((part) => {
      if (!/^\d{1,3}$/.test(part)) return false;
      const number = Number(part);
      return number >= 0 && number <= 255;
    });
  }

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  // ------------------------------------------------------------------
  // Горячие клавиши
  // ------------------------------------------------------------------

  function loadHotkeys() {
    try {
      const raw = localStorage.getItem(HOTKEYS_KEY);
      if (!raw) return DEFAULT_HOTKEYS.map((item) => ({ ...item }));
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return DEFAULT_HOTKEYS.map((item) => ({ ...item }));
      const result = parsed
        .filter((item) => item && item.name && item.combo)
        .slice(0, 12)
        .map((item) => ({
          id: String(item.id || uid()),
          name: String(item.name).slice(0, 40),
          combo: normalizeCombo(item.combo),
        }))
        .filter((item) => !validateCombo(item.combo));
      return result.length ? result : DEFAULT_HOTKEYS.map((item) => ({ ...item }));
    } catch (error) {
      return DEFAULT_HOTKEYS.map((item) => ({ ...item }));
    }
  }

  function saveHotkeys() {
    try {
      localStorage.setItem(HOTKEYS_KEY, JSON.stringify(state.hotkeys));
    } catch (error) {
      // Настройки останутся в памяти.
    }
  }

  function normalizeCombo(value) {
    return String(value || '')
      .trim()
      .toLowerCase()
      .split('+')
      .map((part) => part.trim())
      .filter(Boolean)
      .join('+');
  }

  function comboParts(combo) {
    return String(combo || '')
      .split('+')
      .map((part) => part.trim())
      .filter(Boolean);
  }

  function validateCombo(combo) {
    const parts = comboParts(combo);
    if (!parts.length) return 'Введите сочетание';
    if (parts.length > 5) return 'Слишком много клавиш';
    let mainToken = '';
    let mainCount = 0;
    let modifierCount = 0;
    for (const part of parts) {
      if (MODIFIERS.has(part)) {
        modifierCount += 1;
        continue;
      }
      if (SPECIAL_KEYS.has(part) || /^f([1-9]|1[0-9]|2[0-4])$/.test(part) || (part.length === 1 && /[a-z0-9]/.test(part))) {
        mainToken = part;
        mainCount += 1;
        continue;
      }
      return 'Неизвестная клавиша: ' + part;
    }
    if (mainCount !== 1) return 'Нужна одна основная клавиша';
    if (modifierCount === 0 && !/^f([1-9]|1[0-9]|2[0-4])$/.test(mainToken)) {
      return 'Добавьте Ctrl, Alt, Shift или Win';
    }
    return '';
  }

  function formatCombo(combo) {
    return comboParts(combo)
      .map((part) => {
        if (part.length === 1) return part.toUpperCase();
        return part.charAt(0).toUpperCase() + part.slice(1);
      })
      .join(' + ');
  }

  // ------------------------------------------------------------------
  // Сетевой мост Java ↔ JavaScript
  // ------------------------------------------------------------------

  function apiRequest(config, path, method = 'GET', body = null, timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
      if (!config || !config.ip || !config.token) {
        reject(new Error('Заполните IP и токен'));
        return;
      }
      const id = 'http' + ++sequence;
      const timer = setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error('ПК не отвечает (таймаут)'));
        }
      }, timeoutMs + 1500);
      pending.set(id, { resolve, reject, timer });
      const url = 'http://' + config.ip + ':' + (config.port || 8765) + path;
      const payload = body == null ? '' : JSON.stringify(body);
      try {
        Bridge.httpRequest(url, method, config.token, payload, id, timeoutMs);
      } catch (error) {
        clearTimeout(timer);
        pending.delete(id);
        reject(new Error('Не удалось отправить запрос'));
      }
    });
  }

  window.__nativeHttp = (id, ok, payload) => {
    const request = pending.get(id);
    if (!request) return;
    pending.delete(id);
    clearTimeout(request.timer);
    if (ok) {
      try {
        request.resolve(payload ? JSON.parse(payload) : {});
      } catch (error) {
        request.resolve({});
      }
    } else {
      request.reject(new Error(payload || 'Ошибка сети'));
    }
  };

  function discoverRequest() {
    return new Promise((resolve, reject) => {
      const id = 'discover' + ++sequence;
      const timer = setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          resolve([]);
        }
      }, 7000);
      pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
        timer,
      });
      try {
        Bridge.discover(id);
      } catch (error) {
        clearTimeout(timer);
        pending.delete(id);
        reject(new Error('Поиск недоступен'));
      }
    });
  }

  window.__nativeDiscover = (id, ok, payload) => {
    const request = pending.get(id);
    if (!request) return;
    pending.delete(id);
    clearTimeout(request.timer);
    if (!ok) {
      request.reject(new Error(payload || 'Ошибка поиска'));
      return;
    }
    try {
      request.resolve(JSON.parse(payload || '[]'));
    } catch (error) {
      request.resolve([]);
    }
  };

  function updateRequest() {
    return new Promise((resolve, reject) => {
      const id = 'update' + ++sequence;
      const timer = setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error('GitHub не ответил вовремя'));
        }
      }, 18000);
      pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
        timer,
      });
      try {
        Bridge.checkUpdate(id);
      } catch (error) {
        clearTimeout(timer);
        pending.delete(id);
        reject(new Error('Проверка обновлений недоступна'));
      }
    });
  }

  window.__nativeUpdate = (id, ok, payload) => {
    const request = pending.get(id);
    if (!request) return;
    pending.delete(id);
    clearTimeout(request.timer);
    if (!ok) {
      request.reject(new Error(payload || 'Не удалось проверить обновления'));
      return;
    }
    try {
      request.resolve(JSON.parse(payload || '{}'));
    } catch (error) {
      request.reject(new Error('Некорректный ответ GitHub'));
    }
  };

  function downloadRequest(versionName) {
    return new Promise((resolve, reject) => {
      const id = 'download' + ++sequence;
      const timer = setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error('Скачивание обновления заняло слишком много времени'));
        }
      }, 90000);
      pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
        timer,
      });
      try {
        Bridge.downloadUpdate(versionName || '', id);
      } catch (error) {
        clearTimeout(timer);
        pending.delete(id);
        reject(new Error('Загрузка обновления недоступна'));
      }
    });
  }

  window.__nativeDownload = (id, ok, payload) => {
    const request = pending.get(id);
    if (!request) return;
    pending.delete(id);
    clearTimeout(request.timer);
    if (ok) {
      request.resolve(payload || 'Установщик открыт');
    } else {
      request.reject(new Error(payload || 'Не удалось скачать обновление'));
    }
  };

  // ------------------------------------------------------------------
  // Статус
  // ------------------------------------------------------------------

  function sessionReady() {
    return Boolean(state.online && state.info && state.info.session && state.info.session.ok);
  }

  async function refreshStatus(options = {}) {
    if (state.checking) return;
    if (!state.settings.ip || !state.settings.token) {
      state.online = false;
      state.info = null;
      render();
      return;
    }

    state.checking = true;
    if (!options.silent) render();

    try {
      const data = await apiRequest(state.settings, '/status');
      state.online = true;
      state.info = data;
      state.lastError = '';
      if (state.bootWatch) {
        stopBootWatch();
        showToast('ПК включился и на связи');
        vibrate(35);
      }
      if (sessionReady() && !state.monitor.known) {
        refreshMonitorState({ silent: true });
      }
    } catch (error) {
      state.online = false;
      state.info = null;
      state.lastError = error.message || 'Нет связи';
      if (state.bootWatch && Date.now() - state.bootStartedAt > 120000) {
        stopBootWatch();
        showToast('ПК не ответил за 2 минуты. Проверьте Wake-on-LAN в BIOS', 'error', 5000);
      }
    } finally {
      state.checking = false;
      render();
    }
  }

  function startBootWatch() {
    stopBootWatch();
    state.bootStartedAt = Date.now();
    state.bootWatch = setInterval(() => {
      if (!state.appVisible || document.hidden) return;
      refreshStatus({ silent: true });
    }, 3000);
    render();
  }

  function stopBootWatch() {
    if (state.bootWatch) {
      clearInterval(state.bootWatch);
      state.bootWatch = null;
    }
  }

  // ------------------------------------------------------------------
  // Отрисовка
  // ------------------------------------------------------------------

  function render() {
    const configured = Boolean(state.settings.ip && state.settings.token);
    const online = state.online;
    const checking = state.checking;
    const ready = sessionReady();

    els.statusDot.className =
      'dot ' + (online ? 'online' : checking ? 'checking' : 'offline');
    els.statusText.textContent = !configured
      ? 'Не настроено'
      : checking && !online
        ? 'Проверяю…'
        : online
          ? 'ПК включён'
          : state.bootWatch
            ? 'ПК загружается…'
            : 'ПК не отвечает';

    els.pcName.textContent =
      (state.info && state.info.hostname) || state.settings.name || 'Ваш ПК';

    if (online && state.info) {
      els.pcMeta.textContent =
        (state.info.ip || state.settings.ip) + ' · ' + formatUptime(state.info.uptime_sec);
    } else if (configured) {
      els.pcMeta.textContent = state.settings.ip;
    } else {
      els.pcMeta.textContent = 'Укажите IP и токен в настройках';
    }

    els.pcBadge.textContent = online ? 'Онлайн' : configured ? 'Офлайн' : 'Не настроено';
    els.pcBadge.className = 'pc-badge' + (online ? ' on' : '');

    if (state.busy) {
      els.powerLabel.textContent = 'Отправляю…';
    } else {
      els.powerLabel.textContent = online ? 'Выключить' : 'Включить';
    }

    els.powerHint.textContent = online
      ? 'ПК в сети — нажмите, чтобы выключить'
      : state.bootWatch
        ? 'Ждём, пока ПК загрузится…'
        : 'Отправьте сигнал Wake-on-LAN';

    els.powerBtn.classList.toggle('online', online);
    els.powerBtn.classList.toggle('busy', state.busy);
    els.powerBtn.disabled = state.busy;

    document.querySelectorAll('[data-action]').forEach((button) => {
      button.disabled = !online || state.busy;
    });

    document.querySelectorAll('[data-session]').forEach((button) => {
      button.disabled = !ready;
    });

    if (state.online && !ready) {
      els.sessionHint.hidden = false;
      els.sessionHint.textContent =
        'Помощник сессии не запущен. Громкость, медиа, скриншоты и программы недоступны — переустановите агент на ПК.';
    } else {
      els.sessionHint.hidden = true;
    }

    els.refreshBtn.classList.toggle('spinning', checking);

    const notes = [];
    if (state.lastError && !online && configured) notes.push(state.lastError);
    if (state.net.ip) notes.push('Телефон: ' + state.net.ip);
    if (configured && isValidIp(state.settings.ip) && state.net.ip) {
      const phoneSubnet = state.net.ip.split('.').slice(0, 3).join('.');
      const pcSubnet = state.settings.ip.split('.').slice(0, 3).join('.');
      if (phoneSubnet !== pcSubnet) notes.push('⚠ Телефон и ПК в разных подсетях');
    }
    els.netHint.textContent = notes.join(' · ');
    els.netHint.classList.toggle('warn', notes.some((note) => note.startsWith('⚠')));

    renderBt();
    renderUpdate();
    renderMonitor();
  }

  function formatUptime(seconds) {
    const total = Math.max(0, Number(seconds) || 0);
    const days = Math.floor(total / 86400);
    const hours = Math.floor((total % 86400) / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    if (days > 0) return days + ' д ' + hours + ' ч';
    if (hours > 0) return hours + ' ч ' + minutes + ' мин';
    return Math.max(1, minutes) + ' мин';
  }

  function formatBytes(bytes) {
    const value = Number(bytes) || 0;
    if (value >= 1024 * 1024) return (value / (1024 * 1024)).toFixed(1) + ' МБ';
    if (value >= 1024) return Math.round(value / 1024) + ' КБ';
    return value + ' Б';
  }

  function refreshNetworkInfo() {
    try {
      const data = JSON.parse(Bridge.getNetworkInfo() || '{}');
      state.net = { ip: data.ip || '', broadcast: data.broadcast || '' };
    } catch (error) {
      state.net = { ip: '', broadcast: '' };
    }
    updateNetworkNote();
    render();
  }

  function updateNetworkNote() {
    if (!els.networkNote) return;
    if (state.net.ip) {
      els.networkNote.textContent =
        'Телефон в Wi-Fi: ' + state.net.ip + '. ПК должен быть в этой же сети.';
    } else {
      els.networkNote.textContent =
        'Телефон не в Wi-Fi. Для управления ПК подключитесь к домашней сети.';
    }
  }

  // ------------------------------------------------------------------
  // Power
  // ------------------------------------------------------------------

  function handlePower() {
    if (state.online) {
      openConfirm('shutdown');
      return;
    }
    wakePc();
  }

  function wakePc() {
    if (!state.settings.mac) {
      openSettings();
      showToast('Сначала укажите MAC-адрес ПК', 'error');
      return;
    }
    if (!hasNativeBridge) {
      showToast('Wake-on-LAN работает только в приложении', 'error');
      return;
    }
    Bridge.wake(state.settings.mac, state.settings.ip, state.net.broadcast || '');
    vibrate(40);
    showToast('Сигнал включения отправлен. Ждём ПК…');
    startBootWatch();
  }

  function openConfirm(action) {
    const config = CONFIRM[action];
    if (!config) return;
    state.pendingAction = action;
    state.confirmOpen = true;
    els.confirmTitle.textContent = config.title;
    els.confirmText.textContent = config.text;
    els.confirmIcon.textContent = config.icon;
    els.confirmIcon.className = 'modal-icon' + (config.danger ? '' : ' primary');
    els.okConfirm.textContent = config.button;
    els.okConfirm.className = config.danger ? 'danger-btn' : 'primary-btn';
    els.shutdownTimer.hidden = action !== 'shutdown';
    if (action === 'shutdown') {
      resetShutdownPicker();
      const timerReady = agentSupportsShutdownTimer();
      els.shutdownTimerNote.hidden = timerReady;
      document.querySelectorAll('[data-delay]').forEach((button) => {
        button.disabled = Number(button.dataset.delay) > 0 && !timerReady;
      });
      els.shutdownMinutes.disabled = !timerReady;
    }

    els.modalBackdrop.hidden = false;
    els.confirmModal.hidden = false;
    requestAnimationFrame(() => {
      els.modalBackdrop.classList.add('show');
      els.confirmModal.classList.add('show');
    });
  }

  function resetShutdownPicker() {
    state.shutdownChoice = 0;
    if (els.shutdownMinutes) els.shutdownMinutes.value = '';
    document.querySelectorAll('[data-delay]').forEach((button) => {
      button.classList.toggle('is-active', Number(button.dataset.delay) === 0);
    });
    updateShutdownConfirm();
  }

  function selectShutdownDelay(seconds) {
    state.shutdownChoice = Math.max(0, Math.min(86400, Math.round(Number(seconds) || 0)));
    if (els.shutdownMinutes) els.shutdownMinutes.value = '';
    document.querySelectorAll('[data-delay]').forEach((button) => {
      button.classList.toggle(
        'is-active',
        Number(button.dataset.delay) === state.shutdownChoice
      );
    });
    updateShutdownConfirm();
  }

  function updateShutdownConfirm() {
    if (state.pendingAction !== 'shutdown') return;
    const seconds = state.shutdownChoice;
    if (seconds > 0) {
      els.confirmText.textContent =
        'ПК выключится через ' + formatDelay(seconds) + '. Все программы будут закрыты.';
      els.okConfirm.textContent = 'Запланировать';
    } else {
      els.confirmText.textContent = CONFIRM.shutdown.text;
      els.okConfirm.textContent = CONFIRM.shutdown.button;
    }
  }

  function hideConfirm() {
    state.confirmOpen = false;
    state.pendingAction = null;
    els.modalBackdrop.classList.remove('show');
    els.confirmModal.classList.remove('show');
    setTimeout(() => {
      if (!state.confirmOpen) {
        els.modalBackdrop.hidden = true;
        els.confirmModal.hidden = true;
      }
    }, 240);
  }

  async function runAction(action) {
    state.busy = true;
    render();
    try {
      const delaySeconds =
        action === 'shutdown' ? Math.max(0, Number(state.shutdownChoice) || 0) : 0;
      const scheduled = action === 'shutdown' && delaySeconds > 0;
      const endpoint = scheduled ? '/shutdown_timer' : '/' + action;
      const body = scheduled ? { seconds: delaySeconds } : null;
      const result = await apiRequest(state.settings, endpoint, 'POST', body);
      vibrate(30);
      showToast(result.message || 'Команда выполнена');
      if (scheduled) {
        setShutdownTimer(delaySeconds);
      } else if (action === 'shutdown' || action === 'sleep') {
        if (action === 'shutdown') clearShutdownTimer();
        setTimeout(() => {
          if (state.online) {
            state.online = false;
            state.info = null;
            state.lastError = action === 'sleep' ? 'ПК спит' : 'ПК выключается';
            render();
          }
        }, 3500);
      } else if (action === 'abort') {
        clearShutdownTimer();
      }
    } catch (error) {
      showToast(error.message || 'Не удалось выполнить команду', 'error', 4500);
    } finally {
      state.busy = false;
      render();
    }
  }

  // ------------------------------------------------------------------
  // Команды в сессии пользователя
  // ------------------------------------------------------------------

  async function command(path, body, options = {}) {
    if (!state.online) {
      showToast('ПК не в сети', 'error');
      return null;
    }
    if (!sessionReady()) {
      showToast('Помощник сессии не запущен. Переустановите агент на ПК', 'error', 4500);
      return null;
    }
    try {
      const result = await apiRequest(
        state.settings,
        path,
        'POST',
        body || {},
        options.timeout || 12000
      );
      if (options.vibrate !== false) vibrate(22);
      if (!options.silent) {
        showToast(result.message || 'Готово', '', options.toastDuration || 2400);
      }
      return result;
    } catch (error) {
      showToast(error.message || 'Команда не выполнена', 'error', 4500);
      return null;
    }
  }

  async function sendVolume(steps) {
    const result = await command('/volume', { steps }, { silent: true, vibrate: false, timeout: 12000 });
    if (result) {
      vibrate(12);
      showToast(steps > 0 ? 'Громкость +' : 'Громкость −', '', 900);
    }
  }

  async function toggleMute() {
    await command('/volume', { mute: true }, { timeout: 12000 });
  }

  async function sendMedia(key) {
    await command('/media', { key }, { timeout: 12000 });
  }

  async function sendHotkey(combo) {
    await command('/hotkey', { combo }, { timeout: 12000 });
  }

  // ------------------------------------------------------------------
  // Скриншот
  // ------------------------------------------------------------------

  const SHOT_MAX_ZOOM = 10;
  const SHOT_DOUBLE_TAP_SCALE = 2.5;
  const shotView = {
    scale: 1,
    x: 0,
    y: 0,
    pointers: new Map(),
    pinch: null,
    pan: null,
    lastTap: 0,
    lastTapX: 0,
    lastTapY: 0,
  };

  function shotCenter() {
    const rect = els.shotFrame.getBoundingClientRect();
    return {
      cx: rect.left + rect.width / 2,
      cy: rect.top + rect.height / 2,
    };
  }

  function shotClamp() {
    const baseW = els.shotImage.offsetWidth || 0;
    const baseH = els.shotImage.offsetHeight || 0;
    if (!baseW || !baseH) return;
    const maxX = Math.max(0, (baseW * shotView.scale - els.shotFrame.clientWidth) / 2);
    const maxY = Math.max(0, (baseH * shotView.scale - els.shotFrame.clientHeight) / 2);
    shotView.x = Math.min(maxX, Math.max(-maxX, shotView.x));
    shotView.y = Math.min(maxY, Math.max(-maxY, shotView.y));
  }

  function shotApply() {
    if (!els.shotImage) return;
    els.shotImage.style.transform =
      'translate3d(' +
      shotView.x.toFixed(2) +
      'px, ' +
      shotView.y.toFixed(2) +
      'px, 0) scale(' +
      shotView.scale.toFixed(3) +
      ')';
    const rounded = Math.round(shotView.scale * 10) / 10;
    const label = String(rounded).replace('.', ',') + '×';
    els.shotZoomLevel.textContent = label;
    const atMin = shotView.scale <= 1.001;
    const atMax = shotView.scale >= SHOT_MAX_ZOOM - 0.001;
    els.shotZoomOut.disabled = atMin;
    els.shotZoomIn.disabled = atMax;
    els.shotZoomReset.disabled = atMin;
    els.shotZoomReset.setAttribute('aria-label', 'Сбросить масштаб, сейчас ' + label);
    els.shotFrame.classList.toggle('zoomed', !atMin);
  }

  function shotReset(apply = true) {
    shotView.scale = 1;
    shotView.x = 0;
    shotView.y = 0;
    shotView.pointers.clear();
    shotView.pinch = null;
    shotView.pan = null;
    shotView.lastTap = 0;
    if (apply && els.shotImage) {
      els.shotImage.style.transform = '';
      shotApply();
    }
  }

  function shotZoomAt(nextScale, clientX, clientY) {
    const scale = Math.min(SHOT_MAX_ZOOM, Math.max(1, nextScale));
    if (Math.abs(scale - shotView.scale) < 0.001) return;
    const center = shotCenter();
    const fx = clientX - center.cx;
    const fy = clientY - center.cy;
    const ratio = scale / shotView.scale;
    shotView.x = fx - (fx - shotView.x) * ratio;
    shotView.y = fy - (fy - shotView.y) * ratio;
    shotView.scale = scale;
    shotClamp();
    shotApply();
  }

  function shotZoomCenter(factor) {
    const center = shotCenter();
    shotZoomAt(shotView.scale * factor, center.cx, center.cy);
  }

  function shotPointerPoints() {
    return Array.from(shotView.pointers.values());
  }

  function shotStartPinch() {
    const points = shotPointerPoints();
    if (points.length < 2) return;
    const midX = (points[0].x + points[1].x) / 2;
    const midY = (points[0].y + points[1].y) / 2;
    const dx = points[0].x - points[1].x;
    const dy = points[0].y - points[1].y;
    const center = shotCenter();
    shotView.pan = null;
    shotView.pinch = {
      startDist: Math.max(1, Math.hypot(dx, dy)),
      startScale: shotView.scale,
      anchorX: (midX - center.cx - shotView.x) / shotView.scale,
      anchorY: (midY - center.cy - shotView.y) / shotView.scale,
    };
    shotView.lastTap = 0;
  }

  function onShotPointerDown(event) {
    if (els.shotImage.hidden) return;
    if (event.target.closest && event.target.closest('.shot-zoom-bar')) return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    if (shotView.pointers.size >= 2) return;
    event.preventDefault();
    try {
      els.shotFrame.setPointerCapture(event.pointerId);
    } catch (error) {
      // Захват не критичен.
    }
    shotView.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (shotView.pointers.size === 1) {
      shotView.pinch = null;
      shotView.pan = {
        id: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        startTx: shotView.x,
        startTy: shotView.y,
        moved: false,
        eligible: true,
        startedAt: Date.now(),
      };
    } else {
      shotStartPinch();
    }
  }

  function onShotPointerMove(event) {
    const point = shotView.pointers.get(event.pointerId);
    if (!point) return;
    point.x = event.clientX;
    point.y = event.clientY;
    event.preventDefault();
    if (shotView.pinch && shotView.pointers.size >= 2) {
      const points = shotPointerPoints();
      const dx = points[0].x - points[1].x;
      const dy = points[0].y - points[1].y;
      const midX = (points[0].x + points[1].x) / 2;
      const midY = (points[0].y + points[1].y) / 2;
      const center = shotCenter();
      const nextScale = Math.min(
        SHOT_MAX_ZOOM,
        Math.max(
          1,
          shotView.pinch.startScale *
            (Math.hypot(dx, dy) / shotView.pinch.startDist)
        )
      );
      shotView.scale = nextScale;
      shotView.x = midX - center.cx - shotView.pinch.anchorX * nextScale;
      shotView.y = midY - center.cy - shotView.pinch.anchorY * nextScale;
      shotClamp();
      shotApply();
      return;
    }
    if (shotView.pan && shotView.pan.id === event.pointerId) {
      const dx = event.clientX - shotView.pan.startX;
      const dy = event.clientY - shotView.pan.startY;
      if (Math.hypot(dx, dy) > 6) shotView.pan.moved = true;
      if (shotView.scale > 1.001) {
        shotView.x = shotView.pan.startTx + dx;
        shotView.y = shotView.pan.startTy + dy;
        shotClamp();
        shotApply();
      }
    }
  }

  function onShotPointerEnd(event, cancelled) {
    if (!shotView.pointers.delete(event.pointerId)) return;
    try {
      els.shotFrame.releasePointerCapture(event.pointerId);
    } catch (error) {
      // Захват уже снят.
    }
    if (shotView.pointers.size === 1) {
      if (shotView.pinch) {
        const points = shotPointerPoints();
        const pointerId = Array.from(shotView.pointers.keys())[0];
        shotView.pinch = null;
        shotView.pan = {
          id: pointerId,
          startX: points[0].x,
          startY: points[0].y,
          startTx: shotView.x,
          startTy: shotView.y,
          moved: true,
          eligible: false,
          startedAt: Date.now(),
        };
      }
      return;
    }
    if (shotView.pointers.size > 0) return;
    const pan = shotView.pan;
    shotView.pinch = null;
    shotView.pan = null;
    if (
      !cancelled &&
      pan &&
      pan.id === event.pointerId &&
      pan.eligible &&
      !pan.moved &&
      Date.now() - pan.startedAt < 320
    ) {
      handleShotTap(event.clientX, event.clientY);
    }
    if (shotView.scale <= 1.02) {
      shotReset();
    } else {
      shotClamp();
      shotApply();
    }
  }

  function handleShotTap(x, y) {
    const now = Date.now();
    const doubleTap =
      now - shotView.lastTap < 360 &&
      Math.hypot(x - shotView.lastTapX, y - shotView.lastTapY) < 44;
    if (!doubleTap) {
      shotView.lastTap = now;
      shotView.lastTapX = x;
      shotView.lastTapY = y;
      return;
    }
    shotView.lastTap = 0;
    if (shotView.scale > 1.02) {
      shotReset();
    } else {
      shotZoomAt(SHOT_DOUBLE_TAP_SCALE, x, y);
    }
    vibrate(10);
  }

  function onShotWheel(event) {
    if (els.shotImage.hidden) return;
    event.preventDefault();
    const factor = Math.exp(-event.deltaY * 0.0015);
    shotZoomAt(shotView.scale * factor, event.clientX, event.clientY);
  }

  function onShotImageLoad() {
    if (!state.shotOpen) return;
    els.shotLoader.hidden = true;
    els.shotImage.hidden = false;
    els.shotZoomBar.hidden = false;
    shotReset();
  }

  function openScreenshot() {
    if (!sessionReady()) {
      showToast('Помощник сессии не запущен', 'error');
      return;
    }
    state.shotOpen = true;
    state.shotData = null;
    shotReset(false);
    els.shotImage.style.transform = '';
    els.shotImage.hidden = true;
    els.shotImage.removeAttribute('src');
    els.shotZoomBar.hidden = true;
    els.shotLoader.hidden = false;
    els.shotMeta.textContent = 'Делаю снимок…';
    els.shotBackdrop.hidden = false;
    els.shotModal.hidden = false;
    requestAnimationFrame(() => {
      els.shotBackdrop.classList.add('show');
      els.shotModal.classList.add('show');
    });
    loadScreenshot();
  }

  function closeScreenshot() {
    state.shotOpen = false;
    state.shotData = null;
    shotReset(false);
    els.shotZoomBar.hidden = true;
    els.shotBackdrop.classList.remove('show');
    els.shotModal.classList.remove('show');
    setTimeout(() => {
      if (!state.shotOpen) {
        els.shotBackdrop.hidden = true;
        els.shotModal.hidden = true;
      }
    }, 240);
  }

  async function loadScreenshot() {
    if (state.shotBusy) return;
    state.shotBusy = true;
    shotReset(false);
    els.shotImage.style.transform = '';
    els.shotImage.hidden = true;
    els.shotImage.removeAttribute('src');
    els.shotZoomBar.hidden = true;
    els.shotLoader.hidden = false;
    els.shotMeta.textContent = 'Делаю снимок…';
    renderShotButtons();
    try {
      const data = await apiRequest(state.settings, '/screenshot', 'GET', null, 30000);
      if (!data || !data.image) throw new Error('Снимок не получен');
      state.shotData = data;
      els.shotMeta.textContent =
        (data.dimensions || 'экран ПК') + (data.size ? ' · ' + formatBytes(data.size) : '');
      els.shotImage.src = 'data:' + (data.mime || 'image/png') + ';base64,' + data.image;
      vibrate(18);
    } catch (error) {
      els.shotMeta.textContent = error.message || 'Не удалось сделать снимок';
      els.shotLoader.hidden = true;
      els.shotZoomBar.hidden = true;
      showToast(error.message || 'Не удалось сделать снимок', 'error', 4500);
    } finally {
      state.shotBusy = false;
      renderShotButtons();
    }
  }

  function renderShotButtons() {
    if (!els.shotRefresh) return;
    els.shotRefresh.disabled = state.shotBusy;
    els.shotMonitorOff.disabled = state.shotBusy || !state.shotData;
  }

  async function refreshMonitorState(options = {}) {
    if (!sessionReady()) {
      state.monitor.known = false;
      renderMonitor();
      return null;
    }
    if (state.monitor.checking && !options.force) return null;
    state.monitor.checking = true;
    try {
      const data = await apiRequest(state.settings, '/monitor_state');
      state.monitor.known = true;
      state.monitor.on = Boolean(data.monitor_on);
      state.monitor.explicitOff = Boolean(data.explicit_off);
      state.monitor.idleSeconds = Number(data.idle_seconds) || 0;
      state.monitor.timeoutSeconds = Number(data.timeout_seconds) || 900;
      state.monitor.lastAt = Date.now();
      return data;
    } catch (error) {
      return null;
    } finally {
      state.monitor.checking = false;
      renderMonitor();
    }
  }

  function renderMonitor() {
    if (!els.monitorBtn) return;
    const off = state.monitor.known && !state.monitor.on;
    els.monitorSub.textContent = off ? 'Включить монитор' : 'Выключить монитор';
    els.monitorIconOn.hidden = off;
    els.monitorIconOff.hidden = !off;
    els.monitorBtn.classList.toggle('monitor-off', off);
    els.monitorBtn.disabled = !sessionReady() || state.monitor.busy;
    if (els.shotMonitorOff) {
      els.shotMonitorOff.textContent = off ? 'Включить монитор' : 'Выключить монитор';
    }
  }

  async function toggleMonitor() {
    if (state.monitor.busy) return;
    state.monitor.busy = true;
    renderMonitor();
    try {
      if (!state.monitor.known || Date.now() - state.monitor.lastAt > 12000) {
        await refreshMonitorState({ silent: true, force: true });
      }
      const turningOff = state.monitor.known ? state.monitor.on : true;
      const result = await command(
        turningOff ? '/monitor_off' : '/monitor_on',
        {},
        { timeout: 12000, silent: true }
      );
      if (result) {
        state.monitor.known = true;
        state.monitor.on = !turningOff;
        state.monitor.explicitOff = turningOff;
        state.monitor.lastAt = Date.now();
        showToast(turningOff ? 'Монитор выключен' : 'Монитор включён', '', 1800);
        vibrate(18);
        if (turningOff && state.shotOpen) setTimeout(closeScreenshot, 500);
        refreshMonitorState({ silent: true, force: true });
      }
    } finally {
      state.monitor.busy = false;
      renderMonitor();
    }
  }

  // ------------------------------------------------------------------
  // Программы
  // ------------------------------------------------------------------

  function openAppsSheet() {
    if (state.sheetOpen) showSheet(false);
    if (state.hotkeysOpen) closeHotkeysSheet();
    state.appsOpen = true;
    els.appsBackdrop.hidden = false;
    els.appsSheet.hidden = false;
    requestAnimationFrame(() => {
      els.appsBackdrop.classList.add('show');
      els.appsSheet.classList.add('show');
    });
    renderApps();
    if (!state.apps.length || Date.now() - state.appsLoadedAt > 60000) {
      loadApps(false);
    }
    setTimeout(() => {
      if (state.appsOpen) els.appsSearch.focus();
    }, 380);
  }

  function closeAppsSheet() {
    state.appsOpen = false;
    els.appsBackdrop.classList.remove('show');
    els.appsSheet.classList.remove('show');
    setTimeout(() => {
      if (!state.appsOpen) {
        els.appsBackdrop.hidden = true;
        els.appsSheet.hidden = true;
      }
    }, 340);
  }

  async function loadApps(force) {
    if (!state.online) {
      state.apps = [];
      state.appsError = 'ПК не в сети';
      renderApps();
      return;
    }
    const requestId = ++state.appsRequest;
    state.appsBusy = true;
    state.appsError = '';
    renderApps();
    const query = els.appsSearch.value.trim();
    const suffix =
      '?q=' +
      encodeURIComponent(query) +
      (force ? '&refresh=1' : '');
    try {
      const data = await apiRequest(state.settings, '/apps' + suffix, 'GET', null, 25000);
      if (requestId !== state.appsRequest) return;
      state.apps = Array.isArray(data.apps) ? data.apps : [];
      state.appsLoadedAt = Date.now();
    } catch (error) {
      if (requestId !== state.appsRequest) return;
      state.apps = [];
      state.appsError = error.message || 'Не удалось получить список программ';
    } finally {
      if (requestId === state.appsRequest) {
        state.appsBusy = false;
        renderApps();
      }
    }
  }

  function renderApps() {
    if (!els.appsList) return;
    if (state.appsBusy) {
      els.appsList.innerHTML = '<div class="apps-placeholder">Ищу программы на ПК…</div>';
      return;
    }
    if (state.appsError) {
      els.appsList.innerHTML =
        '<div class="apps-placeholder error">' + escapeHtml(state.appsError) + '</div>';
      return;
    }
    if (!state.apps.length) {
      els.appsList.innerHTML =
        '<div class="apps-placeholder">Ничего не найдено. Попробуйте другое название или обновите список.</div>';
      return;
    }
    els.appsList.innerHTML = state.apps
      .map((app) => {
        const name = String(app.name || '');
        const letter = name.trim().charAt(0).toUpperCase() || '•';
        const kind = app.kind === 'uwp' ? 'Приложение' : 'Программа';
        return (
          '<button class="app-item" type="button" data-app-id="' +
          escapeHtml(app.id || '') +
          '">' +
          '<span class="app-icon">' +
          escapeHtml(letter) +
          '</span>' +
          '<span class="app-text"><span class="app-name">' +
          escapeHtml(name) +
          '</span><span class="app-kind">' +
          kind +
          '</span></span>' +
          '<span class="app-open">›</span>' +
          '</button>'
        );
      })
      .join('');
  }

  async function launchApp(id) {
    const app = state.apps.find((item) => item.id === id);
    const result = await command('/launch', { id }, { timeout: 20000 });
    if (result) {
      if (app) showToast('Запускаю: ' + app.name);
      setTimeout(closeAppsSheet, 550);
    }
  }

  // ------------------------------------------------------------------
  // Горячие клавиши: интерфейс
  // ------------------------------------------------------------------

  function openHotkeysSheet() {
    if (state.sheetOpen) showSheet(false);
    if (state.appsOpen) closeAppsSheet();
    state.hotkeysOpen = true;
    els.hotkeysBackdrop.hidden = false;
    els.hotkeysSheet.hidden = false;
    requestAnimationFrame(() => {
      els.hotkeysBackdrop.classList.add('show');
      els.hotkeysSheet.classList.add('show');
    });
    resetHotkeyForm();
    renderHotkeys();
  }

  function closeHotkeysSheet() {
    state.hotkeysOpen = false;
    els.hotkeysBackdrop.classList.remove('show');
    els.hotkeysSheet.classList.remove('show');
    setTimeout(() => {
      if (!state.hotkeysOpen) {
        els.hotkeysBackdrop.hidden = true;
        els.hotkeysSheet.hidden = true;
      }
    }, 340);
  }

  function renderHotkeys() {
    if (!els.hotkeysList) return;
    if (!state.hotkeys.length) {
      els.hotkeysList.innerHTML =
        '<div class="apps-placeholder">Нет сохранённых сочетаний. Добавьте первое.</div>';
      return;
    }
    els.hotkeysList.innerHTML = state.hotkeys
      .map(
        (item) =>
          '<div class="hotkey-item" data-hotkey-id="' +
          escapeHtml(item.id) +
          '">' +
          '<button class="hotkey-run" type="button" data-hotkey-act="run">' +
          '<span class="hotkey-name">' +
          escapeHtml(item.name) +
          '</span>' +
          '<span class="hotkey-combo">' +
          escapeHtml(formatCombo(item.combo)) +
          '</span>' +
          '</button>' +
          '<button class="hotkey-mini" type="button" data-hotkey-act="edit" aria-label="Изменить">✎</button>' +
          '<button class="hotkey-mini danger" type="button" data-hotkey-act="del" aria-label="Удалить">✕</button>' +
          '</div>'
      )
      .join('');
  }

  function resetHotkeyForm() {
    state.editingHotkey = '';
    els.hotkeyName.value = '';
    els.hotkeyCombo.value = '';
    els.addHotkey.textContent = 'Добавить';
    els.cancelHotkeyEdit.hidden = true;
  }

  function editHotkey(id) {
    const item = state.hotkeys.find((hotkey) => hotkey.id === id);
    if (!item) return;
    state.editingHotkey = id;
    els.hotkeyName.value = item.name;
    els.hotkeyCombo.value = item.combo;
    els.addHotkey.textContent = 'Сохранить';
    els.cancelHotkeyEdit.hidden = false;
    els.hotkeyName.focus();
  }

  function saveHotkeyForm() {
    const name = els.hotkeyName.value.trim();
    const combo = normalizeCombo(els.hotkeyCombo.value);
    if (!name) {
      showToast('Введите название', 'error');
      els.hotkeyName.focus();
      return;
    }
    const comboError = validateCombo(combo);
    if (comboError) {
      showToast(comboError, 'error');
      els.hotkeyCombo.focus();
      return;
    }
    if (state.editingHotkey) {
      const item = state.hotkeys.find((hotkey) => hotkey.id === state.editingHotkey);
      if (item) {
        item.name = name;
        item.combo = combo;
      }
    } else {
      if (state.hotkeys.length >= 12) {
        showToast('Можно сохранить не больше 12 сочетаний', 'error');
        return;
      }
      state.hotkeys.push({ id: uid(), name, combo });
    }
    saveHotkeys();
    renderHotkeys();
    resetHotkeyForm();
    showToast('Сочетание сохранено');
  }

  async function runHotkey(id) {
    const item = state.hotkeys.find((hotkey) => hotkey.id === id);
    if (!item) return;
    await sendHotkey(item.combo);
  }

  // ------------------------------------------------------------------
  // Bluetooth Audio Receiver
  // ------------------------------------------------------------------

  async function refreshBt(manual, action = 'check') {
    if (!state.online) {
      state.bt.checked = false;
      state.bt.error = '';
      renderBt();
      return;
    }
    if (state.bt.loading) return;
    state.bt.loading = true;
    renderBt();
    try {
      const data = await apiRequest(
        state.settings,
        '/bt',
        'POST',
        { action },
        40000
      );
      state.bt.checked = true;
      state.bt.running = Boolean(data.running);
      state.bt.state = String(data.state || '');
      state.bt.openEnabled = Boolean(data.openEnabled);
      state.bt.closeEnabled = Boolean(data.closeEnabled);
      state.bt.error = '';
      state.bt.lastAt = Date.now();
      if (manual) {
        showToast('Проверено', '', 1600);
        vibrate(15);
      }
    } catch (error) {
      state.bt.checked = false;
      state.bt.running = false;
      state.bt.state = '';
      state.bt.openEnabled = false;
      state.bt.closeEnabled = false;
      state.bt.error = error.message || 'Не удалось получить состояние';
      if (manual) showToast(state.bt.error, 'error', 4500);
    } finally {
      state.bt.loading = false;
      renderBt();
    }
  }

  async function btAction(action) {
    if (!state.online) {
      showToast('ПК не в сети', 'error');
      return;
    }
    if (state.bt.loading) return;
    state.bt.loading = true;
    renderBt();
    try {
      const data = await apiRequest(
        state.settings,
        '/bt',
        'POST',
        { action },
        45000
      );
      vibrate(25);
      showToast(data.message || (action === 'open' ? 'Соединение открыто' : 'Соединение закрыто'), '', 3200);
      state.bt.loading = false;
      await refreshBt(false, 'status');
    } catch (error) {
      state.bt.loading = false;
      renderBt();
      showToast(error.message || 'Bluetooth-команда не выполнена', 'error', 5000);
    }
  }

  function formatBtState(raw) {
    const text = String(raw || '').trim();
    const match = text.match(/^\[([^\]]+)\]\s*(.+)$/);
    if (match) {
      const device = match[1].trim();
      const status = match[2].trim();
      if (/^connected$/i.test(status)) return 'Подключено: ' + device;
      if (/^disconnected$/i.test(status)) return 'Не подключено: ' + device;
      return device + ': ' + status;
    }
    if (/^connected$/i.test(text)) return 'Подключено';
    if (/^disconnected$/i.test(text)) return 'Не подключено';
    return text;
  }

  function renderBt() {
    if (!els.btState) return;
    const bt = state.bt;
    let text;
    let className = 'bt-state';

    if (!state.online) {
      text = 'ПК не в сети';
      className += ' off';
    } else if (!sessionReady()) {
      text = 'Помощник сессии не запущен';
      className += ' off';
    } else if (bt.loading) {
      text = 'Проверяю…';
      className += ' checking';
    } else if (bt.error) {
      text = bt.error;
      className += ' error';
    } else if (!bt.checked) {
      text = 'Нажмите «Проверить»';
      className += ' off';
    } else if (!bt.running) {
      text = 'Приложение не запущено';
      className += ' off';
    } else if (!bt.state) {
      text = 'Приложение запущено';
      className += ' off';
    } else {
      const raw = bt.state;
      text = formatBtState(raw);
      const connected = /connected|подключ/i.test(raw) && !/disconnected|отключ/i.test(raw);
      className += connected ? ' connected' : '';
    }

    els.btState.textContent = text;
    els.btState.className = className;
    els.btRefresh.classList.toggle('spinning', bt.loading);
    els.btRefresh.disabled = bt.loading || !state.online;

    if (els.btCheckedAt) {
      if (bt.lastAt) {
        const time = new Date(bt.lastAt).toLocaleTimeString('ru-RU', {
          hour: '2-digit',
          minute: '2-digit',
        });
        els.btCheckedAt.textContent =
          (bt.error ? 'Последняя успешная проверка в ' : 'Проверено в ') + time;
        els.btCheckedAt.hidden = false;
      } else {
        els.btCheckedAt.hidden = true;
      }
    }

    const busy = bt.loading || !state.online || !sessionReady() || Boolean(bt.error);
    const openAllowed = busy ? false : !bt.running || bt.openEnabled;
    const closeAllowed = busy
      ? false
      : bt.running &&
        (bt.closeEnabled ||
          (/connected|подключ/i.test(bt.state) && !/disconnected|отключ/i.test(bt.state)));
    els.btOpen.disabled = !openAllowed;
    els.btClose.disabled = !closeAllowed;
  }

  // ------------------------------------------------------------------
  // OTA-обновления
  // ------------------------------------------------------------------

  function loadUpdateCheckTime() {
    try {
      const raw = localStorage.getItem(UPDATE_KEY);
      if (!raw) return 0;
      const parsed = JSON.parse(raw);
      return Number(parsed.checkedAt) || 0;
    } catch (error) {
      return 0;
    }
  }

  function saveUpdateCheckTime() {
    try {
      localStorage.setItem(UPDATE_KEY, JSON.stringify({ checkedAt: Date.now() }));
    } catch (error) {
      // Не критично.
    }
  }

  function renderUpdate() {
    if (!els.updateStatus) return;
    const update = state.update;
    els.currentVersion.textContent = state.currentVersion;
    let text;
    if (!hasNativeBridge) {
      text = 'Обновления доступны только в приложении';
    } else if (update.downloading) {
      text = 'Скачиваю APK и открываю установщик…';
    } else if (update.checking) {
      text = 'Проверяю GitHub…';
    } else if (update.error) {
      text = update.error;
    } else if (update.available && update.info) {
      text = 'Доступна версия ' + (update.info.versionName || 'новее');
      if (update.info.notes) text += ' · ' + update.info.notes;
    } else if (update.checked) {
      text = 'У вас последняя версия';
    } else {
      text = 'Проверка выполняется автоматически при запуске';
    }
    els.updateStatus.textContent = text;
    els.updateStatus.classList.toggle('error', Boolean(update.error));
    els.installUpdateBtn.hidden = !update.available;
    els.installUpdateBtn.disabled = update.downloading;
    els.checkUpdatesBtn.disabled = update.checking || update.downloading;

    els.updateBanner.hidden = !update.available;
    if (update.available && update.info) {
      els.updateBannerTitle.textContent =
        'Доступно обновление ' + (update.info.versionName || '');
    }
  }

  async function checkUpdates(manual) {
    if (!hasNativeBridge) {
      if (manual) showToast('Обновления доступны только в приложении', 'error');
      return;
    }
    if (state.update.checking || state.update.downloading) return;
    state.update.checking = true;
    state.update.error = '';
    renderUpdate();
    try {
      const info = await updateRequest();
      state.update.checked = true;
      state.update.available = Boolean(info.available);
      state.update.info = info.available ? info : null;
      saveUpdateCheckTime();
      if (manual) {
        if (info.available) {
          showToast('Доступно обновление ' + (info.versionName || ''), '', 3500);
        } else {
          showToast('У вас последняя версия ' + (info.currentVersionName || state.currentVersion));
        }
      }
    } catch (error) {
      state.update.error = error.message || 'Не удалось проверить обновления';
      if (manual) showToast(state.update.error, 'error', 4500);
    } finally {
      state.update.checking = false;
      renderUpdate();
    }
  }

  async function installUpdate() {
    if (!state.update.available || !state.update.info) {
      showToast('Сначала проверьте обновления', 'error');
      return;
    }
    if (state.update.downloading) return;
    state.update.downloading = true;
    state.update.error = '';
    renderUpdate();
    try {
      const message = await downloadRequest(state.update.info.versionName || '');
      showToast(message || 'Установщик открыт', '', 4500);
    } catch (error) {
      state.update.error = error.message || 'Не удалось скачать обновление';
      showToast(state.update.error, 'error', 6000);
    } finally {
      state.update.downloading = false;
      renderUpdate();
    }
  }

  // ------------------------------------------------------------------
  // Настройки: открытие, поиск, сохранение
  // ------------------------------------------------------------------

  function openSettings() {
    fillSettingsForm(state.settings);
    els.discoverResults.innerHTML = '';
    updateNetworkNote();
    renderUpdate();
    showSheet(true);
  }

  function fillSettingsForm(settings) {
    els.ipInput.value = settings.ip || '';
    els.macInput.value = settings.mac || '';
    els.portInput.value = settings.port || 8765;
    els.tokenInput.value = settings.token || '';
  }

  function trapSheetFocus(event) {
    if (event.key !== 'Tab') return;
    const focusables = Array.from(
      els.settingsSheet.querySelectorAll(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'
      )
    ).filter((element) => !element.hidden && element.offsetParent !== null);
    if (!focusables.length) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function showSheet(open) {
    state.sheetOpen = open;
    if (open) {
      els.sheetBackdrop.hidden = false;
      els.settingsSheet.hidden = false;
      requestAnimationFrame(() => {
        els.sheetBackdrop.classList.add('show');
        els.settingsSheet.classList.add('show');
      });
      els.closeSettings.focus({ preventScroll: true });
    } else {
      els.sheetBackdrop.classList.remove('show');
      els.settingsSheet.classList.remove('show');
      setTimeout(() => {
        if (!state.sheetOpen) {
          els.sheetBackdrop.hidden = true;
          els.settingsSheet.hidden = true;
          if (!state.appsOpen && !state.hotkeysOpen) {
            els.settingsBtn.focus({ preventScroll: true });
          }
        }
      }, 340);
    }
  }

  function saveSettingsFromForm() {
    const ip = els.ipInput.value.trim();
    const macRaw = els.macInput.value.trim();
    const mac = macRaw ? normalizeMac(macRaw) : '';
    const port = Number(els.portInput.value.trim());
    const token = els.tokenInput.value.trim();

    if (!isValidIp(ip)) {
      showToast('Проверьте IP-адрес', 'error');
      els.ipInput.focus();
      return;
    }
    if (macRaw && !mac) {
      showToast('Проверьте MAC-адрес', 'error');
      els.macInput.focus();
      return;
    }
    if (!Number.isFinite(port) || port < 1 || port > 65535) {
      showToast('Проверьте порт', 'error');
      els.portInput.focus();
      return;
    }
    if (!token) {
      showToast('Введите токен доступа', 'error');
      els.tokenInput.focus();
      return;
    }

    saveSettings({ ip, mac, port, token, name: state.settings.name || '' });
    stopBootWatch();
    state.lastError = '';
    showSheet(false);
    showToast('Настройки сохранены');
    refreshStatus();
  }

  async function testConnection() {
    const candidate = {
      ip: els.ipInput.value.trim(),
      port: Number(els.portInput.value.trim()) || 8765,
      token: els.tokenInput.value.trim(),
    };
    if (!isValidIp(candidate.ip) || !candidate.token) {
      showToast('Введите IP и токен', 'error');
      return;
    }

    els.testBtn.disabled = true;
    els.testBtn.textContent = 'Проверяю…';
    try {
      const data = await apiRequest(candidate, '/status');
      showToast('Связь есть: ' + (data.hostname || candidate.ip));
      if (!els.macInput.value.trim() && data.mac) {
        els.macInput.value = normalizeMac(data.mac) || data.mac;
      }
    } catch (error) {
      showToast(error.message || 'ПК не отвечает', 'error', 4500);
    } finally {
      els.testBtn.disabled = false;
      els.testBtn.textContent = 'Проверить подключение';
    }
  }

  async function discover() {
    if (!hasNativeBridge) {
      showToast('Поиск работает только в приложении', 'error');
      return;
    }

    els.discoverBtn.disabled = true;
    const original = els.discoverBtn.innerHTML;
    els.discoverBtn.textContent = 'Ищу ПК в сети…';
    els.discoverResults.innerHTML = '';

    try {
      const found = await discoverRequest();
      if (!Array.isArray(found) || found.length === 0) {
        els.discoverResults.innerHTML =
          '<p class="discover-empty">ПК не найден. Проверьте, что агент запущен на компьютере, и повторите поиск.</p>';
        return;
      }

      found.forEach((item, index) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'discover-item';
        const name = item.name || 'ПК';
        const ip = item.ip || '';
        button.innerHTML =
          '<span class="discover-name">' +
          escapeHtml(name) +
          '</span><span class="discover-ip">' +
          escapeHtml(ip) +
          '</span>';
        button.addEventListener('click', () => {
          els.ipInput.value = ip;
          if (item.mac) els.macInput.value = normalizeMac(item.mac) || item.mac;
          if (item.port) els.portInput.value = item.port;
          state.settings.name = name;
          els.discoverResults
            .querySelectorAll('.discover-item')
            .forEach((element) => element.classList.remove('selected'));
          button.classList.add('selected');
          showToast('Выбран ' + name);
        });
        els.discoverResults.appendChild(button);
        if (index === 0) button.click();
      });
    } catch (error) {
      els.discoverResults.innerHTML =
        '<p class="discover-empty">' +
        escapeHtml(error.message || 'Не удалось выполнить поиск') +
        '</p>';
    } finally {
      els.discoverBtn.disabled = false;
      els.discoverBtn.innerHTML = original;
    }
  }

  // ------------------------------------------------------------------
  // Вспомогательное
  // ------------------------------------------------------------------

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (character) => {
      switch (character) {
        case '&':
          return '&amp;';
        case '<':
          return '&lt;';
        case '>':
          return '&gt;';
        case '"':
          return '&quot;';
        default:
          return '&#39;';
      }
    });
  }

  function showToast(message, type = '', duration = 3000) {
    if (!els.toast) return;
    els.toast.textContent = message;
    els.toast.className = 'toast show' + (type === 'error' ? ' error' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      els.toast.className = 'toast';
    }, duration);
  }

  function vibrate(milliseconds) {
    try {
      Bridge.vibrate(milliseconds);
    } catch (error) {
      // Вибрация не критична.
    }
  }

  // ------------------------------------------------------------------
  // Инициализация
  // ------------------------------------------------------------------

  function cacheElements() {
    const ids = [
      'statusDot',
      'statusText',
      'refreshBtn',
      'pcName',
      'pcMeta',
      'pcBadge',
      'netHint',
      'sessionHint',
      'powerBtn',
      'powerLabel',
      'powerHint',
      'shutdownStatus',
      'shutdownStatusText',
      'settingsBtn',
      'sheetBackdrop',
      'settingsSheet',
      'closeSettings',
      'discoverBtn',
      'discoverResults',
      'ipInput',
      'macInput',
      'portInput',
      'tokenInput',
      'testBtn',
      'networkNote',
      'saveSettings',
      'modalBackdrop',
      'confirmModal',
      'confirmIcon',
      'confirmTitle',
      'confirmText',
      'shutdownTimer',
      'shutdownMinutes',
      'shutdownTimerNote',
      'cancelConfirm',
      'okConfirm',
      'toast',
      'appVersion',
      'screenshotBtn',
      'monitorBtn',
      'monitorSub',
      'monitorIconOn',
      'monitorIconOff',
      'appsBtn',
      'hotkeysBtn',
      'muteBtn',
      'btState',
      'btCheckedAt',
      'btRefresh',
      'btOpen',
      'btClose',
      'shotBackdrop',
      'shotModal',
      'shotImage',
      'shotLoader',
      'shotMeta',
      'shotClose',
      'shotRefresh',
      'shotMonitorOff',
      'shotFrame',
      'shotZoomBar',
      'shotZoomOut',
      'shotZoomIn',
      'shotZoomReset',
      'shotZoomLevel',
      'appsBackdrop',
      'appsSheet',
      'closeApps',
      'appsSearch',
      'appsRefresh',
      'appsList',
      'hotkeysBackdrop',
      'hotkeysSheet',
      'closeHotkeys',
      'hotkeyName',
      'hotkeyCombo',
      'addHotkey',
      'cancelHotkeyEdit',
      'resetHotkeys',
      'hotkeysList',
      'updateBanner',
      'updateBannerTitle',
      'currentVersion',
      'updateStatus',
      'checkUpdatesBtn',
      'installUpdateBtn',
      'updateBox',
    ];
    ids.forEach((id) => {
      els[id] = document.getElementById(id);
    });
  }

  function bindEvents() {
    els.settingsBtn.addEventListener('click', openSettings);
    els.closeSettings.addEventListener('click', () => showSheet(false));
    els.sheetBackdrop.addEventListener('click', () => showSheet(false));
    els.settingsSheet.addEventListener('keydown', trapSheetFocus);
    els.saveSettings.addEventListener('click', saveSettingsFromForm);
    els.testBtn.addEventListener('click', testConnection);
    els.discoverBtn.addEventListener('click', discover);
    els.refreshBtn.addEventListener('click', () => refreshStatus());
    els.powerBtn.addEventListener('click', handlePower);
    els.cancelConfirm.addEventListener('click', hideConfirm);
    els.modalBackdrop.addEventListener('click', hideConfirm);
    els.okConfirm.addEventListener('click', () => {
      const action = state.pendingAction;
      hideConfirm();
      if (action) runAction(action);
    });

    document.querySelectorAll('[data-action]').forEach((button) => {
      button.addEventListener('click', () => {
        const action = button.dataset.action;
        if (action === 'lock') {
          runAction('lock');
          return;
        }
        openConfirm(action);
      });
    });

    document.querySelectorAll('[data-volume]').forEach((button) => {
      button.addEventListener('click', () => sendVolume(Number(button.dataset.volume) || 1));
    });
    document.querySelectorAll('[data-media]').forEach((button) => {
      button.addEventListener('click', () => sendMedia(button.dataset.media));
    });
    els.muteBtn.addEventListener('click', toggleMute);

    els.screenshotBtn.addEventListener('click', openScreenshot);
    els.monitorBtn.addEventListener('click', toggleMonitor);
    els.appsBtn.addEventListener('click', openAppsSheet);
    els.hotkeysBtn.addEventListener('click', openHotkeysSheet);

    els.shotClose.addEventListener('click', closeScreenshot);
    els.shotBackdrop.addEventListener('click', closeScreenshot);
    els.shotRefresh.addEventListener('click', loadScreenshot);
    els.shotMonitorOff.addEventListener('click', toggleMonitor);
    els.shotFrame.addEventListener('pointerdown', onShotPointerDown);
    els.shotFrame.addEventListener('pointermove', onShotPointerMove);
    els.shotFrame.addEventListener('pointerup', (event) => onShotPointerEnd(event, false));
    els.shotFrame.addEventListener('pointercancel', (event) => onShotPointerEnd(event, true));
    els.shotFrame.addEventListener('wheel', onShotWheel, { passive: false });
    els.shotImage.addEventListener('load', onShotImageLoad);
    els.shotImage.addEventListener('error', () => {
      if (!state.shotOpen) return;
      els.shotLoader.hidden = true;
      els.shotZoomBar.hidden = true;
      els.shotMeta.textContent = 'Не удалось показать снимок';
    });
    els.shotZoomIn.addEventListener('click', () => {
      shotZoomCenter(1.5);
      vibrate(8);
    });
    els.shotZoomOut.addEventListener('click', () => {
      shotZoomCenter(1 / 1.5);
      vibrate(8);
    });
    els.shotZoomReset.addEventListener('click', () => {
      shotReset();
      vibrate(8);
    });

    els.shutdownStatus.addEventListener('click', () => openConfirm('abort'));
    document.querySelectorAll('[data-delay]').forEach((button) => {
      button.addEventListener('click', () => {
        selectShutdownDelay(Number(button.dataset.delay) || 0);
        vibrate(8);
      });
    });
    els.shutdownMinutes.addEventListener('input', () => {
      const minutes = Math.max(0, Math.min(1440, Math.floor(Number(els.shutdownMinutes.value) || 0)));
      state.shutdownChoice = minutes * 60;
      document.querySelectorAll('[data-delay]').forEach((button) => {
        button.classList.remove('is-active');
      });
      updateShutdownConfirm();
    });
    els.shutdownMinutes.addEventListener('blur', () => {
      if (!els.shutdownMinutes.value) return;
      const minutes = Math.max(1, Math.min(1440, Math.floor(Number(els.shutdownMinutes.value) || 1)));
      els.shutdownMinutes.value = String(minutes);
      state.shutdownChoice = minutes * 60;
      updateShutdownConfirm();
    });

    els.closeApps.addEventListener('click', closeAppsSheet);
    els.appsBackdrop.addEventListener('click', closeAppsSheet);
    els.appsRefresh.addEventListener('click', () => loadApps(true));
    els.appsSearch.addEventListener('input', () => {
      clearTimeout(appsSearchTimer);
      appsSearchTimer = setTimeout(() => loadApps(false), 320);
    });
    els.appsSearch.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        loadApps(false);
      }
    });
    els.appsList.addEventListener('click', (event) => {
      const item = event.target.closest('[data-app-id]');
      if (item) launchApp(item.dataset.appId);
    });

    els.closeHotkeys.addEventListener('click', closeHotkeysSheet);
    els.hotkeysBackdrop.addEventListener('click', closeHotkeysSheet);
    els.addHotkey.addEventListener('click', saveHotkeyForm);
    els.cancelHotkeyEdit.addEventListener('click', resetHotkeyForm);
    els.resetHotkeys.addEventListener('click', () => {
      state.hotkeys = DEFAULT_HOTKEYS.map((item) => ({ ...item }));
      saveHotkeys();
      renderHotkeys();
      resetHotkeyForm();
      showToast('Список сочетаний восстановлен');
    });
    els.hotkeysList.addEventListener('click', (event) => {
      const item = event.target.closest('[data-hotkey-id]');
      if (!item) return;
      const id = item.dataset.hotkeyId;
      const actionButton = event.target.closest('[data-hotkey-act]');
      const action = actionButton ? actionButton.dataset.hotkeyAct : 'run';
      if (action === 'edit') editHotkey(id);
      else if (action === 'del') {
        state.hotkeys = state.hotkeys.filter((hotkey) => hotkey.id !== id);
        saveHotkeys();
        renderHotkeys();
        if (state.editingHotkey === id) resetHotkeyForm();
        showToast('Сочетание удалено');
      } else {
        runHotkey(id);
      }
    });
    els.hotkeyCombo.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        saveHotkeyForm();
      }
    });

    els.btRefresh.addEventListener('click', () => refreshBt(true));
    els.btOpen.addEventListener('click', () => btAction('open'));
    els.btClose.addEventListener('click', () => btAction('close'));

    els.updateBanner.addEventListener('click', () => {
      openSettings();
      setTimeout(() => {
        if (els.updateBox) els.updateBox.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }, 400);
    });
    els.checkUpdatesBtn.addEventListener('click', () => checkUpdates(true));
    els.installUpdateBtn.addEventListener('click', installUpdate);

    [els.ipInput, els.macInput, els.portInput, els.tokenInput].forEach((input) => {
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          saveSettingsFromForm();
        }
      });
    });

    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && state.appVisible && state.settings.ip && state.settings.token) {
        refreshStatus({ silent: true });
        refreshMonitorState({ silent: true });
      }
    });
  }

  window.__onAppResume = () => {
    state.appVisible = true;
    refreshNetworkInfo();
    if (state.settings.ip && state.settings.token) {
      refreshStatus({ silent: true });
      refreshMonitorState({ silent: true });
    }
  };

  window.__onAppPause = () => {
    state.appVisible = false;
  };

  window.__androidBack = () => {
    if (state.shotOpen) {
      closeScreenshot();
      return true;
    }
    if (state.confirmOpen) {
      hideConfirm();
      return true;
    }
    if (state.appsOpen) {
      closeAppsSheet();
      return true;
    }
    if (state.hotkeysOpen) {
      closeHotkeysSheet();
      return true;
    }
    if (state.sheetOpen) {
      showSheet(false);
      return true;
    }
    return false;
  };

  function init() {
    cacheElements();
    bindEvents();
    refreshNetworkInfo();
    renderShutdownTimer();

    try {
      state.currentVersion = Bridge.getVersion() || '1.1.4';
      state.currentVersionCode = Number(Bridge.getVersionCode() || 0) || 0;
      els.appVersion.textContent = state.currentVersion;
    } catch (error) {
      // Версия не критична.
    }
    renderUpdate();

    if (state.settings.ip && state.settings.token) {
      refreshStatus();
    } else {
      render();
      setTimeout(openSettings, 450);
    }

    state.pollTimer = setInterval(() => {
      if (!state.appVisible || document.hidden || state.busy) return;
      refreshStatus({ silent: true });
      refreshMonitorState({ silent: true });
    }, 10000);

    setInterval(() => {
      if (!state.shutdown.at) return;
      if (state.shutdown.at <= Date.now()) {
        state.shutdown = { at: 0, seconds: 0 };
        saveShutdown();
        renderShutdownTimer();
        return;
      }
      renderShutdownTimer();
    }, 1000);

    if (hasNativeBridge && Date.now() - loadUpdateCheckTime() > 6 * 60 * 60 * 1000) {
      setTimeout(() => checkUpdates(false), 2200);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
