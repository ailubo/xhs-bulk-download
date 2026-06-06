---
name: xhs-bulk-download
description: >
  批量下载小红书博主主页的全部笔记图片。当用户要求下载某个小红书
  账号的「所有图片」「全部笔记图片」「主页图片」，或说「把 xx 的
  图片都下下来」时触发。需要用户登录。支持 xhslink.com 短链和
  xiaohongshu.com 完整链接。
agent_created: true
---

# XHS Bulk Image Download

批量下载小红书博主个人主页的全部笔记图片。适用于需要登录的场景（登录后每篇笔记的多张图片都可下载，而不只是封面）。

## 前置条件

- **用户必须扫码登录小红书**（游客只能看 10 篇封面图）
- 如果检测到未登录，直接告诉用户需要登录，打开浏览器让用户扫码，**不要反复尝试绕过**
- 需要 puppeteer-core（Node.js），Chrome 浏览器，和 `fs`/`path` 等标准库

## 触发规则

当用户消息包含以下内容时触发：
- 小红书链接 + 「下载所有图片」「全部下载」「下载所有笔记」
- 「下载 xx 博主的所有照片」「把这个小红书号的全部图下下来」
- 用户直接说「批量下载主页图片」

## 工作流

### 完整流程（已验证 ✅）

```
1. 用户扫码登录（如需）
2. 打开博主个人主页（含 xsec_token）
3. Patient scroll 滚动到底部，等待每轮懒加载完成
4. 从 DOM 提取带 xsec_token 的笔记链接
5. 逐个打开笔记页面，用 fetch(img.src) 下载全部图片
6. 保存到指定目录
```

### 为什么外部下载不行？

| 下载方式 | 结果 | 根因 |
|----------|:--:|------|
| Python requests | ❌ 403 | CDN 防盗链，需要浏览器 session |
| Python requests + Referer | ❌ 403 | 仍需浏览器 session |
| puppeteer fetch + 旧 URL | ❌ 403 | 图片 URL 有时效性，必须从当前页面 DOM 获取 |
| **puppeteer fetch + 当前页面 img.src** | ✅ | 正确 Referer + 有效 URL |

### xsec_token 提取

- 笔记详情页不能直接用 `/explore/{id}`（会 404，错误码 300031）
- 必须从主页 DOM 提取带 xsec_token 的链接：
  ```
  /user/profile/{uid}/{noteId}?xsec_token=XXX&xsec_source=pc_user
  ```
- 构造完整 URL 后导航到笔记页面

### 主页滚动策略

- 使用 **增量滚动**：`scrollBy(0, 800)` 每次滚动一屏，禁止 `scrollTo(0, scrollHeight)` 跳到底
- 打开页面后**先提取当前视口**的 xsec（最新笔记在顶部，跳到底会丢失！）
- 每次滚动后立即提取，`Object.assign` 去重
- 连续 5 轮无变化时停止
- 主页有展示上限，但增量滚动能比跳到底多获取数倍笔记

### API 翻页限制

- XHS API (`edith.xiaohongshu.com`) 被 CORS 阻止
- 需要 X-S/X-t 动态签名头（由 XHS JS SDK 生成）
- 无法从外部调用，滚动到底即停止

## 脚本使用

`scripts/bulk-download.mjs` 是核心脚本，参数：

```bash
node scripts/bulk-download.mjs <profile_url> <output_dir> [options]
```

| 参数 | 必填 | 说明 |
|------|:--:|------|
| `profile_url` | ✅ | 博主个人主页链接（xhslink.com 或 xiaohongshu.com） |
| `output_dir` | ✅ | 图片保存目录 |
| `--chrome <path>` | 否 | Chrome 可执行文件路径（自动检测） |
| `--profile <path>` | 否 | Chrome 用户数据目录（默认系统临时目录） |
| `--skip-login` | 否 | 跳过登录等待（当用户确认已登录时使用） |

脚本内步骤：
1. 自动检测 Chrome 路径
2. 检查/提示用户登录
3. Patient scroll 到底
4. 提取 xsec_token + 逐个下载

## 输出

- 所有笔记的全部图片保存到 `output_dir`
- 文件命名格式：`{noteId前8位}_{序号}.webp`
- 已下载的图片自动跳过（可断点续传）

## 已知限制

- 主页滚动最多 ~70 篇笔记，更早期的需要 API（CORS 阻止）
- 图片 URL 有时效性，不能先收集再批量下载——必须边访问边下载
- 每篇笔记需要约 5-8 秒（导航+下载），总时间取决于笔记数量
