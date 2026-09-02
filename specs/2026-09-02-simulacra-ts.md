# 规格：simulacra，TypeScript 版 LLM 社会模拟内核、稳健性审计 harness 与工具链

版本 2026-09-02。施工者可以是子 agent、外部编码 CLI 或本人；本文档自包含，不依赖任何对话上下文。所有路径相对项目根目录 `/Users/mayu/Projects/simulacra`。

## 背景与目标

LLM 驱动的多 agent 社会模拟在 2023 到 2026 年间从 25 个 agent 走到名义上的十亿 agent，但研究界在 2026 年 5 月集体踩了刹车：SimBench 显示最好的模型群体级保真度只有 40.8/100，Funhouse Mirrors 显示数字孪生的个体级相关只有 r = 0.20，TRAILS 显示同一扰动能让合作率偏移 76 个百分点并要求"无稳健性审计不得下科学结论"。现有三个活跃开源框架（OASIS、AgentSociety 2、Concordia）都不提供审计层，且各自有结构性缺陷：动作与平台写死在核心、时间用墙钟、失败被吞、世界状态是自由文本、随机种子不穿透、扩展要改核心。

本项目建一个新的开源框架 simulacra：一个类型化、事件溯源、组件可替换的模拟内核，一个 TRAILS 风格的稳健性审计 harness，以及 CLI、HTTP API、MCP 服务和可视化 GUI。成功的定义：

1. 同一场景同一种子在 mock 提供者下两次运行得到逐字节相同的事件日志摘要；在真实 LLM 下用录制回放模式也相同。
2. 新增一种动作、一个世界模块、一种决策提供者、一种激活策略、一种指标、一种适配器，都不修改 `src/core/` 下任何文件。
3. harness 能对本内核的场景和至少一个外部框架（OASIS）的运行输出稳健性报告。
4. 用 DeepSeek 端点跑通两个示例（重复囚徒困境、回音室），总 LLM 调用不超过 150 次；用 mock 提供者跑通 10 万 agent 的列式场景。
5. CLI、API、MCP、GUI 四个入口都能启动一次运行、查看事件因果链、查看审计报告。
6. 仓库以 Apache-2.0 开源在 GitHub，README 有 banner、安装、三条命令即可跑示例。

## 非目标

- 不做自然语言到代码的场景生成。场景是声明式 YAML 加注册的 TypeScript。
- 不做多机分布式；执行器接口预留，单进程实现。
- 不做可微分模拟。
- 不做向量检索记忆、不引入嵌入模型。
- 不依赖任何云端 SaaS 存储；不用 Postgres、Redis。
- 不做 RL 训练接口。
- 不做任何"预测现实"的功能或文案。
- 不发布到 npm（本次只开源到 GitHub；package.json 保持可发布状态）。

## 假设

澄清阶段自行拍板，需要用户扫一眼：

1. 运行时 Bun 1.3+，TypeScript 5.x `strict`，另开 `noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`、`noImplicitOverride`。缩进 Tab。ESLint + Prettier。
2. 测试运行器 `bun test`，不是 Vitest。原因：事件日志用 `bun:sqlite`，Bun 不提供 `node:sqlite`，Vitest 在 Bun 运行时下不可靠。GUI 不写单元测试，用 API 契约测试覆盖。
3. 包名 `@misakaikato/simulacra`（`simulacra` 在 npm 已被占用），bin 名 `simulacra`。GitHub 仓库 `misakaikato/simulacra`，公开，Apache-2.0。
4. 依赖白名单。运行时：`zod`、`hono`、`citty`、`yaml`、`@modelcontextprotocol/sdk`。GUI：`react`、`react-dom`。开发：`typescript`、`vite`、`@vitejs/plugin-react`、`eslint`、`@eslint/js`、`typescript-eslint`、`prettier`、`@types/react`、`@types/react-dom`、`@types/bun`。其余一律不引入。ULID、PRNG、统计、日志、Result 类型全部自写。
5. LLM 只接 OpenAI 兼容 HTTP 端点 `POST {baseUrl}/chat/completions`，用全局 `fetch`。DeepSeek 端点 `https://api.deepseek.com/v1`，模型 `deepseek-v4-flash`；密钥从环境变量 `SIMULACRA_LLM_API_KEY` 读取，仓库内不出现任何密钥。
6. GUI 用 Vite + React 单页应用，构建产物放 `gui/dist`，由 API 服务静态托管。不用 Next.js，因为 GUI 随 CLI 分发，需要纯静态产物。
7. 默认解码 temperature 0；审计模式强制 temperature 0。
8. 时间是逻辑时钟 `{tick, substep, seq}`。内核任何位置不得用 `Date.now()` 或 `performance.now()` 影响模拟语义；仅日志时间戳与耗时统计允许。
9. 世界状态内部用可变列式存储换性能，但只暴露只读视图，唯一写入口是 `applyEffects`。这是对"函数式"的有意妥协，边界清晰即可。
10. Git 作者用本机全局配置（misakaikato），提交信息 emoji 加中文，不加任何 Co-Authored-By 或 AI 署名。

## 现状

本项目无既有代码，`specs/` 与 `decisions/` 已存在。设计参考来自对 OASIS、CAMEL、Concordia、Mesa 4、mesa-llm、AgentTorch、AgentSociety 2、YuLan-OneSim 的源码拆解，以及 TRAILS、SimBench、MiroBench、APS、TopoSim、Poor Man's Agentic Modeling、Affordable Generative Agents 的论文定义。施工者不需要读这些仓库，要复用的形状已写成接口。

复用的是设计形状，不是代码：

| 本设计元素 | 来源 | 避开的反面 |
|---|---|---|
| 动作 = 单一定义，多种驱动（LLM 工具调用 / 规则 / 手动 / 访谈） | OASIS 的 docstring 方法自动变 tool schema | OASIS 需在 4 到 5 处手工同步的动作枚举 |
| 单写者解析器 + 请求响应 | OASIS `Platform.running` | 100ms 轮询信道、无异常边界的单循环 |
| 观察与动作一起进追加事件流 | OASIS `trace` 表 | 无从 trace 重放的代码 |
| 调度权可由调用方显式给出 | OASIS `env.step({agent: action})` | 激活逻辑散在实验脚本 |
| 推荐 = 离线打分纯函数 + 物化缓存 | OASIS `rec_sys_*` | if/elif 分派 |
| 实体组件、显式生命周期、`getState/setState` 检查点 | Concordia | 组件靠魔法键互相抓取 |
| 类型化 ActionSpec，GM 与玩家同构 | Concordia | 引擎解析 LLM 自由文本、精确字符串匹配 20 次 |
| 事件解析 = 可插拔函数列表 | Concordia | 世界状态默认是打标签的文本 |
| 掩码 + 定时器的事件驱动激活 | Concordia interrupt-driven | 调度语义散在三处 |
| Scenario 冻结参数 + 种子谱系 + 三段式运行 + Store + 失败即数据 | Mesa 4 scenarios | 核心无 LLM 概念只能 monkey-patch |
| 集合操作决定顺序、事件表决定时间 | Mesa 4 | 无 |
| 列式状态、声明式读写列、按原型分组广播 LLM | AgentTorch | autograd 承诺在 LLM 边界必断；解析失败静默取 0 |
| agent = 工作区记录 + 四段契约 | AgentSociety 2 | driver 丢弃失败结果 |
| 一次声明派生工具 schema、只读门控、回放表 | AgentSociety 2 `@tool` | 每次交互经 LLM 代码生成 |
| 分片追加写 + 读时视图 | AgentSociety 2 | 无 |
| 自适应并发（AIMD） | AgentSociety 2 | YuLan 无并发门 |
| 问卷作为一等实验步骤 | AgentSociety 2 | 无 |
| profile schema 带 sampling 与 private | YuLan-OneSim | 场景生成写进源码树 |
| 类型化 IR 加非 LLM 结构校验 | YuLan-OneSim | LLM 决定路由、输出无 schema |
| 批级决策提供者、软分布、来源与成本记账 | APS / TopoSim / Poor Man's / AGA 统一抽象 | 无 |
| 扰动维度目录与统计口径 | TRAILS | 无 |
| 分布距离 | SimBench TVD、MiroBench W1 与 Cliff's delta | 无 |

## 设计

### 0 分层总览与依赖方向

```
tools     cli/  api/  mcp/  gui/          四个入口，只调用 index.ts 导出的公共 API
harness   harness/                        扰动轴 × 复制 → 运行矩阵 → 统计 → 报告
interop   adapters/                       外部模拟接入 run 契约；OASIS 导入
plugins   agents/ providers/ modules/ policies/ metrics/ instruments/
core      core/                           ids time rng result world resolver actions events log checkpoint population prompt scenario simulation run
infra     logging/                        结构化日志，core 可依赖
```

`core/` 只 import `logging/` 与依赖白名单里的 `zod`、`yaml`。`core/` 不 import `agents/ providers/ modules/ policies/ metrics/ instruments/ harness/ adapters/ cli/ api/ mcp/`。插件通过 `Registry` 显式注册；`src/index.ts` 导出公共 API 并在 `createDefaultRegistry()` 里注册内置插件。

### 1 核心不变量

1. 世界状态只有一个真相源：`World` 的列式表与 env。记忆、提示词、缓存、图索引都是派生物，每条派生记录带产生它的事件 id。
2. 所有写入只经 `applyEffects`。模块、执行体、提供者都不直接改表。
3. 时间是逻辑时钟，完成判定是显式协议，不是超时。
4. 所有随机源从 Scenario 种子按路径派生，路径写进事件。不用 `Math.random`。
5. 失败是一等输出：agent 步、LLM 调用、模块步的失败都成为 `failure` 事件，run 结束执行完整性断言。
6. LLM 只在叶子生成文本或结构化对象；调度、路由、状态变更由类型化数据决定；解析失败走类型化回退并记录，不抛到 tick 循环。
7. 扩展不改内核。
8. 函数式边界：纯函数处理数据（解析、统计、条件生成、渲染），副作用集中在 gateway、log、fs、网络四处；公共类型全部 `readonly`；错误用 `Result` 返回，不用异常传递业务失败。
9. 交付物无过程残留。

### 2 数据模型

全部定义在 `src/core/types.ts`，Zod schema 在 `src/core/schema.ts`，类型从 schema 推导（`z.infer`），保证 YAML、API、MCP 三处校验同源。

#### 2.1 基础类型

```ts
export type Brand<T, B extends string> = T & { readonly __brand: B };
export type EntityId = Brand<string, "EntityId">;   // ULID，只由 world.create 分配
export type EventId = Brand<string, "EventId">;     // ULID
export type RunId = Brand<string, "RunId">;         // `${scenarioId}:${replicationId}`

export interface LogicalTime { readonly tick: number; readonly substep: number; readonly seq: number }
export const compareTime: (a: LogicalTime, b: LogicalTime) => -1 | 0 | 1;

export type Result<T, E> =
	| { readonly ok: true; readonly value: T }
	| { readonly ok: false; readonly error: E };
// src/core/result.ts 提供 ok, err, map, mapErr, andThen, unwrapOr, collect（全成功才成功，否则首个错误）, partition

export type Scalar = number | string | boolean | null | readonly string[];
export type JsonValue = string | number | boolean | null | readonly JsonValue[] | { readonly [k: string]: JsonValue };
export type Provenance = "llm" | "surrogate" | "prototype" | "cache" | "rule" | "manual" | "interview" | "kernel";
```

