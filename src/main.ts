import {
  App,
  ButtonComponent,
  ItemView,
  MarkdownRenderer,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TextComponent,
  ViewStateResult,
  WorkspaceLeaf
} from "obsidian";
import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const VIEW_TYPE_EXPLORER = "gitkb-viewer-explorer";
const VIEW_TYPE_DOCUMENT = "gitkb-viewer-document";

interface GitKbViewerSettings {
  gitKbPath: string;
  kbRoot: string;
  refreshIntervalSeconds: number;
}

const DEFAULT_SETTINGS: GitKbViewerSettings = {
  gitKbPath: "git-kb",
  kbRoot: "",
  refreshIntervalSeconds: 0
};

interface GitKbListDocument {
  slug: string;
  title?: string | null;
  type?: string | null;
  status?: string | null;
  priority?: string | null;
  tags?: string[] | null;
  modified_at?: string | null;
}

interface GitKbDocument extends GitKbListDocument {
  content: string;
  id?: string | null;
  created_at?: string | null;
}

interface GitKbShowResponse {
  count?: number;
  documents?: GitKbDocument[];
  not_found?: string[];
}

type GitKbJson = unknown;

class GitKbReadonlyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitKbReadonlyError";
  }
}

class GitKbClient {
  constructor(private readonly getSettings: () => GitKbViewerSettings) {}

  async version(): Promise<string> {
    const stdout = await this.run(["--version"]);
    return stdout.trim();
  }

  async list(): Promise<GitKbListDocument[]> {
    return extractDocuments(await this.runJson(["list", "--json"]));
  }

  async search(query: string): Promise<GitKbListDocument[]> {
    const cleanQuery = query.trim();
    if (!cleanQuery) {
      return [];
    }
    this.rejectFlagLikeValue(cleanQuery, "search query");
    return extractDocuments(await this.runJson(["search", cleanQuery, "--json"]));
  }

  async show(slug: string): Promise<GitKbDocument> {
    const cleanSlug = normalizeSlug(slug);
    this.rejectFlagLikeValue(cleanSlug, "slug");
    const response = (await this.runJson(["show", cleanSlug, "--json"])) as GitKbShowResponse;
    const doc = response.documents?.[0];
    if (!doc) {
      throw new GitKbReadonlyError(`GitKB document not found: ${cleanSlug}`);
    }
    return doc;
  }

  async board(): Promise<GitKbJson> {
    return this.runJson(["board", "--json"]);
  }

  async graph(slug: string): Promise<GitKbJson> {
    const cleanSlug = normalizeSlug(slug);
    this.rejectFlagLikeValue(cleanSlug, "slug");
    return this.runJson(["graph", cleanSlug, "--json"]);
  }

  private rejectFlagLikeValue(value: string, label: string): void {
    if (value.startsWith("-")) {
      throw new GitKbReadonlyError(`Refusing ${label} that starts with "-": ${value}`);
    }
  }

  private async runJson(args: string[]): Promise<GitKbJson> {
    const stdout = await this.run(args);
    try {
      return JSON.parse(stdout) as GitKbJson;
    } catch (error) {
      throw new GitKbReadonlyError(
        `git-kb returned invalid JSON for: ${args.join(" ")}\n${String(error)}`
      );
    }
  }

  private async run(args: string[]): Promise<string> {
    assertAllowedGitKbArgs(args);

    const settings = this.getSettings();
    if (!settings.gitKbPath.trim()) {
      throw new GitKbReadonlyError("Configure a git-kb binary path first.");
    }
    if (!settings.kbRoot.trim()) {
      throw new GitKbReadonlyError("Configure a GitKB root path first.");
    }

    await this.ensureDirectory(settings.kbRoot);

    try {
      const { stdout } = await execFileAsync(settings.gitKbPath, args, {
        cwd: settings.kbRoot,
        env: {
          ...process.env,
          GITKB_ROOT: settings.kbRoot
        },
        maxBuffer: 1024 * 1024 * 50,
        timeout: 30_000
      });
      return stdout;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new GitKbReadonlyError(
        `Failed to run read-only GitKB command:\n${settings.gitKbPath} ${args.join(" ")}\n\n${message}`
      );
    }
  }

