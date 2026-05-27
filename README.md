# GauntletUI LSP

An integrated VS Code extension and schema indexer providing IntelliSense (autocompletion, hover documentation, and diagnostics) for Mount & Blade II: Bannerlord **GauntletUI prefab XML** files.

## Project Structure

This repository is split into three main components:
1. **[Schema Indexer](./schema-indexer/) (C# Console App)**: Reflects over Bannerlord `.NET` assemblies using `System.Reflection.MetadataLoadContext` and parses game UI resources to generate a unified `gauntlet-schema.json` database.
2. **[TpacTool Submodule](./tpac-tool/) (C# Library)**: Linked as a Git submodule pointing to a custom fork. It decompresses BC7/DXT5 sheets and performs on-the-fly cropping.
3. **[VS Code Extension](./vscode-extension/) (TypeScript)**: The LSP client and server that consumes the generated schema to provide rich editor features without hijacking non-GauntletUI XML files.

---

## Architecture Overview

```mermaid
graph TD
    GameBin[Bannerlord bin folder] -->|C# MetadataLoadContext| Indexer[Schema Indexer]
    GameRes[Bannerlord GUI resources] -->|XML parsing| Indexer
    Indexer -->|Emits| Schema[gauntlet-schema.json]
    Schema -->|Bundled or workspace fallback| LSP[LSP Server]
    Workspace[Workspace XML Prefabs] -->|Indexed on load/change| LSP
    LSP -->|IntelliSense / Hover / Diagnostics| VSCode[VS Code client]
    LSP -->|Spawn extract-sheet| Tpac[TpacTool Submodule]
    Tpac -->|Decompress & Crop on-the-fly| Cache[.gauntletui-cache/]
    Cache -->|Resolved via baseUri| VSCode
```

---

## Editor Features

* **Live Sprite Hover Previews**: Hovering over any `Sprite` attribute resolves the sprite's category and sheet (traversing `gauntlet_ui.tpac`, `core_game.tpac`, etc. lazily). It decompresses the BC7/DXT5 texture and crops the sprite on-the-fly in C#, displaying a live preview image in the hover tooltip.
* **Document Color Decorators & Picker**: Shows inline color squares next to hex colors in the editor. Intercepts VS Code's built-in color picker to format selected colors directly into GauntletUI-compliant hex formats (`#RRGGBBAA` and `#RRGGBB`).
* **Attached Layout & Brush Properties**: Full autocomplete, type information, and enum completions for dot-nested attached properties (e.g. `StackLayout.LayoutMethod`, `Brush.FontSize`).
* **Local Constant (`!`) & Parameter (`*`) Autocomplete**: Typing `!` or `*` dynamically scans the active XML document for defined `<Constant>` and `<Parameter>` elements, providing instant name autocomplete.
* **VisualState Target Property Autocomplete**: When animating widget properties inside `<VisualState>`, the LSP automatically resolves the target widget, suggesting its animatable properties and their enum values.
* **Tag Completion**: Lists all native Widget tags (e.g. `ListPanel`, `TextWidget`) plus custom workspace prefab filenames as custom tags.
* **Attribute & Value Completion**: Offers widget attributes with specific value hints (enums, boolean, brushes, sprites).
* **Context-aware Filtering**: Filters tags contextually (e.g. only suggests `<Constant>` inside `<Constants>`).
* **Smart Language Activation**: Only activates on GauntletUI prefabs (inspecting root `<Prefab>` and `<Window>` tags) to prevent hijacking unrelated XML files (like `pom.xml` or Android layouts).

---

## 1. Schema Indexer (C#)
The schema indexer resides in `/schema-indexer`. It reflects over the game's assemblies to extract widgets, properties, and ViewModels, and parses XML files to extract brushes and sprites.

### Hard Constraints
* **No game binaries are committed:** Assemblies reside in a local, untracked `refs/` directory or are fetched from the local game path.
* **No assembly execution:** Uses `MetadataLoadContext` so it doesn't try to load native engines or execute game code.

### Running the Indexer
Run the indexer from the command line:
```bash
dotnet run --project schema-indexer/schema-indexer.csproj -- --game-bin-path "C:\Path\To\Bannerlord\bin\Win64_Shipping_Client" --resource-path "C:\Path\To\Bannerlord\Modules" --output "gauntlet-schema.json"
```

---

## 2. VS Code Extension (TypeScript)
The extension lives in `/vscode-extension`. It implements the Language Server Protocol (LSP) to provide completion, hover, and diagnostics.

### Building & Running the Extension
1. Clone the repository and initialize submodules:
   ```bash
   git clone --recursive <repo-url>
   cd GauntletUI-LSP
   ```
2. Install dependencies:
   ```bash
   cd vscode-extension
   npm install
   ```
3. Build the extension:
   ```bash
   npm run build
   ```
4. To package into an installable `.vsix`:
   ```bash
   npm run package
   ```

---

## Configuration Settings
Configure the following settings in your VS Code `settings.json`:
* `gauntletui.gamePath`: Path to the game directory (contains `bin` and `Modules`).
* `gauntletui.schemaPath`: Custom location for `gauntlet-schema.json`. Defaults to workspace root.
* `gauntletui.fileGlob`: Glob pattern for prefab activation (defaults to `**/GUI/**/*.xml`).
* `gauntletui.viewModelMapping`: Map prefab names to ViewModels for accurate binding autocompletion.
* `gauntletui.diagnosticsEnabled`: Toggle diagnostics warnings (defaults to `true`).

## License
MIT
