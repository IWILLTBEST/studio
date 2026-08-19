import fs from "fs";
import path from "path";

import type { ProjectStore } from "project-editor/store";
import { runInAction, toJS } from "mobx";

import {
    Section,
    createObject,
    getObjectFromStringPath,
    getObjectPath,
    getObjectPathAsString
} from "project-editor/store";
import {
    MessageType,
    getClassByName,
    getClassesDerivedFrom,
    getDefaultValue,
    setParent
} from "project-editor/core/object";
import { LVGLStyle } from "project-editor/lvgl/style";
import { Color } from "project-editor/features/style/theme";
import { openProject, tabs, ProjectEditorTab } from "home/tabs-store";

// 注意：Page（features/page/page）和 LVGLWidget（lvgl/widgets/Base）必须在函数内
// 惰性 require——它们拖出 project/ui/ProjectEditor → ai-agent/panel 的反向依赖，
// 顶层 import 会形成循环依赖，模块初始化时直接把渲染进程炸掉。

////////////////////////////////////////////////////////////////////////////////
// Agent 工具实现（工程编辑器内部 API，直接访问 ProjectStore）

export interface ToolContext {
    projectStore: ProjectStore;
    workdir: string;
    irFile: string;
    outFile: string;
    pythonPath: string;
}

function fullIrPath(ctx: ToolContext) {
    return path.join(ctx.workdir, ctx.irFile);
}

/** 读当前 IR 全文 */
export function readIr(ctx: ToolContext): string {
    return fs.readFileSync(fullIrPath(ctx), "utf-8");
}

/** 写回 IR（只允许工作目录内的 .ir.json）*/
export function writeIr(ctx: ToolContext, content: string): string {
    const p = fullIrPath(ctx);
    JSON.parse(content); // 不是合法 JSON 直接抛错给模型
    fs.writeFileSync(p, content, "utf-8");
    return `IR 已写入 ${p}（${content.length} 字节）`;
}

/** 跑 ir2eez.py 编译。返回 {ok, output}（校验退出码——非 0 = 失败且工程未写盘）*/
export function compileIr(ctx: ToolContext): { ok: boolean; output: string } {
    const outPath = path.join(ctx.workdir, ctx.outFile);
    const result = { ok: false, output: "" };
    try {
        const stdout = require("child_process").execFileSync(
            ctx.pythonPath,
            [
                path.join(ctx.workdir, "ir2eez.py"),
                fullIrPath(ctx),
                "-o",
                outPath
            ],
            { encoding: "utf-8", timeout: 120000, cwd: ctx.workdir }
        );
        result.output = stdout;
        result.ok = true;
    } catch (err: any) {
        result.output = `${err?.stdout ?? ""}\n${err?.stderr ?? err?.message ?? err}`;
    }
    return result;
}

/**
 * 重载当前工程（等价 Close+Open，保留 ui-state 里最后打开的屏幕）。
 * reloadProject 内部异步重建 store，之后要等工程重新就绪再截图。
 */
export async function reloadProject(ctx: ToolContext): Promise<string> {
    const store = ctx.projectStore;
    if (!store) {
        return "当前没有打开的工程";
    }
    // 跳过 dirty 确认弹窗：以磁盘为准
    runInAction(() => {
        store.savedRevision = store.lastRevision;
    });
    store.reloadProject();
    // reloadProject 不返回 Promise：轮询等新 store 完全加载
    for (let i = 0; i < 100; i++) {
        await sleep(200);
        const p: any = (store as any).project;
        if (p && p._fullyLoaded) {
            // store 对象本身会被替换，加载完成后再多等一拍让预览出帧
            await sleep(1200);
            return "工程已重载";
        }
    }
    return "工程重载等待超时（10s），继续后续步骤可能拿到旧画面";
}

/** 导航到指定屏幕（打开它的页面编辑器） */
export function navigateToScreen(ctx: ToolContext, screen: string): string {
    const store = ctx.projectStore;
    const page = (store.project as any).userPages.find(
        (p: any) => p.name === screen
    );
    if (!page) {
        return `没有名为 ${screen} 的屏幕，现有: ${(
            store.project as any
        ).userPages.map((p: any) => p.name).join(", ")}`;
    }
    store.navigationStore.showObjects([page], true, true, true);
    return `已导航到屏幕 ${screen}`;
}

/**
 * 截取当前 LVGL 页面预览（编辑器是真 LVGL 跑在 wasm，帧常驻 2D canvas，
 * 分辨率恒等于页面逻辑尺寸）。返回 PNG dataURL。
 */
export function screenshotOnce(): string | undefined {
    const canvases = document.querySelectorAll<HTMLCanvasElement>(
        ".EezStudio_FlowEditorCanvasContainer .eez-canvas canvas"
    );
    let best: HTMLCanvasElement | undefined;
    for (let j = 0; j < canvases.length; j++) {
        const c = canvases[j];
        if (!best || c.width * c.height > best.width * best.height) {
            best = c;
        }
    }
    if (best && best.width > 0 && best.height > 0) {
        return best.toDataURL("image/png");
    }
    return undefined;
}

/** 带重试的截图：navigate/reload 后 canvas 可能需要 1~2 秒才出现 */
export async function screenshotWithRetry(maxWait = 4000): Promise<string | undefined> {
    const start = Date.now();
    while (Date.now() - start < maxWait) {
        const data = screenshotOnce();
        if (data) return data;
        await sleep(500);
    }
    return undefined;
}

/** 截图存盘（_shots/ 目录），返回 {dataUrl, file} */
export function screenshotToFile(
    workdir: string,
    tag: string
): { dataUrl: string; file: string } | undefined {
    const dataUrl = screenshotOnce();
    if (!dataUrl) {
        return undefined;
    }
    const dir = path.join(workdir, "_shots");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(
        dir,
        `${new Date().toISOString().replace(/[:.]/g, "-")}_${tag}.png`
    );
    fs.writeFileSync(file, Buffer.from(dataUrl.split(",")[1], "base64"));
    return { dataUrl, file };
}

