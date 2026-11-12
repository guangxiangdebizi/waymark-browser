# 技术架构

## 1. 模块边界

```text
AI agent
   │ MCP：name_session / tabs / snapshot / act / challenge / audit
   ▼
MCP API ─────────────── 不可信内容封装与参数校验
   ▼
BrowserRuntime ──────── 页面、引用、导航、动作账本、检查点
   ├───────────────┐
   ▼               ▼
CapabilityRegistry  ChallengeBroker
   │               ├─ Detector / Classifier
   │               ├─ OCR provider
   │               ├─ AI recovery budget
   │               └─ Human takeover / origin revalidation
   ▼
本地或显式远程能力提供器
   ▼
Chromium / CDP / Playwright
   ▼
AuditLog ── events.jsonl + snapshots/*.json ── 本地审计界面
```

首阶段不维护 Chromium fork。现有 Chromium、CDP、MCP SDK 和本地模型已能覆盖纵向闭环；内核改造必须由无法通过该结构满足的真实用例驱动。

## 2. 动作数据流

1. `snapshot` 为可见交互元素分配短期 `ref`，保存快照文本、元素语义和 SHA-256。
2. `act` 只接收 `ref` 与语义参数；填写值和 OCR 答案不进入审计正文。
3. 执行器根据配置选择指针或剪贴板能力，浏览器本地完成轨迹、输入与等待。
4. 成功/失败事件关联 `basisSnapshotId`、哈希、动作前后 URL、能力版本和耗时。
5. 页面稳定后触发挑战检测；挑战任务异步返回，不以长阻塞 MCP 调用等待人工。

## 3. 能力提供器 SDK

```ts
interface CapabilityProvider<I, O> {
  manifest: {
    id: string;
    version: string;
    kind: 'perception' | 'action' | 'challenge' | 'security' | 'recovery' | 'audit';
    runtime: 'node' | 'python' | 'external-process';
    dataEgress: 'local-only' | 'remote';
    description: string;
  };
  invoke(input: I): Promise<O>;
  health?(): Promise<{ ok: boolean; detail?: string }>;
}
```

提供器只生成结构化结果。`CapabilityRegistry` 负责注册与路由，策略层负责执行权限、资源预算和降级。配置通过 `capabilities.pointer`、`capabilities.challengeOcr`、`capabilities.clipboard` 选择实现。剪贴板默认 `action.clipboard.virtual`；驾驶舱可切换并持久化到 `settingsFile`。

当前内置：

- `action.pointer.bezier`：可配置轨迹与节奏。
- `action.clipboard.virtual`：默认会话内虚拟剪贴板，不访问系统剪贴板。
- `action.clipboard.system`：显式启用的系统全局剪贴板，用于跨应用任务。
- `challenge.ocr.ddddocr`：常驻独立 Python 进程，本地识别，固定输入大小和超时；模型懒加载并复用，避免每次请求重复冷启动。

### 能力插槽与插件（已实现）

自动化层按插槽组织：`pointer`（鼠标轨迹）、`ocr`（验证码识别）、`clipboard`（剪贴板）。插槽归属按提供器形状判定（见 `src/capabilities/slots.ts`），插件无需额外注册标记。

- 插件来源：`capabilities.plugins` 中的 JS 模块（导出轨迹模型、完整 CapabilityProvider、数组或工厂函数），或 `command` 外部进程（stdin/stdout 每行一条 JSON，按 `id` 匹配，带超时）。
- 轨迹模型只输出带时间间隔的点列，统一执行器负责实际 CDP 输入；模型拿不到页面、Cookie 或文件系统。点数、坐标和间隔都经过校验，模型出错时退回内置贝塞尔轨迹，动作照常完成。
- OCR 插件与 ddddocr worker 同一契约：输入裁剪后的挑战图片，输出文本；答案只用于本地填写。
- 运行时通过 `POST /api/settings {"slots": {...}}` 或侧栏切换，选择持久化到 `settingsFile`，切换本身写入审计（`settings.pointer` / `settings.ocr` / `settings.clipboard`）。

使用说明见 [plugins.md](plugins.md)。

## 4. 挑战状态机

```text
detected
  ├─ text_image -> ocr_running
  │                  ├─ challenge gone -> resolved_unverified
  │                  └─ failed/remain -> ai_recovery_required
  └─ other ----------> ai_recovery_required
                           ├─ AI resolved -> resolved_unverified
                           ├─ retry within budget -> ai_recovery_required
                           └─ budget exhausted -> human_required
                                                    └─ human_takeover
                                                         └─ origin revalidated -> resolved_unverified
```

- OCR 默认每个挑战一次，AI 默认两次，参数位于配置文件。
- OCR 答案只用于本地填写，审计仅记录长度。
- `resolved_unverified` 只表示挑战阶段结束，业务结果仍需验证。
- 人工接管状态阻止自动读取与动作；origin 变化使检查点失效。
- 完整版本还需挑战实例 ID、页面 generation、账号绑定、幂等键和权威业务结果验证。

## 5. 溯源模型

每个动作包含：事件 ID、单调序号、时间、会话、页面、动作、脱敏目标、快照 ID/SHA-256、前后 URL/标题、能力清单、耗时、状态和错误。快照与事件分开存储，避免重复正文。

审计用于回答：哪个 agent 在什么时间，基于什么页面证据，调用哪个能力，对哪个元素执行了什么动作，结果如何。审计不用于收集密码、Cookie、OTP 或完整浏览历史。



