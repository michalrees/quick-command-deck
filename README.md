# Quick Command Deck

把 VS Code 的**常用命令与键位**做成侧边栏里的一长列清单：**上面一个搜索框，下面「名字 + 键位」**，点一下就执行。

- **点击即执行真实命令**：走 `vscode.commands.executeCommand()`，不是模拟按键；你改过键位也照样能用
- **不依赖任何私有 CSS / DOM 类名**：用的是扩展公开 API，**VS Code 升级后依然有效**（不像 CSS 注入那样每次升级都要重修）
- **搜索即过滤**：输入名称、键位（如 `ctrl+shift+p`）或命令 ID 都能匹配
- **键盘可用**：`↑` `↓` 选择、`Enter` 执行、`Esc` 清空搜索
- **可用性体检**：启动时用 `vscode.commands.getCommands()` 核对，当前环境里不存在的命令自动置灰并标注，不会"点了没反应"
- **自动收录扩展键位**：读取已安装扩展声明的键位，搜索框为空时附在列表下方，方便直接抄命令 ID
- **快捷键文件可手选**：你自定义的键位来自 `keybindings.json`，自动探测不准时（portable / 远程 / 机器上放了多份变体）可以手动指定读哪一个
- **四种排序**：默认顺序 / 按点击次数 / 按名称 / 按来源分组（点击次数**只统计面板内点击**，快捷键不计，原因见下）

## 安装

### 从 VSIX 安装

```bash
code --install-extension quick-command-deck-<version>.vsix
```

或在 VS Code 里：`扩展` 视图 → 右上角 `...` → **Install from VSIX...** → 选中 `.vsix`

### 从市场安装

在扩展市场搜索 **Quick Command Deck**。

## 使用

1. 安装后，**右侧辅助侧边栏**会出现 **Command Deck** 图标（容器 `Command Deck`，视图 `快捷命令`）
2. 没看到的话：`Ctrl+Alt+B` 切换辅助侧边栏，或命令面板执行 **`Quick Command Deck: 打开命令面板（侧边栏）`**
3. 视图打开后搜索框会自动聚焦，**直接打字即可筛**；`↑`/`↓` 选择，`Enter` 执行
4. 想把容器拖到左侧活动栏也完全可以，位置随意

## 设置

| 设置项 | 默认值 | 说明 |
|---|---|---|
| `quickCommandDeck.fontSize` | `14` | 面板字号（px） |
| `quickCommandDeck.showKeys` | `true` | 是否显示每条命令的键位 |
| `quickCommandDeck.dense` | `false` | 紧凑模式，减小行距与内边距 |
| `quickCommandDeck.includeExtensionCommands` | `true` | 是否把扩展声明的键位也列进主列表 |
| `quickCommandDeck.commands` | `[]` | 自定义命令清单，**留空则用内置的 36 条** |
| `quickCommandDeck.keybindingsPath` | `""` | 手动指定要读的 `keybindings.json`，**留空 = 自动探测** |

### 自定义命令清单

```jsonc
{
  "quickCommandDeck.commands": [
    { "label": "转到文件", "command": "workbench.action.quickOpen", "keys": "Ctrl+P" },
    { "label": "切换终端", "command": "workbench.action.terminal.toggleTerminal", "keys": "Ctrl+`" },
    { "label": "禅模式",   "command": "workbench.action.toggleZenMode",   "keys": "Ctrl+Alt+Z" }
  ]
}
```

- `command` 必须是**命令 ID**。不知道 ID？在视图里清空搜索框，最下方「来自已安装扩展」那一段就是可直接抄的 ID
- `keys` 只用于显示提示，写不写都行；不写时会尝试用扩展声明的键位补上

> 为什么键位要手写？VS Code **没有**公开 API 能查询"某个命令的默认键位"——默认键位表是编译进 bundle 的私有格式。所以内置清单里的键位是人工维护的，**它只影响显示，不影响执行**。

### 手动指定快捷键文件

面板里显示"你自定义的键位"时，扩展是**直接读 `keybindings.json` 文件**的（VS Code 同样没有 API 能读到"当前生效的键位"）。默认按下列顺序自动探测，**取第一个存在的**：

1. 由扩展 `globalStorage` 路径上推的 `<User>\keybindings.json`（portable / 远程 / `--user-data-dir` 场景下准确）
2. `%APPDATA%\Code\User\keybindings.json`
3. `%APPDATA%\Code - Insiders\User\keybindings.json`
4. `~/.config/Code/User/keybindings.json`
5. `~/Library/Application Support/Code/User/keybindings.json`

探测不准时（比如你在别处放了一份专用键位表）用命令覆盖：

| 命令（命令面板） | 作用 |
|---|---|
| `Quick Command Deck: 选择快捷键文件（keybindings.json）` | 打开文件选择框，选中即写入设置并立即刷新 |
| `Quick Command Deck: 恢复自动探测快捷键文件` | 清空设置，回到上面的自动探测 |

也可以直接写设置（支持绝对路径、`file:///` URI、`~` 前缀）：

```jsonc
{
  "quickCommandDeck.keybindingsPath": "C:\\Users\\你\\.vscode\\extras\\keybindings.latex.json"
}
```

行为细节：

