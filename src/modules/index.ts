// Registration entry and public surface of the built-in world modules; column-name constants
// are re-exported here so other plugin layers can reference tables without importing modules.
// 内置世界模块的注册入口与公开出口；列名常量在此再导出，
// 其它插件层引用表时无需引入模块本身。

import type { DuplicatePlugin, Module, PluginFactory, Registry } from "../core/protocols";
import { ok } from "../core/result";
import type { Result } from "../core/types";
import { CALENDAR_KIND, createCalendarModule } from "./calendar";
import { FEED_KIND, createFeedModule } from "./feed";
import { SOCIAL_GRAPH_KIND, createSocialGraphModule } from "./socialGraph";

export {
	CALENDAR_KEY,
	CALENDAR_KIND,
	CalendarOptionsSchema,
	createCalendarModule,
} from "./calendar";
export {
	FEED_KIND,
	FeedOptionsSchema,
	POST_COLUMNS,
	POST_ENTITY,
	REC_COLUMNS,
	REC_ENTITY,
	createFeedModule,
	feedItemsOf,
	type FeedItem,
} from "./feed";
export { hasPostTable, postsOf, type PostView } from "./posts";
export {
	RECOMMENDER_KINDS,
	createRecommender,
	followingFirstRecommender,
	homophilyRecommender,
	randomRecommender,
	recencyRecommender,
	type RecommenderKind,
} from "./recommenders";
export {
	EDGE_COLUMNS,
	EDGE_ENTITY,
	FOLLOW_KIND,
	SOCIAL_GRAPH_KIND,
	SocialGraphOptionsSchema,
	adjacencyOf,
	assignHubs,
	createSocialGraphModule,
	edgeListOf,
	graphViewOf,
	homophilyOf,
	powerlawEdges,
	randomEdges,
	rewireToBand,
	stanceVectorOf,
	type HubAssignment,
	type IndexEdge,
} from "./socialGraph";

export const registerBuiltinModules = (registry: Registry): Result<void, DuplicatePlugin> => {
	const factories: readonly (readonly [string, PluginFactory<Module>])[] = [
		[SOCIAL_GRAPH_KIND, createSocialGraphModule],
		[FEED_KIND, (spec, ctx) => createFeedModule(spec, ctx)],
		[CALENDAR_KIND, createCalendarModule],
	];
	for (const [kind, factory] of factories) {
		const registered = registry.modules.register(kind, factory);
		if (!registered.ok) return registered;
	}
	return ok(undefined);
};
