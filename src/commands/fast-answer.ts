import { Notice } from "obsidian";
import type VaultPensievePlugin from "../main";
import type { EditorView } from "@codemirror/view";

const TRIGGER = "::";
const LOADING_MARKER = "> *Thinking...*";

/**
 * Check whether the current line is a `:: question` and, if so,
 * stream an AI answer directly into the note.
 *
 * Returns `true` when it handled the keypress (caller should suppress
 * the default Enter behaviour), `false` otherwise.
 */
export function handleFastAnswer(
	plugin: VaultPensievePlugin,
	view: EditorView
): boolean {
	const state = view.state;
	const head = state.selection.main.head;
	const line = state.doc.lineAt(head);
	const text = line.text;

	if (!text.startsWith(TRIGGER)) return false;

	const question = text.slice(TRIGGER.length).trim();
	if (!question) return false;

	void streamAnswer(plugin, view, line.from, line.to, question);
	return true;
}

async function streamAnswer(
	plugin: VaultPensievePlugin,
	view: EditorView,
	lineFrom: number,
	lineTo: number,
	question: string
): Promise<void> {
	if (plugin.isOverLimit()) {
		new Notice("Monthly spending limit reached.");
		return;
	}

	const systemPrompt = await plugin.buildSystemPrompt();
	const fullSystem =
		systemPrompt +
		"\n\nThe user is asking a quick inline question from inside a note. " +
		"Reply with a concise, direct answer. No preamble, no repeating the question. " +
		"Use markdown formatting where helpful.";

	// Replace the :: line with question + loading placeholder
	const questionLine = `**Q:** ${question}\n`;
	const initial = questionLine + LOADING_MARKER;
	view.dispatch({ changes: { from: lineFrom, to: lineTo, insert: initial } });

	// answerFrom is the fixed position where the answer region starts
	const answerFrom = lineFrom + questionLine.length;
	// Track the current length of text in the answer region
	let currentAnswerLen = LOADING_MARKER.length;
	let fullText = "";

	try {
		const client = plugin.getClient();
		await client.streamMessage(
			fullSystem,
			[{ role: "user", content: question }],
			{
				onChunk: (chunk: string) => {
					fullText += chunk;
					const formatted = formatAnswer(fullText);
					view.dispatch({
						changes: {
							from: answerFrom,
							to: answerFrom + currentAnswerLen,
							insert: formatted,
						},
					});
					currentAnswerLen = formatted.length;
				},
				onComplete: () => {
					// Ensure a trailing newline for clean separation
					const endPos = answerFrom + currentAnswerLen;
					if (endPos < view.state.doc.length) {
						const charAfter = view.state.doc.sliceString(endPos, endPos + 1);
						if (charAfter !== "\n") {
							view.dispatch({ changes: { from: endPos, insert: "\n" } });
						}
					} else {
						view.dispatch({ changes: { from: endPos, insert: "\n" } });
					}
				},
				onError: (error: Error) => {
					new Notice(`Fast answer error: ${error.message}`);
				},
				onUsage: (inputTokens: number, outputTokens: number) => {
					void plugin.recordUsage(inputTokens, outputTokens);
				},
			}
		);
	} catch (e) {
		const msg = e instanceof Error ? e.message : "Unknown error";
		new Notice(`Fast answer error: ${msg}`);
		// Replace loading/partial answer with error
		const errorText = `> *Error: ${msg}*`;
		view.dispatch({
			changes: { from: answerFrom, to: answerFrom + currentAnswerLen, insert: errorText },
		});
	}
}

function formatAnswer(text: string): string {
	return text
		.split("\n")
		.map((l) => `> ${l}`)
		.join("\n");
}
