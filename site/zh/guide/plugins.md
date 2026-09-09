# 插件

`src/core` 之上的一切都是按名字注册的插件。一个新的动作、模块、提供者、激活策略、指标或适配器，就是一个导出 `register(registry)` 的文件；内核不动。本页的接口声明在 `src/core/protocols.ts`，公共 API 把它们从 `@misakaikato/simulacra` 重新导出。

## 加载插件 {#loading-a-plugin}

场景把自己的插件列出来，路径相对场景文件：

```yaml
plugins: ["./rules.ts"]
```

CLI 在 `run`、`audit` 与 `resume` 上接受 `--plugin <path>`，可以重复给；同一路径既写在场景里又写在参数里，也只注册一次。每个模块都要导出 `register(registry)`，它可以什么都不返回，也可以返回一个 `Result`。返回错误（通常是 kind 重名）或导入时抛出异常，都会连同插件路径一起报出来，运行在第一个 tick 之前就失败。

在代码里，自己建注册表再传进去：

```ts
import { createDefaultRegistry, runScenario } from "@misakaikato/simulacra";

const registry = createDefaultRegistry();
register(registry);
await runScenario(scenario, "runs/demo", { registry });
```

`createDefaultRegistry()` 里装着全部内置 kind；同一个 kind 注册两次会返回错误，而不是把内置的替换掉。

## 注册表 {#the-registry}

| 槽位          | 元素类型           | 工厂签名                                          |
| ------------- | ------------------ | ------------------------------------------------- |
| `actions`     | `ActionDef`        | `register(def)`；动作是声明出来的，不是构造出来的 |
| `executors`   | `Executor`         | `register(kind, factory)`                         |
| `transitions` | `Transition`       | `register(kind, factory)`                         |
| `modules`     | `Module`           | `register(kind, factory)`                         |
| `providers`   | `DecisionProvider` | `register(kind, factory)`                         |
| `policies`    | `ActivationPolicy` | `register(kind, factory)`                         |
| `metrics`     | `Metric`           | `register(kind, factory)`                         |
| `instruments` | `Questionnaire`    | `register(kind, factory)`                         |
| `adapters`    | `Adapter`          | `register(kind, factory)`                         |

工厂是 `(spec, ctx) => Result<T, PluginError>`。`spec` 是场景里的那份插件规格（`kind`、`name`、`options`）；`ctx` 带着场景、注册表、一个 logger、本次运行唯一的 LLM 网关（插件不许自己造一个），还有 `provider(name)`——它解析场景里声明的另一个提供者，好让组合提供者够得着自己的下游。`parseOptions(slot, spec, schema)` 用 zod schema 校验 `spec.options`，失败时转成带路径的 `PluginError`。

## 动作 {#actions}

`defineAction` 接受一份声明，产出给模型看的工具 schema、参数校验与解析器：

| 字段              | 含义                                                                     |
| ----------------- | ------------------------------------------------------------------------ |
| `name`            | 决策引用的动作名。                                                       |
| `description`     | 在工具 schema 里给模型看的说明。                                         |
| `params`          | 一个 zod 对象 schema；参数在 `resolve` 跑起来之前先过校验。              |
| `requiresModules` | 这些模块必须在场，动作才可用。                                           |
| `fallback`        | 每个注册表里恰好有一个动作是兜底动作，决策无法兑现时由内核替换成它。     |
| `resolve`         | `(call, ctx) => Promise<Effect[]>`；效果一律走解析器，绝不直接写进世界。 |

一条效果是这几种之一：`set`、`inc`、`append`（某一行的某一列），`create`、`delete`（一整行），`envSet`（一个环境键），`setColumn`（一次给很多行写同一列，cohort 走的向量化路径）。每条效果都写明自己的 `cause`，也就是它派生自哪条事件 id，`inspect` 追的就是这条线。下面是 README 里的例子：

```ts
import { defineAction, toEntityId, type Registry } from "@misakaikato/simulacra";
import { z } from "zod";

export const register = (registry: Registry) =>
	registry.actions.register(
		defineAction({
			name: "donate",
			description: "Give part of your balance to another agent.",
			params: z.object({ target: z.string(), amount: z.number().positive() }),
			requiresModules: ["ledger"],
			fallback: false,
			resolve: async (call) => [
				{
					op: "inc",
					entity: "agent",
					id: toEntityId(call.args.target),
					column: "ledger.balance",
					value: call.args.amount,
					cause: call.cause,
				},
				{
					op: "inc",
					entity: "agent",
					id: call.agentId,
					column: "ledger.balance",
					value: -call.args.amount,
					cause: call.cause,
				},
			],
		}),
	);
```

在场景里用 `plugins: ["./ledger.ts"]` 声明这个插件，或者在命令行上传 `--plugin`。模块声明自己拥有哪些列，组件声明自己读什么写什么，内核在装配时把两边都校验一遍。`examples/prisoners_dilemma/rules.ts` 是一个完整的例子：一个自定义模块、两个动作和一个规则提供者。

## 模块 {#modules}

模块拥有若干列，并在每个 tick 里、所有执行体行动完之后，把世界推进一步。

