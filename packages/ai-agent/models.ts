import fs from "fs";
import path from "path";
import { app } from "@electron/remote";

////////////////////////////////////////////////////////////////////////////////
// 模型配置（全 OpenAI 兼容自定义端点）

export interface ModelConfig {
    baseUrl: string; // 如 https://api.deepseek.com/v1（到 /v1，不含 /chat/completions）
    apiKey: string;
    model: string; // 如 deepseek-chat
}

export interface AgentConfig {
    coder: ModelConfig; // 生成/修改 IR 的模型
    verifier: ModelConfig; // 看截图验证的视觉模型
    workdir: string; // html2eez 工具目录
    irFile: string; // 相对 workdir 的 IR 文件名
    outFile: string; // 输出 .eez-project 文件名
    pythonPath: string;
    maxRounds: number; // 自动验证闭环最大轮数
    autoMode: boolean; // true=全自动 false=每轮人工确认
}

export const DEFAULT_CONFIG: AgentConfig = {
    coder: { baseUrl: "https://api.deepseek.com/v1", apiKey: "", model: "deepseek-chat" },
    verifier: { baseUrl: "", apiKey: "", model: "" },
    workdir: "E:/eez_studio_project/html2eez",
    irFile: "sg8.ir.json",
    outFile: "out_sg8.eez-project",
    pythonPath: "D:/ClaudeCodeProject/enev/.venv_new/Scripts/python.exe",
    maxRounds: 3,
    autoMode: true
};

function configPath() {
    return path.join(app.getPath("userData"), "eez-agent-config.json");
}

export function loadConfig(): AgentConfig {
    try {
        const data = JSON.parse(fs.readFileSync(configPath(), "utf-8"));
        return {
            ...DEFAULT_CONFIG,
            ...data,
            coder: { ...DEFAULT_CONFIG.coder, ...(data.coder ?? {}) },
            verifier: { ...DEFAULT_CONFIG.verifier, ...(data.verifier ?? {}) }
        };
    } catch {
        return DEFAULT_CONFIG;
    }
}

export function saveConfig(config: AgentConfig) {
    fs.writeFileSync(configPath(), JSON.stringify(config, null, 2), "utf-8");
}

////////////////////////////////////////////////////////////////////////////////
// OpenAI 兼容客户端

export interface ChatMessage {
    role: "system" | "user" | "assistant" | "tool";
    content: any; // string 或 OpenAI 多模态数组
    tool_calls?: any[];
    tool_call_id?: string;
    name?: string;
}

export interface ToolSchema {
    type: "function";
    function: { name: string; description: string; parameters: any };
}

export async function chatCompletion(
    config: ModelConfig,
    messages: ChatMessage[],
    tools?: ToolSchema[]
): Promise<ChatMessage> {
    const body: any = { model: config.model, messages };
    if (tools && tools.length > 0) {
        body.tools = tools;
    }
    // HTTP 头只允许 ISO-8859-1：复制粘贴混入的全角空格/不可见字符会导致
    // "String contains non ISO-8859-1 code point"，这里自动剔除
    const apiKey = config.apiKey.replace(/[^\x21-\x7E]/g, "").trim();
    let resp: Response;
    try {
        resp = await fetch(config.baseUrl.replace(/[^\x21-\x7E\/:.]/g, "").trim().replace(/\/$/, "") + "/chat/completions", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${apiKey}`
            },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(300000) // 5 分钟：大上下文/推理模型可能很慢
        });
    } catch (err: any) {
        throw new Error(`请求失败（检查 baseURL/网络）: ${err?.message ?? err}`);
    }
    if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        throw new Error(`HTTP ${resp.status}: ${text.slice(0, 300)}`);
    }
    const data = await resp.json();
    const msg = data?.choices?.[0]?.message;
    if (!msg) {
        throw new Error(`响应里没有 message: ${JSON.stringify(data).slice(0, 300)}`);
    }
    return msg;
}
