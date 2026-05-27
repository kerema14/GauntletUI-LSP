import {
    createConnection,
    TextDocuments,
    Diagnostic,
    DiagnosticSeverity,
    ProposedFeatures,
    InitializeParams,
    DidChangeConfigurationNotification,
    CompletionItem,
    CompletionItemKind,
    TextDocumentPositionParams,
    TextDocumentSyncKind,
    InitializeResult,
    Hover,
    MarkupContent,
    MarkupKind,
    InsertTextFormat,
    ColorInformation,
    ColorPresentation,
    Color,
    DocumentColorParams,
    ColorPresentationParams
} from 'vscode-languageserver/node';

import { TextDocument } from 'vscode-languageserver-textdocument';
import * as fs from 'fs';
import * as path from 'path';
import { getContext, PositionContext } from './parser';

const connection = createConnection(ProposedFeatures.all);
const documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);

let hasConfigurationCapability = false;
let hasWorkspaceFolderCapability = false;

// GauntletUI Schema Interface
interface AttributeInfo {
    name: string;
    type: string;
    enumValues: string[] | null;
}

interface WidgetInfo {
    name: string;
    namespace: string;
    assembly: string;
    attributes: AttributeInfo[];
}

interface ViewModelInfo {
    name: string;
    properties: string[];
    methods: string[];
}

interface Schema {
    structuralTags: string[];
    specialAttributes: string[];
    widgets: WidgetInfo[];
    enums: { [key: string]: string[] };
    brushes: string[];
    sprites: string[];
    viewModels: ViewModelInfo[];
}

let schema: Schema = {
    structuralTags: [],
    specialAttributes: [],
    widgets: [],
    enums: {},
    brushes: [],
    sprites: [],
    viewModels: []
};

// Workspace and Game custom prefabs mapping
interface CustomPrefabInfo {
    name: string;
    rootTag: string;
    parameters: string[];
    isWorkspace: boolean;
}

let customPrefabsMap = new Map<string, CustomPrefabInfo>();
let workspaceRootUri: string | null = null;

// Optimization Lookups
const widgetMap = new Map<string, WidgetInfo>();
const widgetAttributeSets = new Map<string, Set<string>>();
let structuralTagsSet = new Set<string>();
let specialAttributesSet = new Set<string>();
let brushesSet = new Set<string>();
let spritesSet = new Set<string>();

// Indexing Cache
let lastIndexedGamePath: string | null = null;
let lastIndexedWorkspaceRoot: string | null = null;
let lastLoadedSchemaPath: string | null = null;

// Global settings cache
interface Settings {
    gauntletui: {
        gamePath: string;
        schemaPath: string;
        fileGlob: string;
        viewModelMapping: { [prefabName: string]: string };
        diagnosticsEnabled: boolean;
    };
}

const defaultSettings: Settings = {
    gauntletui: {
        gamePath: '',
        schemaPath: '',
        fileGlob: '**/GUI/**/*.xml',
        viewModelMapping: {},
        diagnosticsEnabled: true
    }
};

let globalSettings: Settings = defaultSettings;

connection.onInitialize((params: InitializeParams) => {
    const capabilities = params.capabilities;
    hasConfigurationCapability = !!(capabilities.workspace && !!capabilities.workspace.configuration);
    hasWorkspaceFolderCapability = !!(capabilities.workspace && !!capabilities.workspace.workspaceFolders);

    if (params.workspaceFolders && params.workspaceFolders.length > 0) {
        workspaceRootUri = params.workspaceFolders[0].uri;
    }

    const result: InitializeResult = {
        capabilities: {
            textDocumentSync: TextDocumentSyncKind.Incremental,
            completionProvider: {
                resolveProvider: true,
                triggerCharacters: ['<', ' ', '@', '.', '"', "'", '{', '!', '*']
            },
            hoverProvider: true,
            colorProvider: true
        }
    };

    return result;
});

connection.onInitialized(() => {
    if (hasConfigurationCapability) {
        connection.client.register(DidChangeConfigurationNotification.type, undefined);
    }
    loadSchema();
    indexWorkspacePrefabs();
});

// Load schema JSON file
function loadSchema() {
    connection.workspace.getConfiguration('gauntletui').then((settings: any) => {
        let schemaPath = settings?.schemaPath || '';
        
        // If not specified, look for schema in workspace root
        if (!schemaPath && workspaceRootUri) {
            const rootPath = workspaceRootUri.replace('file:///', '').replace('file://', '');
            const possiblePath = path.join(rootPath, 'gauntlet-schema.json');
            if (fs.existsSync(possiblePath)) {
                schemaPath = possiblePath;
            }
        }

        // Fallback to extension folder
        if (!schemaPath) {
            const fallbackPath = path.join(__dirname, '..', 'gauntlet-schema.json');
            if (fs.existsSync(fallbackPath)) {
                schemaPath = fallbackPath;
            }
        }

        if (schemaPath && fs.existsSync(schemaPath)) {
            if (schemaPath === lastLoadedSchemaPath) {
                return; // Already loaded this schema
            }
            lastLoadedSchemaPath = schemaPath;
            const tStart = Date.now();
            try {
                const data = fs.readFileSync(schemaPath, 'utf8');
                schema = JSON.parse(data);

                // Build optimized lookups
                widgetMap.clear();
                widgetAttributeSets.clear();
                structuralTagsSet = new Set(schema.structuralTags || []);
                specialAttributesSet = new Set(schema.specialAttributes || []);
                brushesSet = new Set(schema.brushes || []);
                spritesSet = new Set(schema.sprites || []);
                
                if (schema.widgets) {
                    for (const widget of schema.widgets) {
                        widgetMap.set(widget.name, widget);
                        const attrSet = new Set<string>();
                        if (widget.attributes) {
                            for (const attr of widget.attributes) {
                                attrSet.add(attr.name);
                            }
                        }
                        widgetAttributeSets.set(widget.name, attrSet);
                    }
                }

                const elapsed = Date.now() - tStart;
                connection.console.log(`Loaded and indexed GauntletUI schema in ${elapsed}ms from: ${schemaPath}`);
                connection.console.log(`Schema contains: ${schema.widgets?.length || 0} widgets, ${schema.brushes?.length || 0} brushes, ${schema.sprites?.length || 0} sprites.`);
            } catch (err: any) {
                connection.console.error(`Failed to parse schema JSON: ${err.message}`);
            }
        } else {
            connection.console.warn('GauntletUI schema file not found. Place gauntlet-schema.json in workspace root or configure gauntletui.schemaPath.');
        }
    });
}

