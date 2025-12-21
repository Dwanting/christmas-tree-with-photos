# Changelog

## v0.1.0 (2025-12-21)
- 首次公开版本，适配 GitHub Pages 子路径部署
- 统一资源路径为 `import.meta.env.BASE_URL`，修复图片与音频 404
- 为 `video.play()` / `audio.play()` 增加安全处理，避免 AbortError
- 本地开发自动打开 `http://localhost:<port>/christmas-tree-with-photos/`
- 调试窗口缩小为 200px，减少遮挡
- 图片放大交互加入平滑淡入淡出
- 彩蛋效果重构为“中心彩色纸屑炸开”，统一多彩配色与运动逻辑
- 顶部标题简化为 “Merry Christmas~”
- README 增加在线预览链接与致谢说明
