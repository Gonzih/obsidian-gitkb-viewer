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
const VIEW_TYPE_GRAPH = "gitkb-viewer-graph";

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
  id?: string | null;
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

interface GitKbGraphNode extends GitKbListDocument {
  id: string;
}

interface GitKbGraphEdge {
  from: string;
  to: string;
  rel_type?: string | null;
  direction?: string | null;
}

interface GitKbGraphResponse {
  root?: string;
  roots?: string[];
  nodes?: GitKbGraphNode[];
  edges?: GitKbGraphEdge[];
}

interface GitKbMergedGraph {
  nodes: GitKbGraphNode[];
  edges: GitKbGraphEdge[];
  documentCount: number;
}

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

  async allGraph(): Promise<GitKbMergedGraph> {
    const documents = await this.list();
    const slugs = documents.map((doc) => doc.slug).filter(Boolean);
    if (slugs.length === 0) {
      return { nodes: [], edges: [], documentCount: 0 };
    }
    for (const slug of slugs) {
      this.rejectFlagLikeValue(slug, "slug");
    }

    try {
      const response = (await this.runJson(["graph", ...slugs, "--json"])) as GitKbGraphResponse;
      return mergeGraphResponses(documents, [response]);
    } catch (error) {
      if (!(error instanceof GitKbReadonlyError) || !error.message.includes("spawn E2BIG")) {
        throw error;
      }
    }

    const responses: GitKbGraphResponse[] = [];
    for (const chunk of chunkArray(slugs, 250)) {
      responses.push((await this.runJson(["graph", ...chunk, "--json"])) as GitKbGraphResponse);
    }

    return mergeGraphResponses(documents, responses);
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
  const graphArgs =
    command === "graph" &&
    rest.length >= 2 &&
    rest[rest.length - 1] === "--json" &&
    rest.slice(0, -1).every((arg) => Boolean(arg.trim()) && !arg.startsWith("-"));
  const ok =
    (command === "--version" && rest.length === 0) ||
    (command === "list" && rest.length === 1 && rest[0] === "--json") ||
    (command === "board" && rest.length === 1 && rest[0] === "--json") ||
    (command === "show" && rest.length === 2 && rest[1] === "--json") ||
    (command === "search" && rest.length === 2 && rest[1] === "--json") ||
    graphArgs;

  if (!ok) {
    throw new GitKbReadonlyError(`Blocked non-readonly or unsupported git-kb command: ${args.join(" ")}`);
  }
}

