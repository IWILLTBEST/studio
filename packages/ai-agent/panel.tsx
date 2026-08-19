import React from "react";
import { makeAutoObservable } from "mobx";
import { observer } from "mobx-react";

import { ProjectContext } from "project-editor/project/context";
import { Button } from "eez-studio-ui/button";
import * as notification from "eez-studio-ui/notification";

import {
    AgentConfig,
    ModelConfig,
    loadConfig,
    saveConfig
} from "ai-agent/models";
import { StepLog } from "ai-agent/agent";
import { ToolContext, screenshotToFile } from "ai-agent/tools";
import { runAutoLoop, verifyScreenshot } from "ai-agent/verify";

////////////////////////////////////////////////////////////////////////////////

class AgentPanelStore {
    logs: StepLog[] = [];
    running = false;
    stopRequested = false;
    lastScreenshot: string | undefined;

    constructor() {
        makeAutoObservable(this, {}, { autoBind: true });
    }

    log(s: StepLog) {
        this.logs.push(s);
        if (this.logs.length > 500) {
            this.logs.splice(0, this.logs.length - 500);
        }
    }

    start() {
        this.logs.splice(0, this.logs.length);
        this.running = true;
        this.stopRequested = false;
    }

    stop() {
        this.running = false;
        this.log({ kind: "info", text: "已停止" });
    }
}

const agentPanelStore = new AgentPanelStore();

////////////////////////////////////////////////////////////////////////////////

const Field = (props: {
    label: string;
    value: string | number;
    onChange: (v: string) => void;
    password?: boolean;
    width?: number;
}) => (
    <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12 }}>
        <span style={{ minWidth: 52, color: "#888" }}>{props.label}</span>
        <input
            type={props.password ? "password" : "text"}
            value={props.value}
            onChange={e => props.onChange(e.target.value)}
            style={{
                width: props.width ?? 150,
                fontSize: 12,
                padding: "2px 6px",
                border: "1px solid #666",
                borderRadius: 3,
                background: "#222",
                color: "#eee"
            }}
        />
    </label>
);

const ModelFields = (props: {
    title: string;
    m: ModelConfig;
    onChange: (m: ModelConfig) => void;
}) => (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 4, alignItems: "center" }}>
        <span style={{ fontSize: 11, color: "#2E86DE", fontWeight: 700, minWidth: 44 }}>
            {props.title}
        </span>
        <Field label="baseURL" value={props.m.baseUrl} onChange={v => props.onChange({ ...props.m, baseUrl: v })} width={170} />
        <Field label="key" value={props.m.apiKey} onChange={v => props.onChange({ ...props.m, apiKey: v })} password width={120} />
        <Field label="model" value={props.m.model} onChange={v => props.onChange({ ...props.m, model: v })} width={130} />
    </div>
);

////////////////////////////////////////////////////////////////////////////////