// Helper to parse parameters and root widget tag from a prefab XML file
function parsePrefabFile(filePath: string, isWorkspace: boolean): CustomPrefabInfo | null {
    try {
        const content = fs.readFileSync(filePath, 'utf8');
        const name = path.basename(filePath, '.xml');
        
        // Find parameters
        const parameters: string[] = [];
        const paramRegex = /<Parameter\s+[^>]*Name=["']([^"']+)["']/g;
        let match;
        while ((match = paramRegex.exec(content)) !== null) {
            parameters.push(match[1]);
        }

        // Find the root tag by scanning tags in order (skip structural containers)
        let rootTag = 'Widget'; // Default fallback
        const tagRegex = /<\s*([a-zA-Z0-9_\.]+)/g;
        const structuralElements = new Set([
            'Prefab', 'Window', 'Children', 'Parameters', 'Constants', 
            'Variables', 'VisualDefinitions', 'CustomElements', 'ItemTemplate',
            'Parameter', 'Constant', 'Variable', 'VisualState', 'VisualStateTransition'
        ]);

        let tMatch;
        while ((tMatch = tagRegex.exec(content)) !== null) {
            const tag = tMatch[1];
            if (!structuralElements.has(tag)) {
                rootTag = tag;
                break;
            }
        }

        return { name, rootTag, parameters, isWorkspace };
    } catch (err) {
        return null;
    }
}

// Index workspace custom XML files and game module custom prefabs
function indexWorkspacePrefabs(force: boolean = false) {
    const gamePath = globalSettings.gauntletui.gamePath || process.env.BANNERLORD_GAME_DIR || '';
    const workspaceRoot = workspaceRootUri || '';

    // Bypass/optimize indexing if gamePath and workspaceRoot are unchanged, unless forced
    if (!force && lastIndexedGamePath === gamePath && lastIndexedWorkspaceRoot === workspaceRoot) {
        return;
    }
    lastIndexedGamePath = gamePath;
    lastIndexedWorkspaceRoot = workspaceRoot;

    const startTime = Date.now();
    customPrefabsMap.clear();

    function walkDir(dir: string, isWorkspace: boolean) {
        if (!fs.existsSync(dir)) return;
        try {
            const files = fs.readdirSync(dir);
            for (const file of files) {
                const fullPath = path.join(dir, file);
                const stat = fs.statSync(fullPath);
                if (stat.isDirectory()) {
                    // Skip common non-asset directories to optimize walking
                    if (['node_modules', '.git', 'bin', 'obj', 'AssetPackages', 'Illustration', 'Sounds', 'Videos', 'Textures', 'SceneObj'].includes(file)) {
                        continue;
                    }
                    walkDir(fullPath, isWorkspace);
                } else if (file.endsWith('.xml')) {
                    const normalized = fullPath.replace(/\\/g, '/');
                    // Check if it's in GUI/Prefabs or if we are in the workspace
                    const isPrefabFile = normalized.includes('/GUI/Prefabs/') || normalized.includes('/Prefabs/') || isWorkspace;
                    if (isPrefabFile) {
                        const info = parsePrefabFile(fullPath, isWorkspace);
                        if (info) {
                            customPrefabsMap.set(info.name, info);
                        }
                    }
                }
            }
        } catch (err: any) {
            connection.console.error(`Error scanning prefabs in ${dir}: ${err.message}`);
        }
    }

    // Helper to scan a directory optimized for mods (directly targeting GUI/Prefabs or Prefabs if they exist)
    function scanModDir(modPath: string) {
        if (!fs.existsSync(modPath)) return;
        
        const guiPrefabs = path.join(modPath, 'GUI', 'Prefabs');
        const prefabs = path.join(modPath, 'Prefabs');
        
        if (fs.existsSync(guiPrefabs)) {
            walkDir(guiPrefabs, false);
        }
        if (fs.existsSync(prefabs)) {
            walkDir(prefabs, false);
        }
    }

    // 1. Index game modules and workshop mods if gamePath/env is configured
    if (gamePath && fs.existsSync(gamePath)) {
        const modulesPath = path.join(gamePath, 'Modules');
        if (fs.existsSync(modulesPath)) {
            const t0 = Date.now();
            try {
                const mods = fs.readdirSync(modulesPath);
                for (const mod of mods) {
                    const modPath = path.join(modulesPath, mod);
                    if (fs.statSync(modPath).isDirectory()) {
                        scanModDir(modPath);
                    }
                }
            } catch (err: any) {
                connection.console.error(`Error listing modules directory: ${err.message}`);
            }
            connection.console.log(`Indexed game modules in ${Date.now() - t0}ms`);
        }

        // Scan workshop folder relative to gamePath (steamapps/common/Mount & Blade II Bannerlord -> steamapps/workshop/content/261550)
        try {
            const relativeWorkshopPath = path.resolve(gamePath, '..', '..', 'workshop', 'content', '261550');
            if (fs.existsSync(relativeWorkshopPath)) {
                const t0 = Date.now();
                const workshopMods = fs.readdirSync(relativeWorkshopPath);
                for (const wm of workshopMods) {
                    const wmPath = path.join(relativeWorkshopPath, wm);
                    if (fs.statSync(wmPath).isDirectory()) {
                        scanModDir(wmPath);
                    }
                }
                connection.console.log(`Indexed Steam Workshop mods in ${Date.now() - t0}ms`);
            }
        } catch (err: any) {
            connection.console.error(`Error scanning relative workshop path: ${err.message}`);
        }
    }

    // Scan standard default Steam Workshop folder if it exists
    const defaultWorkshopPath = 'C:/Program Files (x86)/Steam/steamapps/workshop/content/261550';
    if (fs.existsSync(defaultWorkshopPath)) {
        const t0 = Date.now();
        try {
            const workshopMods = fs.readdirSync(defaultWorkshopPath);
            for (const wm of workshopMods) {
                const wmPath = path.join(defaultWorkshopPath, wm);
                if (fs.statSync(wmPath).isDirectory()) {
                    scanModDir(wmPath);
                }
            }
            connection.console.log(`Indexed default Steam Workshop folder in ${Date.now() - t0}ms`);
        } catch {}
    }

    // 2. Index workspace prefabs
    if (workspaceRootUri) {
        const t0 = Date.now();
        const rootPath = workspaceRootUri.replace('file:///', '').replace('file://', '').replace(/\\/g, '/');
        walkDir(rootPath, true);
        connection.console.log(`Indexed workspace prefabs in ${Date.now() - t0}ms`);
    }

    const elapsed = Date.now() - startTime;
    connection.console.log(`GauntletUI LSP indexing finished. Total custom prefabs: ${customPrefabsMap.size}. Total time: ${elapsed}ms.`);
}