function normalizeSlug(slug: string): string {
  return slug.trim().replace(/\.md$/i, "");
}

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function mergeGraphResponses(
  documents: GitKbListDocument[],
  responses: GitKbGraphResponse[]
): GitKbMergedGraph {
  const nodes = new Map<string, GitKbGraphNode>();
  const edges = new Map<string, GitKbGraphEdge>();

  for (const doc of documents) {
    const id = doc.id || doc.slug;
    nodes.set(id, { ...doc, id });
  }

  for (const response of responses) {
    for (const node of response.nodes ?? []) {
      nodes.set(node.id, {
        ...nodes.get(node.id),
        ...node
      });
    }

    for (const edge of response.edges ?? []) {
      if (!edge.from || !edge.to || edge.from === edge.to) {
        continue;
      }
      const key = `${edge.from}\u0000${edge.to}\u0000${edge.rel_type || "edge"}`;
      edges.set(key, edge);
    }
  }

  const connectedIds = new Set<string>();
  for (const edge of edges.values()) {
    connectedIds.add(edge.from);
    connectedIds.add(edge.to);
  }

  return {
    nodes: [...nodes.values()].sort((a, b) => a.slug.localeCompare(b.slug)),
    edges: [...edges.values()].filter((edge) => nodes.has(edge.from) && nodes.has(edge.to)),
    documentCount: documents.length
  };
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
    this.registerView(
      VIEW_TYPE_GRAPH,
      (leaf) => new GitKbGraphView(leaf, this)
    );

    this.addRibbonIcon("book-open", "Open GitKB Explorer", () => {
      void this.openExplorer();
    });
    this.addRibbonIcon("network", "Open GitKB Graph", () => {
      void this.openGraph();
    });

    this.addCommand({
      id: "open-gitkb-explorer",
      name: "Open GitKB Explorer",
      callback: () => {
        void this.openExplorer();
      }
    });

    this.addCommand({
      id: "open-gitkb-graph",
      name: "Open GitKB Graph",
      callback: () => {
        void this.openGraph();
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
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_GRAPH);
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

  async openGraph(): Promise<void> {
    const leaf = this.app.workspace.getLeaf("tab");
    await leaf.setViewState({
      type: VIEW_TYPE_GRAPH,
      active: true
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
      .setButtonText("Graph")
      .setIcon("network")
      .onClick(() => {
        void this.plugin.openGraph();
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

interface ForceNode extends GitKbGraphNode {
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  degree: number;
  clusterX: number;
  clusterY: number;
}

interface ForceEdge extends GitKbGraphEdge {
  source: ForceNode;
  target: ForceNode;
}

const SVG_NS = "http://www.w3.org/2000/svg";

class GitKbGraphView extends ItemView {
  private graphRoot: HTMLElement | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private svg: SVGSVGElement | null = null;
  private viewport: SVGGElement | null = null;
  private edgeLayer: SVGGElement | null = null;
  private nodeLayer: SVGGElement | null = null;
  private labelLayer: SVGGElement | null = null;
  private statsEl: HTMLElement | null = null;
  private detailEl: HTMLElement | null = null;
  private searchInput: TextComponent | null = null;
  private animationFrame = 0;
  private nodes: ForceNode[] = [];
  private edges: ForceEdge[] = [];
  private nodeById = new Map<string, ForceNode>();
  private edgeByKey = new Map<string, ForceEdge>();
  private matchedNodeIds = new Set<string>();
  private selectedNode: ForceNode | null = null;
  private hoveredNode: ForceNode | null = null;
  private draggedNode: ForceNode | null = null;
  private panX = 0;
  private panY = 0;
  private scale = 1;
  private pointerStart: { x: number; y: number; panX: number; panY: number } | null = null;
  private ticksRemaining = 0;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly plugin: GitKbViewerPlugin
  ) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE_GRAPH;
  }

  getDisplayText(): string {
    return "GitKB Graph";
  }

  getIcon(): string {
    return "network";
  }

  async onOpen(): Promise<void> {
    await this.render();
  }

  async onClose(): Promise<void> {
    this.stopSimulation();
  }

  private async render(): Promise<void> {
    this.stopSimulation();
    this.contentEl.empty();
    this.graphRoot = this.contentEl.createDiv({ cls: "gitkb-graph-root" });

    const topbar = this.graphRoot.createDiv({ cls: "gitkb-graph-topbar" });
    const title = topbar.createDiv({ cls: "gitkb-graph-title" });
    title.createDiv({ cls: "gitkb-graph-kicker", text: "Readonly GitKB map" });
    title.createDiv({ cls: "gitkb-graph-heading", text: "Knowledge Graph" });

    const controls = topbar.createDiv({ cls: "gitkb-graph-controls" });
    this.searchInput = new TextComponent(controls)
      .setPlaceholder("Filter by slug, title, tag")
      .onChange(() => this.applyFilter());
    new ButtonComponent(controls)
      .setButtonText("Refresh")
      .setIcon("refresh-cw")
      .onClick(() => {
        void this.loadGraph();
      });
    new ButtonComponent(controls)
      .setButtonText("Fit")
      .setIcon("scan")
      .onClick(() => {
        this.fitGraph();
      });

    const body = this.graphRoot.createDiv({ cls: "gitkb-graph-body" });
    const stage = body.createDiv({ cls: "gitkb-graph-stage" });
    this.canvas = document.createElement("canvas");
    this.canvas.addClass("gitkb-graph-canvas");
    stage.appendChild(this.canvas);
    this.ctx = this.canvas.getContext("2d");

    this.registerCanvasEvents();

    const side = body.createDiv({ cls: "gitkb-graph-side" });
    this.statsEl = side.createDiv({ cls: "gitkb-graph-panel" });
    this.detailEl = side.createDiv({ cls: "gitkb-graph-panel" });
    const legend = side.createDiv({ cls: "gitkb-graph-legend" });
    for (const [type, color] of Object.entries(typeColors())) {
      const item = legend.createDiv({ cls: "gitkb-graph-legend-item" });
      item.createSpan({ cls: "gitkb-graph-swatch" }).style.background = color;
      item.createSpan({ text: type });
    }

    await this.loadGraph();
  }

  private async loadGraph(): Promise<void> {
    if (!this.graphRoot || !this.canvas || !this.ctx) {
      return;
    }

    this.stopSimulation();
    this.selectedNode = null;
    this.hoveredNode = null;
    this.matchedNodeIds = new Set();
    if (this.statsEl) {
      renderLoading(this.statsEl, "Loading all GitKB relationships...");
    }
    if (this.detailEl) {
      this.detailEl.empty();
      this.detailEl.createDiv({ cls: "gitkb-graph-hint", text: "Drag the map, scroll to zoom, select a node for details." });
    }

    try {
      const graph = await this.plugin.client.allGraph();
      this.prepareGraph(graph);
      this.renderStats(graph);
      this.fitGraph();
      this.drawCanvasGraph();
    } catch (error) {
      if (this.statsEl) {
        renderError(this.statsEl, error);
      }
    }
  }

  private prepareGraph(graph: GitKbMergedGraph): void {
    const degree = new Map<string, number>();
    for (const edge of graph.edges) {
      degree.set(edge.from, (degree.get(edge.from) ?? 0) + 1);
      degree.set(edge.to, (degree.get(edge.to) ?? 0) + 1);
    }

    const types = [...new Set(graph.nodes.map((node) => node.type || "document"))].sort();
    const clusterRadius = Math.max(260, Math.min(760, graph.nodes.length * 0.55));
    const typeCluster = new Map<string, { x: number; y: number }>();
    types.forEach((type, index) => {
      const angle = (Math.PI * 2 * index) / Math.max(types.length, 1) - Math.PI / 2;
      typeCluster.set(type, {
        x: Math.cos(angle) * clusterRadius,
        y: Math.sin(angle) * clusterRadius
      });
    });

    const byType = new Map<string, GitKbGraphNode[]>();
    for (const node of graph.nodes) {
      const type = node.type || "document";
      const group = byType.get(type) ?? [];
      group.push(node);
      byType.set(type, group);
    }
    for (const group of byType.values()) {
      group.sort((a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0) || a.slug.localeCompare(b.slug));
    }

    const positioned: ForceNode[] = [];
    for (const [type, group] of byType.entries()) {
      const cluster = typeCluster.get(type) ?? { x: 0, y: 0 };
      const ringGap = 32;
      const firstRing = 28;
      group.forEach((node, index) => {
        const ring = Math.floor(Math.sqrt(index + 1));
        const ringStart = ring * ring;
        const ringSlots = Math.max(1, (ring + 1) * (ring + 1) - ringStart);
        const slot = index - ringStart;
        const seed = hashString(node.slug);
        const angle = (Math.PI * 2 * slot) / ringSlots + ((seed % 19) - 9) * 0.006;
        const orbit = firstRing + ring * ringGap;
        const nodeDegree = degree.get(node.id) ?? 0;
        positioned.push({
          ...node,
          x: cluster.x + Math.cos(angle) * orbit,
          y: cluster.y + Math.sin(angle) * orbit,
          vx: 0,
          vy: 0,
          radius: Math.min(15, 3.8 + Math.sqrt(nodeDegree + 1) * 1.55),
          degree: nodeDegree,
          clusterX: cluster.x,
          clusterY: cluster.y
        });
      });
    }

    this.nodes = positioned.sort((a, b) => b.degree - a.degree || a.slug.localeCompare(b.slug));

    this.nodeById = new Map(this.nodes.map((node) => [node.id, node]));
    this.edges = graph.edges
      .map((edge) => {
        const source = this.nodeById.get(edge.from);
        const target = this.nodeById.get(edge.to);
        if (!source || !target) {
          return null;
        }
        return { ...edge, source, target };
      })
      .filter((edge): edge is ForceEdge => edge !== null);
    this.edgeByKey = new Map(this.edges.map((edge) => [graphEdgeKey(edge), edge]));
  }

  private renderStats(graph: GitKbMergedGraph): void {
    if (!this.statsEl) {
      return;
    }
    this.statsEl.empty();
    this.statsEl.createDiv({ cls: "gitkb-graph-panel-title", text: "Graph scope" });
    const grid = this.statsEl.createDiv({ cls: "gitkb-graph-stats" });
    this.renderStat(grid, "Documents", String(graph.documentCount));
    this.renderStat(grid, "Nodes", String(this.nodes.length));
    this.renderStat(grid, "Edges", String(this.edges.length));
    this.renderStat(grid, "Types", String(new Set(this.nodes.map((node) => node.type || "document")).size));
  }

  private renderStat(container: HTMLElement, label: string, value: string): void {
    const item = container.createDiv({ cls: "gitkb-graph-stat" });
    item.createDiv({ cls: "gitkb-graph-stat-value", text: value });
    item.createDiv({ cls: "gitkb-graph-stat-label", text: label });
  }

  private drawCanvasGraph(): void {
    if (!this.canvas || !this.ctx) {
      return;
    }

    const rect = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.floor(rect.width));
    const height = Math.max(1, Math.floor(rect.height));
    if (this.canvas.width !== Math.floor(width * dpr) || this.canvas.height !== Math.floor(height * dpr)) {
      this.canvas.width = Math.floor(width * dpr);
      this.canvas.height = Math.floor(height * dpr);
    }

    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = getComputedStyle(this.canvas).getPropertyValue("--background-primary") || "transparent";

    const query = this.searchInput?.getValue().trim() ?? "";
    const hasFilter = query.length > 0;
    const isNodeVisible = (id: string) => !hasFilter || this.matchedNodeIds.has(id);

    ctx.save();
    ctx.translate(this.panX, this.panY);
    ctx.scale(this.scale, this.scale);

    ctx.lineCap = "round";
    for (const edge of this.edges) {
      const visible = isNodeVisible(edge.from) && isNodeVisible(edge.to);
      if (!visible && hasFilter) {
        ctx.globalAlpha = 0.035;
      } else {
        ctx.globalAlpha = edge.rel_type === "blocks" || edge.rel_type === "blocked_by" ? 0.34 : 0.18;
      }
      ctx.strokeStyle = colorForRelation(edge.rel_type);
      ctx.lineWidth = Math.max(0.55, 1.05 / Math.sqrt(this.scale));
      ctx.beginPath();
      ctx.moveTo(edge.source.x, edge.source.y);
      ctx.lineTo(edge.target.x, edge.target.y);
      ctx.stroke();
    }

    const sortedNodes = [...this.nodes].sort((a, b) => a.radius - b.radius);
    for (const node of sortedNodes) {
      const matched = isNodeVisible(node.id);
      ctx.globalAlpha = hasFilter && !matched ? 0.1 : 0.94;
      ctx.fillStyle = colorForType(node.type);
      ctx.strokeStyle =
        this.selectedNode?.id === node.id
          ? "#d6a84f"
          : this.hoveredNode?.id === node.id
            ? "#ffffff"
            : "rgba(12, 16, 20, 0.72)";
      ctx.lineWidth = (this.selectedNode?.id === node.id ? 3 : this.hoveredNode?.id === node.id ? 2.2 : 1.1) / this.scale;
      ctx.beginPath();
      ctx.arc(node.x, node.y, node.radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }

    ctx.globalAlpha = 1;
    const labelNodes = this.nodes
      .filter((node) => node === this.selectedNode || node === this.hoveredNode || node.degree >= 16 || (hasFilter && this.matchedNodeIds.has(node.id)))
      .sort((a, b) => b.degree - a.degree)
      .slice(0, hasFilter ? 80 : 42);
    ctx.font = `${Math.max(10 / this.scale, 10)}px sans-serif`;
    ctx.textBaseline = "middle";
    ctx.lineJoin = "round";
    for (const node of labelNodes) {
      const label = node.title || node.slug;
      const x = node.x + node.radius + 5 / this.scale;
      const y = node.y;
      ctx.lineWidth = 4 / this.scale;
      ctx.strokeStyle = getComputedStyle(this.canvas).getPropertyValue("--background-primary") || "#000000";
      ctx.fillStyle = getComputedStyle(this.canvas).getPropertyValue("--text-normal") || "#ffffff";
      ctx.strokeText(label, x, y);
      ctx.fillText(label, x, y);
    }
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  private registerCanvasEvents(): void {
    if (!this.canvas) {
      return;
    }

    this.canvas.addEventListener("wheel", (event) => {
      event.preventDefault();
      const before = this.screenToGraph(event.clientX, event.clientY);
      const direction = event.deltaY > 0 ? 0.88 : 1.12;
      this.scale = Math.max(0.05, Math.min(5, this.scale * direction));
      const rect = this.canvas?.getBoundingClientRect();
      if (rect) {
        this.panX = event.clientX - rect.left - before.x * this.scale;
        this.panY = event.clientY - rect.top - before.y * this.scale;
      }
      this.drawCanvasGraph();
    }, { passive: false });

    this.canvas.addEventListener("pointerdown", (event) => {
      const hit = this.hitTestNode(event.clientX, event.clientY);
      if (hit) {
        this.draggedNode = hit;
        this.selectedNode = hit;
        this.hoveredNode = hit;
        this.renderDetails(hit);
      } else {
        this.pointerStart = {
          x: event.clientX,
          y: event.clientY,
          panX: this.panX,
          panY: this.panY
        };
      }
      this.canvas?.setPointerCapture(event.pointerId);
      this.drawCanvasGraph();
    });

    this.canvas.addEventListener("pointermove", (event) => {
      if (this.draggedNode) {
        const point = this.screenToGraph(event.clientX, event.clientY);
        this.draggedNode.x = point.x;
        this.draggedNode.y = point.y;
        this.drawCanvasGraph();
        return;
      }

      if (this.pointerStart) {
        this.panX = this.pointerStart.panX + event.clientX - this.pointerStart.x;
        this.panY = this.pointerStart.panY + event.clientY - this.pointerStart.y;
        this.drawCanvasGraph();
        return;
      }

      const hit = this.hitTestNode(event.clientX, event.clientY);
      if (hit?.id !== this.hoveredNode?.id) {
        this.hoveredNode = hit;
        this.canvas?.toggleClass("is-hovering-node", Boolean(hit));
        this.drawCanvasGraph();
      }
    });

    this.canvas.addEventListener("pointerup", (event) => {
      this.pointerStart = null;
      this.draggedNode = null;
      this.canvas?.releasePointerCapture(event.pointerId);
    });

    this.canvas.addEventListener("pointerleave", () => {
      this.pointerStart = null;
      this.draggedNode = null;
      this.hoveredNode = null;
      this.canvas?.removeClass("is-hovering-node");
      this.drawCanvasGraph();
    });

    this.canvas.addEventListener("dblclick", (event) => {
      const hit = this.hitTestNode(event.clientX, event.clientY);
      if (hit) {
        event.preventDefault();
        void this.plugin.openDocument(hit.slug);
      }
    });

    this.registerDomEvent(window, "resize", () => this.drawCanvasGraph());
  }

  private hitTestNode(clientX: number, clientY: number): ForceNode | null {
    const point = this.screenToGraph(clientX, clientY);
    const query = this.searchInput?.getValue().trim() ?? "";
    const hasFilter = query.length > 0;
    let best: ForceNode | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;

    for (const node of this.nodes) {
      if (hasFilter && !this.matchedNodeIds.has(node.id)) {
        continue;
      }
      const dx = point.x - node.x;
      const dy = point.y - node.y;
      const limit = node.radius + 7 / this.scale;
      const distance = dx * dx + dy * dy;
      if (distance <= limit * limit && distance < bestDistance) {
        best = node;
        bestDistance = distance;
      }
    }

    return best;
  }

  private renderSvgGraph(): void {
    if (!this.edgeLayer || !this.nodeLayer || !this.labelLayer) {
      return;
    }
    this.edgeLayer.empty();
    this.nodeLayer.empty();
    this.labelLayer.empty();

    for (const edge of this.edges) {
      const line = document.createElementNS(SVG_NS, "line");
      line.addClass("gitkb-graph-edge");
      line.setAttribute("data-from", edge.from);
      line.setAttribute("data-to", edge.to);
      line.setAttribute("data-rel", edge.rel_type || "edge");
      line.setAttribute("data-key", graphEdgeKey(edge));
      this.edgeLayer.appendChild(line);
    }

    for (const node of this.nodes) {
      const circle = document.createElementNS(SVG_NS, "circle");
      circle.addClass("gitkb-graph-node");
      circle.setAttribute("r", String(node.radius));
      circle.setAttribute("fill", colorForType(node.type));
      circle.setAttribute("data-id", node.id);
      circle.setAttribute("tabindex", "0");
      const title = document.createElementNS(SVG_NS, "title");
      title.textContent = `${node.title || node.slug}\n${node.slug}`;
      circle.appendChild(title);
      circle.addEventListener("mouseenter", () => {
        this.hoveredNode = node;
        this.updateLabels();
      });
      circle.addEventListener("mouseleave", () => {
        this.hoveredNode = null;
        this.updateLabels();
      });
      circle.addEventListener("pointerdown", (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.draggedNode = node;
        this.selectedNode = node;
        this.renderDetails(node);
        circle.setPointerCapture(event.pointerId);
      });
      circle.addEventListener("pointermove", (event) => {
        if (this.draggedNode !== node) {
          return;
        }
        const point = this.screenToGraph(event.clientX, event.clientY);
        node.x = point.x;
        node.y = point.y;
        node.vx = 0;
        node.vy = 0;
        this.ticksRemaining = Math.max(this.ticksRemaining, 80);
        this.updatePositions();
      });
      circle.addEventListener("pointerup", (event) => {
        if (this.draggedNode === node) {
          this.draggedNode = null;
          circle.releasePointerCapture(event.pointerId);
        }
      });
      circle.addEventListener("dblclick", (event) => {
        event.preventDefault();
        void this.plugin.openDocument(node.slug);
      });
      this.nodeLayer.appendChild(circle);
    }

    this.updatePositions();
    this.applyFilter();
  }

  private registerGraphEvents(): void {
    if (!this.svg) {
      return;
    }

    this.svg.addEventListener("wheel", (event) => {
      event.preventDefault();
      const direction = event.deltaY > 0 ? 0.9 : 1.1;
      this.scale = Math.max(0.08, Math.min(5, this.scale * direction));
      this.applyTransform();
    }, { passive: false });

    this.svg.addEventListener("pointerdown", (event) => {
      if (event.target !== this.svg) {
        return;
      }
      this.pointerStart = {
        x: event.clientX,
        y: event.clientY,
        panX: this.panX,
        panY: this.panY
      };
      this.svg?.setPointerCapture(event.pointerId);
    });

    this.svg.addEventListener("pointermove", (event) => {
      if (!this.pointerStart) {
        return;
      }
      this.panX = this.pointerStart.panX + event.clientX - this.pointerStart.x;
      this.panY = this.pointerStart.panY + event.clientY - this.pointerStart.y;
      this.applyTransform();
    });

    this.svg.addEventListener("pointerup", (event) => {
      this.pointerStart = null;
      this.svg?.releasePointerCapture(event.pointerId);
    });
  }

  private startSimulation(): void {
    const step = () => {
      this.tick();
      this.updatePositions();
      if (this.ticksRemaining > 0) {
        this.animationFrame = requestAnimationFrame(step);
      }
    };
    this.animationFrame = requestAnimationFrame(step);
  }

  private stopSimulation(): void {
    if (this.animationFrame) {
      cancelAnimationFrame(this.animationFrame);
      this.animationFrame = 0;
    }
  }

  private tick(): void {
    this.ticksRemaining -= 1;
    const alpha = Math.max(0.02, this.ticksRemaining / 340);
    const sampleStep = this.nodes.length > 700 ? 7 : this.nodes.length > 420 ? 4 : 1;

    for (let index = 0; index < this.nodes.length; index += 1) {
      const node = this.nodes[index];
      if (node === this.draggedNode) {
        continue;
      }
      node.vx += (node.clusterX - node.x) * 0.0008 * alpha;
      node.vy += (node.clusterY - node.y) * 0.0008 * alpha;
      node.vx += -node.x * 0.00012;
      node.vy += -node.y * 0.00012;

      for (let otherIndex = (index + sampleStep); otherIndex < this.nodes.length; otherIndex += sampleStep) {
        const other = this.nodes[otherIndex];
        const dx = node.x - other.x;
        const dy = node.y - other.y;
        const distanceSquared = Math.max(60, dx * dx + dy * dy);
        if (distanceSquared > 72_000) {
          continue;
        }
        const force = (node.radius + other.radius + 16) * 0.8 / distanceSquared;
        node.vx += dx * force;
        node.vy += dy * force;
        other.vx -= dx * force;
        other.vy -= dy * force;
      }
    }

    for (const edge of this.edges) {
      const dx = edge.target.x - edge.source.x;
      const dy = edge.target.y - edge.source.y;
      const distance = Math.max(1, Math.sqrt(dx * dx + dy * dy));
      const desired = 95 + Math.min(60, edge.source.radius + edge.target.radius);
      const force = (distance - desired) * 0.0024 * alpha;
      const fx = (dx / distance) * force;
      const fy = (dy / distance) * force;
      if (edge.source !== this.draggedNode) {
        edge.source.vx += fx;
        edge.source.vy += fy;
      }
      if (edge.target !== this.draggedNode) {
        edge.target.vx -= fx;
        edge.target.vy -= fy;
      }
    }

    for (const node of this.nodes) {
      if (node === this.draggedNode) {
        continue;
      }
      node.vx *= 0.82;
      node.vy *= 0.82;
      node.x += Math.max(-12, Math.min(12, node.vx));
      node.y += Math.max(-12, Math.min(12, node.vy));
    }
  }

  private updatePositions(): void {
    if (!this.edgeLayer || !this.nodeLayer) {
      return;
    }

    for (const line of Array.from(this.edgeLayer.children) as SVGLineElement[]) {
      const edge = this.edgeByKey.get(line.getAttribute("data-key") || "");
      if (!edge) {
        continue;
      }
      line.setAttribute("x1", edge.source.x.toFixed(1));
      line.setAttribute("y1", edge.source.y.toFixed(1));
      line.setAttribute("x2", edge.target.x.toFixed(1));
      line.setAttribute("y2", edge.target.y.toFixed(1));
    }

    for (const circle of Array.from(this.nodeLayer.children) as SVGCircleElement[]) {
      const id = circle.getAttribute("data-id");
      const node = id ? this.nodeById.get(id) : null;
      if (!node) {
        continue;
      }
      circle.setAttribute("cx", node.x.toFixed(1));
      circle.setAttribute("cy", node.y.toFixed(1));
      circle.toggleClass("is-selected", this.selectedNode?.id === node.id);
      circle.toggleClass("is-hovered", this.hoveredNode?.id === node.id);
    }

    this.updateLabels();
  }

  private updateLabels(): void {
    if (!this.labelLayer) {
      return;
    }
    this.labelLayer.empty();
    const important = this.nodes
      .filter((node) => node === this.selectedNode || node === this.hoveredNode || node.degree >= 12)
      .sort((a, b) => b.degree - a.degree)
      .slice(0, 36);

    for (const node of important) {
      const label = document.createElementNS(SVG_NS, "text");
      label.addClass("gitkb-graph-label");
      label.setAttribute("x", String(node.x + node.radius + 5));
      label.setAttribute("y", String(node.y + 4));
      label.textContent = node.title || node.slug;
      this.labelLayer.appendChild(label);
    }
  }

  private applyFilter(): void {
    const query = this.searchInput?.getValue().trim().toLowerCase() ?? "";
    this.matchedNodeIds = new Set<string>();

    for (const node of this.nodes) {
      const haystack = [
        node.slug,
        node.title,
        node.type,
        node.status,
        node.priority,
        ...(node.tags ?? [])
      ].filter(Boolean).join(" ").toLowerCase();
      if (!query || haystack.includes(query)) {
        this.matchedNodeIds.add(node.id);
      }
    }
    this.drawCanvasGraph();
  }

  private renderDetails(node: ForceNode): void {
    if (!this.detailEl) {
      return;
    }
    this.detailEl.empty();
    this.detailEl.createDiv({ cls: "gitkb-graph-panel-title", text: "Selected document" });
    this.detailEl.createDiv({ cls: "gitkb-graph-detail-title", text: node.title || node.slug });
    this.detailEl.createDiv({ cls: "gitkb-graph-detail-slug", text: node.slug });

    const meta = this.detailEl.createDiv({ cls: "gitkb-graph-detail-meta" });
    for (const value of [node.type, node.status, node.priority, `${node.degree} link(s)`].filter((value): value is string => Boolean(value))) {
      meta.createSpan({ cls: "gitkb-viewer-pill", text: value });
    }

    const actions = this.detailEl.createDiv({ cls: "gitkb-graph-detail-actions" });
    new ButtonComponent(actions)
      .setButtonText("Open")
      .setIcon("file-text")
      .onClick(() => {
        void this.plugin.openDocument(node.slug);
      });
    new ButtonComponent(actions)
      .setButtonText("Copy wikilink")
      .setIcon("copy")
      .onClick(() => {
        void copyText(`[[${node.slug}]]`, "wikilink");
      });
  }

  private fitGraph(): void {
    if (!this.canvas || this.nodes.length === 0) {
      return;
    }
    const rect = this.canvas.getBoundingClientRect();
    const maxX = Math.max(...this.nodes.map((node) => Math.abs(node.x) + node.radius));
    const maxY = Math.max(...this.nodes.map((node) => Math.abs(node.y) + node.radius));
    this.scale = Math.max(0.08, Math.min(1.5, Math.min(rect.width / Math.max(1, maxX * 2.3), rect.height / Math.max(1, maxY * 2.3))));
    this.panX = rect.width / 2;
    this.panY = rect.height / 2;
    this.drawCanvasGraph();
  }

  private applyTransform(): void {
    this.drawCanvasGraph();
  }

  private screenToGraph(clientX: number, clientY: number): { x: number; y: number } {
    const rect = this.canvas?.getBoundingClientRect();
    if (!rect) {
      return { x: 0, y: 0 };
    }
    return {
      x: (clientX - rect.left - this.panX) / this.scale,
      y: (clientY - rect.top - this.panY) / this.scale
    };
  }
}

function typeColors(): Record<string, string> {
  return {
    task: "#4da3ff",
    spec: "#d6a84f",
    incident: "#e66b5b",
    note: "#7bc47f",
    swot: "#b48ad6",
    context: "#59c3b0",
    patterns: "#59c3b0",
    brief: "#d87993",
    document: "#a7b0bd"
  };
}

function colorForType(type?: string | null): string {
  const colors = typeColors();
  return colors[type || "document"] ?? "#a7b0bd";
}

function colorForRelation(type?: string | null): string {
  switch (type) {
    case "blocks":
    case "blocked_by":
      return "rgba(230, 107, 91, 0.72)";
    case "implements":
      return "rgba(214, 168, 79, 0.72)";
    case "depends_on":
      return "rgba(77, 163, 255, 0.62)";
    case "parent":
    case "parent_of":
      return "rgba(89, 195, 176, 0.64)";
    default:
      return "rgba(167, 176, 189, 0.52)";
  }
}

function graphEdgeKey(edge: GitKbGraphEdge): string {
  return `${edge.from}\u0000${edge.to}\u0000${edge.rel_type || "edge"}`;
}

function hashString(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash);
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
