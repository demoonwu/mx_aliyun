# mx_aliyun — 东方财富「妙想」MCP 阿里云中转代理

> **一句话**：把妙想 MCP 的访问从「本机直连」改为「阿里云函数计算中转」，用 **上游会话复用 + 重试矩阵 + 工具列表缓存 + 双超时分离** 压掉直连时的超时 / 上游 500 / 挂载失败。零第三方依赖，仿照 ftshare 透传代理的设计（客户端带 Key，代理不存密钥）。

---

## 1. 背景：为什么要做

妙想 MCP（CherryStudio 中的「东方财富妙想」，serverId `79e2fef9-db5a-4216-a798-9693ed8c39f1`）在本机直连长期"抽风"，应用日志里的实锤：

| 日期 | 日志证据（`%APPDATA%\CherryStudio\logs\app-error.*.log`） | 含义 |
|---|---|---|
| 11-15 ~ 11-16 | `status 500`，`"Server rejected probe; retrying in legacy mode"` | 版本协商探测被上游直接 500 拒绝 |
| 11-19 | `"code":"REQUEST_TIMEOUT"`，工具 `mx_us_finance_data` 调用超时 | 工具调用层超时 |
| 11-20 | `"Version negotiation probe timed out after 10000ms"`（attempts 1→2） | 版本协商探测 10 秒超时，导致**整个工具列表挂载失败** |
| 历史会话 | 工具数为 0、重启后 **11 个 mx_* 工具**才恢复 | 偶发整次挂载失败 |

上游真实配置（从 CherryStudio 配置库 `cherrystudio.sqlite` 提取，Key 值已脱敏）：

```json
{
  "name": "东方财富妙想",
  "type": "streamableHttp",
  "baseUrl": "https://mxapi.eastmoney.com/mxds/mcp",
  "headers": { "em_api_key": "<妙想Key>" }
}
```

**结论**：不是产品能力缺失，而是链路/上游随机故障。直连时每次探测、每次握手都要赌运气；中转方案把"赌运气"变成"在服务端重试 + 缓存复用"。

---

## 2. 架构

```
CherryStudio（或任意 MCP 客户端）
   │  POST https://<FC触发器域名>/mcp
   │  头：em_api_key: <妙想Key>   ← 与直连配置完全相同，只换 URL
   ▼
阿里云函数计算（本代理，Web 函数 / 自定义运行时）
   │  ① 会话缓存复用 + 并发去重握手
   │  ② 重试矩阵（瞬时错误退避重试 / 会话失效重建）
   │  ③ tools/list 缓存 10 分钟
   │  ④ SSE→JSON 解析、outputSchema 剥离
   ▼
https://mxapi.eastmoney.com/mxds/mcp  （东方财富妙想上游，11 个 mx_* 工具）
```

**鉴权不落盘**：代理只在内存中把客户端的 Key 转成上游要求的 `em_api_key` 头；不写日志、不写库、不进环境变量。

---

## 3. 目录结构

```
mx_aliyun/
├── index.js      # 代理本体（无第三方依赖，Node ≥ 18，ESM）
├── package.json  # type=module，启动脚本 node index.js
├── s.yaml        # Serverless Devs 部署模板（函数计算 3.0）
├── .gitignore
└── README.md     # 本文档
```

---

## 4. 可靠性设计（对照直连痛点）

| # | 机制 | 针对的故障 | 参数（默认） |
|---|---|---|---|
| 1 | 上游会话缓存复用，闲置过期自动重握手，并发去重 | 反复握手失败/探测超时 | `SESSION_TTL_MS`（6 分钟） |
| 2 | 重试矩阵（见下表） | 瞬时 500 / 超时 / 会话失效 | `BACKOFF_MS`（0s,1s,3s，共 3 次） |
| 3 | **双超时分离**：握手 15s 快速失败，业务调用 90s | 版本协商探测 10s 窗口内来不及建会话 | `HANDSHAKE_TIMEOUT_MS` / `UPSTREAM_TIMEOUT_MS` |
| 4 | tools/list 缓存 10 分钟 | 工具挂载失败（0 个工具） | `TOOLS_CACHE_MS` |
| 5 | SSE 响应自动解析为 JSON-RPC；`Accept-Encoding: identity` | 网关压缩头导致响应解析失败 | 内置 |
| 6 | 剥离工具的 `outputSchema` | 客户端对 schema 强校验失败 | 内置 |