connection.onDidChangeConfiguration(change => {
    if (hasConfigurationCapability) {
        connection.workspace.getConfiguration('gauntletui').then((settings: any) => {
            globalSettings = { gauntletui: { ...defaultSettings.gauntletui, ...settings } };
            loadSchema();
            indexWorkspacePrefabs(); // Now re-index if settings (like gamePath) changed
            triggerDiagnostics();
        });
    } else {
        globalSettings = <Settings>(change.settings || defaultSettings);
        loadSchema();
        indexWorkspacePrefabs(); // Now re-index if settings (like gamePath) changed
        triggerDiagnostics();
    }
});

// Watch files for changes to update custom prefabs
connection.onDidChangeWatchedFiles(_change => {
    connection.console.log('Workspace files changed. Re-indexing workspace prefabs...');
    indexWorkspacePrefabs(true); // Force re-index on file changes
    triggerDiagnostics();
});

function triggerDiagnostics() {
    documents.all().forEach(validateTextDocument);
}

documents.onDidClose(e => {
    connection.sendDiagnostics({ uri: e.document.uri, diagnostics: [] });
});

documents.onDidChangeContent(change => {
    validateTextDocument(change.document);
});

function matchesGlob(uri: string, glob: string): boolean {
    try {
        const decodedUri = decodeURIComponent(uri).replace(/\\/g, '/');
        let regexStr = glob
            .replace(/[.+^${}()|[\]\\]/g, '\\$&') // escape regex special chars
            .replace(/\*\*/g, '.*')               // double star matches anything
            .replace(/\*(?!\*)/g, '[^/]*')        // single star matches folder/file name
            .replace(/\?/g, '.');                 // question mark matches one char
        
        if (!regexStr.startsWith('^')) {
            regexStr = '.*' + regexStr;
        }
        const regex = new RegExp(regexStr, 'i');
        return regex.test(decodedUri);
    } catch {
        return false;
    }
}

function isGauntletUIFile(uri: string, text: string): boolean {
    // 1. Clean comments and find the first XML element tag
    const textWithoutComments = text.replace(/<!--[\s\S]*?-->/g, '');
    const rootTagMatch = textWithoutComments.match(/<\s*([a-zA-Z0-9_\:\-]+)/);
    
    if (rootTagMatch) {
        const rootTag = rootTagMatch[1];
        // In GauntletUI, the root element tag of a prefab must be Prefab or Window
        return rootTag === 'Prefab' || rootTag === 'Window';
    }
    
    // 2. If no XML tag has been typed yet (blank file), we rely on the glob/path
    // to allow bootstrap autocompletions (completing <Prefab> or <Window>)
    const glob = globalSettings.gauntletui.fileGlob || '**/GUI/**/*.xml';
    if (matchesGlob(uri, glob)) {
        return true;
    }
    const normalized = uri.replace(/\\/g, '/').toLowerCase();
    if (normalized.includes('/gui/prefabs/') || normalized.includes('/prefabs/') || normalized.includes('/gui/brushes/')) {
        return true;
    }
    return false;
}

