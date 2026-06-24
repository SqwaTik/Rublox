// Мост между сервером и плагином Roblox Studio.
//
// Плагин не может принимать входящие соединения, поэтому общение построено
// на long-poll: плагин периодически спрашивает "есть ли команды?", выполняет
// их и присылает результат. Сервер ставит команды в очередь и ждёт ответа
// через Promise.

import { randomUUID } from 'node:crypto';
import { bundledPluginVersion } from './plugin-installer.js';

// Версия плагина, ожидаемая этой сборкой (= версия приложения). Если плагин в
// Studio старее — UI подскажет переустановить. cmp: >0 если a новее b.
function cmpVer(a, b) {
  const pa = String(a || '0').replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b || '0').replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0); }
  return 0;
}

class RobloxBridge {
  constructor() {
    this.connected = false;
    this.lastSeen = 0;
    this.studioInfo = null; // { placeName, studioMode, ... }
    this.queue = []; // ожидающие отправки команды
    this.pending = new Map(); // id -> { resolve, reject, timer }
    this.consoleBuffer = []; // зеркало консоли Studio (если плагин шлёт)
    this.waiters = []; // ресолверы long-poll, ждущие команду
  }

  // Колбэк, вызываемый при смене состояния подключения (для мгновенного
  // broadcast статуса в веб-клиент без ожидания периодического таймера).
  onChange = null;

  isConnected() {
    // Окно 40с: long-poll плагина висит до 25с, между поллами бывает пауза,
    // поэтому окно должно быть заметно больше периода опроса — иначе статус
    // «мигает» (то подключён, то нет).
    return this.connected && Date.now() - this.lastSeen < 40000;
  }

  markConnected(info) {
    const wasConnected = this.isConnected();
    const oldPlace = this.studioInfo && this.studioInfo.placeName;
    this.connected = true;
    this.lastSeen = Date.now();
    if (info) this.studioInfo = { ...this.studioInfo, ...info };
    const newPlace = this.studioInfo && this.studioInfo.placeName;
    // Только что подключились или впервые узнали имя плейса → уведомляем UI.
    if ((!wasConnected || oldPlace !== newPlace) && this.onChange) this.onChange();
  }

  markDisconnected() {
    this.connected = false;
    // Отменяем все ожидающие команды.
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error('Roblox Studio отключён'));
    }
    this.pending.clear();
    this.queue = [];
    if (this.onChange) this.onChange();
  }

  // Вызывается агентом: поставить команду и дождаться результата от плагина.
  dispatch(tool, args, timeoutMs = 30000) {
    if (!this.isConnected()) {
      return Promise.reject(new Error('Плагин Roblox не подключён (/connect в Studio)'));
    }
    const id = randomUUID();
    const command = { id, tool, args: args || {} };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Таймаут выполнения команды ${tool}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.queue.push(command);
      this._flushWaiters();
    });
  }

  // Long-poll со стороны плагина: отдать накопленные команды.
  // Если очередь пуста — держим запрос до timeoutMs, потом отдаём [].
  poll(timeoutMs = 25000) {
    this.markConnected();
    if (this.queue.length) {
      const cmds = this.queue.splice(0, this.queue.length);
      return Promise.resolve(cmds);
    }
    return new Promise((resolve) => {
      const waiter = {
        resolve,
        timer: setTimeout(() => {
          this.waiters = this.waiters.filter((w) => w !== waiter);
          resolve([]);
        }, timeoutMs),
      };
      this.waiters.push(waiter);
    });
  }

  _flushWaiters() {
    if (!this.waiters.length || !this.queue.length) return;
    const cmds = this.queue.splice(0, this.queue.length);
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) {
      clearTimeout(w.timer);
      w.resolve(cmds);
    }
  }

  // Плагин присылает результат выполнения команды.
  resolveResult(id, result, error) {
    const p = this.pending.get(id);
    if (!p) return false;
    clearTimeout(p.timer);
    this.pending.delete(id);
    if (error) p.reject(new Error(error));
    else p.resolve(result);
    return true;
  }

  pushConsole(lines) {
    if (!Array.isArray(lines)) return;
    this.consoleBuffer.push(...lines);
    if (this.consoleBuffer.length > 500)
      this.consoleBuffer = this.consoleBuffer.slice(-500);
  }

  status() {
    const pv = this.studioInfo && this.studioInfo.pluginVersion;
    const latest = bundledPluginVersion(); // версия плагина в этой сборке
    return {
      connected: this.isConnected(),
      lastSeen: this.lastSeen,
      studioInfo: this.studioInfo,
      queued: this.queue.length,
      pending: this.pending.size,
      pluginVersion: pv || null,
      pluginLatest: latest,
      // Устарел только если подключён, прислал версию и бандл реально новее.
      pluginOutdated: !!(this.isConnected() && pv && cmpVer(latest, pv) > 0),
    };
  }
}

export const bridge = new RobloxBridge();