  private async ensureDirectory(path: string): Promise<void> {
    try {
      const info = await stat(path);
      if (!info.isDirectory()) {
        throw new GitKbReadonlyError(`GitKB root is not a directory: ${path}`);
      }
    } catch (error) {
      if (error instanceof GitKbReadonlyError) {
        throw error;
      }
      throw new GitKbReadonlyError(`GitKB root does not exist or is not readable: ${path}`);
    }
  }
}

function assertAllowedGitKbArgs(args: string[]): void {
  const [command, ...rest] = args;
  const ok =
    (command === "--version" && rest.length === 0) ||
    (command === "list" && rest.length === 1 && rest[0] === "--json") ||
    (command === "board" && rest.length === 1 && rest[0] === "--json") ||
    (command === "show" && rest.length === 2 && rest[1] === "--json") ||
    (command === "search" && rest.length === 2 && rest[1] === "--json") ||
    (command === "graph" && rest.length === 2 && rest[1] === "--json");

  if (!ok) {
    throw new GitKbReadonlyError(`Blocked non-readonly or unsupported git-kb command: ${args.join(" ")}`);
  }
}

function normalizeSlug(slug: string): string {
  return slug.trim().replace(/\.md$/i, "");
}

function extractDocuments(json: GitKbJson): GitKbListDocument[] {
  if (Array.isArray(json)) {
    return json.filter(isDocumentLike);
  }

  if (!json || typeof json !== "object") {
    return [];
  }

  const record = json as Record<string, unknown>;
  if (Array.isArray(record.documents)) {
    return record.documents.filter(isDocumentLike);
  }
  if (Array.isArray(record.results)) {
    return record.results
      .map((result) => {
        if (isDocumentLike(result)) {
          return result;
        }
        if (result && typeof result === "object") {
          const resultRecord = result as Record<string, unknown>;
          if (isDocumentLike(resultRecord.document)) {
            return resultRecord.document;
          }
        }
        return null;
      })
      .filter((result): result is GitKbListDocument => result !== null);
  }

  return [];
}

function isDocumentLike(value: unknown): value is GitKbListDocument {
  return Boolean(value && typeof value === "object" && typeof (value as { slug?: unknown }).slug === "string");
}

function groupByType(documents: GitKbListDocument[]): Map<string, GitKbListDocument[]> {
  const grouped = new Map<string, GitKbListDocument[]>();
  for (const doc of documents) {
    const type = doc.type || "document";
    const group = grouped.get(type) ?? [];
    group.push(doc);
    grouped.set(type, group);
  }
  return new Map(
    [...grouped.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([type, docs]) => [
        type,
        docs.sort((a, b) => a.slug.localeCompare(b.slug))
      ])
  );
}

function formatDocMeta(doc: GitKbListDocument): string {
  const parts = [doc.slug, doc.status, doc.priority].filter(Boolean);
  return parts.join(" · ");
}

async function copyText(text: string, label: string): Promise<void> {
  await navigator.clipboard.writeText(text);
  new Notice(`Copied ${label}`);
}

function renderError(container: HTMLElement, error: unknown): void {
  container.empty();
  const errorEl = container.createDiv({ cls: "gitkb-viewer-error" });
  errorEl.setText(error instanceof Error ? error.message : String(error));
}

function renderLoading(container: HTMLElement, message = "Loading GitKB..."): void {
  container.empty();
  container.createDiv({ cls: "gitkb-viewer-loading", text: message });
}

export default class GitKbViewerPlugin extends Plugin {
  settings: GitKbViewerSettings = DEFAULT_SETTINGS;
  client = new GitKbClient(() => this.settings);

  async onload(): Promise<void> {
    await this.loadSettings();

    this.registerView(
      VIEW_TYPE_EXPLORER,
      (leaf) => new GitKbExplorerView(leaf, this)
    );
    this.registerView(
      VIEW_TYPE_DOCUMENT,
      (leaf) => new GitKbDocumentView(leaf, this)
    );

    this.addRibbonIcon("book-open", "Open GitKB Explorer", () => {
      void this.openExplorer();
    });

    this.addCommand({
      id: "open-gitkb-explorer",
      name: "Open GitKB Explorer",
      callback: () => {
        void this.openExplorer();
      }
    });

    this.addCommand({
      id: "open-gitkb-document-by-slug",
      name: "Open GitKB document by slug",
      callback: () => {
        new TextPromptModal(this.app, "Open GitKB document", "tasks/harmony-123", (slug) => {
          if (slug) {
            void this.openDocument(slug);
          }
        }).open();
      }
    });

    this.addCommand({
      id: "search-gitkb",
      name: "Search GitKB",
      callback: () => {
        new TextPromptModal(this.app, "Search GitKB", "auth timeout", (query) => {
          if (query) {
            void this.openExplorer(query);
          }
        }).open();
      }
    });

    this.addSettingTab(new GitKbViewerSettingTab(this.app, this));
  }

