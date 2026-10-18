# 壁纸 / 主题包导入文件

这个目录把之前用过的壁纸和主题包整理成可以直接导入或参考的文件，和挂件本身分开存放。

## 目录

```text
theme-packs/
├─ dsh-dream-skin/
│  ├─ kohaku-shiro-bai-xia-day.dsh-theme.json  # 可直接导入的主题包
│  ├─ wallpaper.json                          # 壁纸参数（图片路径 + 透明度/模糊/填充）
│  └─ wallpapers/
│     └─ kohaku-shiro-bai-xia-day.jpg         # 对应壁纸
└─ codex-dream-skin/
   ├─ gothic-void-crusade/
   │  ├─ theme.json
   │  └─ background.jpg
   └─ arina-hashimoto/
      └─ theme.json                           # 上游未附带 background.jpg
```

## dsh-dream-skin 主题包

`kohaku-shiro-bai-xia-day.dsh-theme.json` 是 `dsh-dream-skin/pack` 格式（`format` + `version` + `manifest`），在：

**设置 → 外观（Theme）→ 主题包 → 导入**

里选这个文件即可。它只包含配色 token，不含壁纸；壁纸按下面的 `wallpaper.json` 单独设置。

`wallpaper.json` 是从本机 `~/.dsh/dream-skin.json` 提取出来的参数快照，不是插件可直接导入的格式：

```json
{
  "kind": "image",
  "image": "wallpapers/kohaku-shiro-bai-xia-day.jpg",
  "skin": "dream-pack:kohaku-shiro-bai-xia-day",
  "followsSkin": false,
  "opacity": "…",
  "blur": "…",
  "fit": "…",
  "autoDim": "…"
}
```

在 dsh-dream-skin 的壁纸设置里上传 `wallpapers/kohaku-shiro-bai-xia-day.jpg`，再按 JSON 里的数值调透明度、模糊和填充方式。

## Codex-Dream-Skin 主题

这两个目录来自 [Codex-Dream-Skin](https://github.com/Fei-Away/Codex-Dream-Skin) 的 Windows/macOS 预设：

- `gothic-void-crusade/theme.json` + `background.jpg`：完整预设。
- `arina-hashimoto/theme.json`：上游只提供 `theme.json`，引用 `background.jpg`，但源码里没有这张图；使用前需自行补图。

它们是 Codex 桌面端的 `theme.json` 格式，**不是** dsh-dream-skin 的 `.dsh-theme.json` 格式，不能直接拖进 DSH 的主题包导入框；保留在这里是为了备份和参考。

## 来源与许可

- dsh-dream-skin：MIT，<https://github.com/RevolutionLA/dsh-dream-skin>。主题包 `白夏回响 · 晴昼` 为本地个人主题。
- Codex-Dream-Skin：MIT，<https://github.com/Fei-Away/Codex-Dream-Skin>（见其 `macos/LICENSE` 与 `macos/NOTICE.md`）。
- 壁纸图片来自本机 dsh-dream-skin 配置；如对外分发，请自行确认图片的使用权。