#### 2.2 Scenario 与运行结果

```ts
export interface Scenario {
	readonly scenarioId: string;
	readonly replicationId: number;
	readonly seed: number;
	readonly seedPath: readonly number[];
	readonly params: Readonly<Record<string, JsonValue>>;     // 点路径可覆盖，如 "feed.size"
	readonly population: PopulationSpec;
	readonly modules: readonly ModuleSpec[];
	readonly executors: readonly ExecutorSpec[];
	readonly providers: Readonly<Record<string, ProviderSpec>>;
	readonly policy: PolicySpec;
	readonly instruments: readonly InstrumentSpec[];
	readonly steps: readonly Step[];
	readonly llm: LLMSpec;
	readonly prompt: PromptOptions;                             // 表征级扰动作用点
}
// 纯函数（src/core/scenario.ts）
export const spawnReplications: (s: Scenario, n: number) => readonly Scenario[];       // seedPath 追加 [i]，replicationId = i
export const overrideScenario: (s: Scenario, dotted: string, value: JsonValue) => Result<Scenario, UnknownOverride>;
export const scenarioHash: (s: Scenario) => string;      // 规范化 JSON 的 sha256，排除 replicationId 与 seedPath
export const parseScenarioYaml: (text: string) => Result<Scenario, ZodIssue[]>;

export interface FailureInfo { readonly stage: "instantiate" | "run" | "extract"; readonly excType: string; readonly message: string; readonly stack: string; readonly at?: LogicalTime }

export interface Integrity {
	readonly activated: number; readonly ok: number; readonly failed: number; readonly parseFailures: number;
	readonly llmCalls: number; readonly llmFailures: number; readonly droppedEffects: number;
	readonly complete: boolean;    // activated === ok + failed 且每个 tick 都显式完成
}

export interface Cost { readonly llmCalls: number; readonly promptTokens: number; readonly completionTokens: number; readonly cachedTokens: number; readonly wallMs: number }

export interface RunResult {
	readonly runId: RunId; readonly scenarioHash: string; readonly seed: number;
	readonly status: "succeeded" | "failed"; readonly failure?: FailureInfo;
	readonly metrics: Readonly<Record<string, number>>;
	readonly distributions: Readonly<Record<string, readonly number[]>>;
	readonly integrity: Integrity; readonly cost: Cost; readonly logPath: string;
}
```

#### 2.3 世界状态与效果

```ts
export interface ColumnDecl {
	readonly entity: string;           // "agent" | "post" | "edge" | 模块自定义
	readonly name: string;             // 模块声明的列自动加前缀 `${owner}.`，owner === "kernel" 除外
	readonly dtype: "f64" | "i32" | "bool" | "str" | "strlist";
	readonly default: Scalar;
	readonly owner: string;
	readonly merge: "last" | "sum" | "max" | "append";   // 同 tick 冲突合并规则
}

export type Effect =
	| { readonly op: "set"; readonly entity: string; readonly id: EntityId; readonly column: string; readonly value: Scalar; readonly cause: EventId }
	| { readonly op: "inc"; readonly entity: string; readonly id: EntityId; readonly column: string; readonly value: number; readonly cause: EventId }
	| { readonly op: "append"; readonly entity: string; readonly id: EntityId; readonly column: string; readonly value: string; readonly cause: EventId }
	| { readonly op: "create"; readonly entity: string; readonly id: EntityId; readonly row: Readonly<Record<string, Scalar>>; readonly cause: EventId }
	| { readonly op: "delete"; readonly entity: string; readonly id: EntityId; readonly cause: EventId }
	| { readonly op: "envSet"; readonly key: string; readonly value: JsonValue; readonly cause: EventId }
	| { readonly op: "setColumn"; readonly entity: string; readonly column: string; readonly ids: readonly EntityId[]; readonly values: readonly Scalar[]; readonly cause: EventId };  // 批量

export interface EffectReport { readonly applied: number; readonly rejected: readonly { readonly effect: Effect; readonly reason: string }[] }
```

#### 2.4 事件

```ts
interface EventBase { readonly eventId: EventId; readonly runId: RunId; readonly t: LogicalTime; readonly agentId?: EntityId; readonly parent?: EventId; readonly seedPath: readonly number[]; readonly provenance?: Provenance }
export type Event =
	| (EventBase & { readonly kind: "activation"; readonly payload: { readonly policy: string; readonly agentIds: readonly EntityId[]; readonly modes: Readonly<Record<string, ActivationMode>> } })
	| (EventBase & { readonly kind: "observation"; readonly payload: { readonly contentSha: string; readonly refs: readonly EventId[]; readonly truncated: boolean; readonly promptHash?: string } })
	| (EventBase & { readonly kind: "decision"; readonly payload: { readonly action: string; readonly args: JsonValue; readonly soft?: Readonly<Record<string, number>>; readonly rationaleSha?: string; readonly provider: string; readonly parseOk: boolean } })
	| (EventBase & { readonly kind: "llm_call"; readonly payload: { readonly promptHash: string; readonly responseSha: string; readonly model: string; readonly params: JsonValue; readonly usage: { readonly promptTokens: number; readonly completionTokens: number; readonly cachedTokens: number }; readonly latencyMs: number; readonly recorded: boolean } })
	| (EventBase & { readonly kind: "effect"; readonly payload: { readonly effects: readonly Effect[]; readonly rejected: readonly { readonly effect: Effect; readonly reason: string }[] } })
	| (EventBase & { readonly kind: "intervention"; readonly payload: { readonly stepIndex: number; readonly arm: string; readonly targets: readonly EntityId[] } })
	| (EventBase & { readonly kind: "measurement"; readonly payload: { readonly instrument: string; readonly name: string; readonly value: JsonValue } })
	| (EventBase & { readonly kind: "failure"; readonly payload: { readonly stage: string; readonly excType: string; readonly message: string; readonly stack?: string; readonly retryable: boolean } })
	| (EventBase & { readonly kind: "checkpoint"; readonly payload: { readonly path: string; readonly worldHash: string } })
	| (EventBase & { readonly kind: "module_step"; readonly payload: { readonly module: string; readonly summary: JsonValue } });
```

大文本（prompt 全文、LLM 原始输出、rationale）不进 payload，进内容存储，payload 只放 sha256。

#### 2.5 人口

```ts
export interface PersonaField { readonly name: string; readonly dtype: ColumnDecl["dtype"]; readonly private?: boolean; readonly sampling: { readonly kind: "value"; readonly value: Scalar } | { readonly kind: "choice"; readonly choices: readonly Scalar[]; readonly weights?: readonly number[] } | { readonly kind: "range"; readonly min: number; readonly max: number } }
export interface PopulationSpec { readonly n: number; readonly fields: readonly PersonaField[]; readonly source: { readonly kind: "synthetic" } | { readonly kind: "csv"; readonly path: string } | { readonly kind: "json"; readonly path: string }; readonly provenance: "demographic" | "survey" | "interview" | "synthetic"; readonly stratify?: Readonly<Record<string, Readonly<Record<string, number>>>> }
```

persona 落成 `agent` 表的列，前缀 `persona.`。

#### 2.6 决策请求与决策

```ts
export interface RenderedPrompt { readonly system: string; readonly messages: readonly { readonly role: "system" | "user" | "assistant"; readonly content: string }[]; readonly schema?: JsonValue; readonly hash: string }
export interface DecisionRequest { readonly agentId: EntityId; readonly t: LogicalTime; readonly state: Readonly<Record<string, JsonValue>>; readonly observation: Readonly<Record<string, JsonValue>>; readonly observationEvent: EventId; readonly features?: readonly number[]; readonly actionSpace: readonly string[]; readonly prompt?: RenderedPrompt }
export interface Decision { readonly agentId: EntityId; readonly action: string; readonly args: Readonly<Record<string, JsonValue>>; readonly soft?: Readonly<Record<string, number>>; readonly rationale?: string; readonly provenance: Exclude<Provenance, "kernel" | "manual">; readonly cost: Cost; readonly parseOk: boolean; readonly llmEvent?: EventId }
export interface ProviderFailure { readonly agentId: EntityId; readonly reason: string; readonly retryable: boolean }
export interface RoundContext { readonly t: LogicalTime; readonly runId: RunId; readonly seedPath: readonly number[]; readonly graph?: GraphView; readonly world: WorldView; readonly log: EventLog }
```

#### 2.7 实验设计

```ts
export interface Selector { readonly where: Readonly<Record<string, JsonValue | { readonly in: readonly Scalar[] } | { readonly gt: number } | { readonly lt: number }>>; readonly fraction?: number; readonly n?: number }
export interface Arm { readonly name: string; readonly role: "treatment" | "control"; readonly overrides: Readonly<Record<string, JsonValue>>; readonly selection?: Selector }
export interface Outcome { readonly name: string; readonly metric: string; readonly direction: "increase" | "decrease" | "any"; readonly targetDistribution?: readonly number[] }
export interface Hypothesis { readonly id: string; readonly claim: string; readonly claimType: "exploratory" | "mechanism" | "policy"; readonly arms: readonly Arm[]; readonly outcomes: readonly Outcome[] }
export type Step =
	| { readonly kind: "run"; readonly ticks: number }
	| { readonly kind: "intervene"; readonly arm: string; readonly instruction?: string }
	| { readonly kind: "questionnaire"; readonly name: string; readonly targets?: Selector }
	| { readonly kind: "checkpoint" };
```

#### 2.8 harness 模型

```ts
export interface PerturbationAxis { readonly id: string; readonly level: "micro" | "meso" | "macro"; readonly kind: "design" | "representation"; readonly dimension: string; readonly target: string; readonly levels: readonly JsonValue[] }
export interface AuditPlan { readonly base: Scenario; readonly hypothesis?: Hypothesis; readonly axes: readonly PerturbationAxis[]; readonly design: "one_at_a_time" | "full_factorial"; readonly replications: number; readonly models: readonly string[]; readonly metrics: readonly string[]; readonly claimType: Hypothesis["claimType"]; readonly concurrency: number }
export interface Condition { readonly conditionId: string; readonly axisValues: Readonly<Record<string, JsonValue>>; readonly model: string; readonly scenario: Scenario }
export interface PairwiseTest { readonly metric: string; readonly a: string; readonly b: string; readonly nA: number; readonly nB: number; readonly meanA: number; readonly meanB: number; readonly meanDiff: number; readonly ci95: readonly [number, number]; readonly cohenD: number; readonly mwuP: number; readonly holmP: number; readonly directionFlip: boolean }
export interface AuditReport { readonly planHash: string; readonly conditions: readonly Condition[]; readonly runs: readonly RunResult[]; readonly pairwise: readonly PairwiseTest[]; readonly directionConsistency: Readonly<Record<string, number>>; readonly sensitivityRank: readonly (readonly [string, number])[]; readonly distributionTests: readonly { readonly metric: string; readonly a: string; readonly b: string; readonly w1: number; readonly cliffDelta: number; readonly tvd?: number }[]; readonly crossModel: Readonly<Record<string, Readonly<Record<string, number>>>>; readonly integritySummary: Readonly<Record<string, number>>; readonly costSummary: Cost; readonly evidenceGrade: "weak" | "moderate" | "strong" }
```

