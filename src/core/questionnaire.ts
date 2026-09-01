import { z } from "zod";
import { makeEvent } from "./events";
import { newEventId } from "./ids";
import type { ActionSummary } from "./prompt";
import type { EventLog, Question, Questionnaire, Rng, WorldView } from "./protocols";
import { QuestionSchema } from "./schema";
import type {
	DecisionRequest,
	EntityId,
	JsonObject,
	JsonValue,
	LogicalTime,
	RunId,
	Scalar,
} from "./types";

export const ANSWER_ACTION = "answer";
export const ANSWERS_ARG = "answers";
export const QUESTIONNAIRE_KEY = "questionnaire";

const QuestionsInObservation = z.object({
	name: z.string(),
	questions: z.array(QuestionSchema),
});

export const questionnaireObservation = (q: Questionnaire): JsonObject => ({
	name: q.name,
	questions: q.questions.map((question) => ({
		id: question.id,
		prompt: question.prompt,
		responseType: question.responseType,
		...(question.choices === undefined ? {} : { choices: [...question.choices] }),
	})),
});

export const toQuestion = (q: z.output<typeof QuestionSchema>): Question => ({
	id: q.id,
	prompt: q.prompt,
	responseType: q.responseType,
	...(q.choices === undefined ? {} : { choices: q.choices }),
});

// Reads the questions back out of a request observation, for providers that answer by rule.
export const questionsOf = (observation: JsonObject): readonly Question[] | undefined => {
	const parsed = QuestionsInObservation.safeParse(observation[QUESTIONNAIRE_KEY]);
	return parsed.success ? parsed.data.questions.map(toQuestion) : undefined;
};

const answerSchemaOf = (question: Question): JsonObject => {
	switch (question.responseType) {
		case "integer":
			return { type: "integer", description: question.prompt };
		case "float":
			return { type: "number", description: question.prompt };
		case "choice":
			return {
				type: "string",
				enum: [...(question.choices ?? [])],
				description: question.prompt,
			};
		case "text":
			return { type: "string", description: question.prompt };
	}
};

export const answersSchema = (q: Questionnaire): JsonObject => {
	const properties: Record<string, JsonValue> = {};
	for (const question of q.questions) properties[question.id] = answerSchemaOf(question);
	return {
		type: "object",
		properties: {
			[ANSWERS_ARG]: {
				type: "object",
				properties,
				required: q.questions.map((question) => question.id),
				additionalProperties: false,
			},
		},
		required: [ANSWERS_ARG],
		additionalProperties: false,
	};
};

export const answerActionSummary = (q: Questionnaire): ActionSummary => ({
	name: ANSWER_ACTION,
	description: `Answer every question of the questionnaire '${q.name}'`,
	schema: answersSchema(q),
});

export const questionnaireInstruction = (q: Questionnaire): string =>
	[
		`You are being interviewed. Answer each question of the questionnaire '${q.name}' as yourself.`,
		...q.questions.map((question) => {
			const format =
				question.responseType === "choice"
					? `one of ${(question.choices ?? []).map((c) => JSON.stringify(c)).join(", ")}`
					: question.responseType === "integer"
						? "an integer"
						: question.responseType === "float"
							? "a number"
							: "free text";
			return `- ${question.id}: ${question.prompt} (${format})`;
		}),
		`Reply with the action "${ANSWER_ACTION}" whose args carry an "${ANSWERS_ARG}" object keyed by question id.`,
	].join("\n");

export interface AnswerIssue {
	readonly questionId: string;
	readonly reason: string;
}

export interface ParsedAnswers {
	readonly answers: Readonly<Record<string, JsonValue>>;
	readonly issues: readonly AnswerIssue[];
}

const numberOf = (raw: JsonValue | undefined): number | undefined => {
	if (typeof raw === "number") return raw;
	if (typeof raw === "string" && raw.trim().length > 0) {
		const n = Number(raw);
		return Number.isFinite(n) ? n : undefined;
	}
	return undefined;
};

type ParsedAnswer =
	| { readonly ok: true; readonly value: JsonValue }
	| { readonly ok: false; readonly issue: AnswerIssue };

const parseAnswer = (question: Question, raw: JsonValue | undefined): ParsedAnswer => {
	const issue = (reason: string): ParsedAnswer => ({
		ok: false,
		issue: { questionId: question.id, reason },
	});
	const value = (v: JsonValue): ParsedAnswer => ({ ok: true, value: v });
	if (raw === undefined || raw === null) return issue("missing answer");
	switch (question.responseType) {
		case "integer": {
			const n = numberOf(raw);
			return n !== undefined && Number.isInteger(n) ? value(n) : issue("expected an integer");
		}
		case "float": {
			const n = numberOf(raw);
			return n !== undefined ? value(n) : issue("expected a number");
		}
		case "choice": {
			const choices = question.choices ?? [];
			return typeof raw === "string" && choices.includes(raw)
				? value(raw)
				: issue(`expected one of ${choices.join(", ")}`);
		}
		case "text":
			return typeof raw === "string" ? value(raw) : issue("expected text");
	}
};

const isObject = (v: JsonValue | undefined): v is JsonObject =>
	typeof v === "object" && v !== null && !Array.isArray(v);

export const parseAnswers = (q: Questionnaire, args: JsonObject): ParsedAnswers => {
	const raw = args[ANSWERS_ARG];
	const answers: Record<string, JsonValue> = {};
	const issues: AnswerIssue[] = [];
	if (!isObject(raw)) {
		return {
			answers,
			issues: q.questions.map((question) => ({
				questionId: question.id,
				reason: `args.${ANSWERS_ARG} is not an object`,
			})),
		};
	}
	for (const question of q.questions) {
		const parsed = parseAnswer(question, raw[question.id]);
		if (parsed.ok) answers[question.id] = parsed.value;
		else issues.push(parsed.issue);
	}
	return { answers, issues };
};

const scalarJson = (v: Scalar): JsonValue => (Array.isArray(v) ? [...v] : v);

// Bare interview requests for executors without their own interview hook: the row is the
// state, the questions are the observation, and there is no rendered prompt.
export const bareInterviewRequests = (
	world: WorldView,
	entity: string,
	ids: readonly EntityId[],
	t: LogicalTime,
	log: EventLog,
	rng: Rng,
	runId: RunId,
	q: Questionnaire,
): readonly DecisionRequest[] => {
	const observation: JsonObject = { [QUESTIONNAIRE_KEY]: questionnaireObservation(q) };
	const contentSha = log.putContent(JSON.stringify(observation));
	return ids.map((agentId) => {
		const eventId = newEventId(rng);
		log.append(
			makeEvent(
				{
					eventId,
					runId,
					t,
					seedPath: rng.path,
					...(q.entersMemory ? { agentId } : {}),
					provenance: "interview",
				},
				{ kind: "observation", payload: { contentSha, refs: [], truncated: false } },
			),
		);
		const row = world.row(entity, agentId);
		const state: Record<string, JsonValue> = {};
		if (row !== undefined) for (const [k, v] of Object.entries(row)) state[k] = scalarJson(v);
		return {
			agentId,
			t,
			state,
			observation,
			observationEvent: eventId,
			actionSpace: [ANSWER_ACTION],
		};
	});
};