// Validation/Diagnostics logic
async function validateTextDocument(textDocument: TextDocument): Promise<void> {
    const text = textDocument.getText();
    if (!isGauntletUIFile(textDocument.uri, text)) {
        connection.sendDiagnostics({ uri: textDocument.uri, diagnostics: [] });
        return;
    }
    if (!globalSettings.gauntletui.diagnosticsEnabled) {
        connection.sendDiagnostics({ uri: textDocument.uri, diagnostics: [] });
        return;
    }

    const tStart = Date.now();
    const diagnostics: Diagnostic[] = [];

    // 1. Validate tag names
    const tagRegex = /<([a-zA-Z0-9_\.]+)/g;
    let match;
    while ((match = tagRegex.exec(text)) !== null) {
        const tagName = match[1];
        if (tagName.startsWith('!--') || tagName.startsWith('?')) continue;

        const isValidTag = 
            structuralTagsSet.has(tagName) ||
            widgetMap.has(tagName) ||
            customPrefabsMap.has(tagName);

        if (!isValidTag) {
            const index = match.index;
            const startPos = textDocument.positionAt(index + 1);
            const endPos = textDocument.positionAt(index + 1 + tagName.length);

            diagnostics.push({
                severity: DiagnosticSeverity.Warning,
                range: { start: startPos, end: endPos },
                message: `Unknown tag name: '${tagName}'. This could be a custom prefab or a misspelled built-in widget.`,
                source: 'GauntletUI LSP'
            });
        }
    }

    // 2. Validate attribute names
    const tagOpenRegex = /<([a-zA-Z0-9_\.]+)([^>]*)\/?>/g;
    let tagOpenMatch;
    while ((tagOpenMatch = tagOpenRegex.exec(text)) !== null) {
        const tagName = tagOpenMatch[1];
        const attrContent = tagOpenMatch[2];
        if (tagName.startsWith('!--') || tagName.startsWith('?')) continue;

        // Check if built-in widget
        const widget = widgetMap.get(tagName);
        if (widget) {
            const widgetAttrs = widgetAttributeSets.get(tagName);
            const singleAttrRegex = /\b([a-zA-Z0-9_\.\-]+)=/g;
            let attrMatch;
            while ((attrMatch = singleAttrRegex.exec(attrContent)) !== null) {
                const attrName = attrMatch[1];

                const isValid =
                    specialAttributesSet.has(attrName) ||
                    schema.specialAttributes.some(sa => sa.startsWith(attrName + '.')) ||
                    attrName.startsWith('Command.') ||
                    attrName.startsWith('CommandParameter.') ||
                    attrName.startsWith('Parameter.') ||
                    (widgetAttrs && widgetAttrs.has(attrName)) ||
                    attrName.includes('.'); // Best-effort dot-nesting (e.g. Brush.FontSize)

                if (!isValid) {
                    const index = tagOpenMatch.index + tagOpenMatch[1].length + 1 + attrMatch.index;
                    const startPos = textDocument.positionAt(index);
                    const endPos = textDocument.positionAt(index + attrName.length);

                    diagnostics.push({
                        severity: DiagnosticSeverity.Warning,
                        range: { start: startPos, end: endPos },
                        message: `Unknown attribute: '${attrName}' on widget '${tagName}'.`,
                        source: 'GauntletUI LSP'
                    });
                }
            }
        }

        // Check if custom prefab
        const customPrefab = customPrefabsMap.get(tagName);
        if (customPrefab) {
            const singleAttrRegex = /\b([a-zA-Z0-9_\.\-]+)=/g;
            let attrMatch;
            while ((attrMatch = singleAttrRegex.exec(attrContent)) !== null) {
                const attrName = attrMatch[1];

                if (attrName.startsWith('Parameter.')) {
                    const paramName = attrName.substring('Parameter.'.length);
                    const isValidParam = customPrefab.parameters.includes(paramName);
                    if (!isValidParam) {
                        const index = tagOpenMatch.index + tagOpenMatch[1].length + 1 + attrMatch.index;
                        const startPos = textDocument.positionAt(index);
                        const endPos = textDocument.positionAt(index + attrName.length);

                        diagnostics.push({
                            severity: DiagnosticSeverity.Warning,
                            range: { start: startPos, end: endPos },
                            message: `Parameter '${paramName}' is not defined in prefab '${customPrefab.name}.xml'.`,
                            source: 'GauntletUI LSP'
                        });
                    }
                } else {
                    // Check if standard attribute is valid on custom prefab's root tag
                    const rootWidget = widgetMap.get(customPrefab.rootTag);
                    const rootAttrs = rootWidget ? widgetAttributeSets.get(customPrefab.rootTag) : null;
                    const isValidAttr =
                        specialAttributesSet.has(attrName) ||
                        schema.specialAttributes.some(sa => sa === attrName || sa.startsWith(attrName + '.')) ||
                        attrName.startsWith('Command.') ||
                        attrName.startsWith('CommandParameter.') ||
                        (rootAttrs && rootAttrs.has(attrName)) ||
                        attrName.includes('.');

                    if (!isValidAttr) {
                        const index = tagOpenMatch.index + tagOpenMatch[1].length + 1 + attrMatch.index;
                        const startPos = textDocument.positionAt(index);
                        const endPos = textDocument.positionAt(index + attrName.length);

                        diagnostics.push({
                            severity: DiagnosticSeverity.Warning,
                            range: { start: startPos, end: endPos },
                            message: `Unknown attribute '${attrName}' on custom prefab '${tagName}' (root widget: '${customPrefab.rootTag}').`,
                            source: 'GauntletUI LSP'
                        });
                    }
                }
            }
        }
    }

    connection.sendDiagnostics({ uri: textDocument.uri, diagnostics });
    const elapsed = Date.now() - tStart;
    connection.console.log(`[Performance] Diagnostics validated in ${elapsed}ms for: ${textDocument.uri}`);
}

// Complete items
connection.onCompletion((posParams: TextDocumentPositionParams): CompletionItem[] => {
    const tStart = Date.now();
    const document = documents.get(posParams.textDocument.uri);
    if (!document) return [];

    const text = document.getText();
    if (!isGauntletUIFile(document.uri, text)) return [];

    const offset = document.offsetAt(posParams.position);
    const context = getContext(text, offset);

    let items: CompletionItem[] = [];
    if (context.type === 'tag') {
        items = handleTagCompletion(context);
    } else if (context.type === 'attribute') {
        items = handleAttributeCompletion(context, document);
    } else if (context.type === 'value') {
        items = handleAttributeValueCompletion(context, document, offset);
    } else if (context.type === 'binding') {
        items = handleBindingCompletion(context);
    }

    const elapsed = Date.now() - tStart;
    connection.console.log(`[Performance] Completion resolved in ${elapsed}ms (${items.length} items)`);
    return items;
});

