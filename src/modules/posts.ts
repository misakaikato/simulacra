// Column names and a read-only view of the `post` table, split out of the feed module so
// recommenders, metrics and the OASIS adapter can share them without importing the module.
// `post` 表的列名与只读视图，从 feed 模块拆出来，
// 让推荐器、指标与 OASIS 适配器无需引入模块即可共用。

import { toEntityId } from "../core/ids";
import type { WorldView } from "../core/protocols";
import type { EntityId } from "../core/types";

export const FEED_KIND = "feed";
export const POST_ENTITY = "post";
export const POST_COLUMNS = {
	author: `${FEED_KIND}.author`,
	content: `${FEED_KIND}.content`,
	t: `${FEED_KIND}.t`,
	likes: `${FEED_KIND}.likes`,
	reposts: `${FEED_KIND}.reposts`,
	parent: `${FEED_KIND}.parent`,
} as const;

export interface PostView {
	readonly id: EntityId;
	readonly author: EntityId;
	readonly t: number;
	readonly index: number;
}

export const hasPostTable = (view: WorldView): boolean =>
	view.entities.includes(POST_ENTITY) &&
	view.columns(POST_ENTITY).some((c) => c.name === POST_COLUMNS.author);

// `index` is the row's position in the table and serves as the final tie-breaker in rankings.
// `index` 是行在表中的位置，作为排序时的最终平局裁决。
export const postsOf = (view: WorldView): readonly PostView[] => {
	if (!hasPostTable(view)) return [];
	const ids = view.ids(POST_ENTITY);
	const author = view.column<string>(POST_ENTITY, POST_COLUMNS.author);
	const t = view.column<number>(POST_ENTITY, POST_COLUMNS.t);
	return ids.map((id, index) => ({
		id,
		author: toEntityId(author.at(index)),
		t: t.at(index),
		index,
	}));
};
