# Quick Command Deck

把 VS Code 的**常用命令与键位**做成侧边栏里的一长列清单：**上面一个搜索框，下面「名字 + 键位」**，点一下就执行。

- **点击即执行真实命令**：走 `vscode.commands.executeCommand()`，不是模拟按键；你改过键位也照样能用
- **不依赖任何私有 CSS / DOM 类名**：用的是扩展公开 API，**VS Code 升级后依然有效**（不像 CSS 注入那样每次升级都要重修）
- **搜索即过滤**：输入名称、键位（如 `ctrl+shift+p`）或命令 ID 都能匹配
- **键盘可用**：`↑` `↓` 选择、`Enter` 执行、`Esc` 清空搜索
- **可用性体检**：启动时用 `vscode.commands.getCommands()` 核对，当前环境里不存在的命令自动置灰并标注，不会"点了没反应"
- **自动收录扩展键位**：读取已安装扩展声明的键位，搜索框为空时附在列表下方，方便直接抄命令 ID

## 安装

### 从 VSIX 安装

```bash
code --install-extension quick-command-deck-0.1.0.vsix
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
| `quickCommandDeck.fontSize` | `16` | 面板字号（px） |
| `quickCommandDeck.showKeys` | `true` | 是否显示每条命令的键位 |
| `quickCommandDeck.dense` | `false` | 紧凑模式，减小行距与内边距 |
| `quickCommandDeck.commands` | `[]` | 自定义命令清单，**留空则用内置的 36 条** |

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
npm run package      # 生成 .vsix
```

调试：用 VS Code 打开本目录，按 `F5` 启动「扩展开发主机」。

本地联调（不用反复打包）也可以直接把工程目录做成扩展目录的 junction：

```powershell
cmd /c mklink /J "%USERPROFILE%\.vscode\extensions\<publisher>.quick-command-deck" "<你的工程目录>"
```

## 许可

MIT
