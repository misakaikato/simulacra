// Small presentational building blocks shared by pages and components: error bar, loading and
// empty placeholders, run status and event kind badges.
// 页面与组件共用的小型展示件：错误条、加载与空态占位、运行状态与事件种类徽章。

import type { EventKind } from "../../../src/core/types";
import type { RunStatus } from "../api";

export const ErrorBar = ({ message }: { readonly message: string }) => (
	<div className="error-bar" role="alert">
		{message}
	</div>
);

export const Loading = ({ label = "Loading" }: { readonly label?: string }) => (
	<div className="loading">{label}</div>
);

export const Empty = ({
	label,
	small = false,
}: {
	readonly label: string;
	readonly small?: boolean;
}) => <div className={small ? "empty small" : "empty"}>{label}</div>;

export const StatusBadge = ({ status }: { readonly status: RunStatus }) => (
	<span className={`badge badge-${status}`}>{status}</span>
);

export const KindBadge = ({ kind }: { readonly kind: EventKind }) => (
	<span className={`kind kind-${kind}`}>{kind}</span>
);