**重试矩阵**（错误分类 → 动作）：

| 错误类型 | 判定 | 动作 |
|---|---|---|
| 网络 / 超时 / 408 / 429 / 5xx / "上游响应格式无效" | 临时 | 沿用会话退避重试，不重新握手 |
| HTTP 400 / 404 / session 类 RPC 错误 | 会话失效 | 重建会话后重试 |
| HTTP 401 / 403 / 其他 4xx / 业务 RPC 错误 | 不可恢复 | 直接返回，不重试 |

**双超时分离为什么关键**：CherryStudio 的版本协商探测只给 10s，超时即挂载失败。代理把握手超时压到 15s 内快速失败并自动重试（含 1s/3s 退避），即使客户端当次探测超时、转"legacy 模式"重试，第二次探测命中的已是**热会话**——这正是把"挂载失败"变成"慢一次"的关键。业务调用（自然语言查金融数据，本身就要 5–30s）单独放宽到 90s。

---

## 5. 环境变量参考

| 变量 | 默认 | 说明 |
|---|---|---|
| `MX_UPSTREAM` | `https://mxapi.eastmoney.com/mxds/mcp` | 妙想上游端点 |
| `MX_AUTH_HEADER` | `em_api_key` | 发给上游的鉴权头名 |
| `MX_AUTH_MODE` | `raw` | `raw`=自定义头 / `bearer`=Authorization |
| `PROXY_KEY` | 空 | 可选门禁：设置后客户端须带 `x-proxy-key: 同值` |
| `HANDSHAKE_TIMEOUT_MS` | `15000` | 握手（initialize）超时 |
| `UPSTREAM_TIMEOUT_MS` | `90000` | tools/call、tools/list 超时 |
| `SESSION_TTL_MS` | `360000` | 上游会话闲置过期 |
| `TOOLS_CACHE_MS` | `600000` | 工具列表缓存时长 |
| `BACKOFF_MS` | `[0,1000,3000]` | 重试退避（JSON 数组） |
| `MX_INJECT_HEADERS` | `{}` | 可选：静态注入上游头（默认保持"密钥不落盘"） |
| `MAX_BODY` | `1048576` | 请求体上限 |
| `FC_SERVER_PORT` / `PORT` | `9000` | 监听端口（FC Web 函数注入） |

---

## 6. 本地运行与冒烟测试

```bash
cd mx_aliyun
npm start          # 即 node index.js，默认监听 :9000

KEY='<你的妙想 em_api_key>'   # 只在本地 shell 变量里，不要写进文件

# ① initialize（应返回 protocolVersion / serverInfo）
curl -s http://localhost:9000/mcp \
  -H "em-api-key: $KEY" -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'

# ② tools/list（应返回 11 个 mx_* 工具）
curl -s http://localhost:9000/mcp \
  -H "em-api-key: $KEY" -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'

# ③ tools/call 实测（工具名以 tools/list 实际返回为准）
curl -s http://localhost:9000/mcp \
  -H "em-api-key: $KEY" -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"mx_ashare_finance_data","arguments":{"query":"杰克科技最新收盘价"}}}'
```

健康检查：`GET /` 或 `/health` 返回 `ok`；无 Key 请求 `/mcp` 返回 401 提示。

**客户端可用头形式**（任选其一，代理都会转成 `em_api_key` 发上游；兼容会丢弃下划线头的网关）：

| 客户端头 | 说明 |
|---|---|
| `em_api_key: <key>` | 与直连配置一致（推荐，CherryStudio 无需改头） |
| `em-api-key` / `mx-api-key` / `mx_api_key` / `x-mx-key` | 连字符/别名形式 |
| `Authorization: Bearer <key>` | 标准形式 |

---

## 7. 部署到阿里云函数计算

### 7.1 控制台部署（实测可用的完整流程）

**第 1 步：选择函数类型**

打开函数计算 3.0 控制台（`fcnext.console.aliyun.com`）→ 创建函数 → 选择 **Web 函数**。

| 函数类型 | 是否适用 | 原因 |
|---|---|---|
| **Web 函数** | ✅ 选这个 | 本代理就是一个自己监听端口的 HTTP 服务，代码无需改动 |
| 事件函数 | ❌ | 需要改写成 FC 的 handler 形式 |
| 任务函数 / 沙箱函数 / GPU 函数 | ❌ | 用途不同（异步任务 / 运行不受信代码 / AI 推理） |