### 3 接口定义

全部在 `src/core/protocols.ts`（接口）与各实现文件。

#### 3.1 随机数与 id（`src/core/rng.ts`, `src/core/ids.ts`）

```ts
export interface Rng { next(): number; int(n: number): number; pick<T>(xs: readonly T[]): T; shuffle<T>(xs: readonly T[]): readonly T[]; bernoulli(p: number): boolean; normal(mu?: number, sigma?: number): number; fork(key: number): Rng; readonly path: readonly number[] }
export const rngFromSeed: (seed: number, path: readonly number[]) => Rng;   // xoshiro128**，状态由 sha256(seed, path) 派生；跨平台确定
export const ulid: (rng?: Rng) => string;                                  // 单调 ULID；不传 rng 时用 crypto.getRandomValues（仅用于 runId 之外的非模拟语义 id 时也必须传 rng）
```

内核里所有 id 都用 `ulid(rng)`，保证同种子 id 相同。

#### 3.2 Clock（`src/core/clock.ts`）

```ts
export interface Clock { readonly now: LogicalTime; nextSeq(): number; advanceTick(): LogicalTime; advanceSubstep(): LogicalTime; schedule(at: LogicalTime, fn: () => Promise<void>, priority?: number, tag?: string): string; cancel(handle: string): void; due(): readonly (() => Promise<void>)[] }
```

二叉堆事件表，键 `(time, priority, insertSeq)`，取消留墓碑。

#### 3.3 World 与 Resolver（`src/core/world.ts`, `src/core/resolver.ts`）

```ts
export interface ReadonlyColumn<T extends Scalar> { readonly length: number; at(i: number): T; get(id: EntityId): T | undefined; toArray(): readonly T[] }
export interface WorldView {
	readonly entities: readonly string[];
	ids(entity: string): readonly EntityId[];
	count(entity: string): number;
	column<T extends Scalar>(entity: string, name: string): ReadonlyColumn<T>;
	row(entity: string, id: EntityId): Readonly<Record<string, Scalar>> | undefined;
	env<T extends JsonValue>(key: string): T | undefined;
	columns(entity: string): readonly ColumnDecl[];
	hash(): string;
}
export interface World extends WorldView {
	declare(decl: ColumnDecl): Result<void, { readonly kind: "ColumnConflict"; readonly message: string }>;
	create(entity: string, rows: readonly Readonly<Record<string, Scalar>>[], rng: Rng): readonly EntityId[];
	snapshot(): WorldSnapshot;                        // 不可变 JSON 结构，列用 base64 二进制
}
export const restoreWorld: (snap: WorldSnapshot) => World;
export const applyEffects: (world: World, effects: readonly Effect[], t: LogicalTime) => EffectReport;   // 唯一写入口；校验列已声明、dtype 可转换、entity 存在；同 tick 冲突按 merge 规则；拒绝不抛异常
```

列存储：`f64` 用 `Float64Array`，`i32` 用 `Int32Array`，`bool` 用 `Uint8Array`，`str` 与 `strlist` 用数组；容量翻倍增长；`hash()` 对规范化的快照做 sha256。

#### 3.4 动作（`src/core/actions.ts`）

```ts
export interface ActionDef<P extends z.ZodTypeAny = z.ZodTypeAny> {
	readonly name: string; readonly description: string; readonly params: P;
	readonly requiresModules: readonly string[]; readonly fallback: boolean;    // 每个动作集恰好一个 fallback
	resolve(call: ActionCall<z.infer<P>>, ctx: ResolveContext): Promise<readonly Effect[]>;
}
export interface ActionCall<A = Readonly<Record<string, JsonValue>>> { readonly agentId: EntityId; readonly name: string; readonly args: A; readonly cause: EventId }
export interface ResolveContext { readonly world: WorldView; readonly t: LogicalTime; readonly modules: ReadonlyMap<string, Module>; readonly rng: Rng; newEventId(): EventId; newEntityId(): EntityId }
export interface ActionRegistry { register(a: ActionDef): Result<void, DuplicateAction>; get(name: string): ActionDef | undefined; toolSchemas(names: readonly string[]): readonly JsonValue[]; validate(call: ActionCall): Result<ActionCall, ValidationFailure> }
export const defineAction: <P extends z.ZodTypeAny>(def: ActionDef<P>) => ActionDef<P>;   // 恒等，仅为类型推导
```

一次声明产出：LLM tool schema（`zod` 转 JSON schema，自写最小转换，只覆盖 object/string/number/boolean/enum/array/optional）、参数校验、规则或手动调用、访谈表单。

#### 3.5 激活策略（`src/core/protocols.ts`，实现 `src/policies/`）

```ts
export type ActivationMode = "llm" | "rule" | "manual" | "interview";
export interface Activation { readonly agents: Readonly<Record<EntityId, ActivationMode>>; readonly manualCalls?: Readonly<Record<EntityId, ActionCall>> }
export interface ActivationPolicy { readonly name: string; select(world: WorldView, t: LogicalTime, rng: Rng): Activation }
```

内置：`allAgents`、`bernoulli(p)`、`profileHourly(column)`、`maskTimer(maskColumn, timerColumn)`、`explicit(schedule)`。`simulation.step(activation?)` 允许调用方覆盖策略输出。

#### 3.6 执行体（`src/agents/`）

```ts
export interface Executor {
	readonly name: string; readonly entity: string; readonly provider: string;
	declare(world: World): Result<void, DeclareError>;
	observe(world: WorldView, ids: readonly EntityId[], t: LogicalTime, log: EventLog, rng: Rng): Promise<readonly DecisionRequest[]>;
	act(decisions: readonly Decision[], ctx: ResolveContext): Promise<readonly Effect[]>;
	after(decisions: readonly Decision[], report: EffectReport, log: EventLog): Promise<void>;
	getState(): JsonValue; setState(s: JsonValue): void;
}
```

`FocalExecutor`（组件式）：

```ts
export interface Component {
	readonly name: string; readonly reads: readonly string[]; readonly writes: readonly string[];
	preAct(agentId: EntityId, view: WorldView, t: LogicalTime, ctx: ReadonlyMap<string, JsonValue>, log: EventLog): Readonly<Record<string, JsonValue>>;
	postAct(agentId: EntityId, decision: Decision, report: EffectReport, log: EventLog): void;
	getState(): JsonValue; setState(s: JsonValue): void;
}
```

`declare` 时校验：`reads` 里的键必须是已声明列或其它组件的 `writes`，否则返回 `ComponentDependencyError`。内置组件：`persona`（公开字段）、`instructions(text)`、`recentMemory(k)`（按 agent 从事件日志取最近 k 条 decision 与 observation 摘要，带事件 id）、`summaryMemory(threshold)`（超阈值调 LLM 压缩，经 gateway 记 llm_call）、`feedObservation(size)`、`neighborhoodObservation(radius)`。

`CohortExecutor`（列式批量）：`observe` 一次性计算特征矩阵，产出 `features` 不渲染 prompt；`act` 用向量化转移写 `setColumn`：

```ts
export interface Transition { readonly name: string; readonly reads: readonly string[]; readonly writes: readonly string[]; apply(view: WorldView, ids: readonly EntityId[], decisions: readonly Decision[], rng: Rng): readonly Effect[] }
```

#### 3.7 决策提供者（`src/providers/`）

```ts
export interface DecisionProvider {
	readonly name: string;
	decide(requests: readonly DecisionRequest[], ctx: RoundContext): Promise<readonly Result<Decision, ProviderFailure>[]>;   // 与 requests 等长、顺序一致
	fit?(trace: readonly { readonly request: DecisionRequest; readonly decision: Decision }[]): void;
	audit?(ctx: RoundContext): Readonly<Record<string, number>> | undefined;
	reset(seedPath: readonly number[]): void;
	getState(): JsonValue; setState(s: JsonValue): void;
}
```

| 名 | 行为 |
|---|---|
| `llm` | 每 request 一次 gateway 调用（`completeMany` 批发），结构化输出 `{action, args, rationale}`，解析失败返回 `err` |
| `rule` | 用户给 `(req, rng) => Decision` |
| `mock` | 确定性：`sha256(prompt.hash ?? JSON(observation), seedPath)` 在 `actionSpace` 选择并按 zod schema 生成合法 args |
| `surrogate` | 逻辑回归（自写，梯度下降），`fit` 用 trace，`decide` 用 `features` |
| `archetype` | 按 `groupOn` 列取值组合各调一次下游，广播；`nArch` 次平均写 `soft` |
| `cache` | 键 = 规范化 `(state 子集, observation 子集)`，命中复用，未命中调下游并写库 |
| `routers/aps` | 分层原型 + 影子审计 + 残差修正，默认 `Nb=5000, alphaB=0.15, Mb=10, lambda=0.6, eta=0.5, zeta=0.4, gamma=0.05`；`audit()` 返回 `{mismatchRate, residualVar}` |
| `routers/topo` | 按 `ctx.graph` 与 `features` 贪心建有界直径单元，代表调用下游，单元内复用；`updateInterval` 默认 4 |

组合器持下游名字，装配时检测循环引用。

#### 3.8 LLM 网关（`src/llm/gateway.ts`）

```ts
export interface LLMRequest { readonly messages: RenderedPrompt["messages"]; readonly schema?: JsonValue; readonly temperature: number; readonly maxTokens: number; readonly seed?: number; readonly tags: Readonly<Record<string, string>>; readonly homogeneousGuard: boolean }
export interface LLMResponse { readonly text: string; readonly parsed?: JsonValue; readonly usage: { readonly promptTokens: number; readonly completionTokens: number; readonly cachedTokens: number }; readonly latencyMs: number; readonly model: string; readonly promptHash: string; readonly responseSha: string; readonly recorded: boolean }
export interface LLMFailure { readonly promptHash: string; readonly excType: string; readonly message: string; readonly retryable: boolean; readonly attempts: number }
export interface LLMGateway { complete(req: LLMRequest): Promise<Result<LLMResponse, LLMFailure>>; completeMany(reqs: readonly LLMRequest[]): Promise<readonly Result<LLMResponse, LLMFailure>[]>; ledger(): Cost }
export interface LLMSpec { readonly baseUrl: string; readonly model: string; readonly apiKeyEnv: string; readonly mode: "live" | "record" | "replay"; readonly recordDir?: string; readonly concurrency: { readonly initial: number; readonly max: number }; readonly structured: "auto" | "json_schema" | "prompt"; readonly budget: { readonly maxCalls: number; readonly maxCompletionTokens: number }; readonly timeoutMs: number }
```

