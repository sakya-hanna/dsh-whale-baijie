# NOTICE

本仓库是 **dsh-whale-baijie**，一个基于
[MeteorNOX/DeepSeek-Balance-Whale-Widget](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget)
（MIT License）的白姐（小伯白）定制分支。

## 上游

- 上游项目：DeepSeek Harness 小鲸鱼余额挂件
- 上游作者：MeteorNOX 及贡献者
- 上游许可证：MIT（见 `LICENSE`）
- 本仓库保留了上游的 MIT 许可证与版权声明；`assets/` 下美术/音频素材的许可范围见 `PROVENANCE.md`，不因本仓库的 MIT 代码许可而改变。

## 本分支的修改

- 包名改为 `dsh-whale-baijie`，bundle id 同步改为 `dsh-whale-baijie`，避免与上游 npm 包并存冲突。
- 新增宿主侧 `lib/proactive.mjs`：每轮对话结束后按概率用**当前会话模型**生成一条白姐气泡，带频率限制、静默时段、JSON 校验、去重与语音预留接口。
- 新增前端主动气泡轮询与系统泡泡场景（排在每轮消耗提示之后），以及「白姐主动说话」独立设置面板。
- 保留当前安装环境里已有的白姐主题、语音、草帽玩具等定制补丁。

## 不隶属声明

本仓库不是 DeepSeek 官方项目，也不代表上游作者；问题反馈请在本仓库提交，不要打扰上游维护者。