export function sleep(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

////////////////////////////////////////////////////////////////////////////////
// Output / Checks（构建与检查错误，读底部 Output 面板的 sections）

const MESSAGE_TYPE_NAMES: Record<number, string> = {
    [MessageType.INFO]: "info",
    [MessageType.ERROR]: "error",
    [MessageType.WARNING]: "warning",
    [MessageType.SEARCH_RESULT]: "search",
    [MessageType.GROUP]: "group"
};

function flattenMessages(
    messages: any[],
    out: { type: string; text: string; object?: string }[],
    depth: number
) {
    for (const m of messages) {
        out.push({
            type: MESSAGE_TYPE_NAMES[m.type] ?? String(m.type),
            text: String(m.text ?? ""),
            object: m.object ? getObjectPathAsString(m.object) : undefined
        });
        if (m.type === MessageType.GROUP && Array.isArray(m.messages)) {
            flattenMessages(m.messages, out, depth + 1);
        }
    }
}

/** 读 Checks（实时后台检查）或 Output（构建输出）section 的全部消息 */
export function readOutputSection(
    ctx: ToolContext,
    which: "checks" | "output"
) {
    const store: any = ctx.projectStore;
    const sectionType = which === "output" ? Section.OUTPUT : Section.CHECKS;
    const section = store.outputSectionsStore.getSection(sectionType);
    const messages: { type: string; text: string; object?: string }[] = [];
    flattenMessages(section.messages.messages, messages, 0);
    return {
        section: which,
        loading: section.loading,
        numErrors: section.numErrors,
        numWarnings: section.numWarnings,
        messages
    };
}

/** 触发一次完整检查（Ctrl+K），等结束后返回 Output section 消息 */
export async function runCheck(ctx: ToolContext) {
    const store: any = ctx.projectStore;
    const out = store.outputSectionsStore.getSection(Section.OUTPUT);
    store.check(); // 内部异步，不返回 promise，靠 loading 标志轮询
    const deadline = Date.now() + 90000;
    let sawLoading = out.loading;
    while (Date.now() < deadline) {
        await sleep(150);
        if (out.loading) {
            sawLoading = true;
        }
        if (sawLoading && !out.loading) {
            break;
        }
        // "Nothing to build!" 场景不进入 loading：出现消息即算结束
        if (!sawLoading && out.messages.messages.length > 0) {
            await sleep(400);
            break;
        }
    }
    return readOutputSection(ctx, "output");
}

/** 触发完整构建（Ctrl+B，LVGL 工程会生成 C 源码），等结束后返回 Output section 消息 */
export async function runBuild(ctx: ToolContext) {
    const store: any = ctx.projectStore;
    await store.build();
    return readOutputSection(ctx, "output");
}

////////////////////////////////////////////////////////////////////////////////
// 样式 / 主题（直接走 ProjectStore 命令封装，支持 undo，改完自动保存）

async function persistStore(store: any): Promise<string> {
    await store.save();
    return "已保存到磁盘";
}

function findLvglStyles(project: any): any[] {
    return project.lvglStyles?.styles ?? [];
}

function findLvglStyle(project: any, name: string) {
    const style = findLvglStyles(project).find((s: any) => s.name === name);
    if (!style) {
        throw new Error(
            `没有名为 ${name} 的 LVGL 样式，现有: ${findLvglStyles(project)
                .map((s: any) => s.name)
                .join(", ") || "（无）"}`
        );
    }
    return style;
}

/** 列出 LVGL 样式（含完整 definition）、经典样式名、主题与颜色矩阵 */
export function listStyles(ctx: ToolContext) {
    const project: any = ctx.projectStore.project;
    return {
        lvglStyles: findLvglStyles(project).map((s: any) => ({
            name: s.name,
            forWidgetType: s.forWidgetType || undefined,
            definition: JSON.parse(JSON.stringify(toJS(s.definition?.definition ?? {}))),
            childStyles: (s.childStyles ?? []).map((c: any) => c.name)
        })),
        styles: (project.styles ?? []).map((s: any) => s.name),
        colors: (project.colors ?? []).map((c: any) => c.name),
        themes: (project.themes ?? []).map((t: any) => ({
            name: t.name,
            colors: toJS(t.colors)
        }))
    };
}

/**
 * 修改 LVGL 样式的 definition：definition[part][state][prop] = value。
 * properties 里值为 null 的键会被删除。
 */
export async function updateLvglStyle(
    ctx: ToolContext,
    styleName: string,
    part: string,
    state: string,
    properties: Record<string, any>
) {
    const store: any = ctx.projectStore;
    const partKey = String(part || "MAIN").toUpperCase();
    const stateKey = String(state || "DEFAULT").toUpperCase();
    const style = findLvglStyle(store.project, styleName);
    const defObj = style.definition;
    const def = JSON.parse(
        JSON.stringify(toJS(defObj?.definition ?? {}))
    );
    if (!def[partKey]) def[partKey] = {};
    if (!def[partKey][stateKey]) def[partKey][stateKey] = {};
    for (const [k, v] of Object.entries(properties ?? {})) {
        if (v === null || v === undefined) {
            delete def[partKey][stateKey][k];
        } else {
            def[partKey][stateKey][k] = v;
        }
    }
    store.updateObject(defObj, { definition: def });
    await persistStore(store);
    return `样式 ${styleName} 的 ${partKey}/${stateKey} 已更新并保存: ${JSON.stringify(
        def[partKey][stateKey]
    )}`;
}

/** 新建 LVGL 样式（默认作用于 Panel 部件） */
export async function createLvglStyle(
    ctx: ToolContext,
    name: string,
    forWidgetType: string
) {
    const store: any = ctx.projectStore;
    const project = store.project;
    if (findLvglStyles(project).some((s: any) => s.name === name)) {
        throw new Error(`样式 ${name} 已存在`);
    }
    const style = createObject<LVGLStyle>(
        store,
        {
            name,
            forWidgetType: forWidgetType || "LVGLPanelWidget",
            definition: {} as any
        },
        LVGLStyle
    );
    store.addObject(project.lvglStyles.styles, style);
    await persistStore(store);
    return `已创建样式 ${name}（forWidgetType=${
        forWidgetType || "LVGLPanelWidget"
    }），用 update_style 设置属性`;
}

export async function deleteLvglStyle(ctx: ToolContext, name: string) {
    const store: any = ctx.projectStore;
    const style = findLvglStyle(store.project, name);
    store.deleteObject(style);
    await persistStore(store);
    return `已删除样式 ${name}（引用它的部件会在 check 里报错）`;
}

/** 设置主题颜色。theme 省略 = 所有主题一起改（合成一条 undo） */
export async function setThemeColor(
    ctx: ToolContext,
    colorName: string,
    value: string,
    themeName?: string
) {
    const store: any = ctx.projectStore;
    const project = store.project;
    const colorIndex = (project.colors ?? []).findIndex(
        (c: any) => c.name === colorName
    );
    if (colorIndex < 0) {
        throw new Error(
            `没有颜色 ${colorName}，现有: ${(project.colors ?? [])
                .map((c: any) => c.name)
                .join(", ") || "（无）"}`
        );
    }
    const themes = themeName
        ? (project.themes ?? []).filter((t: any) => t.name === themeName)
        : project.themes ?? [];
    if (themes.length === 0) {
        throw new Error(
            `没有主题 ${themeName}，现有: ${(project.themes ?? [])
                .map((t: any) => t.name)
                .join(", ")}`
        );
    }
    store.undoManager.setCombineCommands(true);
    try {
        for (const theme of themes) {
            const colors = theme.colors.slice();
            colors[colorIndex] = value;
            store.updateObject(theme, { colors });
        }
    } finally {
        store.undoManager.setCombineCommands(false);
    }
    await persistStore(store);
    return `颜色 ${colorName} = ${value}（主题: ${themes
        .map((t: any) => t.name)
        .join(", ")}），引用该颜色名的样式/部件会即时变色`;
}

/** 新增主题颜色槽位，并在所有主题里赋初值 */
export async function addThemeColor(
    ctx: ToolContext,
    colorName: string,
    value: string
) {
    const store: any = ctx.projectStore;
    const project = store.project;
    if ((project.colors ?? []).some((c: any) => c.name === colorName)) {
        throw new Error(`颜色 ${colorName} 已存在`);
    }
    const color = createObject<Color>(store, { name: colorName }, Color);
    store.addObject(project.colors, color);
    const themes = project.themes ?? [];
    store.undoManager.setCombineCommands(true);
    try {
        for (const theme of themes) {
            const colors = theme.colors.slice();
            while (colors.length < project.colors.length) {
                colors.push("#000000");
            }
            colors[project.colors.length - 1] = value;
            store.updateObject(theme, { colors });
        }
    } finally {
        store.undoManager.setCombineCommands(false);
    }
    await persistStore(store);
    return `已新增颜色 ${colorName}（${themes.length} 个主题初始化为 ${value}）`;
}

////////////////////////////////////////////////////////////////////////////////
// 直接读/写 .eez-project JSON（绕过 IR 编译管线）

export function readProjectJson(ctx: ToolContext): string {
    const store: any = ctx.projectStore;
    const filePath = store.filePath;
    if (!filePath) {
        throw new Error("当前没有打开的工程");
    }
    return fs.readFileSync(filePath, "utf-8");
}

export async function writeProjectJson(
    ctx: ToolContext,
    content: string,
    doReload: boolean
): Promise<string> {
    const store: any = ctx.projectStore;
    const filePath = store.filePath;
    if (!filePath) {
        throw new Error("当前没有打开的工程");
    }
    JSON.parse(content); // 不是合法 JSON 直接抛错给模型
    fs.writeFileSync(filePath, content, "utf-8");
    let msg = `已写入 ${filePath}（${content.length} 字节）`;
    if (doReload) {
        msg += "；" + (await reloadProject(ctx));
    } else {
        msg += "（未重载，编辑器里还是旧内容）";
    }
    return msg;
}

////////////////////////////////////////////////////////////////////////////////
// 多工程操控（枚举/切换/打开工程 tab；其余工具都作用于活动 tab）

export function listProjects() {
    return tabs.tabs
        .filter(t => t instanceof ProjectEditorTab)
        .map((t: any, i: number) => ({
            index: i,
            filePath: t.filePath,
            name: path.basename(t.filePath ?? ""),
            active: t === tabs.activeTab,
            loaded: !!t.projectStore,
            runtimeActive: !!t.projectStore?.runtime
        }));
}

async function waitForProjectLoad(
    findTab: () => any,
    timeoutMs: number
): Promise<string> {
    for (let i = 0; i < timeoutMs / 200; i++) {
        await sleep(200);
        const tab = findTab();
        if (tab) {
            const p = tab.projectStore?.project;
            if (p && p._fullyLoaded) {
                await sleep(800); // 多等一拍让预览出帧
                return `工程已就绪: ${tab.filePath}`;
            }
        }
    }
    return "工程加载等待超时，可能仍在加载（后续操作可能拿到旧状态）";
}

/** 切换活动工程 tab（索引 / 文件名 / 完整路径），之后所有工具作用于它 */
export async function selectProject(match: string | number) {
    const projTabs = tabs.tabs.filter(
        t => t instanceof ProjectEditorTab
    ) as any[];
    let tab: any;
    if (typeof match === "number") {
        tab = projTabs[match];
    } else {
        const m = String(match).toLowerCase().replace(/\\/g, "/");
        tab =
            projTabs.find(t => t.filePath === match) ??
            projTabs.find(
                t =>
                    path.basename(t.filePath ?? "").toLowerCase() === m ||
                    String(t.filePath ?? "").toLowerCase().replace(/\\/g, "/") === m
            );
    }
    if (!tab) {
        throw new Error(
            `没有匹配 "${match}" 的工程，现有: ${projTabs
                .map((t, i) => `${i}=${t.filePath}`)
                .join(" | ") || "（无）"}`
        );
    }
    if (tab !== tabs.activeTab) {
        tabs.makeActive(tab);
    }
    return await waitForProjectLoad(() => tab, 30000);
}

/** 打开一个新工程 tab（已打开则复用并切换） */
export async function openProjectFile(filePath: string) {
    if (!fs.existsSync(filePath)) {
        throw new Error(`文件不存在: ${filePath}`);
    }
    const norm = (p: string) => path.resolve(p).toLowerCase();
    const findTab = () =>
        tabs.tabs.find(
            (t: any) =>
                t instanceof ProjectEditorTab &&
                t.filePath &&
                norm(t.filePath) === norm(filePath)
        );
    const existing = !!findTab();
    openProject(filePath, false);
    let wait = await waitForProjectLoad(findTab, 30000);
    // 死 tab 复活：先前加载失败的 tab（error 置位后 active 不会再重试），
    // 文件现在存在的话清错并强制重载一次
    const tab: any = findTab();
    if (tab && !tab.projectStore && tab.error) {
        runInAction(() => {
            tab.error = undefined;
        });
        await tab.loadProject();
        wait = await waitForProjectLoad(findTab, 30000);
    }
    return (existing ? "已有该工程的 tab，已切换；" : "已打开新 tab；") + wait;
}

////////////////////////////////////////////////////////////////////////////////
// 运行时调试（LVGL 工程对应本地 wasm 模拟器；F5/Ctrl+F5/F6/F10 同款动作）

function runtimeSummary(store: any) {
    const r = store.runtime;
    if (!r) {
        return { runtime: "inactive" };
    }
    const logs = r.logs?.logs ?? [];
    return {
        runtime: "active",
        isDebuggerActive: !!r.isDebuggerActive,
        isRunning: !!r.isRunning,
        isPaused: !!r.isPaused,
        isSingleStep: !!r.isSingleStep,
        selectedPage: r.selectedPage?.name,
        logsTail: logs.slice(-30).map((l: any) => ({
            time: l.date instanceof Date ? l.date.toLocaleTimeString() : String(l.date),
            type: l.type,
            text: l.label
        }))
    };
}

export function debugStatus(ctx: ToolContext) {
    const store: any = ctx.projectStore;
    return runtimeSummary(store);
}

/** 启动运行时：debug=调试模式（Ctrl+F5，可断点/单步），run=运行模式（F5） */
export async function debugStart(ctx: ToolContext, mode: string) {
    const store: any = ctx.projectStore;
    if (store.runtime) {
        return "运行时已在运行\n" + JSON.stringify(runtimeSummary(store), null, 2);
    }
    if (mode === "run") {
        store.onSetRuntimeMode();
    } else {
        store.onSetDebuggerMode();
    }
    // wasm 资产构建可能要几十秒：轮询 runtime 出现
    for (let i = 0; i < 220; i++) {
        await sleep(400);
        if (store.runtime) {
            await sleep(1500); // 让首帧画出来
            return "运行时已启动\n" + JSON.stringify(runtimeSummary(store), null, 2);
        }
    }
    return "等待运行时启动超时（~90s），稍后用 debug_status 查询";
}

export async function debugStop(ctx: ToolContext) {
    const store: any = ctx.projectStore;
    if (!store.runtime) {
        return "运行时未在运行";
    }
    await store.onSetEditorMode();
    return "已停止运行时，回到编辑模式";
}

/** pause / resume / step_over / step_into / step_out / restart */
export async function debugControl(ctx: ToolContext, op: string) {
    const store: any = ctx.projectStore;
    const r = store.runtime;
    if (!r) {
        throw new Error("运行时未启动（先调 debug_start）");
    }
    switch (op) {
        case "pause":
            await r.pause();
            break;
        case "resume":
            await r.resume();
            break;
        case "step_over":
        case "step_into":
        case "step_out":
            await r.runSingleStep(op);
            break;
        case "restart":
            await store.onRestartRuntimeWithDebuggerActive();
            break;
        default:
            throw new Error(
                `未知操作 ${op}，支持: pause, resume, step_over, step_into, step_out, restart`
            );
    }
    await sleep(300);
    return runtimeSummary(store);
}

/** 读全局变量（调试/运行模式下与模拟器双向同步） */
export function readVariable(ctx: ToolContext, name: string) {
    const store: any = ctx.projectStore;
    const dc = store.dataContext;
    if (!dc.has(name)) {
        const vars = (store.project.variables?.globalVariables ?? []).map(
            (v: any) => v.name
        );
        return {
            found: false,
            hint: `没有变量 ${name}，工程全局变量: ${vars.join(", ") || "（无）"}`
        };
    }
    return { found: true, name, value: toJS(dc.get(name)) };
}

/** 写全局变量（更新数据上下文；LVGL wasm 内部状态的回写能力有限） */
export function writeVariable(ctx: ToolContext, name: string, value: any) {
    const store: any = ctx.projectStore;
    const dc = store.dataContext;
    if (!dc.has(name)) {
        const vars = (store.project.variables?.globalVariables ?? []).map(
            (v: any) => v.name
        );
        throw new Error(
            `没有变量 ${name}，工程全局变量: ${vars.join(", ") || "（无）"}`
        );
    }
    dc.set(name, value);
    return `已写入 ${name} = ${JSON.stringify(toJS(dc.get(name)))}`;
}

////////////////////////////////////////////////////////////////////////////////
// 对象级编辑（部件/页面按路径 CRUD + undo/redo + 编辑器定位）
//
// 路径格式与 getObjectPathAsString 一致：/userPages/0/components/0/children/3
// （LVGL 页面的根是 LVGLScreenWidget，普通部件都在 components/0/children 下）。

function objectPathOf(obj: any): string {
    return "/" + getObjectPath(obj).join("/");
}

/** 按 objID 全树查找（objID 创建时分配、随工程持久化，索引漂移不影响） */
function findObjectByObjID(ctx: ToolContext, objID: string): any | undefined {
    // 惰性 require：core/search 拖表达式解析器等重依赖，顶层 import 有循环依赖风险
    const { visitObjects } = require("project-editor/core/search");
    for (const o of visitObjects(ctx.projectStore.project)) {
        if (o && o.objID === objID) {
            return o;
        }
    }
    return undefined;
}

const GUID_RE = /^[0-9a-f][0-9a-f-]{19,}$/i;

/**
 * 解析对象引用：路径（/userPages/0/components/0/children/3）或 objID
 * （裸 GUID / "objID:<guid>"）。结构增删会让路径索引漂移，objID 恒定。
 */
function resolveObject(ctx: ToolContext, path: string): any {
    let p = String(path ?? "").trim();
    // 容错：接受带 [file]: 前缀的完整形式
    const i = p.indexOf("]:");
    if (p.startsWith("[") && i != -1) {
        p = p.slice(i + 2);
    }

    let objID: string | undefined;
    if (p.startsWith("objID:")) {
        objID = p.slice(6).trim();
    } else if (!p.includes("/") && GUID_RE.test(p)) {
        objID = p;
    }
    if (objID) {
        const obj = findObjectByObjID(ctx, objID);
        if (obj) {
            return obj;
        }
        throw new Error(`没有 objID=${objID} 的对象`);
    }

    if (!p.startsWith("/")) {
        p = "/" + p;
    }
    const obj: any = getObjectFromStringPath(ctx.projectStore.project, p);
    // 所有 EezObject 都有 objID：解析出无 objID 的东西（数组/越界残骸）说明
    // 路径漂移了（getChildOfObject 对越界索引会给残缺结果），必须报错
    if (!obj || obj.objID === undefined) {
        throw new Error(
            `路径不存在: ${path}（增删部件后数组索引会漂移——重新 list_objects 取新路径，或改用 objID 寻址）`
        );
    }
    return obj;
}

function isEezObjectLike(v: any): boolean {
    return (
        v !== null &&
        typeof v === "object" &&
        !(v instanceof Date) &&
        !(v instanceof Map) &&
        !(v instanceof Set) &&
        (v.objID !== undefined || v.type !== undefined)
    );
}

/**
 * 序列化对象子树：与官方 objectToJson 同口径（toJS 只含 observable 持久化
 * 字段，computed/内部字段自动跳过），depth 控制 EezObject 子对象/数组的展开
 * 层级，用尽时给路径（可继续 get_object 深入）。路径从活对象取（toJS 后无身份）。
 */
function serializeTree(obj: any, depth: number): any {
    let plain: any;
    try {
        plain = toJS(obj);
    } catch {
        return { __error__: "对象序列化失败" };
    }
    return pruneTree(plain, obj, depth);
}

function isEezArray(liveArr: any): boolean {
    return (
        Array.isArray(liveArr) &&
        liveArr.length > 0 &&
        isEezObjectLike(liveArr[0])
    );
}

function pruneTree(plain: any, live: any, depth: number): any {
    if (plain === null || typeof plain !== "object") {
        return plain;
    }
    if (Array.isArray(plain)) {
        const liveArr = Array.isArray(live) ? live : [];
        if (!isEezArray(liveArr)) {
            return plain;
        }
        if (depth > 0) {
            return plain.map((p: any, i: number) =>
                pruneTree(p, liveArr[i], depth - 1)
            );
        }
        return liveArr.map((c: any) => objectPathOf(c));
    }
    // EezObject 子对象 / 普通对象
    const out: any = {};
    for (const k of Object.keys(plain)) {
        if (k.startsWith("_")) {
            continue;
        }
        const v = plain[k];
        const lv = live?.[k];
        if (v !== null && typeof v === "object") {
            if (Array.isArray(v)) {
                out[k] = pruneTree(v, lv, depth);
            } else if (isEezObjectLike(lv)) {
                out[k] =
                    depth > 0 ? pruneTree(v, lv, depth - 1) : objectPathOf(lv);
            } else {
                // 普通嵌套对象（LVGL 样式 definition 字典等）：跟随 depth 但不再减层
                out[k] = depth > 0 ? pruneTree(v, lv, depth) : v;
            }
        } else {
            out[k] = v;
        }
    }
    return out;
}

/** 部件树紧凑节点（list_objects 用）：路径 + objID + 几何 + 常用内容属性 */
function widgetNode(w: any): any {
    const node: any = {
        path: objectPathOf(w),
        objID: w.objID,
        type: w.type
    };
    if (w.identifier) {
        node.identifier = w.identifier;
    }
    node.left = w.left;
    node.top = w.top;
    node.width = w.width;
    node.height = w.height;
    for (const unit of ["leftUnit", "topUnit", "widthUnit", "heightUnit"]) {
        if (w[unit] && w[unit] !== "px") {
            node[unit] = w[unit];
        }
    }
    for (const k of [
        "useStyle",
        "hiddenFlag",
        "clickableFlag",
        "text",
        "textType",
        "value",
        "min",
        "max",
        "options",
        "placeholder",
        "src",
        "color"
    ]) {
        if (w[k] !== undefined && w[k] !== null && w[k] !== false) {
            node[k] = w[k];
        }
    }
    const ch = w.children ?? [];
    if (ch.length > 0) {
        node.children = ch.map(widgetNode);
    }
    return node;
}

function allPages(project: any): any[] {
    return [...(project.userPages ?? []), ...(project.userWidgets ?? [])];
}

/**
 * 列对象树。screen=页面名 → 该页面部件树；path=对象路径 → 该对象子树；
 * 都不给 → 页面总览（名称/尺寸/部件数）。
 */
export function listObjects(ctx: ToolContext, screen?: string, path?: string) {
    const project: any = ctx.projectStore.project;
    if (screen) {
        const page = allPages(project).find((p: any) => p.name === screen);
        if (!page) {
            throw new Error(
                `没有页面 ${screen}，现有: ${allPages(project)
                    .map((p: any) => p.name)
                    .join(", ")}`
            );
        }
        const root = page.lvglScreenWidget;
        return {
            screen: page.name,
            path: objectPathOf(page),
            width: page.width,
            height: page.height,
            children: (root?.children ?? page.components ?? []).map(widgetNode)
        };
    }
    if (path) {
        const obj = resolveObject(ctx, path);
        if (obj.children) {
            return {
                path: objectPathOf(obj),
                type: obj.type,
                children: (obj.children ?? []).map(widgetNode)
            };
        }
        if (obj.components) {
            return {
                path: objectPathOf(obj),
                name: obj.name,
                children: (obj.lvglScreenWidget?.children ?? obj.components).map(
                    widgetNode
                )
            };
        }
        return { path: objectPathOf(obj), type: obj.type, leaf: true };
    }
    return {
        screens: allPages(project).map((p: any) => ({
            name: p.name,
            path: objectPathOf(p),
            isUserWidget: !!p.isUsedAsUserWidget,
            width: p.width,
            height: p.height,
            widgetCount: (p.lvglScreenWidget?.children ?? p.components ?? [])
                .length
        }))
    };
}

/** 读对象子树（depth 层，默认 2；用尽给路径） */
export function getObject(ctx: ToolContext, path: string, depth: number) {
    const obj = resolveObject(ctx, path);
    return serializeTree(obj, depth);
}

/**
 * 手术式改对象属性。properties 键即属性名（LVGL 部件属性平铺：left/top/
 * width/height/text/useStyle/hiddenFlag...）；支持一层点路径（如 "data.text"）。
 * 走 updateObject 命令封装（可 undo），改完自动保存。
 */
export async function updateObjectByPath(
    ctx: ToolContext,
    path: string,
    properties: Record<string, any>
) {
    const store: any = ctx.projectStore;
    const obj = resolveObject(ctx, path);
    store.undoManager.setCombineCommands(true);
    try {
        const direct: Record<string, any> = {};
        const nested = new Map<any, Record<string, any>>();
        for (const [k, v] of Object.entries(properties ?? {})) {
            const dot = k.indexOf(".");
            if (dot > 0) {
                const child = obj[k.slice(0, dot)];
                if (child && typeof child === "object" && !Array.isArray(child)) {
                    let sub = nested.get(child);
                    if (!sub) {
                        sub = {};
                        nested.set(child, sub);
                    }
                    sub[k.slice(dot + 1)] = v;
                    continue;
                }
            }
            direct[k] = v;
        }
        if (Object.keys(direct).length > 0) {
            store.updateObject(obj, direct);
        }
        for (const [child, sub] of nested) {
            store.updateObject(child, sub);
        }
    } finally {
        store.undoManager.setCombineCommands(false);
    }
    await persistStore(store);
    return `已更新 ${path}: ${JSON.stringify(properties)}`;
}

function availableWidgetTypes(store: any): string[] {
    try {
        const { LVGLWidget } = require("project-editor/lvgl/widgets/Base");
        return getClassesDerivedFrom(store, LVGLWidget)
            .map((c: any) => c.name)
            .filter((n: string) => n !== "LVGLScreenWidget");
    } catch {
        return [];
    }
}

/**
 * 新建部件。parent = 页面名 / 页面路径 / 带 children 的部件路径；
 * properties 覆盖类默认值（left/top/width/height/text 等）。
 * addObject 的 fixParentObject 会自动把部件放进页面的 LVGLScreenWidget。
 */
export async function createWidget(
    ctx: ToolContext,
    type: string,
    parent: string,
    properties: Record<string, any>
) {
    const store: any = ctx.projectStore;
    const project = store.project;
    const cls = getClassByName(store, type);
    if (!cls) {
        throw new Error(
            `未知部件类型 ${type}。可用: ${availableWidgetTypes(store).join(
                ", "
            )}`
        );
    }
    let parentArray: any;
    let parentDesc: string;
    const page = allPages(project).find((p: any) => p.name === parent);
    if (page) {
        parentArray = page.components;
        parentDesc = `页面 ${page.name}`;
    } else {
        const pObj = resolveObject(ctx, parent);
        if (Array.isArray(pObj.components) && pObj.name !== undefined) {
            parentArray = pObj.components;
            parentDesc = `页面 ${pObj.name}`;
        } else if (Array.isArray(pObj.children)) {
            parentArray = pObj.children;
            parentDesc = `${pObj.type} ${objectPathOf(pObj)}`;
        } else {
            throw new Error(
                `父对象不是容器（要页面名/页面路径或带 children 的部件）: ${parent}`
            );
        }
    }
    const js: any = Object.assign(
        {},
        getDefaultValue(store, cls.classInfo) ?? {},
        { type },
        properties ?? {}
    );
    if (js.left == undefined) js.left = 0;
    if (js.top == undefined) js.top = 0;
    if (js.width == undefined) js.width = 100;
    if (js.height == undefined) js.height = 40;
    const widget = createObject(store, js, cls);
    store.addObject(parentArray, widget);
    await persistStore(store);
    return {
        created: objectPathOf(widget),
        type,
        parent: parentDesc,
        summary: widgetNode(widget)
    };
}

export async function deleteObjectByPath(ctx: ToolContext, path: string) {
    const store: any = ctx.projectStore;
    const obj = resolveObject(ctx, path);
    for (const p of allPages(store.project)) {
        if (p.lvglScreenWidget === obj) {
            throw new Error(
                "不能删页面根 ScreenWidget；要删整页就 delete_object 到页面路径"
            );
        }
    }
    const was = {
        type: obj.type,
        name: obj.name,
        identifier: obj.identifier,
        path: objectPathOf(obj)
    };
    store.deleteObject(obj);
    await persistStore(store);
    return { deleted: path, was };
}

/** 新建页面（自动带 LVGLScreenWidget 根，尺寸默认取工程显示设置） */
export async function createScreen(
    ctx: ToolContext,
    name: string,
    width?: number,
    height?: number
) {
    const store: any = ctx.projectStore;
    const project = store.project;
    if (allPages(project).some((p: any) => p.name === name)) {
        throw new Error(`页面 ${name} 已存在`);
    }
    const w = width ?? project.settings.general.displayWidth ?? 480;
    const h = height ?? project.settings.general.displayHeight ?? 272;
    const { Page } = require("project-editor/features/page/page");
    const pageProperties: any = {
        name,
        left: 0,
        top: 0,
        width: w,
        height: h,
        components: [
            {
                type: "LVGLScreenWidget",
                left: 0,
                top: 0,
                width: w,
                height: h,
                leftUnit: "px",
                topUnit: "px",
                widthUnit: "px",
                heightUnit: "px",
                children: []
            }
        ],
        isUsedAsUserWidget: false
    };
    const page = createObject(store, pageProperties, Page);
    store.addObject(project.userPages, page);
    await persistStore(store);
    return { created: objectPathOf(page), name, width: w, height: h };
}

export async function undoProject(ctx: ToolContext) {
    const store: any = ctx.projectStore;
    if (!store.undoManager.canUndo) {
        return { undone: false, reason: "没有可撤销的操作" };
    }
    store.undoManager.undo();
    await persistStore(store);
    return {
        undone: true,
        canUndo: store.undoManager.canUndo,
        canRedo: store.undoManager.canRedo
    };
}

export async function redoProject(ctx: ToolContext) {
    const store: any = ctx.projectStore;
    if (!store.undoManager.canRedo) {
        return { redone: false, reason: "没有可重做的操作" };
    }
    store.undoManager.redo();
    await persistStore(store);
    return {
        redone: true,
        canUndo: store.undoManager.canUndo,
        canRedo: store.undoManager.canRedo
    };
}

/** 在编辑器里选中并定位到对象（check 报错后跳到出错部件用） */
export function gotoObject(ctx: ToolContext, path: string) {
    const obj = resolveObject(ctx, path);
    // showInNavigation/selectObject 置 false：不动导航面板——面板选中会在
    // propertyGridObjects 里遮蔽编辑器选中，导致 get_selection 读到页面
    ctx.projectStore.navigationStore.showObjects([obj], true, false, false);
    return {
        selected: objectPathOf(obj),
        objID: obj.objID,
        type: obj.type ?? undefined,
        name: obj.name
    };
}

/**
 * 读两级选中来源（分开返回，避免视角遮蔽）：
 * editorSelection=活动页面编辑器里选中的部件（goto_object 后看这个）；
 * panelSelection=导航面板的选中（propertyGrid 优先用它，会遮蔽前者）。
 */
export function getSelection(ctx: ToolContext) {
    const store: any = ctx.projectStore;
    const fmt = (o: any) => ({
        path: objectPathOf(o),
        objID: o.objID,
        type: o.type,
        name: o.name,
        identifier: o.identifier
    });
    const pageTabState: any = store.editorsStore?.activeEditor?.state;
    const editorObjs: any[] = Array.isArray(pageTabState?.selectedObjects)
        ? pageTabState.selectedObjects
        : [];
    const panel: any = store.navigationStore?.selectedPanel;
    let panelObjs: any[] = [];
    if (Array.isArray(panel?.selectedObjects)) {
        panelObjs = panel.selectedObjects;
    } else if (panel?.selectedObject) {
        panelObjs = [panel.selectedObject];
    }
    return {
        editorSelection: editorObjs.map(fmt),
        panelSelection: panelObjs.map(fmt)
    };
}

////////////////////////////////////////////////////////////////////////////////
// 模拟器输入注入 + 主题预览 + 程序化新建工程

/**
 * 向运行中的模拟器注入指针输入。直接推 runtime.pointerEvents 队列——
 * 与真实 DOM 输入（WasmCanvas.sendPointerEvent）同一条路，绕开
 * setPointerCapture/坐标换算。x/y 是页面坐标（与部件 left/top 同坐标系，
 * list_objects 可查）。运行时必须已启动且未暂停（暂停时事件不转发）。
 */
export async function sendInput(
    ctx: ToolContext,
    op: string,
    x: number,
    y: number,
    dx?: number,
    dy?: number
) {
    const store: any = ctx.projectStore;
    const runtime = store.runtime;
    if (!runtime) {
        throw new Error("运行时未启动（先 debug_start）");
    }
    if (runtime.isPaused) {
        throw new Error("运行时已暂停，事件不会转发（先 debug_control resume）");
    }

    // 页面坐标 → display 坐标：debug 模式页面即原点；run 模式页面在 display 里居中
    const page = runtime.selectedPage;
    let ox = 0;
    let oy = 0;
    if (!runtime.isDebuggerActive && page) {
        ox =
            (page.left ?? 0) +
            ((runtime.displayWidth ?? 0) - (page.width ?? 0)) / 2;
        oy =
            (page.top ?? 0) +
            ((runtime.displayHeight ?? 0) - (page.height ?? 0)) / 2;
    }
    const push = (px: number, py: number, pressed: number) =>
        runtime.pointerEvents.push({
            x: Math.round(px + ox),
            y: Math.round(py + oy),
            pressed
        });

    let desc: string;
    if (op === "click") {
        push(x, y, 1);
        await sleep(150); // 让 LVGL indev 跨多帧读到按下态，点击才被识别
        push(x, y, 0);
        desc = `click @(${x},${y})`;
    } else if (op === "press" || op === "release") {
        push(x, y, op === "press" ? 1 : 0);
        desc = `${op} @(${x},${y})`;
    } else if (op === "swipe") {
        const ddx = dx ?? 0;
        const ddy = dy ?? 0;
        const dist = Math.abs(ddx) + Math.abs(ddy);
        if (dist < 5) {
            throw new Error("swipe 需要 dx/dy 位移（页面坐标）");
        }
        const steps = Math.max(2, Math.min(30, Math.round(dist / 20)));
        push(x, y, 1);
        await sleep(60);
        for (let i = 1; i <= steps; i++) {
            push(x + (ddx * i) / steps, y + (ddy * i) / steps, 1);
            await sleep(30);
        }
        await sleep(60);
        push(x + ddx, y + ddy, 0);
        desc = `swipe @(${x},${y}) Δ(${ddx},${ddy})`;
    } else {
        throw new Error(
            `未知 op ${op}，支持: click, press, release, swipe`
        );
    }
    await sleep(100);
    return `已注入 ${desc}（页面 ${page?.name ?? "?"}）`;
}

/** 切换主题预览：编辑态改 selectedThemeObject（autorun 重绘即变色）；运行态走 wasm setColorTheme */
export function setPreviewTheme(ctx: ToolContext, themeName: string) {
    const store: any = ctx.projectStore;
    const project = store.project;
    const theme = (project.themes ?? []).find((t: any) => t.name === themeName);
    if (!theme) {
        throw new Error(
            `没有主题 ${themeName}，现有: ${(project.themes ?? [])
                .map((t: any) => t.name)
                .join(", ") || "（无）"}`
        );
    }
    const pageRuntime = store.runtime?.lgvlPageRuntime;
    if (pageRuntime && typeof pageRuntime.setColorTheme === "function") {
        pageRuntime.setColorTheme(themeName);
        return `运行态主题已切换为 ${themeName}`;
    }
    runInAction(() => {
        store.navigationStore.selectedThemeObject.set(theme);
    });
    return `编辑态预览主题已切换为 ${themeName}（screenshot 即可看效果）`;
}

const LVGL_VERSIONS = ["8.4.0", "9.2.2", "9.3.0", "9.4.0", "9.5.0"];

/** 程序化新建最小 LVGL 工程（模板落盘 + 打开新 tab） */
export async function createProject(
    filePath: string,
    width: number,
    height: number,
    lvglVersion: string
) {
    if (!filePath.endsWith(".eez-project")) {
        throw new Error("path 必须以 .eez-project 结尾");
    }
    if (fs.existsSync(filePath)) {
        throw new Error(`文件已存在: ${filePath}`);
    }
    const version = lvglVersion || "9.5.0";
    if (!LVGL_VERSIONS.includes(version)) {
        throw new Error(
            `lvglVersion 必须是 ${LVGL_VERSIONS.join("/")} 之一`
        );
    }
    const w = width || 800;
    const h = height || 480;
    const template = {
        // themesVersion 必须写：LVGL 迁移钩子发现它缺失时会重置 themes、清空 colors
        themesVersion: 1,
        settings: {
            general: {
                projectType: "lvgl",
                projectVersion: "v3",
                lvglVersion: version,
                displayWidth: w,
                displayHeight: h
            },
            build: {}
        },
        themes: [{ name: "Default", colors: [] }],
        fonts: [],
        bitmaps: [],
        userPages: [
            {
                name: "Main",
                left: 0,
                top: 0,
                width: w,
                height: h,
                components: []
            }
        ]
    };
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(template, null, 2), "utf-8");
    const openResult = await openProjectFile(filePath);
    return `已新建 ${filePath}（LVGL ${version}，${w}x${h}，Main 页）；${openResult}`;
}