**第 2 步：填写创建表单**

| 配置项 | 填写 | 说明 |
|---|---|---|
| 地域 | 华东1（杭州）`cn-hangzhou` | 国内任意地域均可 |
| 函数名称 | 例如 `mx_aliyun` | 字母、数字、下划线、中划线 |
| 实例类型 | 弹性实例 | |
| 规格 | 0.35 vCPU / 0.5 GB / 磁盘 512 MB | 只做请求转发，最低规格足够 |
| 最小实例数 | `0` 或 `1` | 见下方「冷启动」说明 |
| 单实例并发度 | `20` | |
| 运行环境 | 自定义运行时 → **Node.js 22（Debian 11）** | 代码要求 Node ≥ 18 |
| 代码上传方式 | 通过文件夹上传，选择本项目目录 | 零依赖，不需要 node_modules；也可把 `index.js` + `package.json` 打成 zip 上传 |
| 启动命令 | `node index.js` | 默认模式即可 |
| 监听端口 | `9000` | 必须与代码一致 |
| **执行超时时间** | **`300` 秒**（默认 60，必须改） | 单次请求最多重试 3 次，每次最长 90 秒；60 秒会在重试中途被截断，返回 504 |

环境变量可以不填：代码内置了全部默认值（上游地址、`em_api_key` 头名、15s/90s 超时）。需要调整时参考第 5 节。

**冷启动说明**：最小实例数为 `0` 时，闲置一段时间后的第一个请求要等实例启动，实测最长约 90 秒；实例启动后的请求在 1–4 秒内返回。CherryStudio 第一次连接可能超时，重连一次即可。不能接受时把最小实例数设为 `1`（会持续计费）。

**第 3 步：配置 HTTP 触发器的认证方式**

函数创建后进入「触发器」页签 → 编辑默认的 HTTP 触发器 → 选择认证方式。只推荐以下两种：

| 认证方式 | 推荐度 | 客户端需要带的请求头 |
|---|---|---|
| **Bearer 认证** | ✅ 推荐 | `Authorization: Bearer <FC Token>` + `em_api_key: <妙想Key>` |
| **无需认证（匿名）** | 可用于测试 | 只需 `em_api_key: <妙想Key>` |
| 签名认证 | ❌ 不要选 | 要求用阿里云 AccessKey 计算签名，MCP 客户端做不到 |
| Basic / JWT 认证 | 不推荐 | 能用但配置更麻烦，没有额外收益 |

> 注意：如果触发器停留在「签名认证」，所有请求都会被网关拦下，返回
> `MissingRequiredHeader: required HTTP header Date was not specified`
> 或 `invalid authorization ''`。这些请求不会进入函数，与代码无关。

两种认证方式的具体配置见第 8 节。

**第 4 步：获取访问地址**

在「触发器」页签复制公网访问地址，形如：

```
https://<函数名>-<随机串>.cn-hangzhou.fcapp.run
```

MCP 地址就是在后面加上 `/mcp`：

```
https://<函数名>-<随机串>.cn-hangzhou.fcapp.run/mcp
```

**第 5 步：验证**

按第 8 节中对应认证方式的 curl 命令验证。全部通过的标准：

1. `/health` 返回 `ok`
2. `initialize` 返回 `serverInfo`
3. `tools/list` 返回 11 个 `mx_*` 工具
4. `tools/call` 返回实际数据

### 7.2 Serverless Devs CLI 部署

```bash
npm i -g @serverless-devs/s
s config add                    # 配置阿里云 AccessKey
cd mx_aliyun
s deploy                         # 使用本目录 s.yaml
```

`s.yaml` 为模板，若与当前 fc3 组件 schema 有出入，以 `s` 报错提示或控制台为准微调。

### 7.3 可选：定时预热

最小实例数为 0 时，可加一个定时触发器每 5 分钟请求一次 `/health`，减少冷启动。触发器是 Bearer 认证时，定时触发器从内部调用函数，不经过 HTTP 网关认证。也可以直接把最小实例数设为 1。

---

## 8. 客户端配置：匿名访问与 Bearer 认证

下文中的占位符：