  onunload(): void {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_EXPLORER);
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_DOCUMENT);
  }

  async openExplorer(initialSearch = ""): Promise<void> {
    const leaf = this.app.workspace.getLeaf(false);
    await leaf.setViewState({
      type: VIEW_TYPE_EXPLORER,
      active: true,
      state: { initialSearch }
    });
    this.app.workspace.revealLeaf(leaf);
  }

  async openDocument(slug: string): Promise<void> {
    const cleanSlug = normalizeSlug(slug);
    if (!cleanSlug) {
      return;
    }

    const leaf = this.app.workspace.getLeaf("tab");
    await leaf.setViewState({
      type: VIEW_TYPE_DOCUMENT,
      active: true,
      state: { slug: cleanSlug }
    });
    this.app.workspace.revealLeaf(leaf);
  }

  async loadSettings(): Promise<void> {
    this.settings = {
      ...DEFAULT_SETTINGS,
      ...(await this.loadData())
    };
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}

class GitKbExplorerView extends ItemView {
  private initialSearch = "";
  private listEl: HTMLElement | null = null;
  private searchInput: TextComponent | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly plugin: GitKbViewerPlugin
  ) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE_EXPLORER;
  }

  getDisplayText(): string {
    return "GitKB Explorer";
  }

  getIcon(): string {
    return "book-open";
  }

  async setState(state: unknown, result: ViewStateResult): Promise<void> {
    await super.setState(state, result);
    if (state && typeof state === "object") {
      const maybeSearch = (state as { initialSearch?: unknown }).initialSearch;
      this.initialSearch = typeof maybeSearch === "string" ? maybeSearch : "";
    }
    await this.render();
  }

  getState(): Record<string, string> {
    return { initialSearch: this.searchInput?.getValue() ?? this.initialSearch };
  }

  async onOpen(): Promise<void> {
    await this.render();
    this.registerAutoRefresh();
  }

  private registerAutoRefresh(): void {
    const seconds = this.plugin.settings.refreshIntervalSeconds;
    if (seconds > 0) {
      this.registerInterval(
        window.setInterval(() => {
          void this.refresh();
        }, seconds * 1000)
      );
    }
  }

  private async render(): Promise<void> {
    this.contentEl.empty();
    const root = this.contentEl.createDiv({ cls: "gitkb-viewer-root" });

    const toolbar = root.createDiv({ cls: "gitkb-viewer-toolbar" });
    new ButtonComponent(toolbar)
      .setButtonText("Refresh")
      .setIcon("refresh-cw")
      .onClick(() => {
        void this.refresh();
      });
    new ButtonComponent(toolbar)
      .setButtonText("Settings")
      .setIcon("settings")
      .onClick(() => {
        // Obsidian does not expose a stable direct-open settings API for plugin tabs.
        new Notice("Open Settings > Community plugins > GitKB Viewer to configure paths.");
      });

    const searchRow = root.createDiv({ cls: "gitkb-viewer-search" });
    this.searchInput = new TextComponent(searchRow)
      .setPlaceholder("Search GitKB")
      .setValue(this.initialSearch);
    new ButtonComponent(searchRow)
      .setButtonText("Search")
      .setIcon("search")
      .onClick(() => {
        void this.refresh();
      });

    this.listEl = root.createDiv({ cls: "gitkb-viewer-list" });
    await this.refresh();
  }

  private async refresh(): Promise<void> {
    if (!this.listEl) {
      return;
    }

    renderLoading(this.listEl);
    try {
      const query = this.searchInput?.getValue().trim() ?? "";
      const docs = query
        ? await this.plugin.client.search(query)
        : await this.plugin.client.list();
      this.renderDocuments(docs, query);
    } catch (error) {
      renderError(this.listEl, error);
    }
  }

  private renderDocuments(documents: GitKbListDocument[], query: string): void {
    if (!this.listEl) {
      return;
    }

    this.listEl.empty();
    if (documents.length === 0) {
      this.listEl.createDiv({
        cls: "gitkb-viewer-empty",
        text: query ? `No GitKB results for "${query}".` : "No GitKB documents found."
      });
      return;
    }

    const summary = this.listEl.createDiv({ cls: "gitkb-viewer-doc-meta" });
    summary.setText(query ? `${documents.length} search result(s)` : `${documents.length} document(s)`);

    for (const [type, docs] of groupByType(documents)) {
      const groupEl = this.listEl.createDiv({ cls: "gitkb-viewer-group" });
      groupEl.createDiv({ cls: "gitkb-viewer-group-title", text: `${type} (${docs.length})` });

      for (const doc of docs) {
        const row = groupEl.createDiv({ cls: "gitkb-viewer-doc-row" });
        row.createDiv({
          cls: "gitkb-viewer-doc-title",
          text: doc.title || doc.slug
        });
        row.createDiv({
          cls: "gitkb-viewer-doc-meta",
          text: formatDocMeta(doc)
        });
        row.addEventListener("click", () => {
          void this.plugin.openDocument(doc.slug);
        });
      }
    }
  }
}