function handleTagCompletion(context: PositionContext): CompletionItem[] {
    const items: CompletionItem[] = [];
    const parentTag = context.tagStack[context.tagStack.length - 1];

    if (parentTag === 'Constants') {
        items.push({
            label: 'Constant',
            kind: CompletionItemKind.Keyword,
            detail: 'GauntletUI Structural Tag',
            insertText: 'Constant Name="$1" Value="$2" />',
            insertTextFormat: InsertTextFormat.Snippet
        });
        return items;
    }

    if (parentTag === 'Variables') {
        items.push({
            label: 'Variable',
            kind: CompletionItemKind.Keyword,
            detail: 'GauntletUI Structural Tag',
            insertText: 'Variable Name="$1" Value="$2" />',
            insertTextFormat: InsertTextFormat.Snippet
        });
        return items;
    }

    if (parentTag === 'Parameters') {
        items.push({
            label: 'Parameter',
            kind: CompletionItemKind.Keyword,
            detail: 'GauntletUI Structural Tag',
            insertText: 'Parameter Name="$1" DefaultValue="$2" />',
            insertTextFormat: InsertTextFormat.Snippet
        });
        return items;
    }

    if (parentTag === 'VisualDefinitions') {
        items.push({
            label: 'VisualDefinition',
            kind: CompletionItemKind.Keyword,
            detail: 'GauntletUI Structural Tag',
            insertText: 'VisualDefinition Name="$1">\n\t$0\n</VisualDefinition>',
            insertTextFormat: InsertTextFormat.Snippet
        });
        return items;
    }

    if (parentTag === 'VisualDefinition') {
        items.push({
            label: 'VisualState',
            kind: CompletionItemKind.Keyword,
            detail: 'GauntletUI Structural Tag',
            insertText: 'VisualState State="$1" $0/>',
            insertTextFormat: InsertTextFormat.Snippet
        }, {
            label: 'VisualStateTransition',
            kind: CompletionItemKind.Keyword,
            detail: 'GauntletUI Structural Tag',
            insertText: 'VisualStateTransition From="$1" To="$2" TransitionDuration="$3" />',
            insertTextFormat: InsertTextFormat.Snippet
        });
        return items;
    }

    if (parentTag === 'Prefab') {
        const prefabTags = ["Constants", "Variables", "VisualDefinitions", "Window", "CustomElements", "Parameters"];
        for (const tag of prefabTags) {
            items.push({
                label: tag,
                kind: CompletionItemKind.Keyword,
                detail: 'GauntletUI Structural Tag',
                insertText: `${tag}>\n\t$0\n</${tag}>`,
                insertTextFormat: InsertTextFormat.Snippet
            });
        }
        return items;
    }

    // Container structural tags
    const containerStructural = [
        "Prefab", "Window", "Children", "Parameters", "Constants", "Variables", 
        "VisualDefinitions", "VisualDefinition", "CustomElements", "ItemTemplate"
    ];

    // Add structural tags
    for (const tag of schema.structuralTags) {
        let insertText = tag;
        let format: InsertTextFormat = InsertTextFormat.PlainText;

        if (containerStructural.includes(tag)) {
            if (tag === 'VisualDefinition') {
                insertText = 'VisualDefinition Name="$1">\n\t$0\n</VisualDefinition>';
            } else {
                insertText = `${tag}>\n\t$0\n</${tag}>`;
            }
            format = InsertTextFormat.Snippet;
        } else if (tag === 'VisualState') {
            insertText = 'VisualState State="$1" $0/>';
            format = InsertTextFormat.Snippet;
        } else if (tag === 'Parameter') {
            insertText = 'Parameter Name="$1" DefaultValue="$2" />';
            format = InsertTextFormat.Snippet;
        } else if (tag === 'Constant') {
            insertText = 'Constant Name="$1" Value="$2" />';
            format = InsertTextFormat.Snippet;
        }

        items.push({
            label: tag,
            kind: CompletionItemKind.Keyword,
            detail: 'GauntletUI Structural Tag',
            insertText: insertText,
            insertTextFormat: format
        });
    }

    // Container widgets (commonly have children)
    const containerWidgets = [
        "Widget", "ListPanel", "GridWidget", "ScrollablePanel", "ScrollbarWidget", 
        "NavigatableGridWidget", "ButtonWidget", "DropdownWidget", "AnimatedDropdownWidget"
    ];

    // Add built-in widgets
    for (const widget of schema.widgets) {
        let insertText = widget.name;
        let format: InsertTextFormat = InsertTextFormat.PlainText;

        if (containerWidgets.includes(widget.name)) {
            insertText = `${widget.name}>\n\t$0\n</${widget.name}>`;
            format = InsertTextFormat.Snippet;
        } else {
            insertText = `${widget.name} $0/>`;
            format = InsertTextFormat.Snippet;
        }

        items.push({
            label: widget.name,
            kind: CompletionItemKind.Class,
            detail: `${widget.namespace} [${widget.assembly}]`,
            insertText: insertText,
            insertTextFormat: format
        });
    }

    // Add custom prefabs (both workspace and modules)
    for (const prefab of customPrefabsMap.values()) {
        items.push({
            label: prefab.name,
            kind: CompletionItemKind.Module,
            detail: prefab.isWorkspace ? 'Custom Workspace Prefab' : 'Custom Module Prefab',
            insertText: `${prefab.name} $0/>`,
            insertTextFormat: InsertTextFormat.Snippet
        });
    }

    return items;
}

function getTargetWidgetForVisualState(context: PositionContext, documentText: string): WidgetInfo | CustomPrefabInfo | null {
    const tagStack = context.tagStack;
    if (!tagStack || tagStack.length < 3) {
        return widgetMap.get('Widget') || null;
    }

    const vDefsIndex = tagStack.lastIndexOf('VisualDefinitions');
    let parentTag: string | null = null;
    if (vDefsIndex > 0) {
        parentTag = tagStack[vDefsIndex - 1];
    } else {
        const structural = new Set(['VisualState', 'VisualDefinition', 'VisualDefinitions']);
        for (let idx = tagStack.length - 1; idx >= 0; idx--) {
            if (!structural.has(tagStack[idx])) {
                parentTag = tagStack[idx];
                break;
            }
        }
    }

    if (parentTag && parentTag !== 'Prefab' && parentTag !== 'Window') {
        const widget = widgetMap.get(parentTag);
        if (widget) return widget;
        const customPrefab = customPrefabsMap.get(parentTag);
        if (customPrefab) return customPrefab;
    }

    const tagRegex = /<\s*([a-zA-Z0-9_\.]+)/g;
    const structuralElements = new Set([
        'Prefab', 'Window', 'Children', 'Parameters', 'Constants', 
        'Variables', 'VisualDefinitions', 'CustomElements', 'ItemTemplate',
        'Parameter', 'Constant', 'Variable', 'VisualState', 'VisualStateTransition'
    ]);

    let match;
    tagRegex.lastIndex = 0;
    while ((match = tagRegex.exec(documentText)) !== null) {
        const tag = match[1];
        if (!structuralElements.has(tag)) {
            const widget = widgetMap.get(tag);
            if (widget) return widget;
            const customPrefab = customPrefabsMap.get(tag);
            if (customPrefab) return customPrefab;
            break;
        }
    }

    return widgetMap.get('Widget') || null;
}