const AIPanelInner = observer(
    class AIPanelInner extends React.Component {
        static contextType = ProjectContext;
        declare context: React.ContextType<typeof ProjectContext>;

        // makeAutoObservable 不能用于有父类的组件（mobx 限制）——
        // 所有受控输入的字段（含 config）都用 React state，否则输入不重渲染打不了字
        state: any = {
            config: loadConfig() as AgentConfig,
            requirement: "把左侧导航栏的选中指示条改成绿色",
            screens: "",
            showConfig: false,
            view: "harness", // "harness"（嵌入 dsh Web UI）| "builtin"（内置驾驶舱）
            harnessOnline: false
        };

        async componentDidMount() {
            // 探测 dsh 是否在跑（跨端口，用 no-cors 只测可达性）
            try {
                await fetch("http://127.0.0.1:3080", { mode: "no-cors", signal: AbortSignal.timeout(3000) });
                this.setState({ harnessOnline: true });
            } catch {
                this.setState({ harnessOnline: false, view: "builtin" });
            }
        }

        setConfig(patch: Partial<AgentConfig>) {
            this.setState({ config: { ...this.state.config, ...patch } });
        }

        get toolCtx(): ToolContext {
            const self = this;
            return {
                // getter：reloadProject 会替换 store 实例，每次取最新的
                get projectStore() {
                    return self.context as any;
                },
                workdir: this.state.config.workdir,
                irFile: this.state.config.irFile,
                outFile: this.state.config.outFile,
                pythonPath: this.state.config.pythonPath
            } as any;
        }

        saveCfg = () => {
            saveConfig(this.state.config);
            notification.info("配置已保存");
        }

        run = async () => {
          try {
            if (agentPanelStore.running) {
                return;
            }
            if (!this.state.config.coder.apiKey) {
                notification.error("请先在配置里填生成模型的 API key");
                this.setState({ showConfig: true });
                return;
            }
            agentPanelStore.start();
            const screens = this.state.screens
                .split(/[,，\s]+/)
                .map((s: string) => s.trim())
                .filter(Boolean);
            await runAutoLoop({
                config: this.state.config,
                ctx: this.toolCtx,
                requirement: this.state.requirement,
                screens,
                log: (s: any) => {
                    agentPanelStore.log(s);
                    if (s.image) {
                        agentPanelStore.lastScreenshot = s.image;
                    }
                },
                onRoundDone: (round: number, results: any[]) => {
                    const img = results[results.length - 1]?.image;
                    if (img) {
                        agentPanelStore.lastScreenshot = img;
                    }
                },
                shouldStop: () => agentPanelStore.stopRequested,
                confirmContinue: this.state.config.autoMode
                    ? undefined
                    : async () => window.confirm("本轮完成，继续下一轮？")
            });
          } catch (err: any) {
            agentPanelStore.log({ kind: "error", text: `循环中断: ${err?.message ?? err}` });
          }
          agentPanelStore.running = false;
        };

        stop = () => {
            agentPanelStore.stopRequested = true;
        };

        shot = async () => {
          try {
            const s = screenshotToFile(this.state.config.workdir, "manual");
            if (s) {
                agentPanelStore.log({ kind: "info", text: `截图 ${s.file}`, image: s.dataUrl });
                agentPanelStore.lastScreenshot = s.dataUrl;
            } else {
                notification.error("截图失败：没有打开的屏幕编辑器");
            }
          } catch (err: any) {
            agentPanelStore.log({ kind: "error", text: `截图出错: ${err?.message ?? err}` });
          }
        };

        reverify = async () => {
          try {
            if (!agentPanelStore.lastScreenshot) {
                notification.error("还没有截图");
                return;
            }
            if (!this.state.config.verifier.apiKey || !this.state.config.verifier.model) {
                notification.error("请先配置验证模型");
                this.setState({ showConfig: true });
                return;
            }
            agentPanelStore.log({ kind: "info", text: `换模型重验: ${this.state.config.verifier.model}` });
            const r = await verifyScreenshot(this.state.config, this.state.requirement, agentPanelStore.lastScreenshot);
            agentPanelStore.log({
                kind: r.pass ? "info" : "error",
                text: `重验结果 ${r.pass ? "✓ 通过" : "✗ " + r.issues} — ${r.summary}`
            });
          } catch (err: any) {
            agentPanelStore.log({ kind: "error", text: `重验失败: ${err?.message ?? err}` });
          }
        };

        render() {
            return (
                <div style={{ display: "flex", flexDirection: "column", height: "100%", fontSize: 12 }}>
                    {/* 视图切换条 */}
                    <div style={{ display: "flex", gap: 4, padding: 4, borderBottom: "1px solid #444", background: "#111" }}>
                        <Button color={this.state.view === "harness" ? "secondary" : "primary"} size="medium" onClick={() => this.setState({ view: "harness" })}>💬 Harness</Button>
                        <Button color={this.state.view === "builtin" ? "secondary" : "primary"} size="medium" onClick={() => this.setState({ view: "builtin" })}>🛠 内置</Button>
                        <span style={{ color: this.state.harnessOnline ? "#27AE60" : "#E74C3C", fontSize: 11, alignSelf: "center" }}>
                            {this.state.harnessOnline ? "dsh 在线" : "dsh 未启动（用 start-dsh.cmd）"}
                        </span>
                    </div>
                    {this.state.view === "harness" ? (
                        <webview
                            src="http://127.0.0.1:3080"
                            partition="persist:eez-agent"
                            allowpopups={true}
                            style={{ flex: 1, border: "none", background: "#fff" }}
                        />
                    ) : (
                    <React.Fragment>
                    {/* 配置区 */}
                    <div style={{ padding: 6, borderBottom: "1px solid #444", background: "#1a1a1a" }}>
                        <div style={{ display: "flex", gap: 6, marginBottom: 4 }}>
                            <Button color="primary" size="medium" onClick={() => this.setState({ showConfig: !this.state.showConfig })}>{this.state.showConfig ? "隐藏配置 ▴" : "模型配置 ▾"}</Button>
                            <Button color="primary" size="medium" onClick={this.saveCfg}>保存配置</Button>
                        </div>
                        {this.state.showConfig && (
                            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                                <ModelFields title="生成" m={this.state.config.coder} onChange={m => this.setConfig({ coder: m })} />
                                <ModelFields title="验证" m={this.state.config.verifier} onChange={m => this.setConfig({ verifier: m })} />
                                <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                                    <Field label="工作目录" value={this.state.config.workdir} onChange={v => this.setConfig({ workdir: v })} width={200} />
                                    <Field label="IR文件" value={this.state.config.irFile} onChange={v => this.setConfig({ irFile: v })} width={110} />
                                    <Field label="输出工程" value={this.state.config.outFile} onChange={v => this.setConfig({ outFile: v })} width={150} />
                                    <Field label="Python" value={this.state.config.pythonPath} onChange={v => this.setConfig({ pythonPath: v })} width={220} />
                                    <Field label="最大轮数" value={this.state.config.maxRounds} onChange={v => this.setConfig({ maxRounds: parseInt(v) || 3 })} width={36} />
                                    <label style={{ display: "flex", alignItems: "center", gap: 4 }}>
                                        <input type="checkbox" checked={this.state.config.autoMode} onChange={e => this.setConfig({ autoMode: e.target.checked })} />
                                        全自动闭环
                                    </label>
                                </div>
                            </div>
                        )}
                    </div>

                    {/* 需求输入 */}
                    <div style={{ padding: 6, borderBottom: "1px solid #444" }}>
                        <textarea
                            value={this.state.requirement}
                            onChange={e => this.setState({ requirement: e.target.value })}
                            rows={2}
                            style={{ width: "100%", fontSize: 12, padding: 4, background: "#222", color: "#eee", border: "1px solid #666", borderRadius: 3, boxSizing: "border-box" }}
                        />
                        <div style={{ display: "flex", gap: 6, marginTop: 4, alignItems: "center" }}>
                            {agentPanelStore.running ? (
                                <Button color="primary" size="medium" onClick={this.stop}>⏹ 停止</Button>
                            ) : (
                                <Button color="primary" size="medium" onClick={this.run}>▶ 运行</Button>
                            )}
                            <Button color="primary" size="medium" onClick={this.shot}>📷 截图</Button>
                            <Button color="primary" size="medium" onClick={this.reverify}>✅ 换模型重验</Button>
                            <Field label="验证屏幕" value={this.state.screens} onChange={v => this.setState({ screens: v })} width={140} />
                            <span style={{ color: "#666" }}>逗号分隔，空=当前屏</span>
                        </div>
                    </div>

                    {/* 日志区 */}
                    <div style={{ flex: 1, overflowY: "auto", padding: 6 }}>
                        {agentPanelStore.logs.map((log, i) => (
                            <LogEntry key={i} log={log} />
                        ))}
                    </div>
                    </React.Fragment>
                    )}
                </div>
            );
        }
    }
);