策略：AIMD 并发（429 与超时乘性减半，稳定 20 次成功加 1）；重试 429/5xx 指数退避 1s 到 60s 最多 3 次，其余 4xx 不重试；结构化输出先试 `response_format: {type: "json_schema"}`，400 后自动切 `prompt` 模式并记一次 `failure(retryable=true, structured_fallback)`；解析取最后一个平衡 JSON 块再 zod 校验；录制回放键 `sha256(promptHash, seed, params)` 存 `recordDir/<hash>.json`，replay 未命中返回 `retryable=false` 失败；同 system 前缀请求排序相邻；`homogeneousGuard` 在 system 末尾追加 `<!-- nonce:${eventId} -->`（不进 promptHash）；预算 `maxCalls` 到达后所有后续调用直接失败（`budget_exhausted`, retryable=false），保护 token；账本按 `tags.purpose` 分桶。断路：连续 10 次不可重试失败后本批余下请求立即失败。

预设 `src/llm/presets.ts`：`deepseek()`（`https://api.deepseek.com/v1`, `deepseek-v4-flash`），`mlxLm(baseUrl)`（不传 seed），`lmStudio(baseUrl)`。

#### 3.9 事件日志与检查点（`src/core/log.ts`, `src/core/checkpoint.ts`）

```ts
export interface EventLog {
	append(e: Event): void;
	putContent(text: string): string;                 // sha256
	getContent(sha: string): string | undefined;
	query(filter: { readonly kind?: readonly Event["kind"][]; readonly agentId?: EntityId; readonly tick?: number; readonly fromTick?: number; readonly toTick?: number; readonly limit?: number; readonly offset?: number }): readonly Event[];
	sql<T>(sql: string, params?: readonly (string | number)[]): readonly T[];   // 只读 SQL
	chain(eventId: EventId): readonly Event[];         // 沿 parent 向上再向下收集因果链
	digest(): string;                                  // 全部事件规范化 sha256
	count(): number;
	close(): void;
}
```

实现 `SqliteEventLog`（`bun:sqlite`，`<runDir>/events.sqlite`，表 `events(event_id PK, run_id, tick, substep, seq, kind, agent_id, parent, seed_path, provenance, payload TEXT)` 与 `content(sha PK, text)`，索引 `(tick, substep, seq)`、`(agent_id, tick)`、`(kind)`；WAL；批量事务每 tick 一次）与 `MemoryEventLog`（同接口，`sql` 不支持时返回错误；用于嵌入与单元测试）。

检查点：`saveCheckpoint(sim, dir)` 只在 tick 边界；写 `world.json`（快照）、`clock.json`、`executors.json`、`providers.json`、`rng.json`、`meta.json`（scenarioHash、digest、lastEventId）；`loadCheckpoint(dir, scenario)` 校验 `scenarioHash`，不一致返回 `ConfigDrift`。

#### 3.10 世界模块（`src/modules/`）

```ts
export interface Module {
	readonly name: string;
	declare(world: World): Result<void, DeclareError>;
	actions(): readonly ActionDef[];
	observe(view: WorldView, ids: readonly EntityId[], t: LogicalTime): Readonly<Record<EntityId, JsonValue>>;
	step(view: WorldView, t: LogicalTime, rng: Rng): Promise<readonly Effect[]>;
	readonly concurrencySafe: boolean;
	graph?(): GraphView;                                // social_graph 提供
	getState(): JsonValue; setState(s: JsonValue): void;
}
export interface GraphView { neighbors(id: EntityId): readonly EntityId[]; degree(id: EntityId): number; readonly edgeCount: number }
export interface Recommender { readonly name: string; rank(view: WorldView, userIds: readonly EntityId[], t: LogicalTime, rng: Rng, k: number): Readonly<Record<EntityId, readonly EntityId[]>> }
```

内置：`socialGraph`（`edge` 表 `src/dst/kind`，动作 `follow/unfollow`，观察 `neighbors`，生成器 random、powerlaw 配置模型、同质性重连 `homophilyBand`、hub 分配 `anti|pro|mixed|random`）；`feed`（`post` 表，动作 `post/repost/reply/like/silent`，`silent` 为 fallback，推荐插件 `random/recency/followingFirst/homophily(column)`，每 tick 物化 `rec` 表）；`calendar`（按 tick 注入 `env["calendar.current"]`）。扩展位 `market`、`spatial` 只留协议。

#### 3.11 仪器（`src/instruments/`, `src/metrics/`）

```ts
export interface Metric { readonly name: string; compute(view: WorldView, log: EventLog, runId: RunId): number | readonly number[] }
export interface Questionnaire { readonly name: string; readonly questions: readonly { readonly id: string; readonly prompt: string; readonly responseType: "text" | "integer" | "float" | "choice"; readonly choices?: readonly string[] }[]; readonly entersMemory: boolean }
```

问卷通过同一 provider 以 `provenance="interview"` 执行，答案写 `measurement`，不产生世界效果。内置指标：`cooperationRate`、`averagePayoff`、`stanceAssortativity`、`sameGroupRatio`、`actionShare(action)`、`tvdToTarget(column, target)`。

#### 3.12 run 契约与适配器（`src/core/run.ts`, `src/adapters/`）

```ts
export type RunFn = (scenario: Scenario, seed: number, outDir: string) => Promise<RunResult>;
export interface Adapter { readonly name: string; toScenario(external: JsonValue): Result<Scenario, string>; run: RunFn }
```

`adapters/script`：子进程 `argv --config cfg.json --seed N --out dir`，读 `dir/result.json`，非零退出转 `FailureInfo`。`adapters/oasis`：在 script 之上读 OASIS SQLite（`bun:sqlite` 打开）`trace/post/user` 表，`REFRESH` 转 observation、其它动作转 decision 加 effect，写入本事件日志格式并计算注册指标；`importOasis(dbPath, outDir)` 可独立使用。

#### 3.13 日志（`src/logging/`）

```ts
export type LogLevel = "trace" | "debug" | "info" | "warn" | "error";
export interface Logger { readonly level: LogLevel; child(ctx: Readonly<Record<string, JsonValue>>): Logger; log(level: LogLevel, msg: string, data?: Readonly<Record<string, JsonValue>>): void; trace/debug/info/warn/error(msg, data?): void; span<T>(name: string, fn: () => Promise<T>): Promise<T>; }   // span 记录开始、结束、耗时、异常
export const createLogger: (opts: { readonly level: LogLevel; readonly sinks: readonly LogSink[] }) => Logger;
export const jsonlSink: (path: string) => LogSink;     // 每行 {ts, level, msg, ctx..., data}
export const prettySink: (stream: WritableStream) => LogSink;   // 人读格式，无颜色代码时退化为纯文本
```

约定：每个 run 一个 `<runDir>/log.jsonl`；根 logger 绑定 `runId`；tick 循环用 `child({tick})`；执行体、提供者、模块各自 `child({component})`；每个 failure 事件同时 `error` 日志；gateway 每次调用 `debug` 一条含 promptHash、latency、usage；`SIMULACRA_LOG` 环境变量与 `--log-level` 控制级别；`trace` 级别打印 prompt sha 与前 200 字符。`simulacra inspect <runDir> --agent <id> --tick <n>` 用 `chain()` 打印因果链，是主要调试入口。

#### 3.14 CLI（`src/cli/`，citty）

```
simulacra run <scenario.yaml> --seed <n> --out <dir> [--ticks N] [--provider mock|llm] [--log-level L]
simulacra replay <runDir> [--to-tick N]                # 折叠 effect 事件，打印 worldHash
simulacra resume <runDir>/checkpoints/<tick> --ticks N --out <dir>
simulacra inspect <runDir> --agent <id> [--tick N] [--event <id>]
simulacra digest <runDir>
simulacra audit <plan.yaml> --out <dir> [--replications N] [--concurrency N]
simulacra report <auditDir> [--out report.html]
simulacra import-oasis <oasis.db> --out <runDir>
simulacra doctor [--llm]                                # 探测端点：结构化输出、并发、cachedTokens；不传 --llm 只检查环境
simulacra serve [--port 8787] [--data <dir>]           # API + GUI
simulacra mcp [--data <dir>]                            # MCP stdio 服务
simulacra examples [name] [--out <dir>]                 # 列出或复制内置示例
```

所有命令的失败以非零退出码加一行 `error: ...` 结束，不打印栈（`--log-level debug` 时打印）。

#### 3.15 HTTP API（`src/api/`，Hono）

数据目录 `--data`，默认 `./simulacra-data`，结构 `runs/<runId>/`、`audits/<auditId>/`。

| 方法 路径 | 说明 |
|---|---|
| `GET /api/health` | `{ok, version}` |
| `GET /api/examples` | 内置示例列表与 YAML |
| `GET /api/runs` | 运行列表（读各 `result.json`） |
| `POST /api/runs` | body `{scenario: Scenario \| string(yaml), seed, ticks?, provider?}`；后台启动，立即返回 `{runId}` |
| `GET /api/runs/:id` | RunResult 与进度 `{tick, status}` |
| `GET /api/runs/:id/events?kind&agent&tick&fromTick&toTick&limit&offset` | 事件分页 |
| `GET /api/runs/:id/events/:eventId/chain` | 因果链 |
| `GET /api/runs/:id/content/:sha` | 大文本 |
| `GET /api/runs/:id/agents` | agent 表（persona 公开列 + 派生统计） |
| `GET /api/runs/:id/graph?tick` | 边列表快照 |
| `GET /api/runs/:id/metrics` | measurement 事件按名聚合成序列 |
| `GET /api/runs/:id/stream` | SSE，实时事件（运行中）或回放（已结束时按 tick 推送） |
| `POST /api/audits` | body `{plan: AuditPlan \| string(yaml)}`，后台启动 |
| `GET /api/audits` `GET /api/audits/:id` | 报告 JSON 与进度 |
| `GET /api/audits/:id/report.html` | 报告 |
| `GET /` 与静态 | `gui/dist` |

所有 body 用 zod 校验，失败 400 返回 issues；不存在 404；内部错误 500 且记 error 日志。API 与 CLI 共用 `src/index.ts` 的 `startRun/startAudit` 函数，不各自实现。

#### 3.16 MCP 服务（`src/mcp/`，stdio）

工具：`list_examples`、`run_scenario({scenarioYaml|examplePath, seed, ticks?, provider?})` 返回 `runId` 与 RunResult 摘要、`get_run({runId})`、`query_events({runId, kind?, agentId?, tick?, limit?})`、`get_agent_trace({runId, agentId, tick?})` 返回因果链的可读文本、`run_audit({planYaml|path, replications?})`、`get_audit({runId})`、`doctor()`。资源：`simulacra://runs/{runId}/result`、`simulacra://audits/{auditId}/report`。所有工具输入 zod 校验；输出为文本加 JSON。