////////////////////////////////////////////////////////////////////////////////
// 资产：字体 / 位图（图片）

/** 列资产：自定义字体（含 LVGL ranges/symbols）、内置 Montserrat、位图 */
export function listAssets(ctx: ToolContext) {
    const project: any = ctx.projectStore.project;
    const { BUILT_IN_FONTS } = require("project-editor/lvgl/style-catalog");
    return {
        fonts: (project.fonts ?? []).map((f: any) => ({
            name: f.name,
            bpp: f.bpp,
            size: f.source?.size,
            height: f.height,
            sourceFile: f.source?.filePath,
            lvglRanges: f.lvglRanges || undefined,
            lvglSymbols: f.lvglSymbols || undefined,
            additionalSources: (f.lvglAdditionalSources ?? []).map(
                (s: any) => s.filePath
            )
        })),
        // text_font 可直接填这些保留名，无需建字体
        builtInFonts: BUILT_IN_FONTS as string[],
        bitmaps: (project.bitmaps ?? []).map((b: any) => ({
            name: b.name,
            bpp: b.bpp,
            image: String(b.image ?? "").startsWith("data:")
                ? "(embedded)"
                : b.image
        }))
    };
}

/**
 * 从 TTF 新建 LVGL 字体（Studio 内建 lv_font_conv 库跑在 worker，无需外部命令）。
 * ranges 如 "32-127"（可逗号分隔多段），symbols 为逐字符（中文/图标）。
 * 建好后样式里 text_font: <name> 引用。
 */
