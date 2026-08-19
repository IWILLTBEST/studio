import { ipcRenderer } from "electron";

import { tabs, ProjectEditorTab } from "home/tabs-store";

import { loadConfig } from "ai-agent/models";
import {
    ToolContext,
    addFont,
    addImage,
    addThemeColor,
    compileIr,
    createLvglStyle,
    createProject,
    createScreen,
    createWidget,
    debugControl,
    debugStart,
    debugStatus,
    debugStop,
    deleteLvglStyle,
    deleteObjectByPath,
    getObject,
    getSelection,
    gotoObject,
    listAssets,
    listObjects,
    listProjects,
    listStyles,
    navigateToScreen,
    openProjectFile,
    readIr,
    readOutputSection,
    readProjectJson,
    readVariable,
    redoProject,
    reloadProject,
    runBuild,
    runCheck,
    screenshotObject,
    screenshotWithRetry,
    selectProject,
    sendInput,
    setPreviewTheme,
    setThemeColor,
    undoProject,
    updateLvglStyle,
    updateObjectByPath,
    writeIr,
    writeProjectJson,
    writeVariable
} from "ai-agent/tools";

////////////////////////////////////////////////////////////////////////////////
// 桥的渲染进程侧：主进程 HTTP 请求转发到这里执行（复用 ai-agent/tools.ts）。
// 常驻注册（放 home/main.tsx 顶层，不放 tabs-store 的 per-tab listeners——
// 那批随 tab 激活/失活挂载卸载）。

function makeCtx(): ToolContext | undefined {
    const tab = tabs.activeTab;
    if (!(tab instanceof ProjectEditorTab) || !tab.projectStore) {
        return undefined;
    }
    const config = loadConfig();
    return {
        // getter：reloadProject 会替换 store 实例，每次取活动 tab 的最新值
        get projectStore() {
            const t = tabs.activeTab;
            return t instanceof ProjectEditorTab && t.projectStore
                ? t.projectStore
                : (tab as ProjectEditorTab).projectStore!;
        },
        workdir: config.workdir,
        irFile: config.irFile,
        outFile: config.outFile,
        pythonPath: config.pythonPath
    } as any;
}

