# DSH Insights

<img src="icon.png" alt="DSH Insights" width="140" align="left" hspace="16" vspace="4">

把 `/insights` 带进 DeepSeek Harness：读取本机 `~/.dsh/sessions` 里的会话日志，生成一份交互式 HTML 报告，回答三个问题——**时间花在哪、哪里卡住、下次怎么少说一遍**。

报告完全本地生成，不上传代码，零外部依赖。

<br clear="left">

## 它产出什么

| 区块 | 内容 |
| --- | --- |
| 一眼看完 | 什么在起作用 / 什么在拖后腿 / 快赢 / 更大的机会 |
| 活跃度 | 日历、时段分布、每日消息量（可切换时区） |
| 工具与语言 | 工具调用量与失败率、改动过的文件类型、反复出现的指令 |
| 会话构成 | 任务目标占比、会话类型、满意度分布 |
| 摩擦点 | 需求误解、工具失败、反复修改、操作被拒等，附原始证据 |
| AGENTS.md | 可直接复制粘贴的规则，按分类分组 |
| 下一步 | 针对实际用法的功能建议（子代理、Skill、todo、脚本化） |
| 明细 | 每个会话的时长、消息数、工具数、目标、满意度，可排序筛选 |

## 安装

要求：DSH 0.2.x（Desktop 或 Web profile）、Node ≥ 22.15（读取 zstd 会话日志）。没有运行时依赖。

**本地目录安装**（开发或自用）：

在 DSH 里让智能体执行，或使用插件管理界面安装本地包，目标指向本仓库的绝对路径：

```
plugin_manager install_bundle  target = <path-to-repo>
```

`install_bundle` 会写 profile 的依赖与 bundle 列表，不要手改 `cordis.patch.yml`、`package.json` 或跑 pnpm。

**从 npm 安装**（发布之后）：

```
plugin_manager install_bundle  target = dsh-insights@1.0.0
```

**从 GitHub 仓库安装**（无需发布）：

```
plugin_manager install_bundle  target = github:z2665/dsh-insights
plugin_manager install_bundle  target = github:z2665/dsh-insights#v1.0.0   # 固定 tag / commit
```

也可以给完整的 git URL：`git+https://github.com/z2665/dsh-insights.git`。仓库当前是私有的，安装方需要有该仓库的 git 访问权限（凭据由 git 的 credential helper / SSH 提供，插件管理器不会弹交互式登录）。

本包是"零构建"的：`index.js` 与 `src/` 就是运行入口，没有 `prepare`/`build` 脚本，所以 git 安装不需要打包产物；`files` 白名单会把 `test/`、`dev/` 排除，安装时只拉运行文件。git 安装的版本兼容检查发生在拉取之后，本包不声明 `engines.dsh` 或 DSH peer，因此不会触发兼容拒绝；失败时插件管理器会回滚 profile 的 `package.json` 与 lockfile。

**手动安装**（不推荐，仅说明 install_bundle 做了什么）：

```json
// ~/.dsh/profiles/<profile>/package.json
{
  "dependencies": { "dsh-insights": "link:<path-to-repo>" },
  "dsh": { "profile": { "bundles": ["...", "dsh-insights"] } }
}
```

安装后刷新一次 GUI 页面：浏览器端的命令目录在页面加载时拉取，刷新后 `/` 菜单里才会出现 `insights`。

## 使用

在任意会话里：

```
/insights                  # 最近 30 天
/insights 7                # 最近 7 天
/insights --project dig    # 只看某个项目
/insights --no-llm         # 不调用模型，纯规则模式（会复用历史分析缓存）
/insights --refresh        # 忽略缓存，重新分析每个会话
```

生成后：

- 浏览器打开 `http://127.0.0.1:<port>/insights`
- 或直接看文件 `~/.dsh/usage-data/report.html`
- 智能体也可以调用 `insights_report` 工具（参数 `days`、`project`、`use_model`、`refresh`），返回值里带报告路径、URL 和主要摩擦点

## 配置

在 bundle 的配置里（`cordis.patch.yml` 的 `config`）可以改：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `days` | `30` | 默认分析窗口（天） |
| `maxSessions` | `60` | 单次最多分析多少个会话，最新的优先 |
| `useModel` | `true` | 是否调用模型做逐会话摘要与跨会话综合 |
| `concurrency` | `3` | 并行模型调用数 |
| `model` | 当前默认模型 | 形如 `{ "provider": "deepseek-account", "model": "deepseek-flash" }` |
| `reportDir` | `~/.dsh/usage-data` | 报告与缓存目录 |

## 工作原理

1. **采集**：扫描 `sessions/<project>/<session>/session.v*.jsonl.zstd`，按帧魔数切分并逐帧解压（DSH 是追加式多帧日志，Node 自带的解压只认第一帧）。
2. **过滤**：跳过子代理会话、种子会话、只有 1 条消息且不到 1 分钟的空壳会话。
3. **规则信号**：工具调用与失败、文件编辑分布、语言分布、审批拒绝、中断、重复修改、跨会话重复指令、时段与连续天数。
4. **模型增强**（可选）：每个会话压缩成 ≤11k 字符的记录，让模型输出结构化 facet（目标、类型、结果、满意度、摩擦点、重复指令）；再做一次跨会话综合，产出结论与 AGENTS.md 规则。
5. **渲染**：单文件 HTML，内联 CSS/JS/SVG，无外部依赖，可离线打开、可打印成 PDF。