export async function addFont(
    ctx: ToolContext,
    name: string,
    ttfPath: string,
    size: number,
    bpp: number,
    ranges: string,
    symbols: string
) {
    const store: any = ctx.projectStore;
    const project = store.project;
    if ((project.fonts ?? []).some((f: any) => f.name === name)) {
        throw new Error(`字体 ${name} 已存在`);
    }
    const absoluteFilePath = path.resolve(ttfPath);
    if (!fs.existsSync(absoluteFilePath)) {
        throw new Error(`TTF 文件不存在: ${ttfPath}`);
    }
    // 惰性 require：font.tsx 顶层拖 React/notification，防循环依赖
    const { extractFont } = require("project-editor/features/font/font-extract");
    const {
        getLvglEncodingsAndSymbols,
        Font
    } = require("project-editor/features/font/font");
    const lvglRanges = ranges || "32-127";
    const lvglSymbols = symbols || "";
    // fonts 是可选数组（旧工程/模板可能没有）：缺则补。注意 updateObject 传
    // 原始 [] 不会建父链（ensureUniqueProperties 要靠它取 project），必须先
    // createObject + setParent 再整体替换引用
    if (!project.fonts) {
        const arr: any = createObject(store, [] as any, Font);
        setParent(arr, project);
        store.updateObject(project, { fonts: arr as any });
    }
    const enc = getLvglEncodingsAndSymbols(lvglRanges, lvglSymbols);
    const fontProperties = await extractFont({
        name,
        absoluteFilePath,
        relativeFilePath: store.getFilePathRelativeToProjectPath(
            absoluteFilePath
        ),
        renderingEngine: "LVGL",
        bpp: bpp || 4,
        size,
        threshold: (bpp || 4) == 1 ? 128 : 0,
        createGlyphs: true,
        encodings: enc.encodings,
        symbols: enc.symbols,
        createBlankGlyphs: false,
        doNotAddGlyphIfNotFound: false,
        getAllGlyphs: true,
        lvglVersion: project.settings.general.lvglVersion,
        lvglInclude: project.settings.build.lvglInclude
    });
    const font: any = createObject(
        store,
        {
            ...fontProperties,
            lvglRanges,
            lvglSymbols
        } as any,
        Font
    );
    store.addObject(project.fonts, font);
    await persistStore(store);
    return {
        name: font.name,
        glyphCount: font.glyphs?.length ?? 0,
        height: font.height,
        ascent: font.ascent,
        descent: font.descent,
        usage: `样式属性 text_font: "${name}"，或 update_object 给部件的 localStyles 加 text_font`
    };
}

