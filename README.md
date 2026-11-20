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
   │  ④ SSE→JSON 解析、outputSchema 剥离、工具白名单
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
| 7 | 工具白名单 | 只透传妙想工具 | `TOOL_FILTER_REGEX`（默认 `^mx_`） |

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
| `TOOL_FILTER_REGEX` | `^mx_` | 工具白名单正则；**置空字符串放行全部** |
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
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"mx_ashare_financial_data","arguments":{"query":"杰克科技最新收盘价"}}}'
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

### 7.1 控制台部署（推荐首次使用）

1. 打开函数计算 3.0 控制台（`fcnext.console.aliyun.com`），选择地域（如华东1-杭州）。
2. 函数 → 创建函数 → 选择 **Web 函数**：请求处理器类型选「处理 HTTP 请求」。
3. 运行环境：**自定义运行时 Debian**（内置 Node.js；若版本低于 18，改用 custom-container + `node:20-alpine` 镜像，或通过层自带 Node）。
4. 代码上传：把 `index.js` + `package.json` 打成 zip 上传（无 node_modules，零依赖）。
5. 启动命令：`node index.js`；监听端口：`9000`。
6. 函数超时：**≥ 300 秒**（要容纳 90s 业务超时 × 3 次重试 + 退避）；单实例并发建议 10。
7. 环境变量：按第 5 节表格填写（至少 `MX_UPSTREAM`、`MX_AUTH_HEADER`、两个 TIMEOUT）。
8. 触发器：HTTP 触发器，认证选「匿名」，获得公网地址 `https://<域名>/`，妙想 MCP 的新 URL 即 `https://<域名>/mcp`。

### 7.2 Serverless Devs CLI 部署

```bash
npm i -g @serverless-devs/s
s config add                    # 配置阿里云 AccessKey
cd mx_aliyun
s deploy                         # 使用本目录 s.yaml
```

`s.yaml` 为模板，若与当前 fc3 组件 schema 有出入，以 `s` 报错提示或控制台为准微调。

### 7.3 可选：定时预热

冷启动约 1–2s。可加定时触发器每 5 分钟 `GET /health` 保持实例温热（收益有限，可不配）。

---

## 8. CherryStudio 切换配置（关键步骤）

设置 → MCP 服务器 → 「东方财富妙想」：

| 项 | 原值（直连） | 改为（走阿里云） |
|---|---|---|
| 类型 | streamableHttp | **不变** |
| URL | `https://mxapi.eastmoney.com/mxds/mcp` | `https://<FC触发器域名>/mcp` |
| 请求头 | `em_api_key: <妙想Key>` | **不变**（或换成 `em-api-key` / `Authorization: Bearer` 任一） |
| （可选） | — | 若设了 `PROXY_KEY`，另加 `x-proxy-key: <门禁密钥>` |

保存后重连/重启，确认工具列表恢复（应为 **11 个 mx_\* 工具**）。
**回退**：URL 改回原值即恢复直连，无任何残留。

---

## 9. 验证与观测

- **切换前后对比**：观察 3–5 天 `%APPDATA%\CherryStudio\logs\app-error.*.log` 中 serverId `79e2fef9` 的 `REQUEST_TIMEOUT` / probe 500 条目是否消失。
- **函数日志**：每次 tools/call 会打一行 `[call] <工具名> <耗时>ms ok|rpc-error|failed`，可直接统计成功率与延迟。
- **会话日志**：`[session] new kh=... sid=... proto=...` 表示新握手；频繁出现说明上游会话保持不稳，可适当调大 `SESSION_TTL_MS`。

---

## 10. 故障排查 FAQ

| 现象 | 原因与处理 |
|---|---|
| 401 `missing mx api key` | 客户端没带 Key：检查 CherryStudio 服务器的请求头配置 |
| JSON-RPC `-32603` 含 `HTTP 401/403` | 妙想 Key 无效或过期：去东财侧更新 Key |
| 405 `method not allowed` | 对 `/mcp` 发了 GET：本代理无状态、不做 SSE 长连接；CherryStudio legacy 探测偶尔 GET 属正常，忽略即可 |
| 版本协商 10s 超时（偶发） | 冷会话 + 上游瞬时慢：代理已在后台完成握手，客户端下次重连即恢复 |
| 工具调用 ~60s 被掐断 | 客户端侧超时限制：调大 CherryStudio 的 MCP 请求超时；代理侧默认已给到 90s |
| FC 网关 504 | 函数超时 < `UPSTREAM_TIMEOUT_MS`×3：把函数超时调到 ≥ 300s |
| `工具 xx 未开放` | 命中白名单：确认识别工具名，或把 `TOOL_FILTER_REGEX` 置空放行 |
| tools/list 返回空 | 上游确实没返回：看函数日志 `[call] tools/list` 行；必要时清 `TOOLS_CACHE_MS` 缓存重启实例 |

---

## 11. 安全说明

- 妙想 Key 只在**请求头**中流动，代理不落盘、不入库、不写日志（对齐 ftshare 代理设计）。
- FC 触发器默认匿名公网：建议绑自定义域名 + 设置 `PROXY_KEY` 门禁，避免中转地址被他人白嫖（无 Key 的调用会被上游 401 拒绝，但会消耗你的函数调用额度）。
- `s.yaml` / 环境变量中**不要**写入妙想 Key，保持透传模式。

---

## 12. 已知边界

- 无状态服务：客户端每连接 initialize 一次；上游会话按 Key 指纹隔离复用，不同 Key 互不串会话。
- 不缓存 tools/call 结果（金融数据要求实时性）。
- 并发受上游限流约束：多人共享同一妙想 Key 时，限流仍以 Key 为准，代理只解决稳定性不扩容配额。
- 上游真宕机时（连续 3 次尝试全失败），代理如实返回 `-32603`，不做假数据兜底。
