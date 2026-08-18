import {
    AgentConfig,
    ChatMessage,
    chatCompletion
} from "ai-agent/models";
import { ToolContext, screenshotToFile, sleep } from "ai-agent/tools";
import { ChatMessage as _M } from "ai-agent/models";
import { StepLog, runAgentTurn } from "ai-agent/agent";

////////////////////////////////////////////////////////////////////////////////
// 截图验证（视觉模型判定）+ 全自动闭环

export interface VerifyResult {
    pass: boolean;
    issues: string;
    summary: string;
}

/** 用验证模型看截图对照需求，输出 {pass, issues} JSON */
export async function verifyScreenshot(
    config: AgentConfig,
    requirement: string,
    imageDataUrl: string
): Promise<VerifyResult> {
    const messages: ChatMessage[] = [
        {
            role: "system",
            content:
                "你是 UI 验收员。看截图对照需求判断界面是否符合。只输出 JSON：" +
                '{"pass": true/false, "issues": "不符合项的简短列表；通过则为空字符串", "summary": "一句话总评"}'
        },
        {
            role: "user",
            content: [
                {
                    type: "text",
                    text: `需求：${requirement}\n\n这是 LVGL 界面截图（1024x600 深色医疗设备 UI）。注意：布局/文字/颜色可判断；动画和交互效果在静态截图里不可见，不要因此判失败。`
                },
                { type: "image_url", image_url: { url: imageDataUrl } }
            ]
        }
    ];
    const reply = await chatCompletion(config.verifier, messages);
    const text = typeof reply.content === "string" ? reply.content : "";
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) {
        return { pass: false, issues: text.slice(0, 500), summary: "验证模型未输出 JSON" };
    }
    try {
        const parsed = JSON.parse(m[0]);
        return {
            pass: !!parsed.pass,
            issues: String(parsed.issues ?? ""),
            summary: String(parsed.summary ?? "")
        };
    } catch {
        return { pass: false, issues: text.slice(0, 500), summary: "验证输出 JSON 解析失败" };
    }
}

/**
 * 全自动闭环：每轮 = 生成模型改 IR（带上一轮验证意见）→ 编译 → 重载 → 截图 → 视觉验证。
 * 通过或到轮数上限停止。screensToVerify: 要逐一验证的屏幕名列表（默认当前打开的屏幕）。
 */
export async function runAutoLoop(opts: {
    config: AgentConfig;
    ctx: ToolContext;
    requirement: string;
    screens: string[];
    log: (s: StepLog) => void;
    onRoundDone: (round: number, results: { screen: string; result: VerifyResult; image: string }[]) => void;
    shouldStop: () => boolean;
    confirmContinue?: () => Promise<boolean>; // 半自动模式：每轮截图后询问
}) {
    const { config, ctx, requirement, log } = opts;
    let conversation: ChatMessage[] = [];
    let feedback = "";

    for (let round = 1; round <= config.maxRounds && !opts.shouldStop(); round++) {
        log({ kind: "info", text: `—— 第 ${round}/${config.maxRounds} 轮 ——` });

        // 1) 生成模型干活
        conversation = await runAgentTurn(
            config,
            ctx,
            requirement,
            round === 1 ? "" : `上一轮验证未通过，问题：${feedback}。请修复。`,
            conversation,
            log,
            opts.shouldStop
        );
        if (opts.shouldStop()) break;

        // 2) 编译 + 重载（若 agent 自己没做，这里兜底）
        log({ kind: "tool", text: "兜底编译+重载+截图" });
        const r = require("ai-agent/tools").compileIr(ctx);
        if (!r.ok) {
            feedback = `编译失败：${r.output.slice(0, 500)}`;
            log({ kind: "error", text: feedback });
            conversation.push({
                role: "user",
                content: `编译失败，必须先修复：\n${r.output.slice(0, 2000)}`
            });
            continue;
        }
        await reloadProjectSafe(ctx);

        // 3) 逐屏截图 + 验证
        const results: { screen: string; result: VerifyResult; image: string }[] = [];
        for (const screen of opts.screens.length > 0 ? opts.screens : [""]) {
            if (screen) {
                require("ai-agent/tools").navigateToScreen(ctx, screen);
                await sleep(800);
            }
            const shot = screenshotToFile(ctx.workdir, `verify_r${round}`);
            if (!shot) {
                log({ kind: "error", text: "截图失败：没有打开的屏幕编辑器" });
                continue;
            }
            log({ kind: "info", text: `验证截图 ${screen || "(当前屏)"}`, image: shot.dataUrl });
            try {
                const result = await verifyScreenshot(config, requirement, shot.dataUrl);
                results.push({ screen: screen || "(当前屏)", result, image: shot.dataUrl });
                log({
                    kind: result.pass ? "info" : "error",
                    text: `${screen || "(当前屏)"} ${result.pass ? "✓ 通过" : "✗ " + result.issues}`
                });
            } catch (err: any) {
                log({ kind: "error", text: `验证模型调用失败: ${err?.message ?? err}` });
            }
        }

        opts.onRoundDone(round, results);

        const failed = results.filter(r => !r.result.pass);
        if (results.length > 0 && failed.length === 0) {
            log({ kind: "info", text: `全部通过，共 ${round} 轮 ✅` });
            return;
        }
        feedback = failed.map(f => `[${f.screen}] ${f.result.issues}`).join("；");

        if (opts.confirmContinue && !(await opts.confirmContinue())) {
            log({ kind: "info", text: "已停止（半自动模式）" });
            return;
        }
    }
    log({ kind: "error", text: `达到最大轮数，最终问题：${feedback}` });
}

async function reloadProjectSafe(ctx: ToolContext) {
    try {
        await require("ai-agent/tools").reloadProject(ctx);
    } catch (err: any) {
        console.warn("reload failed", err);
    }
}
