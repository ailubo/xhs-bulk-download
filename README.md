# XHS Bulk Image Downloader

小批量归档小红书博主个人主页笔记图片的命令行工具。默认策略偏保守：减少滚动、减少连续详情页访问，并在遇到安全限制/访问频繁时自动冷却。

## 特性

- ✅ 全平台支持（Windows / macOS / Linux）
- ✅ 自动检测 Chrome 浏览器路径
- ✅ 小批量增量滚动提取，优先降低访问频率
- ✅ 断点续传——已下载图片自动跳过
- ✅ 登录检测——未登录时弹出扫码页
- ✅ 保守节奏——笔记间长随机停顿 + 小批量休息 + 撞风控自动冷却（保护账号）
- ✅ 高效下载——拦截无关资源 + `domcontentloaded` + base64 回传，少下约一半网络
- ✅ 浏览器内 fetch 图片，保留当前页面 Referer

## 安装

```bash
git clone https://github.com/ailubo/xhs-bulk-download.git
cd xhs-bulk-download
npm install
```

## 使用

```bash
node scripts/bulk-download.mjs <profile_url> <output_dir> [--skip-login] [--max-notes 8]
```

### 参数

| 参数 | 必填 | 说明 |
|------|:--:|------|
| `profile_url` | ✅ | 博主个人主页链接（xhslink.com 短链或完整链接） |
| `output_dir` | ✅ | 图片保存目录 |
| `--chrome <path>` | 否 | Chrome 可执行文件路径（自动检测） |
| `--profile <dir>` | 否 | Chrome 用户数据目录（默认 `~/.xhs-bulk-download-profile`） |
| `--skip-login` | 否 | 跳过登录等待（已登录时使用） |
| `--max-notes <n>` | 否 | 本次最多处理 n 篇笔记后停止（默认 8） |
| `--max-scroll-rounds <n>` | 否 | 主页最多滚动 n 轮（默认 5；设为 0 只处理当前视口/缓存） |
| `--refresh` | 否 | 忽略 xsec 缓存，主动重新滚动主页发现新内容 |
| `--cooldown-hours <n>` | 否 | 触发风控后的冷却小时数（默认 24） |
| `--ignore-cooldown` | 否 | 手动确认账号恢复后，忽略冷却文件继续运行 |

### 示例

```bash
# 小批量下载，默认最多 8 篇
node scripts/bulk-download.mjs "https://xhslink.com/m/xxxxx" "./output/博主名" --skip-login

# 更保守：只处理 3 篇，最多滚 2 轮
node scripts/bulk-download.mjs "https://xhslink.com/m/xxxxx" "./output/博主名" --skip-login --max-notes 3 --max-scroll-rounds 2

# 指定 Chrome 路径
node scripts/bulk-download.mjs "https://xhslink.com/m/xxxxx" "./output" --chrome "/path/to/chrome"
```

## 工作流

```
1. 用户扫码登录（首次）
2. 打开博主个人主页
3. 小批量滚动提取 xsec_token（先顶部 → 少量 scrollBy → 每屏提取 → 去重）
4. 逐个打开笔记页面，用 fetch(img.src) 下载全部图片
5. 保存到指定目录（断点续传）
```

## 输出

- 文件命名：`{noteId前8位}_{序号}.webp`
- 格式：WebP（小红书 CDN 默认格式）
- 已下载自动跳过，支持断点续传

## 已知限制

- 需要用户扫码登录（游客只能看 10 篇封面）
- 主页滚动有展示上限，更早期的笔记需要 API 翻页（CORS 阻止）
- 小红书对短时间内高频翻详情页有行为风控。脚本已内置长随机停顿、低默认批量和 `.xhs-cooldown.json` 冷却文件。
- 如果出现 300013 / 安全限制 / 访问频繁，请不要立刻反复运行；等冷却结束后再用小批量继续，断点续传会自动跳过已处理内容。

## License

MIT
