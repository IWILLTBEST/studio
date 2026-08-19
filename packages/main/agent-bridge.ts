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
