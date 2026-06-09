# XHS Light Mode Learnings

**Logged**: 2026-06-09
**Scope**: `xhs-bulk-download-audit` / `xhs-bulk-download`
**Status**: reusable project guidance

## 核心结论

以后下载用户已授权保存的小红书图片时，优先使用 `light` 模式，而不是默认 `normal` 模式。

推荐命令：

```powershell
node scripts\bulk-download.mjs "<小红书主页URL>" ".\xhs_downloads" --mode light --until-end --user-subdir --rest-every 3
```

如果已经用持久 Chrome profile 登录过：

```powershell
node scripts\bulk-download.mjs "<小红书主页URL>" ".\xhs_downloads" --profile "$env:USERPROFILE\.xhs-bulk-download-profile" --skip-login --mode light --until-end --user-subdir --rest-every 3
```

## 成功操作模式

这次实际跑通的模式不是“先滚很多页再集中下载”，而是：

1. 读取当前可见笔记卡片的 `noteId` 和 `xsec_token`
2. 先把当前可见批次处理完
3. 追加写入 manifest，成功记录才算断点完成
4. 再滚动下一屏
5. 每 3 次滚动休息一会
6. 遇到明确频繁访问或异常访问提示就停止，保留断点

这个节奏的价值是低负载、可断点、容易停在干净状态，也更接近用户手工逐屏保存的工作流。

## 实现要点

### 1. 详情和图片都要在浏览器上下文取

`light` 模式不要用 Node 裸 `fetch` 去取详情页或图片。应使用 Puppeteer 的页面上下文：

- 详情 HTML：`page.evaluate(() => fetch(noteUrl))`
- 图片字节：复用 normal 模式已跑通的 `fetch -> blob -> FileReader -> base64`

原因不是追求激进，而是可靠性：页面上下文天然带当前 Chrome 会话、cookie、referer 和浏览器请求行为；Node 裸 fetch 容易出现 session 缺失、图片 403、详情空壳等问题。

### 2. 风险词要收紧

不要把 `验证码`、`安全验证`、`captcha`、`verify` 这类词作为泛匹配风险词。用户笔记标题或正文可能自然出现这些词，容易误报。

保留强信号即可：

- `300013`
- `安全限制`
- `访问频繁`
- `访问异常`
- `操作过于频繁`
- `请勿频繁操作`
- `请稍后再试`
- URL 侧只匹配 `error_code=300013`

### 3. 失败分类不能混

manifest 里要区分：

- `kind: "image"`：图片笔记，至少一张图片成功
- `kind: "text"`：纯文字笔记，0 张图片，属于正常完成
- `kind: "image_failed"`：详情里有图片，但图片全部失败
- `kind: "detail_failed"`：详情页或初始 state 没拿到
- `kind: "risk"`：明确风险信号

尤其不要把“纯文字笔记”和“有图但全 403”都算成普通成功，否则会掩盖失败率。

### 4. manifest 用 append-only

轻量模式使用 `manifest-light.jsonl` 追加写入，避免每篇笔记全量重写造成 O(n^2)。

兼容旧记录时可以读取旧版 `manifest-light.json`，但新记录只追加到 JSONL。

### 5. 分目录保存

实际下载时必须按用户名分目录：

```text
xhs_downloads/<用户名>/*.webp
```

不要把不同博主混在同一个目录里。之前出现过“苏苏没烦恼”和其他用户目录混淆的问题，后来用 `--user-subdir` 固化。

## 这次遇到的问题和修复

### Chrome/Codex 插件连接

Windows Codex 桌面端显示 Chrome plugin `Connected`，但工具调用仍可能失败。曾经通过把 `~/.codex/config.toml` 的 Windows sandbox 设置调整为 `unelevated` 后恢复：

```toml
[windows]
sandbox = "unelevated"
```

如果另一台电脑要复现 Codex + Chrome 插件的手工浏览器控制流程，需要：

- Codex Windows 桌面客户端
- Chrome Codex 插件已安装并显示 connected
- 使用已登录小红书的同一 Chrome profile
- 若连接异常，检查 `~/.codex/config.toml` 的 Windows sandbox 设置

### Puppeteer 项目模式

这个 repo 自身是 Puppeteer 项目，不等同于 Codex Chrome 插件。项目模式需要显式使用：

```powershell
--mode light
```

否则默认是 `normal`。

## 代码检查清单

合并或修改 light mode 前，至少检查这些项：

1. `downloadNoteLight` 不应调用 Node 裸 `fetchText` / `fetchImageBytes`
2. 不应存在 `vm.runInNewContext` 执行网络返回内容
3. 图片下载应走页面内 `fetch -> blob -> FileReader -> base64`
4. `isRiskText` 不应泛匹配 `验证码/captcha/verify`
5. URL 风险匹配应收紧到 `error_code=300013`
6. 详情 HTML 风险扫描不能只扫前 2000 字
7. 纯文字和图片全失败要分开统计
8. manifest 应 append-only
9. light 启动应读取旧 manifest 和 `.xhs-attempted.json` 用于断点
10. 滚动后应等待瀑布流渲染，并小幅回滚补抓当前窗口

## 验证命令

```powershell
node --check scripts\bulk-download.mjs
git diff --check
node scripts\bulk-download.mjs
```

无参数运行应输出 usage，不应触发真实小红书流量。

## 建议进入长期记忆的规则

- 在这个项目里，XHS 批量下载默认优先推荐 `--mode light --until-end --user-subdir --rest-every 3`
- 如果下载失败表现为图片 403 或详情空壳，先检查是否误用了 Node 裸 fetch 或默认 normal 模式
- 对小红书下载经验做代码沉淀时，应同时更新项目文档和 Codex memory note
- 对用户明确有权保存的内容，只做低负载、可断点、遇强信号即停的归档流程
