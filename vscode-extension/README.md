# GauntletUI LSP for Mount & Blade II: Bannerlord

Provides rich IntelliSense, autocompletion, hover definitions, and diagnostics for GauntletUI XML prefabs in VS Code.

## Features

- **Tag Auto-completion**: Instant completion for all standard widgets (e.g., `ListPanel`, `TextWidget`, `ButtonWidget`) as well as custom workspace prefab XML files as custom tags.
- **Attribute Auto-completion**: Suggests widget-specific properties (including those inherited from base classes like `Widget`) and attached layout properties (e.g., `StackLayout.LayoutType`).
- **Value Auto-completion**: Suggests enum values, boolean options (`true`/`false`), brushes parsed from the game assets, and sprite names.
- **ViewModel Bindings**: Autocompletes data-source bindings starting with `@` (e.g. `@MyProperty`) and command bindings starting with `Command.` (e.g. `Command.MyMethod`) by matching properties and methods on your ViewModels.
- **Hover Documentation**: Hovering over tags shows their namespace and assembly; hovering over attributes shows the property type and the declaring widget class.
- **Smart Activation (Non-invasive)**: Only activates on actual GauntletUI prefabs (checking root `<Prefab>` and `<Window>` tags) to prevent hijacking unrelated XML files (e.g., `pom.xml`, Android layouts, etc.).

## Configuration Settings

You can customize the extension behavior by adding these settings to your workspace or global settings:

| Setting | Type | Default | Description |
|---|---|---|---|
| `gauntletui.gamePath` | `string` | `""` | The directory path to your Bannerlord game installation folder (containing `bin` and `Modules`). |
| `gauntletui.schemaPath` | `string` | `""` | Path to a custom-generated `gauntlet-schema.json`. If left blank, the extension uses a workspace root schema or defaults to the bundled one. |
| `gauntletui.fileGlob` | `string` | `"**/GUI/**/*.xml"` | Glob pattern of files to process for prefab indexing. |
| `gauntletui.viewModelMapping` | `object` | `{}` | Key-value pairs mapping prefab XML file names to ViewModel class names (e.g. `{"ClanScreen": "ClanVM"}`) for accurate binding completions. |
| `gauntletui.diagnosticsEnabled` | `boolean` | `true` | Enables or disables basic diagnostics validation for unrecognized elements/attributes. |

---

## Schema Indexer

By default, the extension uses a bundled snapshot of the GauntletUI schema. If you update the game or use custom widgets, you can regenerate the schema using the included C# Schema Indexer:

```bash
dotnet run --project schema-indexer/schema-indexer.csproj -- --game-bin-path "C:\Path\To\Bannerlord\bin\Win64_Shipping_Client" --resource-path "C:\Path\To\Bannerlord\Modules" --output "gauntlet-schema.json"
```

Place the generated `gauntlet-schema.json` in your workspace root, and the extension will automatically detect and load it on startup.
