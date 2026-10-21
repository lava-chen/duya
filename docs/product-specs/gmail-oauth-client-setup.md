# 为 Gmail / Google Calendar 配置你自己的 OAuth Client

## 为什么需要自己配置

Gmail 涉及你的**私有邮箱数据**，Google Calendar 涉及**私人日程**。DUYA **不托管**为这些敏感连接器准备的共享 OAuth client——它们默认不可直连，需要你用一个**自己创建**的 Google Cloud OAuth client。

这只是创建你自己的 client，**不会产生任何 Google 费用**（Google OAuth 授权与 Gmail/Calendar API 均免费）。本教程大概需要 5 分钟。

> Notion、GitHub、Linear 等 connector 走官方远程 MCP，**无需**此配置即可直连。只有 Gmail / Google Calendar（以及需要时 Slack）需要手动配置 OAuth client。

## 前置条件

- 一个 Google 账号
- 能访问 [Google Cloud Console](https://console.cloud.google.com)

## 步骤一：创建 Google Cloud OAuth client

1. 打开 [console.cloud.google.com](https://console.cloud.google.com)，顶部选中或新建一个 Project（项目名随意）。
2. 左侧菜单 → **API 与服务 (APIs & Services)** → **OAuth 同意屏幕 (OAuth consent screen)**：
   - 选择用户类型 **外部 (External)**，填 App 名称与支持邮箱点「保存」。处于 **Testing** 状态即可，无需提交验证。
3. **凭据 (Credentials)** → **创建凭据** → **OAuth 客户端 ID (OAuth client ID)**：
   - 应用类型选 **桌面应用 (Desktop app)**。
   - 点击「创建」。
4. 在弹出的凭据详情里，**复制两样东西**（点复制图标）：
   - **客户端 ID (Client ID)** —— 形如 `xxxx.apps.googleusercontent.com`
   - **客户端密钥 (Client Secret)** —— 形如 `GOCSPX-xxxx`（桌面客户端同样会签发）

> 提醒：DUYA 走本地 loopback OAuth（PKCE），令牌端点仍会校验 client secret，因此两个都要填。

## 步骤二：在 DUYA 里配置

1. 打开 DUYA → **设置 (Settings)** → **扩展 (Extensions)** → **连接 (Connections)**。
2. 找到 **Gmail**（或 **Google Calendar**），点 **Configure**（而不是 Connect）。
3. 在弹窗里填入上面复制的：
   - **OAuth client ID**
   - **OAuth client secret**
   - 凭据会**加密存储在本地系统 vault**，不会传给 agent。
4. 点保存——保存后会自动发起连接，在浏览器里完成 Google 授权。

## 步骤三：验证

- Gmail / Calendar 在连接列表里状态变为 **Connected**。
- 让 bot「看看我的 Gmail」即可正常使用（`gmail_search_messages` / `gmail_read_message` 等工具可用）。

## 管理与排错

- **撤销连接**：在 Connections 里对已连接项点 Disconnect，将清除本地保存的令牌与该 client 配置。
- **批量托管（企业/自托管）**：可用环境变量注入，DUYA 会自动视为已配置：
  ```
  DUYA_APP_CONNECTION_GMAIL_CLIENT_ID=xxxx.apps.googleusercontent.com
  DUYA_APP_CONNECTION_GMAIL_CLIENT_SECRET=GOCSPX-xxxx
  DUYA_APP_CONNECTION_CALENDAR_CLIENT_ID=...
  DUYA_APP_CONNECTION_CALENDAR_CLIENT_SECRET=...
  ```

## 安全说明

- Client Secret 与访问令牌**只存本地系统 vault**（加密），不会通过 IPC 暴露给 renderer，也不会进入 agent 进程。
- DUYA 不托管、也不通过服务器中转你的 Gmail 令牌。