#### 3.17 GUI（`gui/`，Vite + React + TypeScript）

页面：

- Runs：列表（状态、tick、agent 数、成本、完整性），新建运行表单（选示例或粘贴 YAML、seed、ticks、provider）。
- Run：四栏。左：tick 时间轴（activation/measurement/failure 标记，可拖动）；中：网络画布（canvas，力导向布局自写，节点按 `persona.stance` 或所选列着色，边为 edge 表，点击节点打开 agent）；右：agent 检视（persona、最近观察与决策、点开事件因果链：observation → prompt 文本 → decision → effects）；下：指标折线（canvas 自绘）、完整性与成本面板。运行中经 SSE 实时更新。
- Audit：条件表、成对检验表（可按 metric 过滤、按 |d| 排序）、敏感因素条形图、方向一致率、跨模型表、证据等级说明。
- 设计：无 emoji；中性冷灰配一个强调色；等宽字体显示 id 与数字；亮暗主题跟随系统。

GUI 只通过 3.15 的 API 取数，不引入状态库、UI 库、图表库。

### 4 核心流程

#### 4.1 一个 tick（`src/core/simulation.ts`）

```
step(activationOverride?)
 1. t = clock.now；activation = override ?? policy.select(world, t, rng.fork(tick))；写 activation 事件
 2. 执行到期 clock 回调（干预、定时器）
 3. 对每个 executor（声明顺序）：
    a. ids = activation 中属于 executor.entity 且 mode !== "manual"
    b. requests = await executor.observe(...)         每个 request 写 observation 事件；prompt 全文进内容存储
    c. results = await provider.decide(requests, ctx) 每个 ok 的 Decision 写 decision 事件；llm 的写 llm_call
    d. err 的：替换为 fallback 动作，写 failure（retryable 按 ProviderFailure），integrity.parseFailures 或 failed 计数
    e. validate → ActionCall；失败同 d
    f. effects = executor.act(decisions) ++ 每个 action.resolve(call)
 4. manual：activation.manualCalls 直接进 e、f
 5. report = applyEffects(world, effects, t)；写 effect 事件；被拒绝的写 failure
 6. 每个 executor.after(...)
 7. 每个 module.step（concurrencySafe 的并行 Promise.all，其余串行）→ applyEffects；写 module_step
 8. 本 tick 到期的 Metric 计算并写 measurement
 9. 完成断言：本 tick 每个激活 agent 恰有一条 decision 或 failure；否则抛 IncompleteTick（内核 bug）
10. clock.advanceTick()
```

异常路径：provider 整批抛异常 → 整批 failure 加 fallback，连续 3 tick 整批失败则 run `failed`；module.step 抛 → failure、跳过本 tick、连续 3 次则失败；applyEffects 拒绝 → 记录不抛；gateway 断路 → 本批余下请求立即失败。

#### 4.2 LLM 调用路径

provider.llm 构造 `LLMRequest`（messages 来自 prompt，schema 为动作联合 schema，tags 含 eventId 与 purpose）→ `gateway.completeMany`（replay：按 promptHash 取录制；live/record：排序、信号量、fetch、重试、解析 usage）→ 结构化解析 → 每个响应写 llm_call 事件 → `Decision` 或 `ProviderFailure`。

#### 4.3 回放

`replay(runDir, toTick)`：读 Scenario 与 tick 0 的检查点，按 `(t, seq)` 只折叠 `effect` 事件，到目标 tick 输出 `world.hash()`。要求与实时运行同 tick 的 `worldHash` 相等。

#### 4.4 审计流程（`src/harness/`）

```
audit(plan, run, outDir)
 1. 条件生成（纯函数）：one_at_a_time = 基线 + 每 axis 每 level；full_factorial = 笛卡尔积；× models
 2. 每条件 spawnReplications(plan.replications)
 3. 执行：并发 plan.concurrency 个 run（同进程 Promise 池；每个 run 独立子目录）；单个失败写 FailureInfo 不中断
 4. integrity.complete === false 的 run 计入 integritySummary 并默认排除统计
 5. 统计（纯函数，src/harness/stats.ts）：每 metric 每对 (基线, 条件)：Mann–Whitney U 双侧（正态近似含连续性校正，n<8 时精确枚举）、Cohen d（合并标准差）、bootstrap 2000 次均值差 95% CI（用 rng 派生，确定）；同一 metric 内 Holm 校正；directionFlip；有 targetDistribution 的 outcome 算 TVD（分母为对均匀分布的 TVD）；distributions 非空的算 W1（经验 CDF 积分）与 Cliff's delta；crossModel 均值表
 6. sensitivityRank：每 axis 的 max |cohenD|
 7. evidenceGrade：weak 若 replications < 10 或任一 axis levels < 2；moderate 若 replications ≥ 10 且每 axis levels ≥ 2；strong 若 replications ≥ 30 且每 axis levels ≥ 3 且 models ≥ 2（claimType policy 时还要求 axes 覆盖三层）
 8. 写 audit.json 与 report.html（自写模板字符串，单文件，无外链，含全部表与内联 SVG 条形图）
```

### 5 扩展点

| 需求 | 做法 | 改内核？ |
|---|---|---|
| 新动作 | `defineAction` 并注册 | 否 |
| 新世界模块 | 实现 `Module` | 否 |
| 新推荐算法 | 实现 `Recommender` | 否 |
| 新提供者或路由 | 实现 `DecisionProvider` | 否 |
| 新激活策略 | 实现 `ActivationPolicy` | 否 |
| 新记忆或感知组件 | 实现 `Component` | 否 |
| 新指标 / 问卷 | 实现 `Metric` / YAML | 否 |
| 新扰动轴 | YAML 声明 | 否 |
| 接入外部框架 | `Adapter` 或 script 契约 | 否 |
| 换存储 | 实现 `EventLog` | 否 |
| 换 LLM 传输 | 实现 `LLMGateway` | 否 |
| 换时钟语义 | 实现 `Clock` | 否 |

### 6 目录结构

```
simulacra/
  package.json  tsconfig.json  eslint.config.js  .prettierrc  .gitignore  LICENSE  README.md
  specs/  decisions/
  src/
    index.ts                       # 公共 API：createDefaultRegistry, loadScenario, runScenario, startRun, startAudit, audit, replay, importOasis, version
    core/   types.ts schema.ts result.ts ids.ts rng.ts time.ts clock.ts world.ts resolver.ts actions.ts events.ts log.ts checkpoint.ts population.ts prompt.ts scenario.ts registry.ts simulation.ts run.ts protocols.ts
    logging/ logger.ts sinks.ts
    llm/    gateway.ts structured.ts presets.ts
    agents/ focal.ts cohort.ts components/{persona,instructions,recentMemory,summaryMemory,feedObservation,neighborhoodObservation}.ts
    providers/ llm.ts rule.ts mock.ts surrogate.ts archetype.ts cache.ts routers/{aps,topo}.ts
    modules/ socialGraph.ts feed.ts recommenders.ts calendar.ts
    policies/ index.ts   metrics/ index.ts   instruments/ questionnaire.ts
    harness/ axes.ts plan.ts conditions.ts stats.ts runner.ts report.ts
    adapters/ script.ts oasis.ts
    cli/ index.ts commands/*.ts
    api/ app.ts routes/*.ts sse.ts
    mcp/ server.ts
  gui/ index.html vite.config.ts src/{main.tsx, App.tsx, api.ts, pages/{Runs,Run,Audit}.tsx, components/{NetworkCanvas,Timeline,AgentInspector,MetricChart,PairwiseTable}.tsx, styles.css}
  examples/ prisoners_dilemma/{scenario.yaml,audit.yaml,rules.ts} echo_chamber/{scenario.yaml,audit.yaml,cohort.yaml}
  bench/ kernel.ts llm.ts RESULTS.md
  tests/ unit/*.test.ts integration/*.test.ts fixtures/oasis_min.sql
```

## 边界情况

| 情况 | 期望行为 |
|---|---|
| 人口 n = 0 | schema 校验失败，错误指向 `population.n` |
| 激活集合为空 | 写空 activation，模块照常 step，完成断言通过 |
| actionSpace 为空 | observe 阶段记 failure `no_available_actions`，不构造 request |
| provider 返回长度不等于 requests | 整批视为失败，全部 fallback，记 failure `provider_contract_violation` |
| 同 tick 同列两个 set | 按 merge：last 取 seq 大者，sum 相加，max 取大，append 连接 |
| 效果引用不存在的 entity | 拒绝并记 failure |
| 动作 requiresModules 未装载 | 装配阶段返回错误，列出缺失模块 |
| 组件 reads 未声明 | 装配阶段 `ComponentDependencyError` |
| 列名冲突 | 自动前缀避免；同 owner 重复声明不同 dtype 返回 `ColumnConflict` |
| prompt 超出长度预算 | 记忆组件裁剪；observation `truncated=true`；不裁到空 |
| 端点不可达 | 断路后本批余下立即失败；连续 3 tick 后 run failed，日志与 result.json 保留，integrity.complete=true |
| json_schema 被拒（400） | 自动切 prompt 模式并记 failure `structured_fallback`（retryable=true） |
| 动作不在 actionSpace | 视同解析失败 |
| replay 未命中录制 | LLMFailure retryable=false，fallback |
| 预算耗尽 | 后续调用 `budget_exhausted`，run 继续用 fallback；result.json 的 cost 反映真实调用 |
| 覆盖路径不存在 | `overrideScenario` 返回 `UnknownOverride`，harness 生成条件时即失败 |
| axis level 与基线相同 | 允许，报告标 `identicalToBase` |
| replications = 1 | 跑，统计跳过，evidenceGrade weak |
| resume 配置漂移 | `ConfigDrift`；`--force` 继续并记 failure |
| 检查点在 tick 中途 | 拒绝 |
| ULID 冲突 | `world.create` 检查主键唯一，冲突抛 `IdCollision`（内核 bug） |
| 干预 Selector 命中 0 | intervention 事件 `targets=[]` 加 failure `empty_selection` |
| 输出目录非空 | `run` 拒绝，需 `--overwrite` |
| API 并发启动同 runId | 第二个返回 409 |
| SSE 客户端断开 | 服务端取消订阅，不影响运行 |
| MCP 工具入参非法 | 返回 isError 与 zod issues |
| GUI 拿到超大事件页 | 分页 200 条，画布节点上限 5000（超出按度采样并提示） |

## 实施步骤

每步 ≤ 半天，可独立验证。按阶段下发，每步验收通过后提交一次。

### A 阶段：内核

