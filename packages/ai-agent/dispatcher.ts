import { ipcRenderer } from "electron";

import { tabs, ProjectEditorTab } from "home/tabs-store";

import { loadConfig } from "ai-agent/models";
import {
    ToolContext,
    compileIr,
    navigateToScreen,
    readIr,
    reloadProject,
    screenshotWithRetry,
    writeIr
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
                error = String(err?.message ?? err);
            }
            event.sender.send(`agent-tool-result/${payload.requestId}`, {
                result,
                error
            });
        }
    );
}