class GitKbDocumentView extends ItemView {
  private slug = "";
  private rawMarkdown = "";
  private markdownEl: HTMLElement | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly plugin: GitKbViewerPlugin
  ) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE_DOCUMENT;
  }

  getDisplayText(): string {
    return this.slug ? `GitKB: ${this.slug}` : "GitKB Document";
  }

  getIcon(): string {
    return "file-text";
  }

  getState(): Record<string, string> {
    return { slug: this.slug };
  }

  async setState(state: unknown, result: ViewStateResult): Promise<void> {
    await super.setState(state, result);
    if (state && typeof state === "object") {
      const maybeSlug = (state as { slug?: unknown }).slug;
      this.slug = typeof maybeSlug === "string" ? normalizeSlug(maybeSlug) : "";
    }
    await this.render();
  }

  async onOpen(): Promise<void> {
    await this.render();
    this.registerAutoRefresh();
  }

  private registerAutoRefresh(): void {
    const seconds = this.plugin.settings.refreshIntervalSeconds;
    if (seconds > 0) {
      this.registerInterval(
        window.setInterval(() => {
          void this.refresh();
        }, seconds * 1000)
      );
    }
  }

  private async render(): Promise<void> {
    this.contentEl.empty();
    const root = this.contentEl.createDiv({ cls: "gitkb-viewer-document" });

    if (!this.slug) {
      root.createDiv({
        cls: "gitkb-viewer-empty",
        text: "Open a GitKB document from the explorer or command palette."
      });
      return;
    }

    const header = root.createDiv({ cls: "gitkb-viewer-doc-header" });
    const titleEl = header.createDiv({ cls: "gitkb-viewer-doc-heading", text: this.slug });
    const metaEl = header.createDiv({ cls: "gitkb-viewer-doc-meta" });
    const actions = header.createDiv({ cls: "gitkb-viewer-doc-actions" });

    new ButtonComponent(actions)
      .setButtonText("Refresh")
      .setIcon("refresh-cw")
      .onClick(() => {
        void this.refresh();
      });
    new ButtonComponent(actions)
      .setButtonText("Copy slug")
      .setIcon("copy")
      .onClick(() => {
        void copyText(this.slug, "slug");
      });
    new ButtonComponent(actions)
      .setButtonText("Copy wikilink")
      .setIcon("brackets")
      .onClick(() => {
        void copyText(`[[${this.slug}]]`, "wikilink");
      });
    new ButtonComponent(actions)
      .setButtonText("Copy markdown")
      .setIcon("clipboard-copy")
      .onClick(() => {
        void copyText(this.rawMarkdown, "raw markdown");
      });

    this.markdownEl = root.createDiv({ cls: "gitkb-viewer-markdown" });
    renderLoading(this.markdownEl, "Loading document...");

    await this.loadDocument(titleEl, metaEl);
  }

  private async refresh(): Promise<void> {
    if (!this.markdownEl || !this.slug) {
      return;
    }
    renderLoading(this.markdownEl, "Refreshing document...");
    const header = this.contentEl.querySelector(".gitkb-viewer-doc-header");
    const titleEl = header?.querySelector(".gitkb-viewer-doc-heading") as HTMLElement | null;
    const metaEl = header?.querySelector(".gitkb-viewer-doc-meta") as HTMLElement | null;
    if (titleEl && metaEl) {
      await this.loadDocument(titleEl, metaEl);
    }
  }

  private async loadDocument(titleEl: HTMLElement, metaEl: HTMLElement): Promise<void> {
    if (!this.markdownEl) {
      return;
    }

    try {
      const doc = await this.plugin.client.show(this.slug);
      this.rawMarkdown = doc.content;
      titleEl.setText(doc.title || doc.slug);
      this.renderMetadata(metaEl, doc);

      this.markdownEl.empty();
      await MarkdownRenderer.render(
        this.app,
        doc.content,
        this.markdownEl,
        `gitkb/${doc.slug}.md`,
        this
      );
      this.interceptGitKbLinks(this.markdownEl);
    } catch (error) {
      this.rawMarkdown = "";
      renderError(this.markdownEl, error);
    }
  }

  private renderMetadata(container: HTMLElement, doc: GitKbDocument): void {
    container.empty();
    const values = [
      doc.type,
      doc.status,
      doc.priority,
      doc.modified_at ? `modified ${doc.modified_at}` : null
    ].filter((value): value is string => Boolean(value));

    if (values.length === 0) {
      container.setText(doc.slug);
      return;
    }

    for (const value of values) {
      container.createSpan({ cls: "gitkb-viewer-pill", text: value });
    }
    container.createSpan({ text: doc.slug });
  }

  private interceptGitKbLinks(container: HTMLElement): void {
    container.addEventListener(
      "click",
      (event) => {
        const target = event.target as HTMLElement | null;
        const link = target?.closest("a.internal-link") as HTMLAnchorElement | null;
        if (!link) {
          return;
        }

        const href = link.getAttribute("data-href") || link.getAttribute("href") || "";
        const slug = normalizeSlug(href);
        if (!slug) {
          return;
        }

        event.preventDefault();
        event.stopImmediatePropagation();
        void this.plugin.openDocument(slug);
      },
      { capture: true }
    );
  }
}