| 占位符 | 含义 |
|---|---|
| `<FC地址>` | 第 7.1 节第 4 步复制的访问地址，不含 `/mcp` |
| `<妙想Key>` | 东方财富妙想的 API Key（形如 `em_xxxx`） |
| `<FC Token>` | 在触发器 Bearer 认证中设置的 Token |

> **常见错误**：请求头的值只填密钥本身，前后不能带逗号、空格或引号。
> 例如 `em_xxxx,` 末尾多一个逗号，上游会认为 Key 无效。

### 8.1 方式一：无需认证（匿名访问）

触发器认证方式选「无需认证」。客户端只带妙想 Key：

```json
{
  "mcpServers": {
    "东方财富妙想-阿里云": {
      "type": "streamableHttp",
      "baseUrl": "https://<FC地址>/mcp",
      "headers": {
        "em_api_key": "<妙想Key>"
      }
    }
  }
}
```

匿名模式下，妙想 Key 也可以改用 `Authorization: Bearer <妙想Key>` 传递，代理会自动转换成 `em_api_key`。

验证：

```powershell
$BASE  = 'https://<FC地址>'
$EMKEY = '<妙想Key>'

curl.exe -s "$BASE/health"    # 应返回 ok

curl.exe -s -X POST "$BASE/mcp" -H 'Content-Type: application/json' `
  -H "em_api_key: $EMKEY" `
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

**风险**：地址公开后任何人都能调用函数，消耗你的函数额度（没有妙想 Key 的请求会被代理返回 401，但仍然计费）。如需在匿名模式下加门禁，可设置环境变量 `PROXY_KEY`，客户端再加一个请求头 `x-proxy-key: <同值>`。

### 8.2 方式二：Bearer 认证（推荐）

触发器认证方式选「Bearer 认证」，并设置一个 Token。可以用 PowerShell 生成一个 40 位随机串：

```powershell
-join ((48..57)+(65..90)+(97..122) | Get-Random -Count 40 | ForEach-Object {[char]$_})
```

客户端需要两个请求头：

```json
{
  "mcpServers": {
    "东方财富妙想-阿里云": {
      "type": "streamableHttp",
      "baseUrl": "https://<FC地址>/mcp",
      "headers": {
        "em_api_key": "<妙想Key>",
        "Authorization": "Bearer <FC Token>"
      }
    }
  }
}
```

两个请求头分别由不同的层检查：

```
CherryStudio
  → 阿里云网关：检查 Authorization 中的 FC Token，不对直接返回 403（不进函数、不计函数费用）
  → 本代理：读取 em_api_key 并转发给上游（Authorization 不会被转发）
  → mxapi.eastmoney.com：检查 em_api_key
```

要点：

- `Authorization` 的值是 `Bearer` + 空格 + Token，整体作为一个值，不是 `Bearer=xxx`。
- Bearer 模式下**必须**同时带 `em_api_key`。因为 `Authorization` 已被网关占用，如果缺少 `em_api_key`，代理会把 FC Token 当成妙想 Key 发给上游，导致上游认证失败。

验证：

```powershell
$BASE    = 'https://<FC地址>'
$FCTOKEN = '<FC Token>'
$EMKEY   = '<妙想Key>'

# ① 网关门禁：不带 Token 应返回 403
curl.exe -s "$BASE/health"

# ② 带 Token 应返回 ok
curl.exe -s -H "Authorization: Bearer $FCTOKEN" "$BASE/health"

# ③ 工具列表：应返回 11 个 mx_* 工具
curl.exe -s -X POST "$BASE/mcp" -H 'Content-Type: application/json' `
  -H "Authorization: Bearer $FCTOKEN" -H "em_api_key: $EMKEY" `
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'

# ④ 实际查询：应返回收盘价数据
curl.exe -s -X POST "$BASE/mcp" -H 'Content-Type: application/json' `
  -H "Authorization: Bearer $FCTOKEN" -H "em_api_key: $EMKEY" `
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"mx_ashare_finance_data","arguments":{"query":"杰克科技最新收盘价"}}}'
```

### 8.3 CherryStudio 切换步骤

1. 设置 → MCP 服务器 → 从 JSON 导入，粘贴 8.1 或 8.2 的配置（填入真实值）。
2. 停用原来直连的「东方财富妙想」，避免出现两套同名工具。
3. 连接后确认加载了 **11 个 mx_\* 工具**。

**回退**：重新启用直连配置（URL `https://mxapi.eastmoney.com/mxds/mcp`，只带 `em_api_key`），停用阿里云配置即可。