1. 骨架：`package.json`（bun，scripts：`check`=tsc --noEmit、`lint`、`format`、`test`=bun test、`build:gui`、`dev:gui`）、`tsconfig.json`、ESLint + Prettier（Tab）、`.gitignore`、LICENSE、`src/core/{types,result,ids,rng,time}.ts`、`src/logging/`。验证：`bun run check && bun run lint && bun test` 通过；`rngFromSeed(1,[2,3])` 前 5 个数与固定向量相等；`ulid(rng)` 单调递增。
2. `schema.ts` 与 `scenario.ts`：zod schema、YAML 解析、`spawnReplications/overrideScenario/scenarioHash`。验证：同参数两次 hash 相等；spawn 3 次 seedPath 两两不同；未知路径返回 err。
3. `world.ts` 与 `resolver.ts`。验证：随机效果序列 apply 后 hash 与 snapshot→restore→hash 相等；四种 merge 各一例；拒绝路径不抛。
4. `log.ts`（Sqlite 与 Memory）与 `checkpoint.ts`。验证：写 10k 事件后 `count()` 正确、`chain()` 正确、`digest()` 稳定；检查点 save→load 后 worldHash 相等；ConfigDrift 返回。
5. `clock.ts`、`actions.ts`、`registry.ts`、`policies/`。验证：同种子 bernoulli 相同；取消事件不触发；toolSchemas 与 zod 一致；两个 fallback 报错。
6. `llm/gateway.ts` 与 `structured.ts`、`presets.ts`：用测试内启动的 `Bun.serve` 假端点测 429 退避、并发上限、json_schema 400 回退、record/replay、预算耗尽、nonce 不改 promptHash。
7. `providers/{mock,rule,llm}.ts`、`prompt.ts`（渲染选项：personaFormat plain|bullets|table、instructionOrder、rolePlacement、naming、memoryRepresentation transcript|json|bullets、contextWindow）。验证：mock 确定性；每个渲染选项改变 promptHash。
8. `agents/focal.ts` 与组件。验证：reads 缺失报错；记忆条目带事件 id。
9. `simulation.ts` 与 `run.ts`：4.1 全流程、失败路径、RunResult。验证：单 agent 异常 → integrity.failed=1 且 succeeded；连续 3 tick 整批失败 → failed。
10. `modules/{socialGraph,feed,recommenders,calendar}.ts` 与动作。验证：100 agent 10 tick mock 跑通；rec 表每 tick 重建；silent 为 fallback。
11. 示例 `prisoners_dilemma`（2 agent，rule 对手 TitForTat/Random/AlwaysC/AlwaysD，10 tick，指标 cooperationRate/averagePayoff）、`echo_chamber`（100 agent，幂律图、同质性重连、hub 分配、bernoulli 激活、指标 stanceAssortativity/sameGroupRatio）。验证：mock 下两次 digest 相等。
12. `replay`、`resume`、`inspect`、`digest`、`doctor`、`examples` 命令与 `src/index.ts`。验证：README 命令逐条可执行。

### B 阶段：harness 与适配器

13. `harness/{axes,plan,conditions}.ts`：TRAILS 目录模板（8 个 D 维度、5 个 R 类别）。验证：one_at_a_time 与 full_factorial 条件数正确。
14. `harness/stats.ts`。验证：MWU、Holm、Cohen d、bootstrap、TVD、W1、Cliff's delta 对固定样本与已知值误差 < 1e-9（已知值写在测试里，附来源公式）。
15. `harness/{runner,report}.ts` 与 `audit` `report` 命令。验证：故意失败的条件不中断；HTML 无外链。
16. `adapters/{script,oasis}.ts` 与 `import-oasis`。验证：fixture SQLite 导入后计数正确；非零退出码转 FailureInfo。
17. 示例审计 YAML：PD 轴 personaFormat × framing × memoryRepresentation；回音室轴 homophily × hub × activation × memoryWindow × feedSize。验证：mock 下端到端产出 audit.json 与 report.html。

### C 阶段：规模化与降本

18. `agents/cohort.ts`、`Transition`、回音室列式版 `cohort.yaml`。验证：10 万 agent rule 提供者 20 tick 在 M 系列 Mac 上 300s 内完成。
19. `providers/archetype.ts`、`surrogate.ts`、`cache.ts`。验证：archetype 调用数 = 组合数 × nArch 且与 N 无关；surrogate 留出集准确率高于随机。
20. `providers/routers/{topo,aps}.ts`。验证：topo 单元直径约束；aps 调用数 < 0.3 × N × ticks 且 JSD < 0.05。
21. 问卷仪器与 intervene 步骤。验证：问卷不改世界；Selector 命中按种子可复现。

### D 阶段：API、MCP、GUI

22. `api/`：全部路由、SSE、静态托管、`serve` 命令。验证：契约测试覆盖每条路由的 200/400/404；SSE 收到运行中事件。
23. `mcp/server.ts` 与 `mcp` 命令。验证：用 SDK 客户端在测试内连接 stdio 服务，调用 `list_examples`、`run_scenario`（mock）、`get_agent_trace`。
24. `gui/`：三页与组件，`bun run build:gui` 产物由 API 托管。验证：构建成功；用无头浏览器或 API 契约确认页面拉取的路由；人工视觉检查由验收者截图。

### E 阶段：性能、文档、发布

25. `bench/kernel.ts`（mock：1k focal × 20 tick、100k cohort × 20 tick）与 `bench/llm.ts`（DeepSeek：PD 2 agent × 5 tick 加回音室 20 agent × 3 tick，record 模式，预算 `maxCalls=150, maxCompletionTokens=200`），结果写 `bench/RESULTS.md`（日期、机器、数字表）。录制文件提交到 `examples/*/recordings/` 供 replay 测试。验证：`bun bench/kernel.ts` 输出表；`SIMULACRA_LLM_API_KEY=... bun bench/llm.ts` 总调用 ≤ 150。
26. README：banner（`docs/banner.png`）、一句话定位、安装、三条命令跑示例、架构图（文本）、扩展指南、API/MCP/GUI 入口、引用文献。不写过程叙事。
27. 发布：`gh repo create misakaikato/simulacra --public`，HTTPS 远端，推送 main；仓库 description 与 topics。

## 验收标准

每条可执行。在项目根目录执行。

1. `bun run check && bun run lint && bun run format:check` 退出码 0。
2. `bun test` 全部通过，M 系列 Mac 上 < 120s。
3. 确定性：`bun run simulacra run examples/echo_chamber/scenario.yaml --seed 7 --provider mock --out /tmp/a` 与 `--out /tmp/b` 后 `simulacra digest` 两者相同。
4. 回放：`simulacra replay /tmp/a --to-tick 10` 的 worldHash 等于 `/tmp/a/checkpoints/10/meta.json` 的 worldHash。
5. 续跑：`simulacra resume /tmp/a/checkpoints/5 --ticks 5 --out /tmp/c` 后 tick 10 worldHash 与第 4 条相同。
6. 失败一等：`tests/unit/failures.test.ts` 覆盖单 agent 异常与连续整批失败两种路径。
7. 扩展不改内核：`tests/unit/extension.test.ts` 在测试内定义新动作、模块、提供者、策略、指标、适配器并跑 3 tick；审查项 `git log --stat -- src/core` 在该测试提交中无变更。
8. 审计端到端：`simulacra audit examples/prisoners_dilemma/audit.yaml --replications 5 --provider mock --out /tmp/audit` 生成 audit.json 与 report.html，pairwise 非空且含 holmP，evidenceGrade weak。
9. 统计正确性：`tests/unit/stats.test.ts` 通过。
10. 失败即数据：`tests/integration/auditFailure.test.ts` 通过。
11. OASIS 导入：`simulacra import-oasis tests/fixtures/oasis_min.db --out /tmp/oasis` 后 observation 与 decision 计数等于 fixture 的 REFRESH 与非 REFRESH 动作数。
12. 报告离线：`grep -c "http" /tmp/audit/report.html` 为 0。
13. Cohort：`bun bench/kernel.ts` 中 100k × 20 tick 行 < 300s 且 integrity.complete=true。
14. archetype：`tests/unit/archetype.test.ts` 断言调用数与 N 无关。
15. APS：`tests/unit/aps.test.ts` 通过。
16. API 契约：`tests/integration/api.test.ts` 通过。
17. MCP：`tests/integration/mcp.test.ts` 通过。
18. GUI：`bun run build:gui` 成功；`simulacra serve` 后 `GET /` 返回 200 且含 `<div id="root">`。
19. DeepSeek：`bench/RESULTS.md` 含 LLM 段，总调用 ≤ 150；`examples/*/recordings/` 存在且 `tests/integration/replay.test.ts` 用录制在 replay 模式下 digest 稳定。
20. 仓库：`git log --format=%an | sort -u` 只有一个作者且不含 Claude；`git log --format=%b | grep -ci co-authored` 为 0；`gh repo view misakaikato/simulacra --json visibility` 为 PUBLIC。

## 明确禁止

- 不引入白名单以外的依赖。尤其不引入 lodash、ramda、fp-ts、effect、pino、winston、commander、express、better-sqlite3、d3、echarts、tailwind、任何 UI 组件库、任何状态库。
- `src/core/` 不 import 其它顶层目录（`logging/` 除外）。
- 不用 `Math.random`；不用 `Date.now()` 影响模拟语义。
- 不在核心写平台或场景专用分支。
- 不用字符串前缀当协议；不让引擎解析 LLM 自由文本。
- 不用魔法键跨组件取对象。
- 不在 `catch` 后静默返回；每个捕获产生 failure 事件或 error 日志并重新抛出。
- 不用超时判定完成；不轮询等待。
- 不用整数序号做实体 id。
- 不生成代码作为扩展机制；不 monkey-patch。
- 不把运行产物写进 `src/` 或 `gui/`。
- 不在代码、注释、README、提交信息里写过程叙事。
- 不改测试预期让测试通过；预期错误单独说明。
- 不用 `any`；不用 `as unknown as`；不用非空断言 `!`（除测试）。
- 不在仓库任何文件里出现 API 密钥；`.gitignore` 含 `.env*`、`simulacra-data/`、`*.sqlite`。
- 提交不加 Co-Authored-By；作者只用本机全局 git 配置。

## 工程原则（给施工者）

- 单一真相源：同一件事只有一种做法、一条数据通路、一处类型定义。发现第二套先删一套。
- 警惕架构分叉：动手前先找现有的那一套；交付前自查这次改动有没有制造第二套做法。
- 根因修复不兜底：读完整错误栈，找到根因再改；不用 try/catch 盖住症状。
- 一次只改一个变量。
- 每个中间状态可停可交付：小步走，步步绿。
- 测试红了先怀疑自己：改预期前必须证明预期本来就是错的，并单独说明。
- 交付物无过程残留。
- 类型先行：先写类型与接口，再写实现；公共类型全 readonly；用判别联合替代布尔标志与可选字段堆叠。
- 纯函数优先：能不碰 I/O 的逻辑写成纯函数并单测；副作用集中在四处（gateway、log、fs、网络）。

## 附录 A：A 阶段第 1 到 5 步裁定的细节

以下细节在规格正文未定或与正文签名有差异，以本附录为准：