function handleAttributeCompletion(context: PositionContext, document: TextDocument): CompletionItem[] {
    const items: CompletionItem[] = [];
    const tagName = context.tagName;

    const triggerSuggestCommand = {
        title: 'Trigger Suggest',
        command: 'editor.action.triggerSuggest'
    };

    // Standard special attributes
    for (const attr of schema.specialAttributes) {
        items.push({
            label: attr,
            kind: CompletionItemKind.Property,
            detail: 'Special Attribute',
            insertText: `${attr}="$1"`,
            insertTextFormat: InsertTextFormat.Snippet,
            command: triggerSuggestCommand
        });
    }

    // Find widget attributes
    const widget = widgetMap.get(tagName);
    if (widget) {
        for (const attr of widget.attributes) {
            items.push({
                label: attr.name,
                kind: CompletionItemKind.Field,
                detail: `Type: ${attr.type}`,
                insertText: `${attr.name}="$1"`,
                insertTextFormat: InsertTextFormat.Snippet,
                command: triggerSuggestCommand
            });
        }
    }

    // Find custom prefab attributes/parameters
    const customPrefab = customPrefabsMap.get(tagName);
    if (customPrefab) {
        for (const param of customPrefab.parameters) {
            items.push({
                label: `Parameter.${param}`,
                kind: CompletionItemKind.Field,
                detail: `Prefab Parameter (from ${customPrefab.name}.xml)`,
                insertText: `Parameter.${param}="$1"`,
                insertTextFormat: InsertTextFormat.Snippet,
                command: triggerSuggestCommand
            });
        }
        const rootWidget = widgetMap.get(customPrefab.rootTag);
        if (rootWidget) {
            for (const attr of rootWidget.attributes) {
                items.push({
                    label: attr.name,
                    kind: CompletionItemKind.Field,
                    detail: `Root Widget Property (${customPrefab.rootTag})`,
                    insertText: `${attr.name}="$1"`,
                    insertTextFormat: InsertTextFormat.Snippet,
                    command: triggerSuggestCommand
                });
            }
        }
    }

    // Special structural tag attributes
    if (tagName === 'VisualState') {
        items.push({
            label: 'State',
            kind: CompletionItemKind.Field,
            insertText: 'State="$1"',
            insertTextFormat: InsertTextFormat.Snippet,
            command: triggerSuggestCommand
        });

        const target = getTargetWidgetForVisualState(context, document.getText());
        if (target) {
            let targetWidget: WidgetInfo | null = null;
            if ('attributes' in target) {
                targetWidget = target;
            } else {
                targetWidget = widgetMap.get(target.rootTag) || null;
            }

            if (targetWidget) {
                for (const attr of targetWidget.attributes) {
                    items.push({
                        label: attr.name,
                        kind: CompletionItemKind.Field,
                        detail: `Animate property (from ${targetWidget.name})`,
                        insertText: `${attr.name}="$1"`,
                        insertTextFormat: InsertTextFormat.Snippet,
                        command: triggerSuggestCommand
                    });
                }
            }
        }
    } else if (tagName === 'VisualDefinition') {
        const attrs = ['Name', 'TransitionDuration', 'EaseType', 'EaseFunction', 'DelayOnBegin'];
        for (const attr of attrs) {
            items.push({
                label: attr,
                kind: CompletionItemKind.Field,
                insertText: `${attr}="$1"`,
                insertTextFormat: InsertTextFormat.Snippet,
                command: triggerSuggestCommand
            });
        }
    } else if (tagName === 'Constant') {
        const attrs = [
            'Name', 'Value', 'Prefix', 'Suffix', 'BrushName', 'BrushLayer', 
            'BrushValueType', 'SpriteName', 'SpriteValueType', 'Additive', 
            'MultiplyResult', 'BooleanCheck', 'OnTrue', 'OnFalse'
        ];
        for (const attr of attrs) {
            items.push({
                label: attr,
                kind: CompletionItemKind.Field,
                insertText: `${attr}="$1"`,
                insertTextFormat: InsertTextFormat.Snippet,
                command: triggerSuggestCommand
            });
        }
    } else if (tagName === 'Parameter') {
        const attrs = ['Name', 'DefaultValue'];
        for (const attr of attrs) {
            items.push({
                label: attr,
                kind: CompletionItemKind.Field,
                insertText: `${attr}="$1"`,
                insertTextFormat: InsertTextFormat.Snippet,
                command: triggerSuggestCommand
            });
        }
    } else if (tagName === 'ItemTemplate') {
        items.push({
            label: 'Type',
            kind: CompletionItemKind.Field,
            detail: 'Default | First | Last',
            insertText: 'Type="$1"',
            insertTextFormat: InsertTextFormat.Snippet,
            command: triggerSuggestCommand
        });
    }

    return items;
}

// Helper to extract an attribute value from a raw tag string
function getAttributeValue(tagBody: string, attrName: string): string | null {
    const regex = new RegExp(`\\b${attrName}=["']([^"']*)["']`);
    const match = tagBody.match(regex);
    return match ? match[1] : null;
}

