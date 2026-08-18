import fs from "fs";
import path from "path";

import {
    AgentConfig,
    ChatMessage,
    ToolSchema,
    chatCompletion
} from "ai-agent/models";
import {
    ToolContext,
    compileIr,
    navigateToScreen,
    readIr,
    reloadProject,
    screenshotToFile,
    sleep,
    writeIr
} from "ai-agent/tools";

////////////////////////////////////////////////////////////////////////////////
// 工具定义（OpenAI function calling schema）+ 执行

const TOOLS: ToolSchema[] = [
    {
        type: "function",
        function: {
            name: "read_ir",
            description: "读取当前 IR JSON 全文",
            parameters: { type: "object", properties: {} }
        }
    },
    {
        type: "function",
        function: {
            name: "write_ir",
            description:
                "写入完整的新版 IR JSON（全量覆盖，不是增量 patch）。必须是合法 JSON",
            parameters: {
                type: "object",
                properties: { content: { type: "string" } },
                required: ["content"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "compile",
            description:
                "编译 IR → .eez-project。退出码非 0 视为失败（产物自检/字形覆盖校验不通过都会失败），失败输出里有具体报错",
            parameters: { type: "object", properties: {} }
        }
    },
    {
        type: "function",
        function: {
            name: "reload",
            description: "让 EEZ Studio 重新加载工程文件（编译成功后必须调用才能看到新画面）",
            parameters: { type: "object", properties: {} }
        }
    },
    {
        type: "function",
        function: {
            name: "navigate",
            description: "切换到指定屏幕（打开它的编辑器，之后截图截的就是它）",
            parameters: {
                type: "object",
                properties: { screen: { type: "string" } },
                required: ["screen"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "screenshot",
            description: "截取当前屏幕预览图（会存到 _shots/ 并展示在面板里）",
            parameters: { type: "object", properties: {} }
        }
    }
];

export interface StepLog {
    kind: "tool" | "assistant" | "error" | "info";
    text: string;
    image?: string; // dataUrl
}

async function executeTool(
    name: string,
    args: any,
    ctx: ToolContext,
    log: (s: StepLog) => void
): Promise<string> {
    switch (name) {
        case "read_ir":
            return readIr(ctx);
        case "write_ir":
            return writeIr(ctx, String(args.content));
        case "compile": {
            const r = compileIr(ctx);
            log({ kind: "info", text: r.ok ? "编译成功" : "编译失败" });
            return `exit=${r.ok ? 0 : 1}\n${r.output}`;
        }
        case "reload":
            return await reloadProject(ctx);
        case "navigate":
            return navigateToScreen(ctx, String(args.screen));
        case "screenshot": {
            await sleep(300);
            const shot = screenshotToFile(ctx.workdir, "agent");
            if (!shot) {
                return "截图失败：找不到预览 canvas（工程编辑器里打开一个屏幕再试）";
            }
            log({ kind: "info", text: `截图 ${path.basename(shot.file)}`, image: shot.dataUrl });
            return `截图完成: ${shot.file}`;
        }
        default:
            return `未知工具 ${name}`;
    }
}

////////////////////////////////////////////////////////////////////////////////
// 系统提示词

export function buildSystemPrompt(config: AgentConfig): string {
    const readIfExists = (f: string) => {
        try {
            return fs.readFileSync(path.join(config.workdir, f), "utf-8");
        } catch {
            return `（${f} 缺失）`;
        }
    };
    // 注意：不把 IR 全文嵌进提示词（几十 KB，模型自己 read_ir 按需取，
    // 避免三份重复把上下文撑爆、响应变慢）
    return [
        "你是 EEZ Studio LVGL 界面生成 agent。你的工作是修改 IR JSON、编译成 .eez-project、重载、截图自查，直到满足用户需求。",
        "",
        "== 工作流 ==",
        "1. read_ir 获取当前 IR 全文（改动前必读，以它为准）",
        "2. write_ir 写入完整新版（全量覆盖，保持结构不变只改需要改的）",
        "3. compile —— 失败读报错修 IR 重编",
        "4. reload —— 让编辑器加载新工程",
        "5. navigate 到相关屏幕 + screenshot 看效果",
        "",
        "== 必读规范 ==",
        readIfExists("IR_SCHEMA.md"),
        "",
        readIfExists("SKILL.md")
    ].join("\n");
}

////////////////////////////////////////////////////////////////////////////////
// 单轮 agent 循环

export async function runAgentTurn(
    config: AgentConfig,
    ctx: ToolContext,
    requirement: string,
    extraContext: string,
    messages: ChatMessage[],
    log: (s: StepLog) => void,
    shouldStop: () => boolean
): Promise<ChatMessage[]> {
    if (messages.length === 0) {
        messages.push({ role: "system", content: buildSystemPrompt(config) });
        messages.push({
            role: "user",
            content: `用户需求：${requirement}${
                extraContext ? `\n\n${extraContext}` : ""
            }\n\n先用 read_ir 获取当前 IR，然后按工作流完成需求。`
        });
    } else if (extraContext) {
        messages.push({ role: "user", content: extraContext });
    }

    for (let step = 0; step < 24 && !shouldStop(); step++) {
        log({ kind: "info", text: "⏳ 等待模型响应…" });
        const reply = await chatCompletion(config.coder, messages, TOOLS);
        messages.push(reply);

        if (!reply.tool_calls || reply.tool_calls.length === 0) {
            // 模型认为做完了
            return messages;
        }
        for (const tc of reply.tool_calls) {
            let args: any = {};
            try {
                args = JSON.parse(tc.function.arguments || "{}");
            } catch {}
            log({ kind: "tool", text: `${tc.function.name} ${JSON.stringify(args).slice(0, 120)}` });
            let result: string;
            try {
                result = await executeTool(tc.function.name, args, ctx, log);
            } catch (err: any) {
                result = `工具执行出错: ${err?.message ?? err}`;
            }
            if (result.length > 20000) {
                result = result.slice(0, 20000) + "\n…(截断)";
            }
            log({ kind: "info", text: result.slice(0, 300) });
            messages.push({
                role: "tool",
                tool_call_id: tc.id,
                name: tc.function.name,
                content: result
            });
        }
    }
    log({ kind: "error", text: "达到单轮步数上限（24）" });
    return messages;
}
