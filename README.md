# XHS Bulk Image Downloader

批量下载小红书博主个人主页全部笔记图片的命令行工具。

## 特性

- ✅ 全平台支持（Windows / macOS / Linux）
- ✅ 自动检测 Chrome 浏览器路径
- ✅ 增量滚动提取，不丢失顶部最新笔记
- ✅ 断点续传——已下载图片自动跳过
- ✅ 登录检测——未登录时弹出扫码页
- ✅ 反爬节奏——笔记间随机停顿 + 每 40 篇分批休息 + 撞风控自动停（保护账号）
- ✅ 高效下载——拦截无关资源 + `domcontentloaded` + base64 回传，少下约一半网络
- ✅ 绕过 CDN 防盗链——浏览器内 fetch 带正确 Referer

## 安装

```bash
git clone https://github.com/ailubo/xhs-bulk-download.git
cd xhs-bulk-download
npm install
```

## 使用

```bash
node scripts/bulk-download.mjs <profile_url> <output_dir> [--skip-login]
```

### 参数

| 参数 | 必填 | 说明 |
|------|:--:|------|
| `profile_url` | ✅ | 博主个人主页链接（xhslink.com 短链或完整链接） |
| `output_dir` | ✅ | 图片保存目录 |
| `--chrome <path>` | 否 | Chrome 可执行文件路径（自动检测） |
| `--profile <dir>` | 否 | Chrome 用户数据目录（默认系统临时目录） |
| `--skip-login` | 否 | 跳过登录等待（已登录时使用） |
| `--max-notes <n>` | 否 | 本次最多处理 n 篇笔记后停止（分批下载，配合断点续传） |

### 示例

```bash
# 下载指定博主的全部笔记图片
node scripts/bulk-download.mjs "https://xhslink.com/m/xxxxx" "./output/博主名" --skip-login

# 指定 Chrome 路径
node scripts/bulk-download.mjs "https://xhslink.com/m/xxxxx" "./output" --chrome "/path/to/chrome"
```

## 工作流

```
1. 用户扫码登录（首次）
2. 打开博主个人主页
3. 增量滚动提取 xsec_token（先顶部 → scrollBy 逐屏 → 每屏提取 → 去重）
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
- 小红书对短时间内高频翻详情页有行为风控。脚本已内置随机停顿 + 分批休息 + 撞风控自动停；
  若一次要下很多（如 1000+ 张），建议用 `--max-notes` 分几次/几天跑，断点续传会自动跳过已下的

## License

MIT
