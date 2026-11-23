# dsh-local-persona-switch

[English](./README.md) | 中文

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

在 `agent/pre-step` 阶段，插件以 **agent 自身的 scope** 注册名为 `deployment:persona`、order 为 `0` 的 section，只对该 agent 覆盖 deployment persona，不影响其他 agent。若当前版本没有 per-agent 的 `systemPrompt` 服务，则退化为注入一段 runtime context。

人格内容未变化时不会重复注册：插件按 agent 记录 digest 去重。

## 验证

```bash
node test/smoke.mjs   # 纯逻辑 + 模拟 Cordis 上下文
node test/entry.mjs   # 模块入口导出
```

实测（真实 `@deepseek-ai/cordis` 挂载并派发 `agent/pre-step`）结果：

| provider | 结果 |
|---|---|
| `ollama` | 本地人格 |
| `local-moe` | 本地人格 |
| `openai` | 云端人格 |
| `workbuddy` | 云端人格 |

## 已知限制

- 本地判定是启发式的：provider 名陌生且读不到 baseURL 时会被判为云端，需把它加进 `localProviders`。
- 人格文本为空时不会应用覆盖；因此把 `cloudPersonaFile` 设为空字符串等价于「云端不覆盖」。
- baseURL 读取是 best-effort；不暴露 provider settings 的 harness 版本仍可通过 provider 名规则正常工作。
- 依赖 `agent/pre-step` 与 `systemPrompt.section`；若 harness 改动这两个接口，需要相应调整。

## License

MIT