- `ulid(rng?: Rng)`：内核路径必须传 rng；不传时用 `crypto.getRandomValues`，仅用于非模拟语义的 id（如 runId）。单调状态为模块级。
- `prettySink` 同时接受 `WritableStream` 与 `(line: string) => void`，另有 `{ color?: boolean }`。
- `MemoryEventLog.sql` 返回 `[]` 并记 warn（构造函数可注入 Logger）。
- 检查点签名：`saveCheckpoint(state, dir)` 与 `loadCheckpoint(dir, scenarioHash)`，`state` 为 `{ world, clock, executors, providers, rngPaths, scenarioHash, digest, lastEventId }`；`clock.json` 只存 `{ now }`，已调度回调不序列化，续跑时由 Scenario 步骤重新调度。
- `overrideScenario` 错误为 `UnknownOverride | InvalidOverride`（覆盖后 schema 校验失败）；路径先从 Scenario 根解析，找不到再回退到 `params`。
- `ActionRegistry.register` 错误为 `DuplicateAction | DuplicateFallback`；`params` 必须是 `z.object`，否则抛 `TypeError`；`toolSchemas` 遇未知动作名抛 `RangeError`（内核误用，不是数据错误）。
- `InstrumentSpec = { kind, name?, options?, every? }`，`every` 为采集间隔 tick 数，默认 1。
- `PromptOptions`：`personaFormat: plain|bullets|table`、`instructionOrder: first|last`、`rolePlacement: system|user`、`naming: id|name|anonymous`、`memoryRepresentation: transcript|json|bullets`、`contextWindow` 正整数默认 4000。
- `LLMSpec` 默认：`baseUrl` DeepSeek 端点、`model` `deepseek-v4-flash`、`apiKeyEnv` `SIMULACRA_LLM_API_KEY`。
- `profileHourly(column)`：`strlist` 列为 24 个概率字符串按小时索引，`f64` 列视为常数概率；`hour = floor(tick / ticksPerHour) % 24`，`ticksPerHour` 为策略选项默认 1。
- `explicit(schedule)`：`Record<tick 字符串, EntityId[]>`，不校验 id 存在。
- `Clock.priority` 数值小者先执行。
- 同 tick 合并跨两次 `applyEffects` 仍生效：每列每行记录最后写入 tick；`create` 后首个 `set` 视为替换；`delete` 用 swap-remove，id 顺序变化但确定。
- `declare` 在 merge 与 dtype 不匹配、默认值不可转换时也返回 `ColumnConflict`。
- Scenario 族与实验、审计类型为 `DeepReadonly<z.infer<...>>`；全部接口集中在 `src/core/protocols.ts`；`src/core/hash.ts` 提供 `sha256Hex`、`canonicalJson`、`hashOf`。
- Registry 有七类槽：actions、modules、executors、providers、policies、metrics、adapters；`PluginContext = { scenario, registry, logger }`。
- 工具链：TypeScript 钉 `^5`；zod 4，`ActionDef<P extends z.ZodType>`。
- `.prettierignore` 排除 `specs/` 与 `decisions/`。
- 快照保留列的声明顺序：`snapshot()` 与 `restoreWorld` 后 `columns(entity)` 与 `row()` 的键序必须与原世界一致；哈希仍按规范化 JSON 计算。原因：续跑后 prompt 渲染若依赖列序，promptHash 必须与直跑一致。
- 合并结果也要过 dtype 校验：`merge` 得到的值不能表示为目标 dtype（如 i32 溢出）时整条效果进入 rejected。
- 绕过 `applyEffects` 的内部写入句柄不得从任何公共模块导出；只允许 `world.ts` 与 `resolver.ts` 之间私下共享（例如放在 `src/core/internal/` 且 `src/index.ts` 永不再导出）。
- 内置插件注册函数（`registerBuiltinPolicies` 等）不得丢弃 `Result`：返回 `Result<void, DuplicatePlugin>` 或在重复时抛出。

## 附录 B：A 阶段第 6 到 9 步裁定的细节

- 校验、回退与动作解析统一在 `Simulation.step` 内线性执行（validate → fallback → `action.resolve`）；`FocalExecutor.act` 返回空数组，`Executor.act` 保留给批量执行体（Cohort）的向量化转移。
- `core/` 不 import `llm/`：网关通过 `createSimulation`/`runScenario` 的 deps 或 `PluginContext.gateway` 注入；未注入时 llm 提供者与 summaryMemory 按 `scenario.llm` 自建。`tests/unit/layering.test.ts` 守护分层规则。
- "整批失败"的定义为并集：提供者抛异常、返回长度或 agentId 错位、非空批次全部 err。连续 3 tick 整批失败则 run `failed`。
- `Executor.observe` 第 6 个可选参数 `observations` 承载模块 `observe` 的输出，按模块返回对象的键合并（如 `feed`、`neighbors`）。
- `buildPopulation` 固定声明 kernel 列 `agent.ordinal`（创建序号），保证 `agent` 表存在。
- 组件 `reads` 支持 `persona.*` 通配，无匹配列时视为满足。
- checkpoint 事件的 `path` 为相对 run 目录的 `checkpoints/<tick>`，保证不同输出目录的 digest 相同。
- 结构化回退那一次 400 不计入重试次数。
- 接口增项：`LLMSpec.sendSeed`（默认 true，`mlxLm` 预设为 false）；`ProviderFailure.excType?`；`rng.keyFromLabel(label)` 供插件按标签派生路径；检查点新增 `modules.json`；`Component.consolidate?()` 异步整理钩子（`preAct/postAct` 同步）；`LLMGateway.failures()` 与 `ledgerByPurpose()`；`PluginContext.gateway?`。
- recentMemory 对 observation 条目只给占位摘要（payload 只有 sha），decision 条目含动作、参数与 rationale 前 200 字。
- 每个 run 恰好一个网关：`createSimulation`/`runScenario` 的 deps 必须提供 `createGateway(spec, { logger, onFailure })` 工厂（类型上必填），Simulation 用它创建唯一网关并放入 `PluginContext.gateway`；提供者与组件禁止自建网关，缺席时 llm 提供者返回 `gateway_missing` 失败。公共入口 `src/index.ts` 负责注入 `llm/gateway.ts` 的工厂。
- 网关层失败必须进入事件日志：Simulation 通过 `onFailure` 回调把 `structured_fallback`、`budget_exhausted`、`CircuitOpen`、`ReplayMiss` 等网关失败写成 `failure` 事件（`stage: "llm"`，`retryable` 按失败对象），并计入 `integrity.llmFailures`，同时 error 级日志。
- 预算只对真正发出的网络请求计数：replay 命中、断路后的即时失败、预算耗尽的拒绝都不消耗 `maxCalls`。
- 断路器计数的是"最终失败"（含重试耗尽的 429/5xx/网络错误），措辞以此为准。
- `llm_call` 事件的 `params` 记录实际使用的结构化模式（`json_schema` 或 `prompt`）。
- `LLMResponse.structured?: "json_schema" | "prompt"` 记录实际模式，录制文件同样保存并回放；`SimulationDeps`/`RunOptions` 不再接受直传 `gateway`，只接受 `createGateway` 工厂。
- replay 命中不进入 `ledger`，`cost` 只反映真实网络请求。

## 附录 C：A 阶段第 10 到 12 步裁定的细节

- `module_step.summary` 为 `{ effects: Effect[], applied, rejected }`；回放折叠 `effect` 与 `module_step` 两类事件。
- 模块初始化钩子 `Module.initialize?(world, rng)` 在人口创建后、tick 0 之前执行，产生的 `module_step` 记在 `(0,0,0)` 且不消耗 seq；tick 0 检查点表示"已初始化的世界"；回放按 `lastEventId` 跳过初始化事件。
- `digest()` 的规范化剔除 failure 事件的 `stack` 字段（栈帧文本不确定），事件本身保留 `stack` 供 inspect。
- 动作解析上下文的 rng 与 `newEntityId()` 按 `${executor}:${action}:${cause 事件 id}` 派生，避免同 tick 多个 agent 解析同一动作时实体 id 碰撞。
- `Executor.owns?(world, id)` 可选钩子决定该执行体处理哪些 agent；focal 执行体支持 `where` 选项按列过滤。
- `--provider mock` 替换全部执行体的提供者（含规则对手）；真 LLM 下规则对手保持 `rule`。
- mock 提供者生成 id 类参数（字段名以 `Id` 结尾或为 `target`）时，从本次 `observation` 中的列表（如 `feed[].id`、`neighbors`）按确定性哈希选取；观察里没有候选时才用占位符。（B 阶段第 13 步前实施。）
- 回音室示例不设 `group` persona 字段；分组指标按 `persona.stance` 阈值 `< -0.5`、`[-0.5, 0.5]`、`> 0.5` 划分。
- hub "度最高"取入度；`anti`/`pro` 取全体人口立场的 min/max；`random` 从现有立场抽样；同质性 `x̄` 取人口均值，迭代上限未达区间记 warn。
- `resume` 从 `<runDir>/scenario.json` 读原场景并跳过检查点已覆盖的 steps；同一 tick 不重复写检查点；`rng.json` 增加 `boundaryEvents` 用于对齐边界事件 id。
- `replay --to-tick N` 表示 tick N 开始时的状态，与 `checkpoints/N` 对齐。
- `params.ts`：模块、策略、执行体的 options 支持 `{ $param: "name", map?: {...} }` 引用 `scenario.params`，装配前解析。
- 分层守护扩展到入口：`src/cli`、`src/api`、`src/mcp` 只 import `src/index.ts`（相对路径 `../index` 或 `../../index`），`layering.test.ts` 守护；`doctor` 的端点探测逻辑与 `isLogLevel` 等由公共 API 导出，MCP 的 `doctor` 工具复用同一函数。
- `Integrity` 增加 `rejectedActions`（动作解析被拒，即 `ActionRejected` 失败）计数，`complete` 的定义不变。
- Scenario 增加可选 `plugins: string[]`（相对场景文件所在目录的模块路径，模块导出 `register(registry)`），`loadScenario` 记录来源目录，`runScenario` 与 harness 装配前自动装载；CLI `--plugin` 为追加。审计示例 `examples/prisoners_dilemma/audit.yaml` 依赖此字段而非 `--plugin`。
- `replay` 从不晚于目标 tick 的最早检查点开始折叠（续跑输出目录没有 tick 0 检查点时从其首个检查点起）。
- 公共 API 新增模块：`src/llm/probe.ts`（`probeEndpoint`）、`src/doctor.ts`（`doctor` 返回 `Result<DoctorCheck[], string>`）、`src/examples.ts`（`listExamples/copyExample/examplePath`）、`src/plugins.ts`（`loadPlugins`，按绝对路径去重），均经 `src/index.ts` 导出。`replay` 结果含 `fromTick`。

## 附录 D：HTTP API 响应契约（GUI 已按此实现，API 必须对齐）

