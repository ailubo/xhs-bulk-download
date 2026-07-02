# XHS Bulk Image Downloader

批量下载小红书博主个人主页全部笔记图片的命令行工具。

## 特性

- ✅ 全平台支持（Windows / macOS / Linux）
- ✅ 自动检测 Chrome 浏览器路径
- ✅ xsec 缓存 — 滚动结果存 `.xhs-xsec-cache.json`，下次跳过滚动直接下载
- ✅ 断点续传 — 已下载图片自动跳过 + `.xhs-attempted.json` 记录已尝试笔记（含纯文字）
- ✅ 登录检测 — Cookie 多维度检测 + 扫码登录支持
- ✅ 反爬节奏 — 笔记间 12-20s 随机停顿 + 每 10 篇休息 4-6 分钟 + 撞风控自动停
- ✅ 风控检测 — 滚动/下载阶段检测安全验证/访问频繁/captcha，触发即停
- ✅ 高效下载 — 拦截无关资源 + `domcontentloaded` + base64 回传
- ✅ 绕过 CDN 防盗链 — 浏览器内 fetch 带正确 Referer
- ✅ 单篇下载 — `xhs-single-note.mjs` 无需登录，从公开 explore 页面提取

## 安装

```bash
git clone https://github.com/ailubo/xhs-bulk-download.git
cd xhs-bulk-download
npm install
```

依赖：`puppeteer-core` >= 22.0.0，Node.js >= 18，本地 Chrome 浏览器。

## 使用

### 批量下载博主主页

```bash
node scripts/bulk-download.mjs <profile_url> <output_dir> [options]
```

### 单篇笔记下载（无需登录）

```bash
node xhs-single-note.mjs <note_url_or_shortlink> <output_dir> [--chrome PATH]
```

### 参数

| 参数 | 必填 | 说明 |
|------|:--:|------|
| `profile_url` | ✅ | 博主个人主页链接（xhslink.com 短链或完整链接） |
| `output_dir` | ✅ | 图片保存目录 |
| `--chrome <path>` | 否 | Chrome 可执行文件路径（自动检测） |
| `--profile <dir>` | 否 | Chrome 用户数据目录（默认系统临时目录） |
| `--skip-login` | 否 | 跳过登录等待（已登录时使用） |
| `--max-notes <n>` | 否 | 本次最多处理 n 篇笔记后停止（默认 50，配合断点续传） |

### 示例

```bash
# 批量下载博主全部笔记图片
node scripts/bulk-download.mjs "https://xhslink.com/m/xxxxx" "./output/博主名" --skip-login

# 分批下载（每次 30 篇，断点续传自动跳过已下载）
node scripts/bulk-download.mjs "https://xhslink.com/m/xxxxx" "./output" --max-notes 30

# 单篇笔记下载
node xhs-single-note.mjs "https://xhslink.com/xxx" "./output/单篇"

# 指定 Chrome 路径
node scripts/bulk-download.mjs "https://xhslink.com/m/xxxxx" "./output" --chrome "/path/to/chrome"
```

## 工作流

### 批量下载

```
1. 用户扫码登录（首次）
2. 打开博主个人主页
3. 增量滚动提取 xsec_token（先顶部 → scrollBy 逐屏 → 每屏提取 → 去重）
   → 结果缓存到 .xhs-xsec-cache.json
4. 逐个打开笔记页面，用 fetch(img.src) 下载全部图片
   → 已尝试笔记记录到 .xhs-attempted.json（含纯文字笔记）
5. 保存到指定目录（断点续传，已下载自动跳过）
```

### 单篇下载

```
1. 打开短链，跟随重定向到最终页面
2. 提取 noteId，跳转到 /explore/{noteId} 公开页面
3. 安全检查（确认未登录状态）
4. 从 __INITIAL_STATE__ 提取笔记数据（标题/描述/图片/标签/互动数据）
5. 下载图片 + 生成 Markdown 文件（含 YAML front Matter 元数据）
```

## 输出

### 批量下载
- 文件命名：`{noteId前8位}_{序号}.webp`
- 格式：WebP（小红书 CDN 默认格式）
- 缓存文件：`.xhs-xsec-cache.json`（xsec 令牌）、`.xhs-attempted.json`（已尝试笔记）

### 单篇下载
- 图片：`{标题前30字}_{序号}.{格式}`
- Markdown：`{日期}_{标题前40字}.md`（含 YAML front matter：作者/标签/点赞/收藏/评论数/URL）

## 已知限制

- 需要用户扫码登录（游客只能看 10 篇封面）
- 主页滚动有展示上限，更早期的笔记需要 API 翻页（CORS 阻止）
- 小红书对短时间内高频翻详情页有行为风控。脚本已内置随机停顿 + 分批休息 + 撞风控自动停；
  若一次要下很多（如 1000+ 张），建议用 `--max-notes` 分几次/几天跑，断点续传会自动跳过已下的

## 文件结构

| 文件 | 用途 |
|------|------|
| `scripts/bulk-download.mjs` | 批量下载主脚本（v2.3） |
| `xhs-single-note.mjs` | 单篇笔记下载（无需登录） |
| `package.json` | 依赖声明 |
| `CHANGELOG.md` | 版本变更记录 |

## License

MIT
