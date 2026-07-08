# 小合陪伴 · PLAN

> Living doc。每完成一步 update + commit。
> 完整设计背景（含 InkLoop 架构对齐、三层上下文、compact/memory 分工）见原始设计：
> `panel-workplace/dev/server/bot/xiaohe-agent-sdk/PLAN.md` §12。本文件是抽出独立 repo 后的精简执行版。

## 定位
独立陪伴型飞书 bot，替换原 panel 内嵌 bot。纯陪伴，不碰 panel 数据。人设=温柔知心的朋友。

## 架构基线（对齐 InkLoop）
API 无状态；状态全在每次现装的 system（纯静态人设 + cache_control）+ 现渲染的 user turn（`renderCompanionTurn`：记忆/专属上下文/召回/当前请求）。长延续靠召回不靠长 transcript。模型=MiniMax-M3（1M）。

## 三层上下文
- **session**：当前连续聊天窗口（可 compact/裁剪）。
- **专属上下文**：跨天关系状态（上次聊到哪/open loops/主动说过啥）——自己的 SQLite（`src/db/`，C3 起用）。
- **memory**：长期人物画像（`src/memory/` markdown）。

## Build order
- **C1 ✅ 已建**：反应式陪伴最小闭环。飞书 WS → 白名单私聊 → `runCompanionMessage`（静态人设 system + `renderCompanionTurn` 动态 turn + M3 + `remember_about_person` 工具 + companion 权限）→ 轻量流式卡。`npm run smoke` 12 项过。**待真跑**：私聊验温度 + M3 流式/tool + 记忆写读。
- **C2** 白名单落 DB + 身份映射（openId→显示名，让人设知道在陪谁）。当前白名单走 env、boundUser=null。
- **C3** 专属上下文 SQLite（`companion_people/turns/context/followups`）——跨天"记得上次聊到哪"。这是"记不住人"的真正解药。同时把 history 从空接上滑动窗。
- **C4** 陪伴 distill（会话结束/idle 整理进 memory，去重）。
- **C5** 轻量 compact（engine 加 compactManager，只在安全边界；MiniMax 窗口阈值）。
- **C6** 主动关心 v1：`companion_hooks` + scheduler（规则触发：定时问候/跟进待办/节日）。主动消息写回专属上下文。
- **C7** 主动关心 v2：LLM decider + 冷却/静默门控（守"别打扰"）。
- **C8** 召回层：按当前话题从记忆/往事库捞相关片段注入 user turn（对齐 InkLoop 向量主题层）。

## 已知待验证
- **M3 流式 + tool use**：highspeed 实测过，M3 只在会议总结（非流式）用过。C1 真跑第一件事验，不行就 `BOT_COMPANION_MODEL=MiniMax-M2.7-highspeed` 降级。
- 轻量 streamer（`feishu/streamer.js`）是新写的（非旧 ChatCardStreamer），真跑看流式/收尾是否顺。

## 已砍（纯陪伴，相对旧 bot）
查工单/工单通知/绑定 panel 账号/会议纪要/巡检。要恢复见原 PLAN 二阶段（走 panel MCP）。
