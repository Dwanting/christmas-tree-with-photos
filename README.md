# 🎄 christmas-tree-with-photos v2.0

一个基于 **React + R3F(Three.js) + MediaPipe 手势识别** 的高保真 3D 圣诞树 Web 应用：它既是一棵树，也是一座“记忆画廊”。

- 在线预览（GitHub Pages）：https://Dwanting.github.io/christmas-tree-with-photos/
- 国内可访问链接（可选）：（你部署后把链接贴这里）

![Project Preview](public/preview.png)

## ✨ 核心特性
- 电影级氛围：高密度粒子 + 彩灯 + 后期辉光，营造奢华质感
- 记忆画廊：拍立得照片悬浮在树身上，支持查看大图
- AI 手势控制：张开手掌/握拳切换形态，左右移动控制旋转，捏合查看照片
- 经典烟花：查看大图时，背景展示经典烟花爆炸效果
- 本地照片管理：本地开发模式下支持网页上传/重置照片

## 🛠️ 技术栈
- 框架：React 18 + Vite
- 3D：React Three Fiber + Three.js
- 工具库：@react-three/drei、maath
- 后期处理：@react-three/postprocessing
- AI 视觉：MediaPipe Tasks Vision（Gesture Recognizer）

## ⚙️ 电脑配置要求
- 最低可用：4 核 CPU、8GB 内存、支持 WebGL2 的显卡/核显、可用摄像头、Chrome/Edge 新版本
- 推荐：6 核及以上 CPU、16GB 内存、性能较好的核显或独显（帧率更稳）

## 🚀 本地运行
### 1) 环境准备
- Node.js：建议 v18 或更高

### 2) 安装依赖
```bash
npm install
```

### 3) 启动开发服务器（支持网页上传照片）
```bash
npm run dev
```

### 4) 构建生产包（用于静态部署）
```bash
npm run build
```

## 🖼️ 照片管理（两种方式）
### 方式 A：网页上传（仅本地开发模式可用）
1. 运行 `npm run dev`
2. 点击页面左上角的“音乐播放/暂停”“图片上传”
3. 在弹窗中上传/重置照片

说明：网页上传依赖本地开发服务器提供的 `/api/upload` 等接口；部署到纯静态站点（如 GitHub Pages）后，这些接口不存在，因此线上预览站点不支持上传。

### 方式 B：手动替换（静态部署也适用）
静态站点会优先展示内置的 `public/backup_photos/` 默认照片。你可以把自己的照片覆盖到这个目录里（建议单张 500KB 以内、正方形或 4:3 比例，加载更流畅）。

补充：开发模式网页上传的照片会写入 `public/photos/`（该目录默认被 gitignore 忽略，适合放个人照片）。如果你希望线上静态站点也展示你上传的照片，请在构建前把它们同步/复制到 `public/backup_photos/`。

## 🖐️ 手势控制说明
建议打开“展示调试”确认摄像头已识别到手部骨骼点。

| 手势 | 功能 |
|------|------|
| 🖐 张开手掌 (Open Palm) | 散开模式（CHAOS） |
| ✊ 握紧拳头 (Closed Fist) | 聚合模式（FORMED） |
| 👋 手掌左右移动 | 旋转视角 |
| 👌 捏合（食指+拇指） | 打开照片大图，松开自动关闭 |

## 📦 部署
### GitHub Pages（推荐给国外/通用访问）
项目生产构建会使用 `base: '/christmas-tree-with-photos/'`，可直接用于 `https://<user>.github.io/christmas-tree-with-photos/` 这种子路径部署。

常见做法：
1. 推送到 GitHub 的 `main` 分支后，会自动把 `dist/` 发布到 `gh-pages` 分支（见 `.github/workflows/publish-gh-pages-branch.yml`）
2. 在 GitHub 仓库 Settings → Pages，把 Source 选择为 `Deploy from a branch`，分支选 `gh-pages`，目录选 `/ (root)`

### 国内访问（两种常见方案）
1) Gitee Pages（更适合国内直连体验）
- 在 Gitee 新建同名仓库并同步代码
- 开启 Gitee Pages，分支选择 `gh-pages`，目录选择 `/ (root)`
- 访问地址通常为 `https://<user>.gitee.io/<repo>/`

可选：自动同步到 Gitee
- 本项目包含 GitHub Actions 同步工作流：`.github/workflows/mirror-to-gitee.yml`
- 在 GitHub 仓库 Settings → Secrets and variables → Actions 配置两个 Secrets：
  - `GITEE_REPO_URL`：例如 `git@gitee.com:<user>/<repo>.git`
  - `GITEE_SSH_PRIVATE_KEY`：有该 Gitee 仓库写权限的 SSH 私钥

2) 国内云存储 + CDN（访问更稳，适合传播）
- 例如：阿里云 OSS / 腾讯云 COS + CDN
- 上传 `dist/` 全量文件，绑定自定义域名 + CDN 加速

## 📝 v2.0 更新点（相对上一次开源版本）
- 查看大图时增加经典烟花背景效果
- 优化手势识别：降低延迟、提升捏合触发灵敏度（同时减少误触）
- UI 调整：放大图片时顶部按钮与调试框保持可见；音乐按钮固定在顶部左侧区域
- 本地照片管理：开发模式下支持网页上传/重置照片（静态站点不支持上传）

## 📄 License
MIT