const MIME_BY_EXT: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".bmp": "image/bmp",
    ".gif": "image/gif"
};

/** 导入图片为位图（embedBitmaps=false 时自动拷进工程 images/ 目录），LVGLImageWidget 的 image 属性填返回的 name */
export async function addImage(
    ctx: ToolContext,
    imagePath: string,
    name: string,
    bpp: number
) {
    const store: any = ctx.projectStore;
    const project = store.project;
    const abs = path.resolve(imagePath);
    if (!fs.existsSync(abs)) {
        throw new Error(`图片不存在: ${imagePath}`);
    }
    // 非 embed 模式 image 存相对路径：文件必须位于工程目录内
    let targetPath = abs;
    if (!project.settings.general.embedBitmaps) {
        const projectDir = path.dirname(store.filePath);
        targetPath = path.join(projectDir, "images", path.basename(abs));
        fs.mkdirSync(path.dirname(targetPath), { recursive: true });
        if (path.resolve(targetPath) !== path.resolve(abs)) {
            fs.copyFileSync(abs, targetPath);
        }
    }
    const mime = MIME_BY_EXT[path.extname(abs).toLowerCase()] ?? "image/png";
    // bitmaps 数组缺失时自愈（同 fonts：先建对象+父链再替换引用）
    if (!project.bitmaps) {
        const { Bitmap } = require("project-editor/features/bitmap/bitmap");
        const arr: any = createObject(store, [] as any, Bitmap);
        setParent(arr, project);
        store.updateObject(project, { bitmaps: arr as any });
    }
    const { createBitmap } = require("project-editor/features/bitmap/bitmap");
    const bitmap = await createBitmap(
        store,
        targetPath,
        mime,
        name || undefined,
        bpp || undefined
    );
    if (!bitmap) {
        throw new Error("createBitmap 失败");
    }
    store.addObject(project.bitmaps, bitmap);
    await persistStore(store);
    return {
        name: bitmap.name,
        image: String(bitmap.image).startsWith("data:")
            ? "(embedded)"
            : bitmap.image,
        bpp: bitmap.bpp,
        usage: `create_widget LVGLImageWidget 的 image 属性填 "${bitmap.name}"`
    };
}
