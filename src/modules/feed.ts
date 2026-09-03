// Feed module: owns the `post` table and the per-user `rec` table, defines post/repost/reply/
// like/silent (silent is the fallback action) and materialises every user's ranked feed once per
// tick in step, so observation is a row lookup rather than a ranking pass.
// 信息流模块：拥有 `post` 表与按用户的 `rec` 表，定义 post/repost/reply/like/silent
// （silent 是兜底动作），每 tick 在 step 里物化所有用户的排序信息流，观察只是查一行而非重排。

import { z } from "zod";
import { ActionRejected, defineAction } from "../core/actions";
import { ZERO_EVENT_ID, toEntityId } from "../core/ids";
import type {
	ActionDef,
	DeclareError,
	Module,
	PluginContext,
	PluginError,
	Recommender,
	Rng,
	World,
	WorldView,
} from "../core/protocols";
import { parseOptions } from "../core/registry";
import { err, ok } from "../core/result";
import type {
	ColumnDecl,
	Effect,
	EntityId,
	JsonValue,
	LogicalTime,
	ModuleSpec,
	Result,
	Scalar,
} from "../core/types";
import { FEED_KIND, POST_COLUMNS, POST_ENTITY } from "./posts";
import { RECOMMENDER_KINDS, createRecommender } from "./recommenders";

export { FEED_KIND, POST_COLUMNS, POST_ENTITY };

export const REC_ENTITY = "rec";
export const REC_COLUMNS = {
	user: `${FEED_KIND}.user`,
	posts: `${FEED_KIND}.posts`,
} as const;

export const FeedOptionsSchema = z.object({
	entity: z.string().min(1).default("agent"),
	size: z.number().int().positive().default(5),
	recommender: z.enum(RECOMMENDER_KINDS).default("recency"),
	column: z.string().min(1).optional(),
});

export type FeedOptions = z.output<typeof FeedOptionsSchema>;

export interface FeedItem {
	readonly id: string;
	readonly author: string;
	readonly content: string;
	readonly likes: number;
	readonly reposts: number;
	readonly t: number;
}

// likes and reposts merge by `sum` so same-tick reactions from many agents accumulate instead of
// the last writer winning; the other columns are set once at creation.
// likes 与 reposts 按 `sum` 合并，同 tick 多个 agent 的互动会累加而不是最后写者胜出；
// 其余列只在创建时写一次。
const POST_DECLS: readonly Omit<ColumnDecl, "entity" | "owner">[] = [
	{ name: "author", dtype: "str", default: "", merge: "last" },
	{ name: "content", dtype: "str", default: "", merge: "last" },
	{ name: "t", dtype: "i32", default: 0, merge: "last" },
	{ name: "likes", dtype: "i32", default: 0, merge: "sum" },
	{ name: "reposts", dtype: "i32", default: 0, merge: "sum" },
	{ name: "parent", dtype: "str", default: "", merge: "last" },
];

const REC_DECLS: readonly Omit<ColumnDecl, "entity" | "owner">[] = [
	{ name: "user", dtype: "str", default: "", merge: "last" },
	{ name: "posts", dtype: "strlist", default: [], merge: "last" },
];

const isStringList = (v: Scalar | undefined): v is readonly string[] =>
	Array.isArray(v) && v.every((x) => typeof x === "string");

const stringOf = (v: Scalar | undefined): string => (typeof v === "string" ? v : "");
const numberOf = (v: Scalar | undefined): number => (typeof v === "number" ? v : 0);

export const feedItemsOf = (view: WorldView, postIds: readonly string[]): readonly FeedItem[] =>
	postIds.flatMap((postId) => {
		const row = view.row(POST_ENTITY, toEntityId(postId));
		if (row === undefined) return [];
		return [
			{
				id: postId,
				author: stringOf(row[POST_COLUMNS.author]),
				content: stringOf(row[POST_COLUMNS.content]),
				likes: numberOf(row[POST_COLUMNS.likes]),
				reposts: numberOf(row[POST_COLUMNS.reposts]),
				t: numberOf(row[POST_COLUMNS.t]),
			},
		];
	});

const postRow = (
	author: EntityId,
	content: string,
	t: LogicalTime,
	parent: string,
): Readonly<Record<string, Scalar>> => ({
	[POST_COLUMNS.author]: author,
	[POST_COLUMNS.content]: content,
	[POST_COLUMNS.t]: t.tick,
	[POST_COLUMNS.likes]: 0,
	[POST_COLUMNS.reposts]: 0,
	[POST_COLUMNS.parent]: parent,
});

const PostParams = z.object({ content: z.string().describe("text of the post") });
const RepostParams = z.object({ postId: z.string().min(1).describe("id of the post to repost") });
const ReplyParams = z.object({
	postId: z.string().min(1).describe("id of the post to reply to"),
	content: z.string().describe("text of the reply"),
});
const LikeParams = z.object({ postId: z.string().min(1).describe("id of the post to like") });
const SilentParams = z.object({});

// concurrencySafe is false so the kernel steps this module after the concurrently stepped ones;
// ranking therefore sees the graph module's refreshed adjacency for this tick.
// concurrencySafe 为 false，内核把本模块排在并发 step 的模块之后；
// 排序因此看到的是图模块本 tick 刷新后的邻接。
class FeedModule implements Module {
	readonly name: string;
	readonly concurrencySafe = false;
	private readonly options: FeedOptions;
	private readonly recommender: Recommender;

	constructor(name: string, options: FeedOptions, recommender: Recommender) {
		this.name = name;
		this.options = options;
		this.recommender = recommender;
	}