### 8.4 其他 MCP 客户端

Claude Desktop、Cursor 等客户端使用 `type: "http"` 和 `url` 字段，`headers` 与上面相同：

```json
{
  "mcpServers": {
    "mx-aliyun": {
      "type": "http",
      "url": "https://<FC地址>/mcp",
      "headers": {
        "em_api_key": "<妙想Key>",
        "Authorization": "Bearer <FC Token>"
      }
    }
  }
}
```

---

## 9. 验证与观测

- **切换前后对比**：观察 3–5 天 `%APPDATA%\CherryStudio\logs\app-error.*.log` 中 serverId `79e2fef9` 的 `REQUEST_TIMEOUT` / probe 500 条目是否消失。
- **函数日志**：每次 tools/call 会打一行 `[call] <工具名> <耗时>ms ok|rpc-error|failed`，可直接统计成功率与延迟。
- **会话日志**：`[session] new kh=... sid=... proto=...` 表示新握手；频繁出现说明上游会话保持不稳，可适当调大 `SESSION_TTL_MS`。

---

## 10. 故障排查 FAQ

| 现象 | 原因与处理 |
|---|---|
| 400 `MissingRequiredHeader: required HTTP header Date was not specified` | 触发器是「签名认证」：改为 Bearer 认证或无需认证（见 7.1 第 3 步） |
| 400 `invalid authorization ''` | 同上，签名认证模式 |
| 403 `Authorization header is expected but missing` | 触发器是 Bearer 认证，但客户端没带 `Authorization: Bearer <FC Token>` |
| 403（带了 Token 仍被拒） | Token 不一致：检查是否写成了 `Bearer=xxx`，或 Token 前后带了空格、逗号 |
| 上游返回认证失败，但 Key 是对的 | 检查请求头值是否多了逗号、空格、引号；Bearer 模式下检查是否漏了 `em_api_key` 头 |
| 闲置后第一次连接很慢或超时 | 最小实例数为 0 时的冷启动：重连一次即可，或把最小实例数设为 1 |
| 401 `missing mx api key` | 客户端没带 Key：检查 CherryStudio 服务器的请求头配置 |
| JSON-RPC `-32603` 含 `HTTP 401/403` | 妙想 Key 无效或过期：去东财侧更新 Key |
| 405 `method not allowed` | 对 `/mcp` 发了 GET：本代理无状态、不做 SSE 长连接；CherryStudio legacy 探测偶尔 GET 属正常，忽略即可 |
| 版本协商 10s 超时（偶发） | 冷会话 + 上游瞬时慢：代理已在后台完成握手，客户端下次重连即恢复 |
| 工具调用 ~60s 被掐断 | 客户端侧超时限制：调大 CherryStudio 的 MCP 请求超时；代理侧默认已给到 90s |
| FC 网关 504 | 函数超时 < `UPSTREAM_TIMEOUT_MS`×3：把函数超时调到 ≥ 300s |
| tools/list 返回空 | 上游确实没返回：看函数日志 `[call] tools/list` 行；必要时清 `TOOLS_CACHE_MS` 缓存重启实例 |

---

## 11. 安全说明

- 妙想 Key 只在**请求头**中流动，代理不落盘、不入库、不写日志（对齐 ftshare 代理设计）。
- 推荐使用触发器的 **Bearer 认证**：未授权请求在网关层被拒，不进入函数、不产生函数费用。匿名模式下可用 `PROXY_KEY` 作为替代门禁，但请求已进入函数，仍会计费。
- FC Token 或妙想 Key 一旦出现在聊天记录、截图或公开仓库中，应及时更换。
- `s.yaml` / 环境变量中**不要**写入妙想 Key，保持透传模式。

---

## 12. 已知边界

- 无状态服务：客户端每连接 initialize 一次；上游会话按 Key 指纹隔离复用，不同 Key 互不串会话。
- 不缓存 tools/call 结果（金融数据要求实时性）。
- 并发受上游限流约束：多人共享同一妙想 Key 时，限流仍以 Key 为准，代理只解决稳定性不扩容配额。
- 上游真宕机时（连续 3 次尝试全失败），代理如实返回 `-32603`，不做假数据兜底。
