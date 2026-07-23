import {
	type AgentSession,
	createAgentSession,
	DefaultResourceLoader,
	defineTool,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { McpToolCaller, UserTextAgent } from "./types.ts";

export function buildAgentSystemPrompt(defaultSpeedMps: number): string {
	return `你是一个通过 MCP 控制机器狗的本地探索 Agent。

你的最终输出会直接发给用户。最终回复必须完整、简洁、直接面向用户，不得输出内部推理、工具调用过程、原始工具结果或异常堆栈。

运动规则：
- 用户可以提供“速度加时长”“距离加时长”或仅“距离”。方向可选，方向默认为向前。
- “距离加时长”使用“距离 ÷ 时长”计算速度。
- 仅提供距离时，使用部署标定速度 ${defaultSpeedMps} 米每秒计算时长。
- 速度和时长只需是正的有限数值，不添加硬编码范围限制，也不得擅自改变用户指定的数值。
- 只有时长或只有速度时参数不完整，必须向用户追问，不得调用运动工具或套用默认参数。
- 当前只支持向前和向后。左、右、转向等请求必须说明尚不支持，不得映射为前后运动。
- 距离运动是基于速度和时长的估算，不得声称机器狗精确移动或到达了指定距离。
- 工具调用成功只说明命令已被 MCP 接受；最终回复不得虚构机器狗遥测或物理状态。

导航规则：
- 用户指定具名地点或自然语言目的地时，可调用 navigate_with_text；不得把它改写成定时直行。
- tag_location 只用于把机器狗当前地图位置保存为名称。
- “探索未知区域”使用 begin_exploration；“在已知区域持续巡逻”使用 start_patrol，不得混为一谈。
- 停止定点导航、探索和巡逻分别使用 stop_navigation、end_exploration、stop_patrol。
- 导航、探索和巡逻只在下层 Go2 模式可用；下层返回 dry-run 或错误时，必须如实告诉用户没有启动真实导航。

规范化后精确等于“停”或“stop”的输入会在进入你之前由输入网关处理。其他文本都作为普通用户请求处理。`;
}

export function createDogTools(mcp: McpToolCaller) {
	const motionParameters = Type.Object(
		{
			speed_mps: Type.Number({
				description: "用户指定或根据距离与时长计算得到的正有限速度，单位 m/s",
				exclusiveMinimum: 0,
			}),
			duration_s: Type.Number({
				description: "用户指定或根据距离与标定速度计算得到的正有限时长，单位秒",
				exclusiveMinimum: 0,
			}),
		},
		{ additionalProperties: false },
	);

	const moveForward = defineTool({
		name: "move_forward",
		label: "Move Forward",
		description: "按给定正速度和正时长让机器狗向前运动。",
		promptSnippet: "按用户给定或计算得到的速度和时长向前运动",
		parameters: motionParameters,
		executionMode: "sequential",
		execute: async (_toolCallId, params, signal) => ({
			content: [
				{
					type: "text",
					text: await mcp.callTool(
						"move_forward",
						{ speed_mps: params.speed_mps, duration_s: params.duration_s },
						signal,
					),
				},
			],
			details: {},
		}),
	});

	const moveBackward = defineTool({
		name: "move_backward",
		label: "Move Backward",
		description: "按给定正速度和正时长让机器狗向后运动。",
		promptSnippet: "按用户给定或计算得到的速度和时长向后运动",
		parameters: motionParameters,
		executionMode: "sequential",
		execute: async (_toolCallId, params, signal) => ({
			content: [
				{
					type: "text",
					text: await mcp.callTool(
						"move_backward",
						{ speed_mps: params.speed_mps, duration_s: params.duration_s },
						signal,
					),
				},
			],
			details: {},
		}),
	});

	const stopMotion = defineTool({
		name: "stop_motion",
		label: "Stop Motion",
		description: "向机器狗 MCP 发送一次停止运动指令。",
		promptSnippet: "停止当前机器狗运动",
		parameters: Type.Object({}, { additionalProperties: false }),
		executionMode: "sequential",
		execute: async (_toolCallId, _params, signal) => ({
			content: [{ type: "text", text: await mcp.callTool("stop_motion", {}, signal) }],
			details: {},
		}),
	});

	const motionStatus = defineTool({
		name: "motion_status",
		label: "Motion Status",
		description: "读取 MCP 本地运动命令状态；该结果不是机器狗遥测。",
		promptSnippet: "读取本地运动命令状态",
		parameters: Type.Object({}, { additionalProperties: false }),
		executionMode: "sequential",
		execute: async (_toolCallId, _params, signal) => ({
			content: [{ type: "text", text: await mcp.callTool("motion_status", {}, signal) }],
			details: {},
		}),
	});

	const tagLocation = defineTool({
		name: "tag_location",
		label: "Tag Location",
		description: "把机器狗当前地图位置保存为可复用的名称。",
		promptSnippet: "命名并保存当前地图位置",
		parameters: Type.Object(
			{
				location_name: Type.String({
					description: "当前位置的人类可读名称",
					minLength: 1,
				}),
			},
			{ additionalProperties: false },
		),
		executionMode: "sequential",
		execute: async (_toolCallId, params, signal) => ({
			content: [
				{
					type: "text",
					text: await mcp.callTool("tag_location", { location_name: params.location_name }, signal),
				},
			],
			details: {},
		}),
	});

	const navigateWithText = defineTool({
		name: "navigate_with_text",
		label: "Navigate With Text",
		description: "让 DIMOS 解析自然语言目的地，并使用官方地图和路径规划开始导航。",
		promptSnippet: "导航到具名地点或自然语言描述的目的地",
		parameters: Type.Object(
			{
				query: Type.String({
					description: "自然语言目的地或已标记位置名称",
					minLength: 1,
				}),
			},
			{ additionalProperties: false },
		),
		executionMode: "sequential",
		execute: async (_toolCallId, params, signal) => ({
			content: [
				{
					type: "text",
					text: await mcp.callTool("navigate_with_text", { query: params.query }, signal),
				},
			],
			details: {},
		}),
	});

	const stopNavigation = defineTool({
		name: "stop_navigation",
		label: "Stop Navigation",
		description: "取消当前定点导航目标。",
		promptSnippet: "停止当前定点导航",
		parameters: Type.Object({}, { additionalProperties: false }),
		executionMode: "sequential",
		execute: async (_toolCallId, _params, signal) => ({
			content: [{ type: "text", text: await mcp.callTool("stop_navigation", {}, signal) }],
			details: {},
		}),
	});

	const beginExploration = defineTool({
		name: "begin_exploration",
		label: "Begin Exploration",
		description: "启动 DIMOS Wavefront Frontier 自主探索未知区域。",
		promptSnippet: "开始自主探索未知区域",
		parameters: Type.Object({}, { additionalProperties: false }),
		executionMode: "sequential",
		execute: async (_toolCallId, _params, signal) => ({
			content: [{ type: "text", text: await mcp.callTool("begin_exploration", {}, signal) }],
			details: {},
		}),
	});

	const endExploration = defineTool({
		name: "end_exploration",
		label: "End Exploration",
		description: "停止当前 DIMOS 自主探索。",
		promptSnippet: "停止自主探索",
		parameters: Type.Object({}, { additionalProperties: false }),
		executionMode: "sequential",
		execute: async (_toolCallId, _params, signal) => ({
			content: [{ type: "text", text: await mcp.callTool("end_exploration", {}, signal) }],
			details: {},
		}),
	});

	const startPatrol = defineTool({
		name: "start_patrol",
		label: "Start Patrol",
		description: "启动 DIMOS 在已知地图内的自主巡逻。",
		promptSnippet: "开始在已知地图内自主巡逻",
		parameters: Type.Object({}, { additionalProperties: false }),
		executionMode: "sequential",
		execute: async (_toolCallId, _params, signal) => ({
			content: [{ type: "text", text: await mcp.callTool("start_patrol", {}, signal) }],
			details: {},
		}),
	});

	const stopPatrol = defineTool({
		name: "stop_patrol",
		label: "Stop Patrol",
		description: "停止当前 DIMOS 自主巡逻。",
		promptSnippet: "停止自主巡逻",
		parameters: Type.Object({}, { additionalProperties: false }),
		executionMode: "sequential",
		execute: async (_toolCallId, _params, signal) => ({
			content: [{ type: "text", text: await mcp.callTool("stop_patrol", {}, signal) }],
			details: {},
		}),
	});

	return [
		moveForward,
		moveBackward,
		stopMotion,
		motionStatus,
		tagLocation,
		navigateWithText,
		stopNavigation,
		beginExploration,
		endExploration,
		startPatrol,
		stopPatrol,
	] as const;
}

export interface PiUserTextAgentOptions {
	cwd: string;
	agentDir: string;
	sessionDir: string;
	defaultSpeedMps: number;
	mcp: McpToolCaller;
}

export async function createPiAgentSession(options: PiUserTextAgentOptions): Promise<AgentSession> {
	const settingsManager = SettingsManager.create(options.cwd, options.agentDir);
	const resourceLoader = new DefaultResourceLoader({
		cwd: options.cwd,
		agentDir: options.agentDir,
		settingsManager,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		systemPrompt: buildAgentSystemPrompt(options.defaultSpeedMps),
	});
	await resourceLoader.reload();
	const sessionManager = SessionManager.continueRecent(options.cwd, options.sessionDir);
	const { session } = await createAgentSession({
		cwd: options.cwd,
		agentDir: options.agentDir,
		settingsManager,
		resourceLoader,
		sessionManager,
		noTools: "builtin",
		customTools: [...createDogTools(options.mcp)],
	});
	return session;
}

export class PiUserTextAgent implements UserTextAgent {
	private readonly session: AgentSession;

	private constructor(session: AgentSession) {
		this.session = session;
	}

	static async create(options: PiUserTextAgentOptions): Promise<PiUserTextAgent> {
		return new PiUserTextAgent(await createPiAgentSession(options));
	}

	async run(text: string): Promise<string> {
		const assistantMessagesBefore = this.session.messages.filter((message) => message.role === "assistant").length;
		await this.session.prompt(text, { expandPromptTemplates: false });
		const assistantMessagesAfter = this.session.messages.filter((message) => message.role === "assistant").length;
		if (assistantMessagesAfter <= assistantMessagesBefore) {
			throw new Error("Agent did not produce a final assistant message");
		}
		const reply = this.session.getLastAssistantText();
		if (!reply) {
			throw new Error("Agent produced an empty final assistant message");
		}
		return reply;
	}

	close(): void {
		this.session.dispose();
	}
}
