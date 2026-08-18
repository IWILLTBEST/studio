import fs from "fs";
import path from "path";

import type { ProjectStore } from "project-editor/store";
import { runInAction } from "mobx";

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
export function screenshot(): string | undefined {
    const canvases = document.querySelectorAll<HTMLCanvasElement>(
        ".EezStudio_FlowEditorCanvasContainer .eez-canvas canvas"
    );
    let best: HTMLCanvasElement | undefined;
    for (let i = 0; i < canvases.length; i++) {
        const c = canvases[i];
        if (!best || c.width * c.height > best.width * best.height) {
            best = c;
        }
    }
    if (!best) {
        return undefined;
    }
    return best.toDataURL("image/png");
}

/** 截图存盘（_shots/ 目录），返回 {dataUrl, file} */
export function screenshotToFile(
    workdir: string,
    tag: string
): { dataUrl: string; file: string } | undefined {
    const dataUrl = screenshot();
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