function handleAttributeValueCompletion(context: PositionContext, document: TextDocument, offset: number): CompletionItem[] {
    const items: CompletionItem[] = [];
    const attrName = context.attributeName;
    const tagName = context.tagName;

    // Check if we are inside special brackets/prefix
    const prefix = context.valuePrefix;

    if (prefix === '!') {
        // Complete constant reference (starts with !)
        const content = document.getText();
        const constantRegex = /<Constant\s+([^>]+)\/?>/g;
        let match;
        const constants = new Set<string>();
        
        while ((match = constantRegex.exec(content)) !== null) {
            const body = match[1];
            const name = getAttributeValue(body, 'Name');
            const value = getAttributeValue(body, 'Value');
            if (name) {
                const label = `!${name}`;
                if (!constants.has(label)) {
                    constants.add(label);
                    items.push({
                        label: label,
                        kind: CompletionItemKind.Constant,
                        detail: value ? `Constant Value: ${value}` : 'Constant Reference',
                        insertText: name,
                        filterText: label
                    });
                }
            }
        }
        return items;
    } else if (prefix === '*') {
        // Complete parameter reference (starts with *)
        const content = document.getText();
        const parameterRegex = /<Parameter\s+([^>]+)\/?>/g;
        let match;
        const parameters = new Set<string>();
        
        while ((match = parameterRegex.exec(content)) !== null) {
            const body = match[1];
            const name = getAttributeValue(body, 'Name');
            const defaultValue = getAttributeValue(body, 'DefaultValue');
            if (name) {
                const label = `*${name}`;
                if (!parameters.has(label)) {
                    parameters.add(label);
                    items.push({
                        label: label,
                        kind: CompletionItemKind.Variable,
                        detail: defaultValue ? `Default Value: ${defaultValue}` : 'Parameter Reference',
                        insertText: name,
                        filterText: label
                    });
                }
            }
        }
        return items;
    }

    if (attrName === 'VisualDefinition') {
        const content = document.getText();
        const visualDefRegex = /<VisualDefinition\s+([^>]+)\/?>/g;
        let match;
        const visualDefs = new Set<string>();

        while ((match = visualDefRegex.exec(content)) !== null) {
            const body = match[1];
            const name = getAttributeValue(body, 'Name');
            if (name) {
                if (!visualDefs.has(name)) {
                    visualDefs.add(name);
                    items.push({
                        label: name,
                        kind: CompletionItemKind.Value,
                        detail: 'Local Visual Definition Name'
                    });
                }
            }
        }
        if (context.attributeValue.length > 0) {
            const startPos = document.positionAt(offset - context.attributeValue.length);
            const endPos = document.positionAt(offset);
            return items.map(item => {
                if (!item.textEdit) {
                    item.textEdit = {
                        range: { start: startPos, end: endPos },
                        newText: item.insertText || item.label
                    };
                }
                return item;
            });
        }
        return items;
    }

    // 1. Check if attribute type is enum
    let targetWidget: WidgetInfo | null = null;
    if (tagName === 'VisualState') {
        const target = getTargetWidgetForVisualState(context, document.getText());
        if (target) {
            if ('attributes' in target) {
                targetWidget = target;
            } else {
                targetWidget = widgetMap.get(target.rootTag) || null;
            }
        }
    } else {
        targetWidget = widgetMap.get(tagName) || null;
    }
    const attr = targetWidget?.attributes.find(a => a.name === attrName);

    if (attr && attr.type === 'enum' && attr.enumValues) {
        for (const val of attr.enumValues) {
            items.push({
                label: val,
                kind: CompletionItemKind.EnumMember,
                detail: `Enum value for ${attrName}`
            });
        }
    }

    // 2. Check if boolean type
    if (attr && attr.type === 'bool') {
        items.push(
            { label: 'true', kind: CompletionItemKind.Value },
            { label: 'false', kind: CompletionItemKind.Value }
        );
    }

    // 3. Brushes
    if (attrName === 'Brush' || attrName === 'BrushName' || attr?.type === 'Brush') {
        for (const brush of schema.brushes) {
            items.push({
                label: brush,
                kind: CompletionItemKind.Color,
                detail: 'Brush Resource'
            });
        }
    }

    // 4. Sprites
    if (attrName === 'Sprite' || attrName === 'SpriteName' || attr?.type === 'Sprite') {
        for (const sprite of schema.sprites) {
            items.push({
                label: sprite,
                kind: CompletionItemKind.File,
                detail: 'Sprite Resource'
            });
        }
    }

    // 5. Special values
    if (attrName === 'Type' && tagName === 'ItemTemplate') {
        items.push(
            { label: 'Default', kind: CompletionItemKind.EnumMember },
            { label: 'First', kind: CompletionItemKind.EnumMember },
            { label: 'Last', kind: CompletionItemKind.EnumMember }
        );
    }

    if (attrName === 'EaseFunction') {
        items.push(
            { label: 'Sine', kind: CompletionItemKind.EnumMember },
            { label: 'Quad', kind: CompletionItemKind.EnumMember },
            { label: 'Cubic', kind: CompletionItemKind.EnumMember },
            { label: 'Quart', kind: CompletionItemKind.EnumMember },
            { label: 'Quint', kind: CompletionItemKind.EnumMember }
        );
    }

    if (attrName === 'EaseType') {
        items.push(
            { label: 'Linear', kind: CompletionItemKind.EnumMember },
            { label: 'EaseIn', kind: CompletionItemKind.EnumMember },
            { label: 'EaseOut', kind: CompletionItemKind.EnumMember },
            { label: 'EaseInOut', kind: CompletionItemKind.EnumMember }
        );
    }
    if (context.attributeValue.length > 0) {
        const startPos = document.positionAt(offset - context.attributeValue.length);
        const endPos = document.positionAt(offset);
        return items.map(item => {
            if (!item.textEdit) {
                item.textEdit = {
                    range: { start: startPos, end: endPos },
                    newText: item.insertText || item.label
                };
            }
            return item;
        });
    }

    return items;
}