const LogEntry = ({ log }: { log: StepLog }) => {
    const color =
        log.kind === "error" ? "#E74C3C" : log.kind === "tool" ? "#0ABDE3" : log.kind === "assistant" ? "#E0E4EA" : "#7A8499";
    return (
        <div style={{ marginBottom: 4 }}>
            <div style={{ color, whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
                {log.kind === "tool" ? "🔧 " : log.kind === "error" ? "✗ " : "· "}
                {log.text}
            </div>
            {log.image && (
                <img
                    src={log.image}
                    style={{ maxWidth: "100%", border: "1px solid #444", borderRadius: 3, marginTop: 2 }}
                />
            )}
        </div>
    );
};

////////////////////////////////////////////////////////////////////////////////
// 错误边界：把真实渲染错误显示出来（EEZ 的占位符会吞掉错误详情）

export class AIPanel extends React.Component<
    {},
    { error: any }
> {
    state: { error: any } = { error: undefined };

    static getDerivedStateFromError(error: any) {
        return { error };
    }

    componentDidCatch(error: any, info: any) {
        console.error("AIPanel render error:", error, info);
    }

    render() {
        if (this.state.error) {
            return (
                <div style={{ padding: 8, color: "#E74C3C", fontSize: 12, whiteSpace: "pre-wrap" }}>
                    <b>AI 面板渲染出错：</b>
                    {String(this.state.error?.message ?? this.state.error)}
                    <div style={{ color: "#888", marginTop: 4 }}>
                        把这段错误发给开发者。stack:
                        {(this.state.error?.stack ?? "").split("\n").slice(1, 3).join(" | ")}
                    </div>
                </div>
            );
        }
        return <AIPanelInner />;
    }
}
