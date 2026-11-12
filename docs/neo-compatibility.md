# BrowserOS neo 兼容矩阵

目标为渐进迁移，不是首版宣称完全替代。

| neo 能力 | 当前状态 | 说明 |
|---|---|---|
| `name_session` | 基础兼容 | 会话名进入动作账本 |
| `tabs` | 部分兼容 | list/new/active/close；标签组未实现 |
| `navigate` | 基础兼容 | url/back/forward/reload |
| `snapshot` | 部分兼容 | DOM 交互快照；完整 AX/iframe 未实现 |
| `read` | 部分兼容 | 可见文本；markdown 语义未实现 |
| `act` | 部分兼容 | click/fill/copy/paste/press/scroll/hover |
| `wait` | 基础兼容 | text/selector/time，最长 30 秒 |
| `capabilities` | 新增 | 模型/动作提供器与版本元数据 |
| `challenge` | 新增 | OCR -> AI -> 人工异步恢复 |
| `audit` | 新增 | 动作账本与快照依据 |
| `run` | 未实现 | 需要隔离 JS 运行时和 browser/page SDK |
| `evaluate` | 未实现 | 默认不开放任意页面脚本 |
| `screenshot` / `pdf` | 未实现 | 列入 P1 |
| `upload` / `download` | 未实现 | 需要文件策略与检测链 |
| `request_human_help` / `await_human_help` | 由 `challenge` 替代 | 后续增加同名兼容包装 |
| 标签组、窗口、历史 | 未实现 | 列入迁移阶段 |
| MCP Streamable HTTP | 已实现 | 默认 `127.0.0.1:9410/mcp` |

## 迁移顺序

1. 用真实任务对比高频 granular 工具的输入、输出和错误语义。
2. 补标签归属、快照 AX、跨 iframe 和文件链路。
3. 实现 `run` 沙箱及 SDK，再迁移使用 helper 的复杂任务。
4. 同一任务在 neo 与新浏览器双跑，对比成功率、耗时、token、人工接管次数和审计完整性。
5. 达到门槛后修改客户端 MCP 地址，保留 neo 回退，不直接卸载。