export async function executeBridgeTool(tool: string, args: any): Promise<any> {
    const ctx = makeCtx();
    const config = loadConfig();

    switch (tool) {
        case "ping":
            return {
                pong: true,
                projectOpen: !!ctx,
                projectFile: ctx ? (makeCtx()!.projectStore as any).filePath : undefined
            };

        case "read_ir":
            if (!ctx) throw new Error("没有配置工作目录或配置文件");
            return readIr(ctx);

        case "write_ir":
            if (!ctx) throw new Error("没有配置工作目录或配置文件");
            return writeIr(ctx, String(args.content ?? ""));

        case "compile":
            if (!ctx) throw new Error("没有配置工作目录或配置文件");
            return compileIr(ctx);

        case "reload": {
            if (!ctx) throw new Error("EEZ Studio 里没有打开的工程");
            return await reloadProject(ctx);
        }

        case "navigate": {
            if (!ctx) throw new Error("EEZ Studio 里没有打开的工程");
            return navigateToScreen(ctx, String(args.screen ?? ""));
        }

        case "screenshot": {
            // 带重试：navigate/reload 后 canvas 可能需要 1~2 秒才出现
            const dataUrl = await screenshotWithRetry(5000);
            if (!dataUrl) {
                throw new Error(
                    "截图失败：没有找到屏幕预览 canvas。请先调 eez_navigate 打开一个屏幕编辑器"
                );
            }
            const path = await import("path");
            const fs = await import("fs");
            const dir = path.join(config.workdir, "_shots");
            fs.mkdirSync(dir, { recursive: true });
            const file = path.join(dir, `bridge_${Date.now()}.png`);
            fs.writeFileSync(file, Buffer.from(dataUrl.split(",")[1], "base64"));
            return { dataUrl, file };
        }

        // ---- Output / Checks ----
        case "read_output": {
            if (!ctx) throw new Error("EEZ Studio 里没有打开的工程");
            const which = args.section === "output" ? "output" : "checks";
            return readOutputSection(ctx, which);
        }

        case "check": {
            if (!ctx) throw new Error("EEZ Studio 里没有打开的工程");
            return await runCheck(ctx);
        }

        case "build_project": {
            if (!ctx) throw new Error("EEZ Studio 里没有打开的工程");
            return await runBuild(ctx);
        }

        // ---- 样式 / 主题 ----
        case "list_styles": {
            if (!ctx) throw new Error("EEZ Studio 里没有打开的工程");
            return listStyles(ctx);
        }

        case "update_style": {
            if (!ctx) throw new Error("EEZ Studio 里没有打开的工程");
            return await updateLvglStyle(
                ctx,
                String(args.style ?? ""),
                String(args.part ?? "MAIN"),
                String(args.state ?? "DEFAULT"),
                args.properties ?? {}
            );
        }

        case "create_style": {
            if (!ctx) throw new Error("EEZ Studio 里没有打开的工程");
            return await createLvglStyle(
                ctx,
                String(args.name ?? ""),
                String(args.forWidgetType ?? "")
            );
        }

        case "delete_style": {
            if (!ctx) throw new Error("EEZ Studio 里没有打开的工程");
            return await deleteLvglStyle(ctx, String(args.style ?? args.name ?? ""));
        }

        case "set_theme_color": {
            if (!ctx) throw new Error("EEZ Studio 里没有打开的工程");
            return await setThemeColor(
                ctx,
                String(args.color ?? ""),
                String(args.value ?? ""),
                args.theme ? String(args.theme) : undefined
            );
        }

        case "add_color": {
            if (!ctx) throw new Error("EEZ Studio 里没有打开的工程");
            return await addThemeColor(
                ctx,
                String(args.name ?? ""),
                String(args.value ?? "#000000")
            );
        }

        // ---- .eez-project JSON 直读直写 ----
        case "read_project_json": {
            if (!ctx) throw new Error("EEZ Studio 里没有打开的工程");
            return readProjectJson(ctx);
        }

        case "write_project_json": {
            if (!ctx) throw new Error("EEZ Studio 里没有打开的工程");
            return await writeProjectJson(
                ctx,
                String(args.content ?? ""),
                args.reload !== false
            );
        }

        // ---- 多工程 ----
        case "list_projects":
            return listProjects();

        case "select_project": {
            const m = args.project ?? args.index;
            if (typeof m === "number") {
                return await selectProject(m);
            }
            return await selectProject(String(m ?? ""));
        }

        case "open_project":
            return await openProjectFile(String(args.path ?? args.project ?? ""));

        // ---- 运行时调试 ----
        case "debug_start": {
            if (!ctx) throw new Error("EEZ Studio 里没有打开的工程");
            return await debugStart(ctx, String(args.mode ?? "debug"));
        }

        case "debug_stop": {
            if (!ctx) throw new Error("EEZ Studio 里没有打开的工程");
            return await debugStop(ctx);
        }

        case "debug_control": {
            if (!ctx) throw new Error("EEZ Studio 里没有打开的工程");
            return await debugControl(ctx, String(args.op ?? ""));
        }

        case "debug_status": {
            if (!ctx) throw new Error("EEZ Studio 里没有打开的工程");
            return debugStatus(ctx);
        }

        case "read_variable": {
            if (!ctx) throw new Error("EEZ Studio 里没有打开的工程");
            return readVariable(ctx, String(args.name ?? ""));
        }

        case "write_variable": {
            if (!ctx) throw new Error("EEZ Studio 里没有打开的工程");
            return writeVariable(
                ctx,
                String(args.name ?? ""),
                args.value
            );
        }

        case "screenshot_object": {
            if (!ctx) throw new Error("EEZ Studio 里没有打开的工程");
            return await screenshotObject(
                ctx,
                String(args.path ?? ""),
                typeof args.padding === "number" ? args.padding : 8
            );
        }

        // ---- 对象级编辑（部件/页面 CRUD + undo） ----
        case "list_objects": {
            if (!ctx) throw new Error("EEZ Studio 里没有打开的工程");
            return listObjects(
                ctx,
                args.screen ? String(args.screen) : undefined,
                args.path ? String(args.path) : undefined
            );
        }

        case "get_object": {
            if (!ctx) throw new Error("EEZ Studio 里没有打开的工程");
            return getObject(
                ctx,
                String(args.path ?? ""),
                typeof args.depth === "number" ? args.depth : 2
            );
        }

        case "update_object": {
            if (!ctx) throw new Error("EEZ Studio 里没有打开的工程");
            return await updateObjectByPath(
                ctx,
                String(args.path ?? ""),
                args.properties ?? {}
            );
        }

        case "create_widget": {
            if (!ctx) throw new Error("EEZ Studio 里没有打开的工程");
            return await createWidget(
                ctx,
                String(args.type ?? ""),
                String(args.parent ?? ""),
                args.properties ?? {}
            );
        }

        case "delete_object": {
            if (!ctx) throw new Error("EEZ Studio 里没有打开的工程");
            return await deleteObjectByPath(ctx, String(args.path ?? ""));
        }

        case "create_screen": {
            if (!ctx) throw new Error("EEZ Studio 里没有打开的工程");
            return await createScreen(
                ctx,
                String(args.name ?? ""),
                typeof args.width === "number" ? args.width : undefined,
                typeof args.height === "number" ? args.height : undefined
            );
        }

        case "undo": {
            if (!ctx) throw new Error("EEZ Studio 里没有打开的工程");
            return await undoProject(ctx);
        }

        case "redo": {
            if (!ctx) throw new Error("EEZ Studio 里没有打开的工程");
            return await redoProject(ctx);
        }

        case "goto_object": {
            if (!ctx) throw new Error("EEZ Studio 里没有打开的工程");
            return gotoObject(ctx, String(args.path ?? ""));
        }

        case "get_selection": {
            if (!ctx) throw new Error("EEZ Studio 里没有打开的工程");
            return getSelection(ctx);
        }

        // ---- 模拟器输入 / 主题预览 / 新建工程 ----
        case "send_input": {
            if (!ctx) throw new Error("EEZ Studio 里没有打开的工程");
            return await sendInput(
                ctx,
                String(args.op ?? ""),
                Number(args.x ?? 0),
                Number(args.y ?? 0),
                args.dx !== undefined ? Number(args.dx) : undefined,
                args.dy !== undefined ? Number(args.dy) : undefined
            );
        }

        case "set_preview_theme": {
            if (!ctx) throw new Error("EEZ Studio 里没有打开的工程");
            return setPreviewTheme(ctx, String(args.theme ?? args.name ?? ""));
        }

        case "create_project":
            return await createProject(
                String(args.path ?? ""),
                typeof args.width === "number" ? args.width : 0,
                typeof args.height === "number" ? args.height : 0,
                String(args.lvglVersion ?? "")
            );

        // ---- 资产：字体 / 位图 ----
        case "list_assets": {
            if (!ctx) throw new Error("EEZ Studio 里没有打开的工程");
            return listAssets(ctx);
        }

        case "add_font": {
            if (!ctx) throw new Error("EEZ Studio 里没有打开的工程");
            return await addFont(
                ctx,
                String(args.name ?? ""),
                String(args.ttf_path ?? args.ttfPath ?? ""),
                Number(args.size ?? 16),
                Number(args.bpp ?? 4),
                String(args.ranges ?? "32-127"),
                String(args.symbols ?? "")
            );
        }

        case "add_image": {
            if (!ctx) throw new Error("EEZ Studio 里没有打开的工程");
            return await addImage(
                ctx,
                String(args.image_path ?? args.imagePath ?? args.png_path ?? ""),
                String(args.name ?? ""),
                typeof args.bpp === "number" ? args.bpp : 0
            );
        }

        default:
            throw new Error(`未知工具: ${tool}`);
    }
}

export function registerAgentBridgeDispatcher() {
    ipcRenderer.on(
        "agent-tool-request",
        async (event, payload: { requestId: string; tool: string; args?: any }) => {
            let result: any;
            let error: any;
            try {
                result = await executeBridgeTool(payload.tool, payload.args ?? {});
            } catch (err: any) {
                error = String(err?.stack ?? err?.message ?? err);
            }
            event.sender.send(`agent-tool-result/${payload.requestId}`, {
                result,
                error
            });
        }
    );
}