	declare(world: World): Result<void, DeclareError> {
		for (const decl of POST_DECLS) {
			const declared = world.declare({ ...decl, entity: POST_ENTITY, owner: FEED_KIND });
			if (!declared.ok) return declared;
		}
		for (const decl of REC_DECLS) {
			const declared = world.declare({ ...decl, entity: REC_ENTITY, owner: FEED_KIND });
			if (!declared.ok) return declared;
		}
		return ok(undefined);
	}

	// A repost is a new post row carrying the original's content and `parent`, plus an inc on the
	// original's counter; reply and like only require the target post to exist.
	// 转发是一条带原帖内容与 `parent` 的新帖行，外加原帖计数器的 inc；回复与点赞只要求目标帖存在。
	actions(): readonly ActionDef[] {
		const requiresModules = [this.name];
		const existing = (view: WorldView, postId: string): Readonly<Record<string, Scalar>> => {
			const row = view.row(POST_ENTITY, toEntityId(postId));
			if (row === undefined) throw new ActionRejected(`unknown post ${postId}`);
			return row;
		};
		return [
			defineAction({
				name: "post",
				description: "Publish a new post to the feed",
				params: PostParams,
				requiresModules,
				fallback: false,
				resolve: async (call, ctx) => [
					{
						op: "create",
						entity: POST_ENTITY,
						id: ctx.newEntityId(),
						row: postRow(call.agentId, call.args.content, ctx.t, ""),
						cause: call.cause,
					},
				],
			}),
			defineAction({
				name: "repost",
				description: "Share an existing post with your followers",
				params: RepostParams,
				requiresModules,
				fallback: false,
				resolve: async (call, ctx) => {
					const original = existing(ctx.world, call.args.postId);
					return [
						{
							op: "create",
							entity: POST_ENTITY,
							id: ctx.newEntityId(),
							row: postRow(
								call.agentId,
								stringOf(original[POST_COLUMNS.content]),
								ctx.t,
								call.args.postId,
							),
							cause: call.cause,
						},
						{
							op: "inc",
							entity: POST_ENTITY,
							id: toEntityId(call.args.postId),
							column: POST_COLUMNS.reposts,
							value: 1,
							cause: call.cause,
						},
					];
				},
			}),
			defineAction({
				name: "reply",
				description: "Reply to an existing post",
				params: ReplyParams,
				requiresModules,
				fallback: false,
				resolve: async (call, ctx) => {
					existing(ctx.world, call.args.postId);
					return [
						{
							op: "create",
							entity: POST_ENTITY,
							id: ctx.newEntityId(),
							row: postRow(call.agentId, call.args.content, ctx.t, call.args.postId),
							cause: call.cause,
						},
					];
				},
			}),
			defineAction({
				name: "like",
				description: "Like an existing post",
				params: LikeParams,
				requiresModules,
				fallback: false,
				resolve: async (call, ctx) => {
					existing(ctx.world, call.args.postId);
					return [
						{
							op: "inc",
							entity: POST_ENTITY,
							id: toEntityId(call.args.postId),
							column: POST_COLUMNS.likes,
							value: 1,
							cause: call.cause,
						},
					];
				},
			}),
			defineAction({
				name: "silent",
				description: "Do nothing this round",
				params: SilentParams,
				requiresModules,
				fallback: true,
				resolve: async () => [],
			}),
		];
	}

	observe(
		view: WorldView,
		ids: readonly EntityId[],
		_t: LogicalTime,
	): Readonly<Record<EntityId, JsonValue>> {
		const out: Record<EntityId, JsonValue> = {};
		for (const id of ids) {
			const posts = view.row(REC_ENTITY, id)?.[REC_COLUMNS.posts];
			const list = isStringList(posts) ? posts.slice(0, this.options.size) : [];
			out[id] = { feed: feedItemsOf(view, list).map((item) => ({ ...item })) };
		}
		return out;
	}

	// The rec row is keyed by the user's own id: created on first sight, overwritten afterwards, so
	// the table never grows beyond the population.
	// rec 行以用户自己的 id 为键：首次出现时创建，之后覆盖，表不会超过人口规模。
	async step(view: WorldView, t: LogicalTime, rng: Rng): Promise<readonly Effect[]> {
		const users = view.ids(this.options.entity);
		const ranked = this.recommender.rank(view, users, t, rng, this.options.size);
		const existing = new Set(view.ids(REC_ENTITY));
		return users.map((user): Effect => {
			const posts = ranked[user] ?? [];
			return existing.has(user)
				? {
						op: "set",
						entity: REC_ENTITY,
						id: user,
						column: REC_COLUMNS.posts,
						value: posts,
						cause: ZERO_EVENT_ID,
					}
				: {
						op: "create",
						entity: REC_ENTITY,
						id: user,
						row: { [REC_COLUMNS.user]: user, [REC_COLUMNS.posts]: posts },
						cause: ZERO_EVENT_ID,
					};
		});
	}

	getState(): JsonValue {
		return null;
	}

	setState(_s: JsonValue): void {}
}

export const createFeedModule = (
	spec: ModuleSpec,
	ctx: PluginContext,
	recommender?: Recommender,
): Result<Module, PluginError> => {
	const options = parseOptions(ctx.registry.modules.slot, spec, FeedOptionsSchema);
	if (!options.ok) return options;
	const o = options.value;
	if (o.recommender === "homophily" && o.column === undefined && recommender === undefined)
		return err({
			reason: "invalid_options",
			slot: ctx.registry.modules.slot,
			kind: spec.kind,
			issues: ["column: required for the homophily recommender"],
		});
	const chosen =
		recommender ??
		createRecommender(o.recommender, {
			entity: o.entity,
			...(o.column === undefined ? {} : { column: o.column }),
		});
	return ok(new FeedModule(spec.name ?? spec.kind, o, chosen));
};
