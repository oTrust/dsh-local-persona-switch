# dsh-local-persona-switch

[![English](https://img.shields.io/badge/README-English-blue)](./README.md)
[![简体中文](https://img.shields.io/badge/README-%E7%AE%80%E4%BD%93%E4%B8%AD%E6%96%87-red)](./README.zh.md)

一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件：根据当前模型是**本地部署**还是**云端**，自动把 deployment **persona（人格）** 切换成不同的 markdown 文件。

典型用途：本地小模型使用更精简、更快的人格提示，云端模型继续使用完整人格。

## 判定方式

插件按以下顺序把每个 route 判定为 `local` 或 `cloud`：

1. **provider id** —— 与 `localPatterns` 做子串匹配（忽略大小写），与 `localProviders` 做精确匹配。默认内置 `ollama`、`llama-cpp`、`lmstudio`、`vllm`、`koboldcpp`、`local` 等常见本地路由名。
2. **baseURL 主机名** —— 可从 harness settings 服务读到时就读取，也可用 `baseURL` 选项直接指定。回环地址与私有 IPv4 段（`127.*`、`10.*`、`192.168.*`、`172.16–31.*`）一律判为本地。

插件不绑定任何特定机器：人格文件默认从 `$DSH_HOME`（不存在则 `~/.dsh`）推导。

## 安装

```bash
dsh plugin --profile <你的profile> add dsh-local-persona-switch
```

或手动写进 profile 的 `package.json`：

```json
{
  "dependencies": { "dsh-local-persona-switch": "^0.1.0" },
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "dsh-local-persona-switch"] } }
}
```

然后创建两个人格文件（默认路径如下）：

- `$DSH_HOME/AGENTS-local.md` —— 本地路由使用
- `$DSH_HOME/AGENTS-cloud.md` —— 其他情况使用

文件不存在不会报错，该 section 保持为空。`examples/` 目录下有两份模板可直接改。

## 配置

在 profile 的 `cordis.patch.yml` 里覆盖任意默认值：

```yaml
- id: local-persona-switch
  name: dsh-local-persona-switch
  config:
    localProviders:
      - my-local-box
    localPatterns:
      - ollama
      - llama-cpp
    localHosts:
      - localhost
      - 127.0.0.1
    localPersonaFile: /opt/personas/AGENTS-local.md
    cloudPersonaFile: /opt/personas/AGENTS-cloud.md
    watchFiles: true
    log: true
```

| 选项 | 默认值 | 含义 |
|---|---|---|
| `localProviders` | `[]` | 即使没命中 pattern 也强制判为本地的 provider id |
| `localPatterns` | 内置列表 | 与 provider route id 做子串匹配 |
| `localHosts` | `localhost`、`127.0.0.1`、`::1` 等 | 命中即判为本地的主机名 |
| `baseURL` | 未设置 | 读不到 settings 时用于判定的固定端点 |
| `localPersonaFile` | `$DSH_HOME/AGENTS-local.md` | 本地路由使用的人格文件 |
| `cloudPersonaFile` | `$DSH_HOME/AGENTS-cloud.md` | 其他情况使用；设为空字符串则不做覆盖 |
| `watchFiles` | `true` | 文件 mtime 变化时重新读取 |
| `log` | `true` | 每次判定变化输出一行 info 日志 |

## 生效方式

插件挂在 `system-prompt/assemble` 瀑布上，**原地改写**名为 `deployment:persona` 的 section：只替换 `text`，保留 harness 身份、工具指引等相邻 section，其他 agent 与其他 scope 不受影响。

之所以不用 `agent/pre-step`：`dsh-agent-loop` 是**先**组装提示词、**再**派发 `agent/pre-step`。在 pre-step 里注册人格会晚一步，切换要到下一回合才体现。

人格文件为空或不存在时不改动组装结果，因此把 `cloudPersonaFile` 设为空字符串等价于「云端不覆盖」。

## 验证

```bash
node test/smoke.mjs      # 纯逻辑 + 模拟上下文（16 项）
node test/entry.mjs      # 模块入口导出
node test/installed.mjs  # 挂载进真实的 @deepseek-ai/cordis 瀑布
```

`test/installed.mjs` 从 `desktop` profile 解析依赖，验证的就是应用真正加载的那份副本。改 `DSH_PROFILE_DIR` 可指向别的 profile。

## 已知限制

- 本地判定是启发式的：provider 名陌生时会被判为云端，需把它加进 `localProviders`。
- `provider` 取自 `agent.options.provider` —— 与 `dsh-agent-loop` 构造请求路由用的是同一个值。`LlmProviderInfo` 不含端点信息，因此 `baseURL` 只能通过配置项提供。
- `system-prompt/assemble` 这个瀑布名和 `deployment:persona` 这个 section 名是与 harness 的契约，任一方改名都需要同步修改本插件。

## License

MIT
