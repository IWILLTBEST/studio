# IWILLTBEST Studio

[English](README.md)

[EEZ Studio](https://github.com/eez-open/studio) 的个人集成构建：在上游评审期间提前整合 LVGL 部件编辑贡献，并内置面向自动化的 AI agent 桥。跟踪 `eez-open/studio` `master` 并定期 rebase/合并——已进上游的内容直接取自上游。

## 相对上游 `master` 增加了什么

### LVGL 部件原生编辑（上游 PR）

| 部件 | 上游 PR | 状态 | 要点 |
|---|---|---|---|
| Chart | [eez-open/studio#1051](https://github.com/eez-open/studio/pull/1051) | **已合上游** | 系列（标识符 → `state->` 句柄、颜色、轴、范围），每系列仅编辑器可见的 *Preview value* |
| Table | [eez-open/studio#1052](https://github.com/eez-open/studio/pull/1052) | **已合上游** | 行数、列宽/表头 |
| MessageBox | [eez-open/studio#1055](https://github.com/eez-open/studio/pull/1055) | **已合上游** | 标题/文本，按钮作为真实子部件在专用数组编辑器管理，每按钮 Event handlers |
| List | [eez-open/studio#1056](https://github.com/eez-open/studio/pull/1056) | 在审 | 按钮与文本条目（`lv_list_add_button` / `lv_list_add_text`），位图/符号/表达式图标，每条目 Event handlers |
| TileView | [eez-open/studio#1057](https://github.com/eez-open/studio/pull/1057) | 在审 | Tile 子部件 + 位掩码滑动方向 |
| Menu | [eez-open/studio#1058](https://github.com/eez-open/studio/pull/1058) | 在审 | 菜单 page/section 子部件，首页经 `lv_menu_set_page` 显示 |
| GIF | —（仅 fork，见 [#758](https://github.com/eez-open/studio/issues/758)） | fork | `lv_gif_create` + `lv_gif_set_src`，原始 GIF 字节内嵌为 `lv_img_dsc_t`；设备需 `LV_USE_GIF=1`；fork 附带为 9.2.2/9.3.0/9.4.0/9.5.0 重编的编辑器 wasm（含 `LV_USE_GIF`），Run 模式直接放动画；每部件 *From file system* 开关改为从设备文件系统流式读取（`lv_gif_set_src(obj, "S:/ui_image_x.gif")`，.gif 拷到生成源码旁，路径前缀取构建 *File system path* 设置），或经可选 *File* 属性直指设备上已有文件（什么都不导出——Source 仅作编辑器预览替身） |

相关示例工程：[eez-open/eez-project-examples#4](https://github.com/eez-open/eez-project-examples/pull/4)（已合并）与 [#5](https://github.com/eez-open/eez-project-examples/pull/5)（在审）——示例照官方 LVGL 文档复刻。

### 类 Figma 界面重构（v0.33.0）

对编辑器外壳与控件的整体翻新，手感向 Figma 看齐——对象模型与工程格式零改动：

- **外壳**：左侧活动栏（带资源子图标：样式/字体/位图/主题/LVGL 组从右边框迁入）、页面+部件结构堆叠面板、底部浮动工具条（Run 模式也常驻）、命令面板（`Ctrl+Shift+P`，数据源为实时应用菜单）。
- **几何字段（X/Y/W/H）**：Figma 风格行组件，轴字母嵌在字段内；按住标签水平拖动即可拖洗改值——整次拖动只算一步撤回。内容定尺寸部件（GIF/Label 等）的数值呈惰性（不可点选/聚焦、变暗），单位下拉仍可切回 px/%。
- **结构树**：选中父容器整棵子树连续圆角块高亮；悬停行即在画布上勾勒对应部件轮廓。
- **控件统一**：全局无边框浮起输入框、色块嵌入框内的颜色字段+聚焦蓝环、自定义下拉菜单与 select 替换（对话框内同样生效）、工具栏幽灵按钮+自绘 tooltip。
- 以上全部新字符串均有 zh-CN 翻译（见下）。

### LVGL 9.6.0 支持（v0.32.0）

- 版本注册表加入 LVGL 9.6.0：样式/事件常量表按 9.6 适配（`CHECKED`/`UNCHECKED` 正式枚举、`GESTURE_*` 等），编辑器 wasm 运行时为 9.6 重编并导出 `lv_gif_*` 全家族。
- C 导出产物与 9.5 兼容（`IMG→IMAGE` 为上游枚举改名）。
- ESP32-P4 实机端到端验证（双 GIF 部件正常播放）。

### 界面中文化（zh-CN，v0.31.x）

完整的 UI 字典（1290+ 条，零缺口）覆盖整个编辑器界面含上述全部重构区域；设置里切换语言即时生效、无需重启。

### AI agent 桥

内置 HTTP 工具服务器（`packages/ai-agent`，监听 `127.0.0.1:17620`），把打开的工程暴露给自动化：对象级编辑（创建/更新/删除部件）、工程构建与检查、画布截图、带输入注入（点击/滑动）的调试/运行控制、样式与资源工具。上述部件工作就是靠它做无头与 CI 验证的。

像官方程序一样启动即可，桥随主窗口自动启动。工具调用方式 `POST /tool` + JSON 体 `{"tool": "<name>", "args": {...}}`。

## 构建

每个集成版本的安装包都在 [Releases](https://github.com/IWILLTBEST/studio/releases) 页（最新：[v0.33.0](https://github.com/IWILLTBEST/studio/releases/tag/v0.33.0)——类 Figma 界面 + LVGL 9.6.0）。

从源码构建，与上游相同：

```bash
npm install
npm run build
```

## 与上游的关系

- 基于 `eez-open/studio` `master`（确切基点见合并提交）。
- 部件 PR 以干净的单目的分支放在 [IWILLTBEST/studio-upstream](https://github.com/IWILLTBEST/studio-upstream)；本仓库是日常使用的个人集成分支。
- PR 合入上游后，下次 rebase 到上游 `master` 时本地副本让位于上游版本。

## 版权与许可

贡献者名单见 CONTRIB.TXT。本项目采用 GPL v3 许可，见 LICENSE.TXT。
EEZ Studio 采用 [C4.1（集体代码构建契约）](http://rfc.zeromq.org/spec:22)流程接受贡献。

_重要说明：除使用了 EEZ Flow 的工程（此时按 MIT 许可给出）外，Envox d.o.o. 不对 `Build` 命令生成的源代码主张任何权利。_
_用户拥有 `.eez-project` 文件及由该文件内模板定义生成的全部源代码。EEZ Studio 也可能生成采用 MIT、BSD 2.0 或公共领域许可的文件。_

## 链接

-   [EEZ Studio 官网](https://www.envox.eu/studio/studio-introduction/)
-   [上游仓库](https://github.com/eez-open/studio)
-   [Discord](https://discord.gg/q5KAeeenNG) 服务器
-   [eez-project-examples](https://github.com/eez-open/eez-project-examples)
