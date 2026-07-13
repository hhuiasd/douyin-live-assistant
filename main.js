/**
 * Douyin Live Assistant (抖音场控助手)
 * Copyright (C) 2025
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, dialog, session, protocol } = require('electron');
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const WebSocket = require('ws');

// 兜底：异常退出时强制杀掉弹幕服务进程
process.on('uncaughtException', () => {
  if (barrageProcess) {
    try { execSync(`taskkill /F /PID ${barrageProcess.pid} /T`, { stdio: 'ignore' }); } catch (e) {}
    barrageProcess = null;
  }
});

// ==================== 全局状态 ====================
let mainWindow = null;
let douyinWindow = null; // 抖音浏览器窗口
let tray = null;
let barrageProcess = null;
let wsClient = null;

// 风控状态
const riskState = {
  sendCount: 0,
  hourSendCount: 0,
  lastSendTime: 0,
  consecutiveFailures: 0,
  circuitBroken: false,
  welcomeTracker: {},
  hourlyResetTimer: null,
};

// 配置
let ruleConfig = {};
let runtimeConfig = {};
let debugMode = false;

// ==================== 配置加载 ====================
function loadConfig() {
  try {
    ruleConfig = JSON.parse(fs.readFileSync(path.join(__dirname, 'config', 'rule.json'), 'utf-8'));
    runtimeConfig = JSON.parse(fs.readFileSync(path.join(__dirname, 'config', 'runtime.json'), 'utf-8'));
    console.log('[配置] 加载完成');
  } catch (e) {
    console.error('[配置] 加载失败:', e.message);
    ruleConfig = { welcome: { enabled: false, templates: [] }, keyword: { enabled: false, rules: [] }, gift: { enabled: false, templates: [] }, warmup: { enabled: false, templates: [], intervalMinutes: 3 } };
    runtimeConfig = { roomId: '', webRoomId: '', headless: false, features: { welcome: true, keyword: true, gift: true, warmup: true }, riskControl: { globalMaxPerHour: 30, sendIntervalMin: 1000, sendIntervalMax: 3000, circuitBreakerThreshold: 3, welcomeCooldownMinutes: 5 }, chromePath: '', autoReplyDelay: 500 };
  }
}

function saveRuleConfig() {
  try {
    fs.writeFileSync(path.join(__dirname, 'config', 'rule.json'), JSON.stringify(ruleConfig, null, 2), 'utf-8');
  } catch (e) {
    console.error('[配置] 保存失败:', e.message);
  }
}

function saveRuntimeConfig() {
  try {
    fs.writeFileSync(path.join(__dirname, 'config', 'runtime.json'), JSON.stringify(runtimeConfig, null, 2), 'utf-8');
  } catch (e) {
    console.error('[配置] 保存失败:', e.message);
  }
}

// ==================== 日志系统 ====================
function logToRenderer(level, message) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('app-log', { level, message, time: new Date().toLocaleTimeString() });
  }
}

// ==================== 弹幕服务管理 ====================
function startBarrageService() {
  const exePath = path.join(__dirname, 'tools', 'WssBarrageServer.exe');
  if (!fs.existsSync(exePath)) {
    logToRenderer('error', `弹幕服务不存在: ${exePath}`);
    return;
  }

  barrageProcess = spawn(exePath, [], {
    cwd: path.join(__dirname, 'tools'),
    windowsHide: true,
    detached: false,
  });

  barrageProcess.stdout.on('data', (data) => {
    const msg = data.toString().trim();
    if (msg) console.log('[弹幕服务]', msg);
  });

  barrageProcess.stderr.on('data', (data) => {
    const msg = data.toString().trim();
    if (msg) console.error('[弹幕服务错误]', msg);
  });

  barrageProcess.on('error', (err) => {
    logToRenderer('error', `弹幕服务启动失败: ${err.message}`);
  });

  barrageProcess.on('exit', (code) => {
    logToRenderer('warn', `弹幕服务已退出，代码: ${code}`);
    barrageProcess = null;
  });

  logToRenderer('info', '弹幕服务已启动');
  setTimeout(connectWebSocket, 2000);
}

function stopBarrageService() {
  if (barrageProcess) {
    try { barrageProcess.kill(); } catch (e) {}
    if (process.platform === 'win32') {
      try { execSync(`taskkill /F /PID ${barrageProcess.pid} /T`, { stdio: 'ignore' }); } catch (e) {}
    }
    barrageProcess = null;
  }
  if (wsClient) {
    try { wsClient.close(); } catch (e) {}
    wsClient = null;
  }
}

function connectWebSocket() {
  if (wsClient && wsClient.readyState === WebSocket.OPEN) return;

  wsClient = new WebSocket('ws://127.0.0.1:8888');

  wsClient.on('open', () => {
    logToRenderer('info', 'WebSocket 已连接弹幕服务');
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('ws-status', 'connected');
    }
  });

  wsClient.on('message', (data) => {
    try {
      const raw = JSON.parse(data.toString());
      let msg = raw;
      if (raw.Data && typeof raw.Data === 'string') {
        try { msg = JSON.parse(raw.Data); } catch (e) {}
      }
      if (raw.Type !== undefined) msg._rawType = raw.Type;
      handleBarrageEvent(msg);
    } catch (e) {
      console.error('[WebSocket] 解析失败:', e.message);
    }
  });

  wsClient.on('close', () => {
    logToRenderer('warn', 'WebSocket 断开，3秒后重连...');
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('ws-status', 'disconnected');
    }
    setTimeout(connectWebSocket, 3000);
  });

  wsClient.on('error', (err) => {
    console.error('[WebSocket] 错误:', err.message);
  });
}

// ==================== 弹幕事件处理 ====================
function handleBarrageEvent(msg) {
  if (debugMode && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('raw-message', msg);
  }

  // 按直播间 ID 过滤
  const targetRoomId = runtimeConfig.webRoomId;
  if (targetRoomId) {
    const msgRoomId = msg.WebRoomId || msg.RoomId || '';
    if (msgRoomId && String(msgRoomId) !== String(targetRoomId)) {
      return;
    }
  }

  if (!riskState.circuitBroken && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('barrage-message', msg);
  }

  if (riskState.circuitBroken) return;

  const eventType = detectEventType(msg);
  switch (eventType) {
    case 'enter': handleEnterEvent(msg); break;
    case 'barrage': handleBarrageMsg(msg); break;
    case 'gift': handleGiftEvent(msg); break;
    case 'follow': handleFollowEvent(msg); break;
  }
}

function detectEventType(msg) {
  if (msg.EnterTipType !== undefined || (msg.Content && msg.Content.includes('$来了'))) return 'enter';
  if (msg.GiftType !== undefined || (msg.Content && msg.Content.includes('$送了'))) return 'gift';
  if (msg.FollowType !== undefined || (msg.Content && msg.Content.includes('$关注'))) return 'follow';
  if (msg.Content) return 'barrage';
  return 'unknown';
}

function handleEnterEvent(msg) {
  if (!runtimeConfig.features.welcome || !ruleConfig.welcome?.enabled) return;
  const user = msg.User;
  if (!user || !user.Id) return;

  const now = Date.now();
  const cooldown = (runtimeConfig.riskControl?.welcomeCooldownMinutes || 5) * 60 * 1000;
  if (riskState.welcomeTracker[user.Id] && (now - riskState.welcomeTracker[user.Id]) < cooldown) return;

  const nickname = user.Nickname || '新朋友';
  const templates = ruleConfig.welcome.templates || [];
  if (templates.length === 0) return;

  const text = templates[Math.floor(Math.random() * templates.length)].replace('{nickname}', nickname);
  sendToPage(text);
  riskState.welcomeTracker[user.Id] = now;
}

function handleBarrageMsg(msg) {
  if (!runtimeConfig.features.keyword || !ruleConfig.keyword?.enabled) return;
  const content = msg.Content || '';
  const rules = ruleConfig.keyword.rules || [];
  for (const rule of rules) {
    if (new RegExp(rule.trigger, 'i').test(content)) {
      const replies = rule.reply || [];
      if (replies.length > 0) sendToPage(replies[Math.floor(Math.random() * replies.length)]);
      break;
    }
  }
}

function handleGiftEvent(msg) {
  if (!runtimeConfig.features.gift || !ruleConfig.gift?.enabled) return;
  const nickname = msg.User?.Nickname || '神秘人';
  const giftName = msg.GiftName || '礼物';
  const templates = ruleConfig.gift.templates || [];
  if (templates.length === 0) return;
  const text = templates[Math.floor(Math.random() * templates.length)].replace('{nickname}', nickname).replace('{giftName}', giftName);
  sendToPage(text);
}

function handleFollowEvent() {}

// ==================== 风控与发送 ====================
function canSend() {
  if (riskState.circuitBroken) return false;
  const rc = runtimeConfig.riskControl || {};
  if (riskState.hourSendCount >= (rc.globalMaxPerHour || 30)) return false;
  if (Date.now() - riskState.lastSendTime < (rc.sendIntervalMin || 1000)) return false;
  return true;
}

function recordSend() {
  riskState.sendCount++;
  riskState.hourSendCount++;
  riskState.lastSendTime = Date.now();
  riskState.consecutiveFailures = 0;
}

function recordFailure() {
  riskState.consecutiveFailures++;
  if (riskState.consecutiveFailures >= (runtimeConfig.riskControl?.circuitBreakerThreshold || 3)) {
    riskState.circuitBroken = true;
    logToRenderer('error', '连续失败 3 次，触发熔断！自动评论已暂停');
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('circuit-break', true);
  }
}

function resetHourlyCounter() { riskState.hourSendCount = 0; }

function startHourlyReset() {
  riskState.hourlyResetTimer = setInterval(() => {
    resetHourlyCounter();
    logToRenderer('info', '每小时发送计数已重置');
  }, 60 * 60 * 1000);
}

// ==================== Electron 内置浏览器 ====================

// 检查是否有已保存的登录状态
function hasLoginSession() {
  const cookiesPath = path.join(__dirname, 'config', 'cookies.json');
  if (!fs.existsSync(cookiesPath)) return false;
  try {
    const cookies = JSON.parse(fs.readFileSync(cookiesPath, 'utf-8'));
    return cookies && cookies.length > 0;
  } catch (e) {
    return false;
  }
}

// 保存 cookies 到文件
async function saveCookies() {
  if (!douyinWindow) return false;
  try {
    // 使用 window 的 session（已绑定 partition）
    const cookies = await douyinWindow.webContents.session.cookies.get({});
    if (cookies.length === 0) {
      logToRenderer('warn', '没有获取到任何 cookies');
      return false;
    }
    const cookiesPath = path.join(__dirname, 'config', 'cookies.json');
    fs.writeFileSync(cookiesPath, JSON.stringify(cookies, null, 2), 'utf-8');
    logToRenderer('info', `已保存 ${cookies.length} 个 cookies`);
    return true;
  } catch (e) {
    logToRenderer('error', `保存 cookies 失败: ${e.message}`);
    return false;
  }
}

// 从文件恢复 cookies
async function restoreCookies() {
  const cookiesPath = path.join(__dirname, 'config', 'cookies.json');
  if (!fs.existsSync(cookiesPath)) {
    logToRenderer('info', '无已保存的 cookies 文件');
    return false;
  }

  try {
    const cookies = JSON.parse(fs.readFileSync(cookiesPath, 'utf-8'));
    if (!cookies || cookies.length === 0) {
      logToRenderer('info', 'cookies 文件为空');
      return false;
    }

    // 过滤已过期的 cookies
    const now = Date.now() / 1000;
    const validCookies = cookies.filter(c => {
      if (c.expirationDate && c.expirationDate < now) {
        logToRenderer('info', `跳过过期 cookie: ${c.name}`);
        return false;
      }
      return true;
    });

    logToRenderer('info', `共 ${cookies.length} 个 cookies，有效 ${validCookies.length} 个`);

    if (!douyinWindow) {
      logToRenderer('warn', 'douyinWindow 为空，无法恢复 cookies');
      return false;
    }

    let restored = 0;
    let failed = 0;
    for (const cookie of validCookies) {
      const domain = cookie.domain || '.douyin.com';
      const url = (cookie.secure ? 'https://' : 'http://') + domain.replace(/^\./, '');
      const cookieData = {
        url: url,
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain,
        path: cookie.path || '/',
        secure: cookie.secure || false,
        httpOnly: cookie.httpOnly || false,
        sameSite: cookie.sameSite || 'no_restriction',
      };
      try {
        await douyinWindow.webContents.session.cookies.set(cookieData);
        restored++;
      } catch (e) {
        failed++;
        if (failed <= 3) {
          logToRenderer('warn', `cookie 设置失败: ${cookie.name} - ${e.message}`);
        }
      }
    }
    logToRenderer('info', `恢复完成: 成功 ${restored}，失败 ${failed}`);
    return restored > 0;
  } catch (e) {
    logToRenderer('error', `恢复 cookies 失败: ${e.message}`);
    return false;
  }
}

// 创建抖音浏览器窗口
function createDouyinWindow() {
  if (douyinWindow && !douyinWindow.isDestroyed()) {
    douyinWindow.show();
    douyinWindow.focus();
    return;
  }

  douyinWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    title: '抖音直播 - 扫码登录',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  // 设置 User-Agent 为 PC 端 Chrome
  const PC_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
  douyinWindow.webContents.setUserAgent(PC_UA);

  // 拦截所有自定义协议导航（在导航发生前）
  douyinWindow.webContents.on('will-navigate', (event, url) => {
    // 拦截非 http/https 协议
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      logToRenderer('warn', `拦截自定义协议导航: ${url}`);
      event.preventDefault();
      return;
    }
  });

  // 监听页面导航完成
  douyinWindow.webContents.on('did-navigate', (event, url) => {
    logToRenderer('info', `页面导航: ${url}`);

    // 检测是否进入直播间
    const roomMatch = url.match(/live\.douyin\.com\/(\d+)/);
    if (roomMatch) {
      const roomId = roomMatch[1];
      logToRenderer('info', `检测到直播间号: ${roomId}`);
      runtimeConfig.webRoomId = roomId;
      saveRuntimeConfig();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('room-detected', roomId);
      }
      saveCookies();
    }

    // 检测登录成功
    if (url.includes('live.douyin.com') && !url.includes('/login')) {
      logToRenderer('info', '检测到登录状态');
      saveCookies();
      updateLoginUI(true);
    }
  });

  // 拦截所有新窗口请求（抖音会在新窗口打开链接）
  douyinWindow.webContents.setWindowOpenHandler(({ url }) => {
    logToRenderer('info', `新窗口请求: ${url}`);

    // 拦截自定义协议链接
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      logToRenderer('warn', `忽略自定义协议链接: ${url}`);
      return { action: 'deny' };
    }

    // 在当前窗口打开普通网页链接
    douyinWindow.webContents.loadURL(url);
    return { action: 'deny' };
  });

  // 拦截新打开的 webContents（处理 window.open 等）
  douyinWindow.webContents.on('did-create-window', (childWindow) => {
    // 监听子窗口的导航
    childWindow.webContents.on('will-navigate', (event, url) => {
      if (!url.startsWith('http://') && !url.startsWith('https://')) {
        event.preventDefault();
      }
    });
  });

  // 窗口关闭请求 - 拦截关闭，改为隐藏
  douyinWindow.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      hideDouyinWindow();
      logToRenderer('info', '浏览器已隐藏到后台运行');
    }
  });

  // 窗口真正关闭
  douyinWindow.on('closed', () => {
    douyinWindow = null;
    logToRenderer('info', '抖音浏览器窗口已关闭');
  });

  // 先恢复 cookies，再加载页面
  restoreCookies().then(() => {
    // 检查是否有保存的房间号
    const targetUrl = runtimeConfig.webRoomId
      ? `https://live.douyin.com/${runtimeConfig.webRoomId}`
      : 'https://live.douyin.com';

    logToRenderer('info', `正在打开: ${targetUrl}`);
    douyinWindow.loadURL(targetUrl);
  });
}

// 隐藏抖音浏览器窗口（进入后台运行）
function hideDouyinWindow() {
  if (douyinWindow && !douyinWindow.isDestroyed()) {
    // 从任务栏隐藏，但保持运行
    douyinWindow.setSkipTaskbar(true);
    douyinWindow.hide();
    logToRenderer('info', '抖音浏览器已转为后台运行');
  }
}

// 显示抖音浏览器窗口
function showDouyinWindow() {
  if (douyinWindow && !douyinWindow.isDestroyed()) {
    douyinWindow.setSkipTaskbar(false);
    douyinWindow.show();
    douyinWindow.focus();
    logToRenderer('info', '已显示浏览器窗口');
  } else {
    // 窗口不存在，重新创建
    logToRenderer('info', '浏览器窗口已关闭，正在重新打开...');
    createDouyinWindow();
  }
}

// 关闭抖音浏览器窗口（强制销毁）
function closeDouyinWindow(force = false) {
  if (douyinWindow && !douyinWindow.isDestroyed()) {
    if (force) {
      // 强制关闭，跳过 close 事件拦截
      douyinWindow.destroy();
      douyinWindow = null;
    } else {
      // 正常关闭（会被 close 事件拦截，改为隐藏）
      douyinWindow.close();
    }
  }
}

// 更新登录状态 UI
function updateLoginUI(isLoggedIn) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('login-status', isLoggedIn ? 'success' : 'logged-out');
  }
}

// 发送消息到抖音页面
async function sendToPage(text) {
  if (!canSend()) return;
  if (!douyinWindow || douyinWindow.isDestroyed()) {
    logToRenderer('warn', '抖音浏览器未启动，无法发送');
    return;
  }

  try {
    const code = `
      (async function() {
        var msg = ${JSON.stringify(text)};

        // 1. 查找 Slate 编辑器输入框
        var input = document.querySelector('div[data-slate-editor="true"][contenteditable="true"]');
        if (!input) return false;

        // 2. 聚焦输入框
        input.focus();
        await new Promise(function(r) { setTimeout(r, 100); });

        // 3. 直接设置文本内容（一次性）
        input.innerText = msg;

        // 4. 触发 Slate 编辑器事件
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        await new Promise(function(r) { setTimeout(r, 500); });

        // 5. 等待发送按钮解除禁用
        var sendBtn = null;
        for (var wait = 0; wait < 50; wait++) {
          sendBtn = document.querySelector('svg.webcast-chatroom___send-btn:not([disabled]):not(.disable)');
          if (sendBtn) break;
          await new Promise(function(r) { setTimeout(r, 100); });
        }

        if (sendBtn) {
          sendBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
          return true;
        }

        // 备用：回车键
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
        return true;
      })()
    `;

    const sent = await douyinWindow.webContents.executeJavaScript(code);

    if (sent) {
      recordSend();
      logToRenderer('info', `发送成功: ${text}`);
    } else {
      recordFailure();
      // 获取调试信息
      try {
        const debugInfo = await douyinWindow.webContents.executeJavaScript(`
          JSON.stringify({
            contentEditable: document.querySelectorAll('div[contenteditable="true"]').length,
            buttons: document.querySelectorAll('button').length,
            chatDivs: document.querySelectorAll('div[class*="chat"], div[class*="Chat"]').length,
            title: document.title,
            url: window.location.href
          })
        `);
        logToRenderer('warn', `未找到输入框或发送按钮 - ${debugInfo}`);
      } catch (e) {
        logToRenderer('warn', '未找到输入框或发送按钮');
      }
    }
  } catch (e) {
    recordFailure();
    logToRenderer('error', `发送异常: ${e.message}`);
  }
}

// ==================== 暖场消息 ====================
let warmupTimer = null;

function startWarmupTimer() {
  stopWarmupTimer();
  if (!runtimeConfig.features.warmup || !ruleConfig.warmup?.enabled) return;
  const interval = (ruleConfig.warmup.intervalMinutes || 3) * 60 * 1000;
  warmupTimer = setInterval(() => {
    const templates = ruleConfig.warmup.templates || [];
    if (templates.length > 0) sendToPage(templates[Math.floor(Math.random() * templates.length)]);
  }, interval);
  logToRenderer('info', `暖场消息已启动，间隔 ${ruleConfig.warmup.intervalMinutes || 3} 分钟`);
}

function stopWarmupTimer() {
  if (warmupTimer) { clearInterval(warmupTimer); warmupTimer = null; }
}

// ==================== IPC 通信 ====================
function setupIPC() {
  ipcMain.handle('get-config', () => ({ rule: ruleConfig, runtime: runtimeConfig }));
  ipcMain.handle('save-rule-config', (_, config) => { ruleConfig = config; saveRuleConfig(); return true; });
  ipcMain.handle('save-runtime-config', (_, config) => { runtimeConfig = { ...runtimeConfig, ...config }; saveRuntimeConfig(); return true; });

  ipcMain.handle('send-message', async (_, text) => { await sendToPage(text); return true; });

  ipcMain.handle('emergency-stop', () => {
    riskState.circuitBroken = true;
    logToRenderer('warn', '紧急停止已触发');
    return true;
  });

  ipcMain.handle('resume-auto', () => {
    riskState.circuitBroken = false;
    riskState.consecutiveFailures = 0;
    logToRenderer('info', '自动评论已恢复');
    return true;
  });

  // 退出软件
  ipcMain.handle('exit-app', () => {
    app.isQuitting = true;
    app.quit();
    return true;
  });

  // 打开抖音浏览器
  ipcMain.handle('open-douyin', () => {
    createDouyinWindow();
    return true;
  });

  // 关闭抖音浏览器
  ipcMain.handle('close-douyin', () => {
    closeDouyinWindow();
    return true;
  });

  // 刷新直播间
  ipcMain.handle('refresh-room', async () => {
    if (douyinWindow && !douyinWindow.isDestroyed() && runtimeConfig.webRoomId) {
      douyinWindow.webContents.loadURL(`https://live.douyin.com/${runtimeConfig.webRoomId}`);
      logToRenderer('info', '正在刷新直播间...');
    }
    return true;
  });

  // 进入指定直播间
  ipcMain.handle('enter-room', async (_, roomId) => {
    if (!douyinWindow || douyinWindow.isDestroyed()) {
      createDouyinWindow();
    }
    runtimeConfig.webRoomId = roomId;
    saveRuntimeConfig();
    douyinWindow.webContents.loadURL(`https://live.douyin.com/${roomId}`);
    logToRenderer('info', `正在进入直播间: ${roomId}`);

    // 页面加载完成后隐藏窗口
    douyinWindow.webContents.once('did-finish-load', () => {
      setTimeout(() => {
        hideDouyinWindow();
        logToRenderer('info', '浏览器已转为后台运行');
      }, 3000); // 延迟 3 秒，确保页面完全加载
    });

    return true;
  });

  // 显示抖音浏览器窗口
  ipcMain.handle('show-douyin', () => {
    showDouyinWindow();
    return true;
  });

  // 隐藏抖音浏览器窗口
  ipcMain.handle('hide-douyin', () => {
    hideDouyinWindow();
    return true;
  });


  ipcMain.handle('get-risk-state', () => ({
    circuitBroken: riskState.circuitBroken,
    hourSendCount: riskState.hourSendCount,
    sendCount: riskState.sendCount,
    consecutiveFailures: riskState.consecutiveFailures,
  }));

  ipcMain.handle('get-ws-status', () => wsClient && wsClient.readyState === WebSocket.OPEN ? 'connected' : 'disconnected');

  ipcMain.handle('toggle-debug', (_, enabled) => {
    debugMode = enabled;
    logToRenderer('info', `调试模式已${enabled ? '开启' : '关闭'}`);
    return true;
  });

  ipcMain.handle('get-debug-mode', () => debugMode);

  // 退出登录
  ipcMain.handle('logout', async () => {
    closeDouyinWindow(true);
    const cookiesPath = path.join(__dirname, 'config', 'cookies.json');
    if (fs.existsSync(cookiesPath)) fs.unlinkSync(cookiesPath);
    // 清除 session cookies
    await session.defaultSession.clearStorageData();
    logToRenderer('info', '已退出登录');
    updateLoginUI(false);
    return true;
  });

  // 清除缓存换号
  ipcMain.handle('clear-cache', async () => {
    closeDouyinWindow(true);
    const cookiesPath = path.join(__dirname, 'config', 'cookies.json');
    if (fs.existsSync(cookiesPath)) fs.unlinkSync(cookiesPath);
    await session.defaultSession.clearStorageData();
    runtimeConfig.webRoomId = '';
    saveRuntimeConfig();
    logToRenderer('info', '已清除所有缓存，请重新登录');
    updateLoginUI(false);
    return true;
  });

  // 检查登录状态
  ipcMain.handle('check-login-status', () => ({
    hasCookies: hasLoginSession(),
    isLoggedIn: douyinWindow && !douyinWindow.isDestroyed(),
  }));

  ipcMain.handle('start-warmup', () => { startWarmupTimer(); return true; });
  ipcMain.handle('stop-warmup', () => { stopWarmupTimer(); return true; });
}

// ==================== 主窗口 ====================
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 680,
    minWidth: 750,
    minHeight: 550,
    title: '抖音场控助手',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    show: false,
  });

  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('close', (e) => { if (!app.isQuitting) { e.preventDefault(); mainWindow.hide(); } });
  mainWindow.on('closed', () => { mainWindow = null; });
}

// ==================== 系统托盘 ====================
function createTray() {
  const iconPath = path.join(__dirname, 'assets', 'icon.png');
  let trayIcon = fs.existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty();
  tray = new Tray(trayIcon);
  tray.setToolTip('抖音场控助手');

  const contextMenu = Menu.buildFromTemplate([
    { label: '显示窗口', click: () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } } },
    { type: 'separator' },
    { label: '紧急停止', click: () => { riskState.circuitBroken = true; logToRenderer('warn', '从托盘触发紧急停止'); } },
    { type: 'separator' },
    { label: '退出', click: () => { app.isQuitting = true; app.quit(); } },
  ]);

  tray.setContextMenu(contextMenu);
  tray.on('double-click', () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } });
}

// ==================== 应用生命周期 ====================
app.whenReady().then(() => {
  // 注册自定义协议拦截器（静默处理，不弹窗）
  const customProtocols = ['bitbrowser', 'bytedance', 'sslocal', 'webcast'];
  for (const p of customProtocols) {
    protocol.handle(p, () => {
      return new Response('', { status: 204 });
    });
  }

  // 通用拦截：放行 http/https/ws/wss/file，拦截其他自定义协议
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    const url = details.url;
    if (url.startsWith('http://') || url.startsWith('https://') ||
        url.startsWith('ws://') || url.startsWith('wss://') ||
        url.startsWith('file://')) {
      callback({ cancel: false });
    } else {
      console.log(`拦截自定义协议: ${url}`);
      callback({ cancel: true });
    }
  });

  loadConfig();
  setupIPC();
  createWindow();
  createTray();
  startBarrageService();
  startHourlyReset();
});

app.on('before-quit', () => {
  app.isQuitting = true;
  stopBarrageService();
  closeDouyinWindow(true);
  stopWarmupTimer();
  if (riskState.hourlyResetTimer) clearInterval(riskState.hourlyResetTimer);
});

app.on('will-quit', () => {
  if (barrageProcess) {
    try { execSync(`taskkill /F /PID ${barrageProcess.pid} /T`, { stdio: 'ignore' }); } catch (e) {}
    barrageProcess = null;
  }
});

app.on('window-all-closed', () => {});
