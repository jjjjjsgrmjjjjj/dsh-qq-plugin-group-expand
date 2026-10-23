# 宿主流式帧的形态（第一步实测记录）

这些事实来自**第一步能力体检**：宿主的事件词汇没有文档，只能把实际收到的帧印出来学。

**它们原先是以"每次启动写五行日志"的形式留着的。那些日志已经删除**——理由是它们把真正
有用的行淹没了：排查"会话夹进不去"时，日志尾部的非 sdk 行全是这五条，而想找的
"路由做了什么"一个字都没有。**观测手段本身变成了观测的障碍。**

所以事实搬到这里。日志只留**当前**需要的东西。

---

## `agent/assistant-stream` 的载荷形状

```
payload.agent.session.id        → 会话 id
payload.frame.type              → 'start' | 'chunk' | 'end' | …
payload.frame.chunk.type        → 'text-delta' | 'tool-call-delta' | 'block-start' | …
```

`frame.type === 'end'` 是**唯一的回合结束信号**。
（`chunk.type === 'finish'` 刻意**不算**结束——它在回合真正结束前就会出现。）

## 帧的字段清单（实测）

| `frame.type` | 字段 | 备注 |
|---|---|---|
| `start` | `type, attemptId, revision, turn, step` | 载荷里没有 `chunk` |
| `chunk` | `type, chunk` | 真正的载荷在 `chunk` 里 |
| `end` | `type` | 没有 `chunk` |

## chunk 的字段清单（实测）

| `chunk.type` | 字段 | 备注 |
|---|---|---|
| `text-delta` | `type, text` | **模型真正的输出** |
| `tool-call-delta` | `type, index, id, argumentsDelta` | ★ **不带工具名** |
| `block-start` | `type, index, blockType` | ★ **工具名在这里** |
| `block-end` | `type, index` | |
| `reasoning-delta` | — | 不是用户可见文本 |
| `usage` | — | 不是用户可见文本 |
| `finish` | — | **不是**回合结束信号 |

## 两条承重的结论

1. **`tool-call-delta` 不带工具名。** 它只有 `id` 与 `argumentsDelta`。
   所以"工具名从哪来"这个问题，只可能在 `block-start` 上找到答案——
   而那**必须靠观测**：当时漏记了 `block-start` 的字段，
   于是"它到底带不带工具名"在日志里查不到。
   **问题不是无解，而是不可观测**；没有观测记录的假设，和错误的假设无法区分。

2. **工具名确实在 `block-start` 的 `blockType` 上。** 这是当时靠上面那条观测拿到的。

## 为什么现在可以删掉那些日志

原注释里写的理由是"**工具进度卡片要靠它**"。**工具卡片功能已取消并回退**，
所以那条理由不再成立。而事实本身——尤其第 1、2 条——已经记在本文件里，
下一个人要做类似的东西时不必重新观测一遍。

## 如果将来还需要观测

**不要把它们加回每次启动的路径上。** 正确的做法是：
临时的、带开关的、或者只在你真正要查那个问题的那一次打开。
判断标准很简单——**如果一行日志不是你现在要读的，它就在妨碍你读那一行。**
