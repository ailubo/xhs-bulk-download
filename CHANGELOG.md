# Changelog

## v2.3 (2026-06-07)

- xsec 缓存：滚动结果存 `.xhs-xsec-cache.json`，下次跳过滚动直接下载
- 已尝试追踪：`.xhs-attempted.json` 记录已尝试笔记（含纯文字），避免重复浪费请求
- 滚动中检测风控：300013 / 访问频繁等立即停止
- 滚动节奏放缓：3-6s 随机间隔，最大 30 轮
- 下载节奏放缓：12-20s 间隔，每 10 篇休息 4-6 分钟
- 默认 `--max-notes 50`（防止一次性全量触发风控）
- 支持断点续传：已下载图片自动跳过
- 缓存命中但无新笔记时自动重新滚动发现新内容

## v2.1 (2026-06-05)

- 下载阶段拦截图片/媒体/字体的自动加载
- 详情页用 `domcontentloaded` 替代 `networkidle2`
- 图片字节经 base64 回传（比逐字节 JSON 数组小约 3 倍）
- Cookie 多维度登录检测（a1 + web_session）
- `--skip-login` 仍验证 xsec 可用性

## v2.0 (2026-06-04)

- 通用化重构：支持任意博主主页链接
- 跨平台 Chrome 自动检测（Windows / macOS / Linux）
- Windows puppeteer-core 多路径查找（WorkBuddy managed / npm global）
- 反爬基础：笔记间随机停顿 + 分批休息

## v1.0 (2026-06-02)

- 初始版本：硬编码博主 URL，基本滚动+下载功能
