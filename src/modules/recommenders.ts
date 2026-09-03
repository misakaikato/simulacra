// Built-in feed recommenders: each ranks the post table for one user at a time, excluding the
// user's own posts, and the feed module materialises the top k. Ties fall back to recency and
// then to table order so every ranking is deterministic.
// 内置信息流推荐器：逐用户对帖子表排序并剔除本人的帖子，由 feed 模块物化前 k 条。
// 平局先按时间再按表内顺序裁决，排序因此完全确定。

import type { Recommender, Rng, WorldView } from "../core/protocols";
import type { EntityId, LogicalTime, Scalar } from "../core/types";
import { postsOf, type PostView } from "./posts";
import { adjacencyOf } from "./socialGraph";

export const RECOMMENDER_KINDS = ["random", "recency", "followingFirst", "homophily"] as const;
export type RecommenderKind = (typeof RECOMMENDER_KINDS)[number];

export interface RecommenderOptions {
	readonly entity?: string;
	readonly column?: string;
}

const numberOf = (v: Scalar | undefined): number => (typeof v === "number" ? v : 0);

const byRecency = (a: PostView, b: PostView): number => b.t - a.t || b.index - a.index;

const rankWith = (
	name: RecommenderKind,
	order: (
		view: WorldView,
		user: EntityId,
		posts: readonly PostView[],
		rng: Rng,
	) => readonly PostView[],
): Recommender => ({
	name,
	rank: (view, userIds, _t: LogicalTime, rng, k) => {
		const posts = postsOf(view);
		const out: Record<EntityId, readonly EntityId[]> = {};
		for (const user of userIds) {
			const candidates = posts.filter((p) => p.author !== user);
			out[user] = order(view, user, candidates, rng)
				.slice(0, k)
				.map((p) => p.id);
		}
		return out;
	},
});

export const randomRecommender = (): Recommender =>
	rankWith("random", (_view, _user, posts, rng) => rng.shuffle(posts));

export const recencyRecommender = (): Recommender =>
	rankWith("recency", (_view, _user, posts) => [...posts].sort(byRecency));

// followingFirst reads the edge table through adjacencyOf rather than the graph module instance,
// so it works on any world that carries the table, including imported OASIS runs.
// followingFirst 经 adjacencyOf 读 edge 表而不依赖图模块实例，
// 任何带该表的世界（包括导入的 OASIS 运行）都能用。
export const followingFirstRecommender = (): Recommender =>
	rankWith("followingFirst", (view, user, posts) => {
		const following = adjacencyOf(view).out.get(user);
		const sorted = [...posts].sort(byRecency);
		const followed = sorted.filter((p) => following?.has(p.author) === true);
		const rest = sorted.filter((p) => following?.has(p.author) !== true);
		return [...followed, ...rest];
	});

// Homophily ranks by absolute stance distance between reader and author: an algorithmic echo
// chamber that works even when the follow graph is random.
// 同质性推荐按读者与作者的立场绝对距离排序：即使关注图是随机的，也能制造算法回音室。
export const homophilyRecommender = (column: string, entity = "agent"): Recommender =>
	rankWith("homophily", (view, user, posts) => {
		const stance = view.column<Scalar>(entity, column);
		const mine = numberOf(stance.get(user));
		const distance = (p: PostView): number => Math.abs(numberOf(stance.get(p.author)) - mine);
		return [...posts].sort((a, b) => distance(a) - distance(b) || byRecency(a, b));
	});

export const createRecommender = (
	kind: RecommenderKind,
	options: RecommenderOptions = {},
): Recommender => {
	switch (kind) {
		case "random":
			return randomRecommender();
		case "recency":
			return recencyRecommender();
		case "followingFirst":
			return followingFirstRecommender();
		case "homophily":
			return homophilyRecommender(options.column ?? "persona.stance", options.entity);
	}
};
