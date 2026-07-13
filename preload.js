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

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // 弹幕消息
  onBarrage: (callback) => ipcRenderer.on('barrage-message', (_, data) => callback(data)),

  // 应用日志
  onLog: (callback) => ipcRenderer.on('app-log', (_, data) => callback(data)),

  // WebSocket 状态
  onWsStatus: (callback) => ipcRenderer.on('ws-status', (_, status) => callback(status)),

  // 熔断状态
  onCircuitBreak: (callback) => ipcRenderer.on('circuit-break', (_, broken) => callback(broken)),

  // 配置操作
  getConfig: () => ipcRenderer.invoke('get-config'),
  saveRuleConfig: (config) => ipcRenderer.invoke('save-rule-config', config),
  saveRuntimeConfig: (config) => ipcRenderer.invoke('save-runtime-config', config),

  // 操作
  sendMessage: (text) => ipcRenderer.invoke('send-message', text),
  emergencyStop: () => ipcRenderer.invoke('emergency-stop'),
  resumeAuto: () => ipcRenderer.invoke('resume-auto'),
  exitApp: () => ipcRenderer.invoke('exit-app'),
  refreshRoom: () => ipcRenderer.invoke('refresh-room'),
  enterRoom: (roomId) => ipcRenderer.invoke('enter-room', roomId),
  getRiskState: () => ipcRenderer.invoke('get-risk-state'),
  getWsStatus: () => ipcRenderer.invoke('get-ws-status'),

  // 抖音浏览器
  openDouyin: () => ipcRenderer.invoke('open-douyin'),
  closeDouyin: () => ipcRenderer.invoke('close-douyin'),
  showDouyin: () => ipcRenderer.invoke('show-douyin'),
  hideDouyin: () => ipcRenderer.invoke('hide-douyin'),

  // 登录管理
  logout: () => ipcRenderer.invoke('logout'),
  clearCache: () => ipcRenderer.invoke('clear-cache'),
  checkLoginStatus: () => ipcRenderer.invoke('check-login-status'),

  // 登录状态
  onLoginStatus: (callback) => ipcRenderer.on('login-status', (_, status) => callback(status)),
  onRoomDetected: (callback) => ipcRenderer.on('room-detected', (_, roomId) => callback(roomId)),

  // 调试模式
  toggleDebug: (enabled) => ipcRenderer.invoke('toggle-debug', enabled),
  getDebugMode: () => ipcRenderer.invoke('get-debug-mode'),
  onRawMessage: (callback) => ipcRenderer.on('raw-message', (_, data) => callback(data)),

  // 暖场
  startWarmup: () => ipcRenderer.invoke('start-warmup'),
  stopWarmup: () => ipcRenderer.invoke('stop-warmup'),
});