class TextPromptModal extends Modal {
  constructor(
    app: App,
    private readonly title: string,
    private readonly placeholder: string,
    private readonly onSubmit: (value: string) => void
  ) {
    super(app);
  }

  onOpen(): void {
    this.contentEl.empty();
    this.titleEl.setText(this.title);

    let input: TextComponent;
    new Setting(this.contentEl)
      .setName(this.title)
      .addText((text) => {
        input = text;
        text.setPlaceholder(this.placeholder);
        text.inputEl.addEventListener("keydown", (event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            this.close();
            this.onSubmit(text.getValue().trim());
          }
        });
      });

    new Setting(this.contentEl)
      .addButton((button) => {
        button
          .setButtonText("Open")
          .setCta()
          .onClick(() => {
            this.close();
            this.onSubmit(input.getValue().trim());
          });
      });
  }
}

class GitKbViewerSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly plugin: GitKbViewerPlugin
  ) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "GitKB Viewer" });

    new Setting(containerEl)
      .setName("git-kb binary path")
      .setDesc("Defaults to git-kb. Use an absolute path if Obsidian cannot find it.")
      .addText((text) =>
        text
          .setPlaceholder("git-kb")
          .setValue(this.plugin.settings.gitKbPath)
          .onChange(async (value) => {
            this.plugin.settings.gitKbPath = value.trim() || "git-kb";
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("GitKB root path")
      .setDesc("Absolute path to the project containing the GitKB instance. Passed as GITKB_ROOT.")
      .addText((text) =>
        text
          .setPlaceholder("/Users/you/project")
          .setValue(this.plugin.settings.kbRoot)
          .onChange(async (value) => {
            this.plugin.settings.kbRoot = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Refresh interval")
      .setDesc("Optional auto-refresh interval in seconds. Set to 0 to disable.")
      .addText((text) =>
        text
          .setPlaceholder("0")
          .setValue(String(this.plugin.settings.refreshIntervalSeconds))
          .onChange(async (value) => {
            const parsed = Number.parseInt(value.trim(), 10);
            this.plugin.settings.refreshIntervalSeconds = Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Readonly diagnostics")
      .setDesc("Runs git-kb --version and git-kb list --json using the configured root.")
      .addButton((button) =>
        button
          .setButtonText("Test connection")
          .onClick(async () => {
            try {
              const version = await this.plugin.client.version();
              const docs = await this.plugin.client.list();
              new Notice(`Connected: ${version}; ${docs.length} document(s) visible.`);
            } catch (error) {
              new Notice(error instanceof Error ? error.message : String(error), 8000);
            }
          })
      );
  }
}
