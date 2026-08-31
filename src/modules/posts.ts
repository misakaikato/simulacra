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
