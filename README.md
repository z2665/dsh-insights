# DSH Insights

把 `/insights` 带进 DeepSeek Harness：读取本机 `~/.dsh/sessions` 里的会话日志，生成一份交互式 HTML 报告，回答三个问题——**时间花在哪、哪里卡住、下次怎么少说一遍**。

报告完全本地生成，不上传代码，零外部依赖。

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
plugin_manager install_bundle  target = github:<owner>/dsh-insights
plugin_manager install_bundle  target = github:<owner>/dsh-insights#v1.0.0   # 固定 tag / commit
```

也可以给完整的 git URL：`git+https://github.com/<owner>/dsh-insights.git`。

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

所有模型输出按内容哈希缓存在 `~/.dsh/usage-data/facets/`，只有会话内容变化时才重新分析。模型调用失败会自动降级为规则版，不会中断报告生成。

## 隐私

- 只读本地会话日志，不写会话数据。
- 报告只写在本机 `~/.dsh/usage-data/`。
- 开启模型分析时，只有压缩后的对话摘录（用户消息、助手回复节选、工具名与错误行）会发往当前配置的模型服务，不包含文件内容。

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
