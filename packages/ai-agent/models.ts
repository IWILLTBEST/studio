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