- **手动指定优先**；若该文件不存在或路径不合法，会提示一次并**回退自动探测**（不会让面板突然丢掉所有键位）
- 视图标题右侧的小字会显示当前在用哪个文件：`手动：xxx.json` / `xxx.json` / `未找到快捷键文件`
- 解析时会去掉 `//` 注释与尾随逗号（JSONC），并忽略 `-command` 定向解绑；同一命令多条绑定时**取第一条**；`when` 条件**不参与**判断
- **不会自动监听文件变化**：改完 `keybindings.json` 后按视图标题栏的刷新按钮（或 `Quick Command Deck: 刷新命令可用性`）即可，不必重载窗口

## 排序与「点击次数」

工具栏右上有 4 种排序，会记在 `globalState` 里（跨工作区保留）：

| 排序 | 依据 |
|---|---|
| `默认顺序` | 内置/自定义清单的排列顺序，扩展命令按名称附在后面 |
| `按点击次数` | 你在**本面板里点击**该行的累计次数，多的在前 |
| `按名称` | 按显示名（`zh-Hans-CN` 规则）排序 |
| `按来源分组` | 先内置、再按扩展显示名分段，组内按名称 |

> ⚠️ **「点击次数」只统计你在面板里点击行**（行内悬停提示写作「面板内点击 N 次」）。
> **用键盘快捷键执行命令不会被统计**，原因是：快捷键由 VS Code 的键位服务**在主线程直接执行**，扩展宿主完全不在链路上——公开 API 里没有"命令被执行"这类事件（`commands` 命名空间里没有 `onDidExecuteCommand`），也没有 API 能在运行时注册键位去拦截。
> 所以：想让排序反映你的真实习惯，就多点几次面板；敲快捷键按多少次都不会计入。
> （理论上可以给每个想统计的键做一个"转调命令"代理——键位指向扩展、扩展计数后再转调真实命令——但那样这些键就依赖本扩展，且每个键都要改一次 `keybindings.json`，暂未实现。）

## 内置命令（36 条）

| 分类 | 命令 |
|---|---|
| 导航 | 转到文件 `Ctrl+P` · 转到行/列 `Ctrl+G` · 转到符号 `Ctrl+Shift+O` · 转到定义 `F12` · 全局搜索 `Ctrl+Shift+F` |
| 编辑 | 命令面板 `Ctrl+Shift+P` · 快速修复 `Ctrl+.` · 重命名符号 `F2` · 格式化文档 `Ctrl+Shift+I` · 查找替换 `Ctrl+H` · 切换注释 `Ctrl+/` · 复制行 `Ctrl+Shift+D` · 删除行 `Ctrl+Shift+K` · 上移行 `Alt+Up` · 下移行 `Alt+Down` · 保存文件 `Ctrl+S` · 全部保存 `Ctrl+K Ctrl+S` · 撤销 `Ctrl+Z` · 重做 `Ctrl+Y` |
| 视图/窗口 | 全屏 `F11` · 禅模式 `Ctrl+Alt+Z` · 切换终端 `` Ctrl+` `` · 新建终端 `` Ctrl+Shift+` `` · 切换侧边栏 `Ctrl+B` · 切换面板 `Ctrl+J` · 拆分编辑器 `Ctrl+\` · 关闭编辑器 `Ctrl+W` · 关闭所有编辑器 `Ctrl+K Ctrl+W` · 打开聊天 `Ctrl+Alt+I` · 源代码管理 `Ctrl+Shift+G` · 扩展 `Ctrl+Shift+X` · 资源管理器 `Ctrl+Shift+E` · 调试 `Ctrl+Shift+D` · 打开设置 `Ctrl+,` · 键盘快捷方式 `Ctrl+K Ctrl+S` · 新建窗口 `Ctrl+Shift+N` |

## 与「CSS 注入水印」方案的区别

原本这套命令列表是靠 custom-css 注入 JS、往水印 DOM 里塞节点实现的，问题是：

| | CSS 注入水印 | 本扩展 |
|---|---|---|
| 实现 | 私有 DOM 类名 + 派发按键模拟 | 公开扩展 API，直接调命令 |
| 改键位后 | 点击失效 | 不受影响 |
| VS Code 升级 | 注入被重置，需重新 Enable | 无影响 |
| 位置 | 只能铺在编辑区 | 侧边栏 / 活动栏，随便放 |
| 搜索 | 无 | 有 |

## 开发

```bash
npm install
npm run compile      # 编译到 out/
npm run watch        # 增量编译
npm run check        # compile + webview 内联脚本自检（改完 buildHtml 后先跑这个）
npm run package      # 生成 .vsix
```

> `npm run check` 会重新生成 webview 的 HTML、校验内联脚本语法，并检查模板内是否混入了会被外层模板字符串吃掉的反斜杠转义——这类错误 `tsc` 不会报，但会让面板整个白屏。**改完 `src/extension.ts` 里的 `buildHtml()` 一定要跑一次**，看到「结果：通过」再重载窗口。

调试：用 VS Code 打开本目录，按 `F5` 启动「扩展开发主机」。

本地联调（不用反复打包）也可以直接把工程目录做成扩展目录的 junction：

```powershell
cmd /c mklink /J "%USERPROFILE%\.vscode\extensions\<publisher>.quick-command-deck" "<你的工程目录>"
```

## 许可

MIT
