---
summary: 主动接活：轮询 GitHub 通知，白名单网关放行后自动开 Agent 会话处理，带每日次数与 token 上限。
---
# 主动接活（Proactive Intake）

把 GitHub 上发给你的活自动交给 hark-desk 里的 Agent：

1. **来源**：每隔一段时间读取 GitHub 未读通知（`/notifications`，遵守 `Last-Modified` 与 `X-Poll-Interval`）。
2. **网关**：纯代码白名单，只看仓库和发送人账号，以及 GitHub 给出的通知原因（默认 mention / assign / review_requested / team_mention），不读消息内容来做判断，防止提示注入绕过。白名单为空时不接任何活。
3. **接活**：通过网关的事件用 `conversation.create` 开一个新会话交给选定的 Agent，首条消息带上标题、仓库、发起人、链接和原文（原文标注为数据）。
4. **回报**：会话的完成、失败、权限请求、提问会通过 hark-desk 现有的飞书 / QQ / Telegram 通道推送（沿用全局通道设置）；需要人决定或失败时，桌面端另弹提醒。
5. **上限**：每日接活次数、每日 token、同时进行的会话数。超限只拒绝新活，已在跑的跑完；被拒的通知不会标记已处理，额度空出后再接。token 只统计 Agent 上报的用量，没上报的单独计数，不当成 0。

## 配置

在插件设置里填写：

| 项 | 说明 |
| --- | --- |
| 开启主动接活 | 总开关，默认关 |
| GitHub token | 可选。保存后下次检查时移入系统钥匙串并从 `config.json` 清除；留空用 `gh auth token` |
| 关注的仓库 | `owner/name` 列表，留空表示全部 |
| 白名单 | 能发起工作的 GitHub 账号 |
| 接活用的 Agent | 留空用目录里第一个 |
| 每日次数 / token / 并发上限 | 0 表示不限（并发最少 1） |

状态栏显示今日接活次数，悬停看详情。命令面板有「立即检查」和「删除保存的 GitHub token」。

## 试用

```bash
node packages/plugin-cli/dist/cli.js build plugins/proactive-intake
vibex plugin add --dev plugins/proactive-intake
```

## 致谢

网关与上限的设计移植自 [Superagent / dsh-superagent-prototype](https://github.com/xyt071024/dsh-superagent-cn)（MIT, Copyright (c) 2026 DeepSeek Harness Team），见仓库根目录 `THIRD_PARTY_NOTICES.md`。
