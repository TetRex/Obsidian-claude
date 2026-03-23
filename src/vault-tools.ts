import { App, Notice, TFile, TFolder } from "obsidian";
import type { ToolDefinition } from "./claude-client";

export const VAULT_TOOLS: ToolDefinition[] = [
	{
		name: "list_files",
		description:
			"List all files in a folder. Returns file paths. Use '/' for vault root.",
		input_schema: {
			type: "object",
			properties: {
				folder: {
					type: "string",
					description: "Folder path relative to vault root, e.g. '/' or 'Notes/Daily'",
				},
			},
			required: ["folder"],
		},
	},
	{
		name: "read_note",
		description: "Read the full content of a note by its path.",
		input_schema: {
			type: "object",
			properties: {
				path: {
					type: "string",
					description: "File path relative to vault root, e.g. 'Notes/My Note.md'",
				},
			},
			required: ["path"],
		},
	},
	{
		name: "create_note",
		description: "Create a new note with the given content. Fails if the file already exists.",
		input_schema: {
			type: "object",
			properties: {
				path: {
					type: "string",
					description: "File path for the new note, e.g. 'Notes/New Note.md'",
				},
				content: {
					type: "string",
					description: "Markdown content for the note",
				},
			},
			required: ["path", "content"],
		},
	},
	{
		name: "update_note",
		description: "Replace the entire content of an existing note.",
		input_schema: {
			type: "object",
			properties: {
				path: {
					type: "string",
					description: "File path of the note to update",
				},
				content: {
					type: "string",
					description: "New markdown content",
				},
			},
			required: ["path", "content"],
		},
	},
	{
		name: "search_notes",
		description:
			"Search notes by content. Returns matching file paths and a snippet of the matching line.",
		input_schema: {
			type: "object",
			properties: {
				query: {
					type: "string",
					description: "Text to search for (case-insensitive)",
				},
				max_results: {
					type: "number",
					description: "Maximum number of results to return (default 10)",
				},
			},
			required: ["query"],
		},
	},
	{
		name: "get_vault_structure",
		description:
			"Get the folder structure of the vault as a tree. Does not include file contents.",
		input_schema: {
			type: "object",
			properties: {
				max_depth: {
					type: "number",
					description: "Maximum folder depth to traverse (default 3)",
				},
			},
		},
	},
];

export function createToolExecutor(app: App): (name: string, input: Record<string, unknown>) => Promise<string> {
	return async (name: string, input: Record<string, unknown>): Promise<string> => {
		switch (name) {
			case "list_files":
				return listFiles(app, input.folder as string);
			case "read_note":
				return readNote(app, input.path as string);
			case "create_note": {
				const result = await createNote(app, input.path as string, input.content as string);
				new Notice(`Claude created: ${input.path}`);
				return result;
			}
			case "update_note": {
				const result = await updateNote(app, input.path as string, input.content as string);
				new Notice(`Claude updated: ${input.path}`);
				return result;
			}
			case "search_notes":
				return searchNotes(app, input.query as string, (input.max_results as number) || 10);
			case "get_vault_structure":
				return getVaultStructure(app, (input.max_depth as number) || 3);
			default:
				throw new Error(`Unknown tool: ${name}`);
		}
	};
}

async function listFiles(app: App, folder: string): Promise<string> {
	const normalizedPath = folder === "/" ? "" : folder.replace(/^\//, "").replace(/\/$/, "");
	const abstractFile = normalizedPath === "" ? app.vault.getRoot() : app.vault.getAbstractFileByPath(normalizedPath);

	if (!abstractFile || !(abstractFile instanceof TFolder)) {
		return `Error: Folder not found: ${folder}`;
	}

	const files = abstractFile.children
		.map((f) => f.path)
		.sort();

	return files.length > 0 ? files.join("\n") : "(empty folder)";
}

async function readNote(app: App, path: string): Promise<string> {
	const file = app.vault.getAbstractFileByPath(path);
	if (!file || !(file instanceof TFile)) {
		return `Error: File not found: ${path}`;
	}
	const content = await app.vault.read(file);
	const MAX_CHARS = 20000;
	return content.length > MAX_CHARS
		? content.slice(0, MAX_CHARS) + "\n\n[…file truncated for token efficiency]"
		: content;
}

async function createNote(app: App, path: string, content: string): Promise<string> {
	const existing = app.vault.getAbstractFileByPath(path);
	if (existing) {
		return `Error: File already exists: ${path}`;
	}

	// Ensure parent folder exists
	const parentPath = path.substring(0, path.lastIndexOf("/"));
	if (parentPath) {
		const parent = app.vault.getAbstractFileByPath(parentPath);
		if (!parent) {
			await app.vault.createFolder(parentPath);
		}
	}

	await app.vault.create(path, content);
	return `Created: ${path}`;
}

async function updateNote(app: App, path: string, content: string): Promise<string> {
	const file = app.vault.getAbstractFileByPath(path);
	if (!file || !(file instanceof TFile)) {
		return `Error: File not found: ${path}`;
	}
	await app.vault.modify(file, content);
	return `Updated: ${path}`;
}

async function searchNotes(app: App, query: string, maxResults: number): Promise<string> {
	const files = app.vault.getMarkdownFiles();
	const results: string[] = [];
	const lowerQuery = query.toLowerCase();

	for (const file of files) {
		if (results.length >= maxResults) break;
		const content = await app.vault.cachedRead(file);
		const lines = content.split("\n");
		for (let i = 0; i < lines.length; i++) {
			if (lines[i].toLowerCase().includes(lowerQuery)) {
				const snippet = lines[i].trim().substring(0, 150);
				results.push(`${file.path}:${i + 1}: ${snippet}`);
				break; // One match per file
			}
		}
	}

	return results.length > 0 ? results.join("\n") : "No matches found.";
}

function getVaultStructure(app: App, maxDepth: number): string {
	const lines: string[] = [];

	function walk(folder: TFolder, depth: number, prefix: string) {
		if (depth > maxDepth) return;
		const children = [...folder.children].sort((a, b) =>
			a.name.localeCompare(b.name)
		);
		for (const child of children) {
			if (child instanceof TFolder) {
				lines.push(`${prefix}${child.name}/`);
				walk(child, depth + 1, prefix + "  ");
			} else {
				lines.push(`${prefix}${child.name}`);
			}
		}
	}

	walk(app.vault.getRoot(), 0, "");
	return lines.length > 0 ? lines.join("\n") : "(empty vault)";
}
