# build util
项目打包工具

## Commands

### Build And Zip

- 扫描工作目录中的项目并识别类型（Maven / Ant / Node）
- 支持前台执行 `构建 + 压缩` 并实时滚动输出日志
- 支持后台执行（可关闭 Raycast 窗口），并作为列表默认执行方式
- 支持多个后台任务并发；每个后台任务都会写独立的状态文件、日志和脚本文件
- 前台完成后自动复制 zip 绝对路径；后台完成后自动复制 zip 绝对路径并发送系统通知（标题为构建成功/失败，内容为 ZIP 路径或失败原因）
- 后台通知仅使用 `terminal-notifier`（不再使用 Script Editor 通知）；可点击跳转 Finder（成功定位 ZIP，失败定位日志）
- 后台日志默认目录：`~/.sxuhutils/build-and-zip-logs`
- 后台任务状态文件：`~/.sxuhutils/build-and-zip-logs/<runId>.json`
- 后台索引文件：`~/.sxuhutils/build-and-zip-logs/index.json`
- 后台日志与脚本会自动清理，仅保留最近 10 份已完成任务记录；活动任务始终保留（每份含 `.sh + .log + .json`）
- 每次执行都先构建再压缩，不提供“仅压缩”模式
- Java 项目会优先识别 `target`，并额外识别 IDEA 输出目录 `out/production/<项目名>`
- Ant 项目若识别到 IDEA 输出目录，会在构建后同步产物到该目录并压缩
- Ant + IDEA 输出目录场景下，默认仅压缩 `com` 目录
- 若 Ant 的 IDEA 输出目录不存在，会自动创建并在构建后同步 `com` 到该目录再压缩
- 支持对单个项目临时覆盖参数：
  - 构建命令
  - 压缩根目录
  - 压缩内容（逗号分隔）
  - zip 文件名

### Build And Zip Status

- 菜单栏命令，显示后台任务活动数量
- `Active Runs` 展示当前构建中/压缩中的后台任务
- `Recent Runs` 展示最近完成或失败的任务
- 每条任务支持：
  - 打开日志
  - 复制日志路径
  - 成功时打开 ZIP
  - 成功时复制 ZIP 路径

## Build And Zip Preferences

- `Workspace Roots`: 仅支持 `/Users/husky/workSpace/7-lk` 与 `/Users/husky/workSpace/10-lknodejs`（其他路径会被忽略）
- `Max Scan Depth`: 扫描目录深度，默认 `3`
- `Default Zip Name`: 默认压缩包名，默认 `a.zip`
- `Node Build Script`: Node 默认构建脚本名，默认 `build`
- `Java Home`: Maven/Ant 构建使用的 JAVA_HOME，默认 `zulu-8`
- `Ant Build File`: Ant 默认构建文件名，默认 `build_pre.xml`
- `Maven Executable`: Maven 可执行文件，默认 `/opt/homebrew/Cellar/maven@3.6.1/3.6.1/bin/mvn`
- `Maven Settings`: Maven settings.xml，默认 `/opt/homebrew/Cellar/maven@3.6.1/settings.xml`
- `Maven Local Repo`: Maven 本地仓库，默认 `/Users/husky/maven_repo`
- `Maven Profile`: Maven 构建 profile，默认 `pre`
- `Maven Goals`: Maven 目标参数，默认 `--update-snapshots clean install -Dmaven.test.skip=true`