**磁盘上只有一个报告文件**：每次运行都覆盖 `~/.dsh/usage-data/report.html`（固定临时名 + rename，不生成带时间戳的副本，异常时也会清掉临时文件）。`facets/` 缓存按会话内容哈希，窗口外的条目 30 天后自动删除，目录最多保留 400 个文件；`last-run.json` 只存计数快照，用于"较上次"对比。模型调用失败会自动降级为规则版，不会中断报告生成。

## 安全与隐私

### 数据怎么流动

```
~/.dsh/sessions/**/session.v*.jsonl.zstd      （只读）
        │  解压 + 解析，跳过子代理/空会话
        ▼
内存中的会话对象 ──规则统计──► 报告数据 ──► report.html（本地覆盖写）
        │
        └──可选──► 模型 provider（每个会话 ≤11k 字符摘录）
```

### 会写到磁盘的东西

| 文件 | 内容 | 生命周期 |
| --- | --- | --- |
| `~/.dsh/usage-data/report.html` | 完整报告 | 每次覆盖，仅一份 |
| `~/.dsh/usage-data/facets/<session>.json` | 模型生成的摘要、**用户原话片段**（摩擦证据） | 30 天后 / 超过 400 个自动清理 |
| `~/.dsh/usage-data/synthesis.json` | 跨会话总结与规则 | 每次覆盖 |
| `~/.dsh/usage-data/last-run.json` | 计数快照 | 每次覆盖 |
| `~/.dsh/usage-data/plugin-status.json` | 激活状态 | 每次启动覆盖 |

### 模型调用会发送什么

开启模型分析（默认）时，每个会话的摘录会发往当前配置的 provider，内容包括：用户消息、助手回复节选（每条 ≤280 字符）、工具名与错误首行、会话标题与项目名。

- **不发送**：文件正文、工具参数原文、图片、附件、系统提示词。
- **可能包含**：助手回复里被引用的少量代码片段（因为那是对话文本的一部分）。介意的话用 `/insights --no-llm` 完全离线跑规则版。

### 对外暴露的接口

`/insights` 路由挂在 DSH 自带的 webServer 上，**不新建服务、不新建端口**，绑定 `127.0.0.1`。但它**不经 GUI 的登录 token 校验**：

```
GET /            → 401（需要 dsh web 的 token）
GET /insights    → 200（插件路由直接响应）
```

也就是说：同一台机器上的任何进程/脚本，只要知道当前端口，就能读到报告内容（会话标题、项目名、用户原话片段）。风险范围限于本机、且端口每次启动随机；但**不要在共享机器上把它当作私密数据**。需要更强隔离时的加固方向（尚未实现）：一次性 token 查询参数、校验 GUI 会话 Cookie、或改成只写文件不挂路由。

### 渲染与注入

- 所有来自会话的文本在写入 HTML 前统一做实体转义；嵌入的 JSON 把 `<` 转成 `\u003c`，避免 `</script>` 截断注入。
- 报告没有外部资源、没有远程请求、没有 `eval`；即使会话内容里含恶意 HTML，也只会显示为文本。
- 插件在 Host 进程内以当前用户权限运行（profile 插件不受工作区沙箱约束），但代码只读 `sessions/`、只写 `usage-data/`。

## 排查

插件激活结果写在 `~/.dsh/usage-data/plugin-status.json`：

```json
{ "tools": true, "commands": true, "webServer": true, "commandRegistered": true, "commandError": null }
```

- `commands: false`：命令注册表尚未建立。插件声明了 `inject = ['tools', 'commands']`，DSH 会等它就绪再激活，冷启动不会漏注册。
- `/insights` 不在斜杠菜单里：刷新页面（命令目录按页面/会话缓存），或直接用工具 `insights_report`。
- 报告为空：确认分析窗口内有会话，且没有用 `--project` 过滤掉全部会话；报告顶部会显示跳过统计。

## 兼容性

- 会话日志按 `session.v4` 格式解析；DSH 升级日志格式后需要同步 `src/collect.js`，未知版本会被跳过并计入跳过统计。
- `/insights` 页面路由需要 `webServer`；没有 HTTP 载体的部署里命令与工具仍然可用。
- 无构建步骤、无运行时依赖，安装即为源码。

## 开发

```
npm test                 # node --test：zstd 多帧、采集过滤、信号规则
npm run check            # 逐文件语法检查
node dev/probe-collect.mjs 30       # 看采集结果
node dev/build-report.mjs 30        # 用真实会话生成 dev/report.html（不调模型）
```

结构：

```
index.js              Cordis 入口：命令、工具、HTTP 路由
src/zstd.js           多帧 zstd + JSONL 读取
src/collect.js        会话发现、解析、过滤
src/signals.js        确定性统计与摩擦信号
src/llm.js            facet / 综合摘要与缓存
src/insights.js       编排与合并
src/report.js         单文件 HTML 报告
```

## License

MIT