| 成员                    | 含义                                                                                                 |
| ----------------------- | ---------------------------------------------------------------------------------------------------- |
| `name`                  | 实例名；也是它所声明的那些列的 `owner`。                                                             |
| `concurrencySafe`       | 可以安全地放进 `Promise.all` 步进的模块自己标出来，其余按顺序步进。                                  |
| `declare(world)`        | 声明列（`entity`、`name`、`dtype`、`default`、`owner`，合并规则 `last`、`sum`、`max` 或 `append`）。 |
| `actions()`             | 模块贡献的动作。                                                                                     |
| `observe(view, ids, t)` | 模块给每个 agent 看什么；会并进该 agent 的观察。                                                     |
| `step(view, t, rng)`    | 本 tick 结束时要应用的效果。                                                                         |
| `initialize?`           | 在 tick 0 之前跑一次；它的效果属于初始化后的世界，由第一个检查点收下。                               |
| `graph?()`              | 一份 `GraphView`（`neighbors`、`degree`、`edgeCount`），供路由与状态转移使用。                       |
| `getState`、`setState`  | 给检查点用的模块状态；世界状态已经装下一切时返回 `null`。                                            |

模块通过 `WorldView`（`ids`、`count`、`column`、`row`、`env`、`columns`、`hash`）读取，从不直接写；解析器按声明的合并规则应用效果，并拒绝冲突，被拒的计入 `droppedEffects`。

## 提供者 {#providers}

一个决策提供者一次回答一批请求：

| 成员                    | 含义                                                                                              |
| ----------------------- | ------------------------------------------------------------------------------------------------- |
| `decide(requests, ctx)` | 每个请求一条 `Result<Decision, ProviderFailure>`，顺序与请求一致；长度或 agent 对不上，整批失败。 |
| `reset(seedPath)`       | 每次复制重新播种，让组合提供者保持确定性。                                                        |
| `fit?(trace)`           | 可选：从 `(request, decision)` 对里学习，代理模型就是这么做的。                                   |
| `audit?(ctx)`           | 可选：提供者自己的数字，会落进指标里。                                                            |
| `getState`、`setState`  | 给检查点用的提供者状态。                                                                          |

一条 `Decision` 带着 `agentId`、`action`、`args`、`provenance`（`llm`、`surrogate`、`prototype`、`cache`、`rule` 或 `interview`）、`cost` 与 `parseOk`；`parseOk: false` 表示提供者退回了默认动作。请求给出该 agent 的 `state`、`observation`、`actionSpace`、可选的 `features`，对 LLM 执行体还给出渲染好的 `prompt`。

多数插件用不着手写这个接口。`createRuleProvider({ name, seed, rule })` 把一个 `(request, rng) => Decision` 函数包起来，配上按 agent 派生的 rng——由场景 seed、本轮的 seed 路径与 agent id 派生，因此一个 agent 的随机流不受批次顺序影响；规则抛异常只是这个 agent 的失败，不是崩溃。`examples/prisoners_dilemma/rules.ts` 就是这样在同一个 kind `pdRule` 下注册了四种对手策略，再按 `options.strategy` 选一种。

## 激活策略 {#activation-policies}

策略只凭世界状态和本 tick 的 rng 选出谁行动，所以激活是可复现的：

```ts
interface ActivationPolicy {
	readonly name: string;
	select(world: WorldView, t: LogicalTime, rng: Rng): Activation;
}
```

`Activation.agents` 把 agent id 映射到模式（`llm`、`rule`、`manual` 或 `interview`）；`manualCalls` 可以为以 manual 模式激活的 agent 直接给出动作调用，内核不经观察与决策就派发它们。

## 指标 {#metrics}

```ts
interface Metric {
	readonly name: string;
	compute(view: WorldView, log: EventLog, runId: RunId): number | readonly number[];
}
```

把指标注册到 `registry.metrics` 的某个 kind 下；场景随后在 `instruments` 里列出它并给一个 `every` 间隔，每次算出的值都会变成一条 measurement 事件，以及 `result.json` 里的一个键。指标可以用类型化的 `query` 过滤器查事件日志，也可以对 `events` 表写自由 SQL。

## 适配器 {#adapters}

适配器把外部的模拟纳入同一套审计 harness：

```ts
interface Adapter {
	readonly name: string;
	toScenario(external: JsonValue): Result<Scenario, string>;
	run: RunFn; // (scenario, seed, outDir) => Promise<RunResult>
}
```

内置的 `script` 适配器启动一个子进程，这个子进程接受 `--config`、`--seed` 与 `--out` 并写出 `result.json`；`oasis` 适配器把一个 OASIS SQLite 数据库导入成运行目录（也可以用 `simulacra import-oasis`）。两者都在 `src/adapters/`。

## 一个完整的代码内插件 {#a-complete-plugin-in-code}

`examples/programmatic/02-custom-plugin.ts` 定义了一个模块、两个动作和一个规则提供者，注册之后运行一个由 YAML 字符串构建的场景，磁盘上不落任何文件。测试套件会执行它。

<<< ../../../examples/programmatic/02-custom-plugin.ts

想看从场景文件加载的插件，读 [`examples/prisoners_dilemma/rules.ts`](https://github.com/misakaikato/simulacra/blob/main/examples/prisoners_dilemma/rules.ts)：一个在 `step` 里配对 agent 并结算收益的模块，`cooperate` 与 `defect` 两个动作（`defect` 是兜底动作），以及一个带四种策略的规则提供者。
