# 桌面插件管理器

在运行 OpenCode、Claude Code、DeepSeek Harness 或 Codex 的电脑上，从 Swarm 首页下载对应平台的安装包。

- Windows x64 双击 EXE。安装器会将管理器安装到 `%USERPROFILE%\agent-swarm-manager`，添加当前用户的开始菜单快捷方式，开启登录自启并打开管理器。
- Debian、Ubuntu 等 Linux x64 桌面系统用软件安装器打开 DEB。软件安装器可能要求系统安装授权。包会注册应用菜单和 XDG 自启动。首次从应用菜单打开或登录桌面时，管理器会以当前用户权限安装到 `~/agent-swarm-manager`。

1. 输入 Swarm 服务地址，例如 `http://10.0.0.1:8700`，用 Swarm 用户名和密码登录。
2. 在列表查看检测到的客户端和版本。点击各行的「安装」或「更新」，也可以全部安装、全部更新。管理器以插件内容版本检查更新，先前通过命令安装的插件可能显示「已安装（未知版本）」。
3. 关闭窗口后，管理器继续在支持系统托盘的桌面驻留。双击托盘图标重新打开。Windows 和 Linux 安装后默认在登录系统桌面时启动到托盘，可在管理器中取消「开机启动」。Windows 使用当前用户的 `Run` 注册表项。Linux 默认使用 DEB 注册的 XDG 自启动项，个人设置保存在 `$XDG_CONFIG_HOME/autostart`（默认 `~/.config/autostart`）。

切换账号或服务器时，管理器会用新凭据重装本机已安装的 Swarm 插件。退出登录会卸载这些插件并清除保存的登录状态。工作区注册、Swarm 历史和客户端会话数据保留。托盘菜单的「退出程序」仅关闭管理器，下次打开会自动恢复登录。管理器将 API Key 保存在用户目录的 `.config/agent-swarm-manager/config.json`，密码不会保存。

安装后，管理器会尝试触发 OpenCode V2 服务热重载或 Codex 共享 App Server 的 MCP 重载。对于仍在运行的 Windows 桌面客户端，管理器可请求窗口正常退出后重新启动。尚在运行的终端会话以及不支持热重载的客户端，有时需要重开会话。每个插件的操作结果都会显示生效状态。

## 开发和分发

```sh
python -m pip install -r desktop/requirements.txt
python -m desktop.manager
python -m pip install PyInstaller Pillow
python desktop/build.py
```

请在各平台原生构建，Linux 打包需要 `dpkg-deb`。产物在 `desktop/dist/`。GitHub Actions 的 `plugin-manager` 工作流可手动构建，推送发布标签时也会把产物上传到 GitHub Releases。自托管环境可在后台管理页上传 `AgentSwarmManager-windows-x64-setup.exe`、`AgentSwarmManager-linux-x64.deb` 到服务器 `data/`，网站会优先提供本地文件（未上传时下载端点回退 GitHub Release）。插件版本从 `/download/plugin-manifest.json` 获取，旧服务器通过现有插件包兼容检测。
