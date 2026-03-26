import type { App } from "obsidian";
import { getVaultStructure } from "./vault-tools";

const INSTRUCTION_FILE = ".instructions.md";

export class VaultInstructions {
	private app: App;
	private cache: Map<string, { content: string; mtime: number }> = new Map();

	constructor(app: App) {
		this.app = app;
	}

	/**
	 * Load and merge .instructions.md files from vault root through every parent
	 * folder of the active file. Global instructions come first, local last.
	 */
	async getInstructions(activeFilePath?: string): Promise<string> {
		const paths = this.getInstructionPaths(activeFilePath);
		const sections: string[] = [];

		for (const path of paths) {
			const content = await this.readCachedInstruction(path);
			if (content !== null) {
				sections.push(content);
			}
		}

		return sections.join("\n\n---\n\n");
	}

	/**
	 * Returns true if at least one .instructions.md exists in the vault.
	 * Uses the filesystem adapter directly so dotfiles are not missed.
	 */
	async hasInstructions(): Promise<boolean> {
		return this.app.vault.adapter.exists(INSTRUCTION_FILE);
	}

	/**
	 * Create a starter .instructions.md at vault root.
	 * Returns false if the file already exists.
	 */
	async createStarterTemplate(): Promise<boolean> {
		if (await this.app.vault.adapter.exists(INSTRUCTION_FILE)) {
			return false;
		}

		const template = `# Claude Instructions

These instructions are automatically loaded by the VaultPensieve plugin on every request.
Edit this file to customise how Claude behaves in your vault.

---

## About this vault
- Purpose: [describe what this vault is for]
- Main topics: [e.g. research, journaling, project management]
- Primary language: [e.g. English]

## Writing style
- Be concise and clear
- Use active voice
- Match the tone already present in the note
- Keep paragraphs short (3–4 sentences max)
- Prefer plain language over jargon

## Formatting rules
- Use Markdown headings (##, ###) to organise content
- Use [[wikilinks]] for internal references, never plain URLs
- Preserve existing YAML frontmatter — do not add or remove keys
- Do not change formatting or structure unless explicitly asked
- Bullet lists for enumerations; numbered lists only for steps

## Behaviour
- When rewriting or improving text, preserve the original meaning
- When summarising, include the key points and any action items
- When continuing text, match the existing style and voice
- If a task is ambiguous, ask a clarifying question before proceeding
- Do not add disclaimers, caveats, or filler phrases like "Certainly!" or "Great question!"

## Vault tools
- You may read and search notes when relevant context is needed
- Always show a summary of changes before creating or modifying files
- Prefer editing existing notes over creating new ones unless asked

## Vault structure map
- A note named ".structure.md" at the vault root is the canonical structure map — it lists every folder and note in the vault as a nested Markdown list
- If ".structure.md" does not exist, create it using get_vault_structure before doing any other work in a new session
- After creating or modifying any note or folder, update ".structure.md" immediately to reflect the change
- Keep the map accurate: add new entries when files are created, remove entries when files are deleted, rename entries when files are moved
- Before creating a new note, consult ".structure.md" to find the most relevant existing folder; only create a new folder if no suitable one exists

## Off-limits
- Do not delete notes or folders unless explicitly instructed
- Do not share or reference content from one note in another without permission
`;

		await this.app.vault.adapter.write(INSTRUCTION_FILE, template);

		await this.updateStructureFile();

		return true;
	}

	async updateStructureFile(): Promise<void> {
		const structure = getVaultStructure(this.app, 100);
		await this.app.vault.adapter.write(".structure.md", structure);
	}

	private getInstructionPaths(activeFilePath?: string): string[] {
		const paths: string[] = [INSTRUCTION_FILE]; // vault root always first

		if (activeFilePath) {
			const parts = activeFilePath.split("/");
			// Remove the filename, keep only folder segments
			parts.pop();
			let current = "";
			for (const part of parts) {
				current = current ? `${current}/${part}` : part;
				const instructionPath = `${current}/${INSTRUCTION_FILE}`;
				if (instructionPath !== INSTRUCTION_FILE) {
					paths.push(instructionPath);
				}
			}
		}

		return paths;
	}

	private async readCachedInstruction(path: string): Promise<string | null> {
		const exists = await this.app.vault.adapter.exists(path);
		if (!exists) {
			this.cache.delete(path);
			return null;
		}

		const stat = await this.app.vault.adapter.stat(path);
		const mtime = stat?.mtime ?? 0;

		const cached = this.cache.get(path);
		if (cached && cached.mtime === mtime) {
			return cached.content;
		}

		const content = await this.app.vault.adapter.read(path);
		this.cache.set(path, { content, mtime });
		return content;
	}
}