- `GET /api/runs` → `RunSummary[]`；`GET /api/runs/:id` → `RunSummary = { runId, progress: { tick, ticks, status: "running" | "succeeded" | "failed" }, agentCount, result?: RunResult }`。
- `GET /api/examples` → `{ name, yaml }[]`。
- `POST /api/runs` body `{ scenario: string（YAML 文本）| Scenario, seed: number, ticks?: number, provider?: "mock" | "llm" }` → `201 { runId }`；同 runId 已存在 `409`。
- `GET /api/runs/:id/events?kind=a,b&agent&tick&fromTick&toTick&limit&offset` → `Event[]`（时间升序，默认 200 最大 1000）；`GET /api/runs/:id/events/:eventId/chain` → `Event[]`。
- `GET /api/runs/:id/content/:sha` → `text/plain`。
- `GET /api/runs/:id/agents` → `{ id, columns: Record<string, Scalar> }[]`，`columns` 含 `persona.*` 公开列与派生统计键 `decisions`、`failures`。
- `GET /api/runs/:id/graph?tick` → `{ tick, edges: { src, dst, kind }[] }`（tick 省略或不可用时返回当前状态并回填实际 tick）。
- `GET /api/runs/:id/metrics` → `Record<name, { tick, value: number }[]>`，只含数值 measurement。
- `GET /api/runs/:id/stream` → SSE：`event: event` 的 data 为 Event JSON，`event: done` 表示结束；已结束的 run 按 tick 顺序回放后 `done`。
- `GET /api/audits` → `AuditSummary[]`；`GET /api/audits/:id` → `AuditSummary = { auditId, progress: { completed, total, status }, plan?: AuditPlan, report?: AuditReport }`；`POST /api/audits` body `{ plan: string | AuditPlan, replications?, provider? }` → `201 { auditId }`；`GET /api/audits/:id/report.html`。
- 错误体：校验失败 `400 { issues: [{ path, message }] }`；其它 `{ error: string }`。
- 路径参数 URL 编码（runId 含冒号），服务端解码。
- GUI 的 Runs 页同时列出 audits，因此 `GET /api/audits` 为必需。

## 附录 E：B 阶段裁定的细节

- `planHash` 排除 `concurrency`；conditionId 只在 `models` 非空时追加 `@model`；`identicalToBase` 以模型覆盖前的 `scenarioHash` 相等判定。
- 运行器把条件场景的 `scenarioId` 改为 `<id>#<conditionId>` 保证 runId 唯一；`AuditReport` 扩展 `plan`（摘要）、`options`、`runIndex`；`Condition.flags`；`DistributionTest.tvdBase`。
- 审计对 `llm` 提供者强制 `temperature: 0`。
- 统计退化值：样本先滤 NaN；空样本 mean 0、CI [0,0]、p 1；pooled sd 为 0 且均值不等时 Cohen d 为 ±Infinity（JSON 落 null，HTML 显示 inf）；无轴时 evidenceGrade weak；`directionFlip` 依据 `hypothesis.outcomes` 的 `direction`，无假设时恒 false。
- 分布检验：有 `targetDistribution` 时用等宽直方图（bin 数 = target 长度，范围取两组并集）算归一化 TVD，写 `tvd` 与 `tvdBase`。
- `audit` 命令有 run 失败仍退出 0 并打印失败数；审计日志 `<out>/log.jsonl`。
- OASIS 导入：`importOasis(dbPath, outDir, metrics, registry, { logger, overwrite })`，`metrics` 接受名字或 `InstrumentSpec`；从 `follow` 表落 `edge` 表；另写 `scenario.json`、`world.json`。fixture 只提交 SQL（`tests/fixtures/oasis_min.sql`），验收标准 11 的 `.db` 由测试或验收方从 SQL 临时生成。
- 插件层之间允许引用列名常量（如 `adapters/oasis.ts` 引用 `modules/posts.ts`、`modules/socialGraph.ts`）；分层限制只针对 `core/` 与入口目录。
- 工具链忽略 `.claude/worktrees/`（eslint、prettier、git）。
- mock 提供者的 id 参数：`*Id` 取含 `id` 的对象数组（键名含字段词干者优先），`target` 取字符串数组；无候选时占位符。回音室 mock 下仍有少量 `ActionRejected`（feed 为空时），属预期。

## 附录 F：B 阶段验收后的裁定

- `full_factorial` 设计同样包含 `base` 条件（axisValues 为空），成对检验以它为基线；报告不再出现"无成对检验"的误导文案。
- `audit --overwrite` 删除整个输出目录（文档中写明）；`import-oasis --overwrite` 只删导入器自身产物。
- `import-oasis --metrics` 只接受指标名；需要 options 的指标走 API 的 `InstrumentSpec`。

## 附录 G：D 阶段裁定的细节

- 运行注册表 `createRunRegistry({ dataDir, logger })`：目录 `runs/<runId 冒号替换为 __>/`、`audits/<planHash 前 12 位 或用户命名>/`；进度由 `activation` 事件推进，审计按完成 run 计数；`subscribe`/`subscribeAudit` 为事件总线。
- 事件总线 `src/core/bus.ts` 的 `observableLog(log, emit)`；`RunOptions.onEvent` 与 `SimulationDeps.onEvent`。
- `replayWorld(runDir, tick)` 返回任意 tick 开始时的 `WorldView`，供 `agents`、`graph?tick` 路由；tick 超出或省略时返回最终状态并回填实际 tick。
- `renderInspect` 从 CLI 移入 `core/inspect.ts`，CLI 与 MCP 共用。
- POST 的 YAML 文本若与某内置示例逐字相同，插件按该示例目录解析，否则按 cwd；MCP 用显式 `example`/`examplePlan` 参数。
- MCP `run_audit` 同步等待完成后返回摘要；`get_audit` 返回浓缩报告，完整报告走资源 `simulacra://audits/{id}/report`。
- `GET /api/runs/:id/agents` 只给 `persona.*` 公开列加 `decisions`、`failures`。
- 审计自动 id 不含 provider，同计划换 provider 需显式 `name`。
- `serve` 固定绑定 `127.0.0.1`，`--port 0` 可用并打印实际地址。
- 空成对检验表按真实原因提示：无扰动条件 / 无指标 / 可用复制不足 2。

## 附录 H：C 阶段裁定的细节

- `population.n` 支持 `{ $param }` 引用，在 `ScenarioSchema` 的 transform 里解析（解析时刻），`Scenario` 类型不变；解析后再覆盖 `params.n` 不重新派生，harness 轴直接指向 `population.n`。
- `Executor.fallbackAction?`：Cohort 执行体的回退动作，默认取 `virtualActions` 末项；`Executor.resolvesOwnActions` 为 true 时 Simulation 跳过 registry 校验与 resolve。
- `Transition.apply` 第 5 个可选参数 `graph?: GraphView`；`opinionDynamics` 只更新本批激活的 agent，邻居均值取本轮发帖的关注对象。
- `PluginContext.provider(name)` 解析器由 `createSimulation` 提供，记忆化并在装配期检测循环。
- archetype 的每次代表调用写一条无 `agentId` 的 `observation` 事件（provenance `prototype`，parent 指向组内首个观察，refs 为成员观察），成本记在组内首个成员的 Decision。
- APS 默认参数按 N ≥ 5000 设计；小 N 测试用 `alphaB: 0.08, gamma: 0.02`；`tau` 为选项默认 0.1；`audit()` 以 `reportedDistribution.<action>` 扁平键给出分布，结构化走 `ApsProvider.report()`。
- 问卷 `entersMemory: false` 时 interview 的 observation/decision 事件不带 `agentId` 且跳过 `after()`；measurement 事件带 `agentId` 与 `parent`。
- 干预与问卷事件记在 tick 边界 `(tick, 0, 0)` 且不消耗 seq；`assertComplete` 只统计 substep > 0 的事件；`run → intervene → checkpoint` 合法。
- 热配置：`ctx.scenario` 为活引用；intervene 逐键覆盖 `params.*`、`prompt.*`、`policy.options.*`，其它键记 `override_not_hot` 并回退；策略每次重建，`$param` 驱动的执行体 options 变化时重建执行体并转移状态。已知局限：`resume` 跳过检查点之后的 intervene/questionnaire 步骤。
- 注册表新增 `transitions` 与 `instruments` 槽；`bench/kernel.ts` 输出目录用系统临时目录并清理；`tsconfig.json` include 加 `bench`。
- mock 提供者对注册表外的虚拟动作返回无参决策。

## 附录 I：D 阶段验收后的裁定

- `serve` 的 `Bun.serve` 设 `idleTimeout: 0`，SSE 另每 15 秒写一行注释心跳；补一条经真实 `Bun.serve` 的慢 tick SSE 测试。
- 注册表读取 `result.json`、`plan.json` 失败时返回带路径与原因的 `err` 并 error 日志，不得吞成 undefined；MCP 资源变量解码失败同样记录。
- `POST /api/runs` 接受可选 `name`；未给时 API 侧把 `scenarioId` 改写为 `<scenarioId>-s<seed>`，只有同名（同 scenarioId 与 seed）才 409。MCP `run_scenario` 同理。
- 契约信封类型（`RunSummary`、`RunProgress`、`AuditSummary`、`AuditProgress`、`RunStatus`、`GraphSnapshot`、`AgentRow`、`MetricSeries`）单一定义在 `src/api/contract.ts`（只含类型与 zod，不引 hono），`src/index.ts` 导出，`gui/src/api.ts` 只 `import type`，不再重复定义；`issues[].path` 为字符串。
- MCP `get_audit` 入参名为 `auditId`（规格正文 3.16 为笔误）。
- `serve --port` 限制 0 到 65535。

## 附录 J：C 阶段验收后的裁定

- 提供者 `audit()` 的数值结果每 tick 写成 `measurement` 事件（`instrument: "provider:<name>"`），并以 `provider.<name>.<key>` 进入 `RunResult.metrics`。
- 检查点之后的边界事件记在 `(tick, 0, 1)`（checkpoint 事件占 seq 0），语义与附录 H 一致。
- `resume` 跳过检查点之后的 intervene/questionnaire 步骤，属已知局限，README 写明。
- APS 默认参数面向 N ≥ 5000，小 N 需显式给 `alphaB`/`gamma`。

## 附录 K：真实 LLM 性能测试后的裁定

- `LLMSpec.extra?: Record<string, JsonValue>`：原样合并进 `/chat/completions` 请求体（不覆盖 `model`、`messages`、`max_tokens`、`temperature`、`seed`、`response_format`），进入录制键的 `params`。
- DeepSeek 预设默认 `extra: { thinking: { type: "disabled" } }`（实测 `deepseek-v4-flash` 接受，等价于 `reasoning_effort: "none"`）；推理内容会占用 `max_tokens`，默认关闭以保证结构化输出在小预算下完整；用户可覆盖。
- `LLMResponse.finishReason?: string`（来自 `choices[0].finish_reason`），录制文件保存；`content` 为空且 `finish_reason === "length"` 时网关返回失败 `truncated`（`retryable: false`），`content` 为空但存在 `reasoning_content` 时返回失败 `empty_content`；两者都进 failure 事件与 `integrity.llmFailures`。
- `bench/llm.ts` 的 `maxCompletionTokens` 提高到 512。
