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
- ✅ 轻量模式——浏览器只发现当前可见笔记，详情页用 SSR 解析下载，减少连续详情页浏览行为

## 安装

```bash
git clone https://github.com/ailubo/xhs-bulk-download.git
cd xhs-bulk-download
npm install
```

## 使用

```bash
node scripts/bulk-download.mjs <profile_url> <output_dir> [--skip-login] [--mode normal|light]
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
| `--mode <normal\|light>` | 否 | 下载模式：`normal` 为原浏览器详情页下载；`light` 为分批发现 + SSR 轻量下载 |
| `--light` | 否 | `--mode light` 的快捷写法 |
| `--light-batch-size <n>` | 否 | 轻量模式处理当前视口时，每个下载子批次最多 n 篇（默认 8） |
| `--light-scroll-rounds <n>` | 否 | 轻量模式最多滚动发现 n 轮（默认 30） |
| `--until-end` | 否 | 轻量模式一直滚到页面底部；若未指定 `--max-notes`，不设篇数上限 |
| `--rest-every <n>` | 否 | 轻量模式每滚动 n 次休息一段时间（默认 3；设 0 关闭） |
| `--rest-min-ms <n>` | 否 | 每次休息的最短毫秒数（默认 35000） |
| `--rest-max-ms <n>` | 否 | 每次休息的最长毫秒数（默认 50000） |
| `--user-subdir` | 否 | 按页面用户名保存到 `<output_dir>/<用户名>/`，避免不同账号混目录 |

### 示例

```bash
# 下载指定博主的全部笔记图片
node scripts/bulk-download.mjs "https://xhslink.com/m/xxxxx" "./output/博主名" --skip-login

# 轻量模式：当前可见批次下载完再轻滚下一批
node scripts/bulk-download.mjs "https://xhslink.com/m/xxxxx" "./output/博主名" --skip-login --mode light --max-notes 50 --light-batch-size 8

# 推荐归档模式：按用户名建目录，一屏一屏处理，每 3 次滚动休息，直到页面底部
node scripts/bulk-download.mjs "https://www.xiaohongshu.com/user/profile/xxxxx?xsec_token=..." "./xhs_downloads" --mode light --until-end --user-subdir --rest-every 3

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

轻量模式工作流：

```
1. 用户扫码登录（首次）
2. 打开博主个人主页
3. 可选：用页面标题识别用户名，保存到 output_dir/用户名
4. 读取当前可见卡片的 noteId + xsec_token，并写入缓存
5. 先下载当前可见批次，完成后再滚动下一屏
6. 用 Node 侧 SSR 请求解析笔记详情页 __INITIAL_STATE__.noteDetailMap.imageList
7. 写入 manifest-light.json；只有成功记录才算断点完成，短暂 fetch failed 会在下一次可见时重试
8. 每滚动 3 次休息一段时间，直到到达页面底部或达到 --max-notes / --light-scroll-rounds
```

轻量模式不会在浏览器里连续打开详情页，适合先处理当前可见批次、再滚动发现下一批的低行为量归档。

## 实跑注意事项

这次实跑后固定了几个坑位：

```
1. Puppeteer 会打开自己的 Chrome profile，不等于你正在使用的 Chrome。
   如果用了默认临时 profile，需要先扫码登录；更稳的方式是用 --profile 指向一个专用持久目录。

2. 失败不能记成已完成。
   旧逻辑如果把 fetch failed 写入 attempted，下次会跳过失败笔记；现在 manifest-light.json 只把 ok=true 作为完成依据。

3. 不同账号必须分目录。
   推荐用 --user-subdir，把图片保存到 xhs_downloads/用户名/，不要把多个博主混到一个目录。

4. 当前屏做完再滚动。
   轻量模式只读取当前可见卡片，下载完成后再 scrollBy；这比先滚很多页再集中下载更容易断点，也更容易停在干净状态。

5. 每 3 次滚动休息。
   默认 --rest-every 3，可用 --rest-min-ms / --rest-max-ms 调整。
```

## 输出

- 文件命名：`{noteId前8位}_{序号}.webp`
- 格式：WebP（小红书 CDN 默认格式）
- 已下载自动跳过，支持断点续传
- 轻量模式记录：`manifest-light.json`
- 如果使用 `--user-subdir`：`<output_dir>/<用户名>/*.webp`

## 已知限制

- 需要用户扫码登录（游客只能看 10 篇封面）
- 主页滚动有展示上限，更早期的笔记需要 API 翻页（CORS 阻止）
- 小红书对短时间内高频翻详情页有行为风控。脚本已内置随机停顿 + 分批休息 + 撞风控自动停；
  若一次要下很多（如 1000+ 张），建议用 `--max-notes` 分几次/几天跑，断点续传会自动跳过已下的

## License

MIT
