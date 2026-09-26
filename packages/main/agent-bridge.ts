import http from "http";
import { ipcMain } from "electron";

import { guid } from "eez-studio-shared/guid";
import { findHomeWindow } from "main/home-window";

////////////////////////////////////////////////////////////////////////////////
// AI Agent 桥：主进程 HTTP 服务（仅 127.0.0.1），把外部 agent 工具请求
// 转发给 home 渲染进程执行（工程重载/导航/截图都在 renderer），
// 按 correlation-id 等异步回包（模式参照 eez-studio-shared/service.ts）。

const PORT = 17620;
const REQUEST_CHANNEL = "agent-tool-request";
const RESULT_CHANNEL_PREFIX = "agent-tool-result/";
const TIMEOUT_MS = 120000;

let server: http.Server | undefined;

export function startAgentBridge() {
    if (server) {
        return;
    }

    // 调试辅助：把 home 渲染进程 console 转发到主进程 stdout（无头日志）
    // （桥启动晚于 home window 创建，不能靠 web-contents-created，直接挂窗口）
    const homeWindowForLogs = findHomeWindow();
    homeWindowForLogs?.browserWindow.webContents.on(
        "console-message",
        (_e: any, a: any, b?: any, c?: any, d?: any) => {
            // 兼容新旧两种事件签名：(event, level, message, line, sourceId)
            // 和 (event, { level, message, lineNumber, sourceId })
            const level = typeof a === "object" ? a.level : a;
            const message = typeof a === "object" ? a.message : (b as string);
            const line = typeof a === "object" ? a.lineNumber : c;
            const sourceId = typeof a === "object" ? a.sourceId : d;
            if (level >= 2) {
                console.log(`[renderer] ${message} (${sourceId}:${line})`);
            }
        }
    );

    server = http.createServer((req, res) => {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");

        if (req.method === "GET" && url.pathname === "/health") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true }));
            return;
        }

        if (req.method === "POST" && url.pathname === "/tool") {
            const chunks: Buffer[] = [];
            req.on("data", (chunk: Buffer) => chunks.push(chunk));
            req.on("end", async () => {
                let body: any;
                try {
                    body = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
                } catch {
                    res.writeHead(400, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ error: "invalid JSON body" }));
                    return;
                }
                // 整窗截图（含菜单栏以外的全部 UI）：汉化验收等场景需要看
                // 属性面板/设置页，而这些不在 LVGL 页面 canvas 里，renderer
                // 侧扩展的 screenshot 工具抓不到，主进程 capturePage 直出。
                if (body.tool === "window_screenshot") {
                    const homeWindow = findHomeWindow();
                    if (!homeWindow || homeWindow.browserWindow.isDestroyed()) {
                        res.writeHead(500, { "Content-Type": "application/json" });
                        res.end(
                            JSON.stringify({ ok: false, error: "home window not open" })
                        );
                        return;
                    }
                    const image =
                        await homeWindow.browserWindow.webContents.capturePage();
                    res.writeHead(200, { "Content-Type": "application/json" });
                    res.end(
                        JSON.stringify({
                            ok: true,
                            result: { dataUrl: image.toDataURL() }
                        })
                    );
                    return;
                }

                try {
                    const result = await dispatchToRenderer(body.tool, body.args ?? {});
                    res.writeHead(200, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ ok: true, result }));
                } catch (err: any) {
                    res.writeHead(500, { "Content-Type": "application/json" });
                    res.end(
                        JSON.stringify({ ok: false, error: String(err?.message ?? err) })
                    );
                }
            });
            return;
        }

        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "not found" }));
    });

    server.on("error", err => {
        console.warn(`agent-bridge server error: ${err}`);
    });

    server.listen(PORT, "127.0.0.1", () => {
        console.log(`agent-bridge listening on http://127.0.0.1:${PORT}`);
    });
}

function dispatchToRenderer(tool: unknown, args: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
        const homeWindow = findHomeWindow();
        if (!homeWindow || homeWindow.browserWindow.isDestroyed()) {
            reject(new Error("EEZ Studio home window not open"));
            return;
        }
        if (typeof tool !== "string" || !tool) {
            reject(new Error("missing tool name"));
            return;
        }

        const requestId = guid();
        const channel = RESULT_CHANNEL_PREFIX + requestId;

        const timer = setTimeout(() => {
            ipcMain.removeListener(channel, onResult);
            reject(new Error(`tool ${tool} timeout (${TIMEOUT_MS}ms)`));
        }, TIMEOUT_MS);

        function onResult(_event: any, payload: { result?: any; error?: any }) {
            clearTimeout(timer);
            ipcMain.removeListener(channel, onResult);
            if (payload?.error) {
                reject(new Error(String(payload.error)));
            } else {
                resolve(payload?.result);
            }
        }

        ipcMain.on(channel, onResult);
        homeWindow.browserWindow.webContents.send(REQUEST_CHANNEL, {
            requestId,
            tool,
            args
        });
    });
}