function handleBindingCompletion(context: PositionContext): CompletionItem[] {
    const items: CompletionItem[] = [];
    const attrName = context.attributeName;
    const tagName = context.tagName;

    // Check if the attribute is command or regular data binding
    const isCommand = attrName.startsWith('Command.');

    // We collect all VM properties or methods
    // We can also narrow down if we know the root ViewModel mapping
    let targetVMName = '';
    
    // Check view model mapping setting
    if (globalSettings.gauntletui.viewModelMapping) {
        // Search through mappings for active file name or check file name if passed
        // For now, if a specific ViewModel is mapping, we can prioritize it
    }

    if (isCommand) {
        // Complete methods
        const methods = new Set<string>();
        for (const vm of schema.viewModels) {
            for (const method of vm.methods) {
                methods.add(method);
            }
        }
        for (const m of methods) {
            items.push({
                label: m,
                kind: CompletionItemKind.Method,
                detail: 'ViewModel Command Method'
            });
        }
    } else {
        // Complete properties
        const properties = new Set<string>();
        for (const vm of schema.viewModels) {
            for (const prop of vm.properties) {
                properties.add(prop);
            }
        }
        for (const p of properties) {
            items.push({
                label: p,
                kind: CompletionItemKind.Property,
                detail: 'ViewModel DataSource Property'
            });
        }
    }

    return items;
}

connection.onCompletionResolve((item: CompletionItem): CompletionItem => {
    return item;
});

// Hover provider
connection.onHover((params: TextDocumentPositionParams): Hover | null => {
    const tStart = Date.now();
    const document = documents.get(params.textDocument.uri);
    if (!document) return null;

    const text = document.getText();
    if (!isGauntletUIFile(document.uri, text)) return null;

    const offset = document.offsetAt(params.position);
    const context = getContext(text, offset);

    let hoverResult: Hover | null = null;

    // If hovering a tag name
    if (context.tagName && (context.type === 'tag' || context.type === 'attribute')) {
        const widget = widgetMap.get(context.tagName);
        if (widget) {
            // Hovering attribute
            if (context.attributeName) {
                const attr = widget.attributes.find(a => a.name === context.attributeName);
                if (attr) {
                    hoverResult = {
                        contents: {
                            kind: MarkupKind.Markdown,
                            value: `**Attribute**: \`${attr.name}\`\n\n**Type**: \`${attr.type}\`\n\nDeclared in: \`${widget.name}\` (${widget.namespace})`
                        }
                    };
                }
            } else {
                // Hovering tag
                hoverResult = {
                    contents: {
                        kind: MarkupKind.Markdown,
                        value: `**Widget**: \`${widget.name}\`\n\n**Namespace**: \`${widget.namespace}\`\n\n**Assembly**: \`${widget.assembly}.dll\``
                    }
                };
            }
        }
    }

    const elapsed = Date.now() - tStart;
    connection.console.log(`[Performance] Hover resolved in ${elapsed}ms`);
    return hoverResult;
});

function parseHexToColor(hex: string): Color | null {
    hex = hex.replace('#', '');
    let r = 0, g = 0, b = 0, a = 1;

    if (hex.length === 3) {
        r = parseInt(hex[0] + hex[0], 16) / 255;
        g = parseInt(hex[1] + hex[1], 16) / 255;
        b = parseInt(hex[2] + hex[2], 16) / 255;
    } else if (hex.length === 4) {
        r = parseInt(hex[0] + hex[0], 16) / 255;
        g = parseInt(hex[1] + hex[1], 16) / 255;
        b = parseInt(hex[2] + hex[2], 16) / 255;
        a = parseInt(hex[3] + hex[3], 16) / 255;
    } else if (hex.length === 6) {
        r = parseInt(hex.substring(0, 2), 16) / 255;
        g = parseInt(hex.substring(2, 4), 16) / 255;
        b = parseInt(hex.substring(4, 6), 16) / 255;
    } else if (hex.length === 8) {
        r = parseInt(hex.substring(0, 2), 16) / 255;
        g = parseInt(hex.substring(2, 4), 16) / 255;
        b = parseInt(hex.substring(4, 6), 16) / 255;
        a = parseInt(hex.substring(6, 8), 16) / 255;
    } else {
        return null;
    }

    return { red: r, green: g, blue: b, alpha: a };
}

connection.onDocumentColor((params: DocumentColorParams): ColorInformation[] => {
    const document = documents.get(params.textDocument.uri);
    if (!document) return [];

    const text = document.getText();
    if (!isGauntletUIFile(document.uri, text)) return [];

    const colors: ColorInformation[] = [];
    
    // Match hex colors: # followed by 3, 4, 6, or 8 hex digits, bounded by word boundary or quote
    const colorRegex = /#([0-9a-fA-F]{3,8})\b/g;
    let match;

    while ((match = colorRegex.exec(text)) !== null) {
        const hex = match[0];
        const innerHex = match[1];
        if ([3, 4, 6, 8].includes(innerHex.length)) {
            const color = parseHexToColor(hex);
            if (color) {
                const startOffset = match.index;
                const endOffset = startOffset + hex.length;
                colors.push({
                    range: {
                        start: document.positionAt(startOffset),
                        end: document.positionAt(endOffset)
                    },
                    color: color
                });
            }
        }
    }

    return colors;
});

connection.onColorPresentation((params: ColorPresentationParams): ColorPresentation[] => {
    const color = params.color;
    
    const r = Math.round(color.red * 255);
    const g = Math.round(color.green * 255);
    const b = Math.round(color.blue * 255);
    const a = Math.round(color.alpha * 255);

    const toHex = (num: number) => {
        const str = num.toString(16).toUpperCase();
        return str.length === 1 ? '0' + str : str;
    };

    const hex8 = `#${toHex(r)}${toHex(g)}${toHex(b)}${toHex(a)}`;
    const hex6 = `#${toHex(r)}${toHex(g)}${toHex(b)}`;

    const presentations: ColorPresentation[] = [];
    
    presentations.push({
        label: hex8,
        textEdit: {
            range: params.range,
            newText: hex8
        }
    });

    if (a === 255) {
        presentations.push({
            label: hex6,
            textEdit: {
                range: params.range,
                newText: hex6
            }
        });
    }

    return presentations;
});

documents.listen(connection);
connection.listen();
