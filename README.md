# Douyin Live Assistant (抖音场控助手)

抖音直播间自动场控工具，专为房管小号设计。通过对接弹幕抓包服务，实现自动欢迎、关键词回复、礼物感谢、定时暖场等功能。

> ⚠️ **免责声明**：本软件仅供学习和研究使用。使用本软件时请遵守抖音平台的用户协议和相关法律法规，禁止用于任何违规刷屏、骚扰等不正当用途。使用者需自行承担使用风险。

## 功能特性

- **🎯 自动欢迎** — 用户进入直播间时自动发送欢迎消息
- **💬 关键词回复** — 按预设关键词（如"价格"、"尺码"）自动回复观众
- **🎁 礼物感谢** — 收到礼物时自动感谢送礼观众
- **🔥 定时暖场** — 每隔数分钟自动发送暖场消息，活跃直播间氛围
- **🛡️ 风控保护** — 内置频次限流、随机间隔、异常熔断等多层风控机制
- **🎮 GUI 可视化面板** — 深色主题控制面板，实时查看日志、控制开关、编辑话术
- **🔐 扫码登录** — 支持抖音扫码登录，自动持久化 Cookie

## 系统架构

```
观众操作直播间 → 抖音服务器推送 WSS 数据流
        ↓
WssBarrageServer 抓包解析 → JSON 结构化数据
        ↓
WebSocket (ws://127.0.0.1:8888) 推送至 Electron 主进程
        ↓
主进程判断事件类型 + 匹配话术规则
        ↓
页面注入 → 自动填充文字 + 点击发送
        ↓
房管小号公屏完成文字互动
```

## 技术栈

| 层面 | 技术 |
|------|------|
| 桌面框架 | Electron 28 |
| 主进程 | JavaScript (Node.js) |
| 前端界面 | 原生 HTML + CSS + JavaScript |
| 弹幕抓包 | WssBarrageServer (第三方工具) |
| 依赖管理 | npm |

## 环境要求

- **Node.js** >= 18
- **npm** >= 9
- **操作系统**：Windows (Electron 构建目标)

## 安装与运行

```bash
# 1. 克隆仓库
git clone https://github.com/YOUR_USERNAME/douyin-live-assistant.git
cd douyin-live-assistant

# 2. 安装依赖
npm install

# 3. 安装 Electron (开发依赖)
npx electron install

# 4. 准备弹幕抓包工具
#    本项目依赖 WssBarrageServer 进行弹幕数据抓包解析，
#    请自行获取并将其放置在 tools/ 目录下。

# 5. 启动应用
npm start
```

## 使用说明

1. 启动应用后，点击「打开抖音」按钮，在弹窗中扫码登录抖音账号
2. 登录成功后浏览器窗口会自动隐藏，进入无头模式
3. 输入目标直播间 ID，点击「进入直播间」
4. 在配置面板中启用需要的自动功能（欢迎、回复、感谢、暖场）
5. 在规则面板中编辑话术模板和关键词规则
6. 软件运行日志会实时显示在主面板中

## 风控机制

| 机制 | 说明 |
|------|------|
| 频次限流 | 单用户 5 分钟内仅触发 1 次欢迎 |
| 随机间隔 | 全局发送间隔 1~3 秒随机 |
| 小时硬上限 | 单小时最大发送条数硬限制 (默认 30) |
| 异常熔断 | 连续 3 次发送失败自动暂停所有自动功能 |
| 紧急开关 | GUI 面板一键暂停所有自动发送 |

## 项目结构

```
douyin-live-assistant/
├── main.js              # Electron 主进程（核心逻辑）
├── preload.js           # 安全桥接脚本（contextBridge）
├── package.json         # 项目依赖与构建配置
├── src/
│   └── index.html       # 前端 GUI 页面
├── config/
│   ├── rule.json        # 规则配置（欢迎/回复/礼物/暖场）
│   └── runtime.json     # 运行时配置（直播间/风控参数）
├── tools/               # 第三方弹幕抓包工具（需自行获取）
├── electron/            # Electron 运行时（需自行安装）
└── assets/              # 资源目录
```

## 打包构建

```bash
# 打包为 Windows NSIS 安装包
npm run build

# 打包为目录（不压缩）
npm run build:dir
```

## 许可证

本项目采用 [GNU General Public License v3.0](LICENSE) 开源许可证。

## 重要说明

- 本项目不包含弹幕抓包工具 WssBarrageServer 的源代码（该工具为第三方闭源软件）
- 本项目不包含 Electron 运行时（需通过 npm 安装）
- `config/cookies.json` 和 `config/chrome-profile/` 为用户运行时数据，不纳入版本控制
