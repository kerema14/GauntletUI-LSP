using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Xml;
using System.Xml.Linq;

namespace GauntletUISchemaIndexer
{
    public class AttributeInfo
    {
        public string name { get; set; }
        public string type { get; set; }
        public List<string> enumValues { get; set; }
    }

    public class WidgetInfoModel
    {
        public string name { get; set; }
        public string @namespace { get; set; }
        public string assembly { get; set; }
        public List<AttributeInfo> attributes { get; set; }
    }

    public class ViewModelInfoModel
    {
        public string name { get; set; }
        public List<string> properties { get; set; }
        public List<string> methods { get; set; }
    }

    public class SpriteInfoModel
    {
        public string name { get; set; }
        public string categoryName { get; set; }
        public int sheetId { get; set; }
        public int x { get; set; }
        public int y { get; set; }
        public int width { get; set; }
        public int height { get; set; }
    }

    public class SchemaModel
    {
        public List<string> structuralTags { get; set; }
        public List<string> specialAttributes { get; set; }
        public List<WidgetInfoModel> widgets { get; set; }
        public Dictionary<string, List<string>> enums { get; set; }
        public List<string> brushes { get; set; }
        public List<SpriteInfoModel> sprites { get; set; }
        public List<ViewModelInfoModel> viewModels { get; set; }
    }

    class Program
    {
        static void Main(string[] args)
        {
            string gameBinPath = "";
            string resourcePath = "";
            string outputPath = "gauntlet-schema.json";

            string extractSheetName = "";
            int cropX = 0;
            int cropY = 0;
            int cropW = 0;
            int cropH = 0;

            for (int i = 0; i < args.Length; i++)
            {
                if (args[i] == "--game-bin-path" && i + 1 < args.Length)
                {
                    gameBinPath = args[i + 1];
                }
                else if (args[i] == "--resource-path" && i + 1 < args.Length)
                {
                    resourcePath = args[i + 1];
                }
                else if (args[i] == "--output" && i + 1 < args.Length)
                {
                    outputPath = args[i + 1];
                }
                else if (args[i] == "--extract-sheet" && i + 1 < args.Length)
                {
                    extractSheetName = args[i + 1];
                }
                else if (args[i] == "--crop-x" && i + 1 < args.Length)
                {
                    int.TryParse(args[i + 1], out cropX);
                }
                else if (args[i] == "--crop-y" && i + 1 < args.Length)
                {
                    int.TryParse(args[i + 1], out cropY);
                }
                else if (args[i] == "--crop-w" && i + 1 < args.Length)
                {
                    int.TryParse(args[i + 1], out cropW);
                }
                else if (args[i] == "--crop-h" && i + 1 < args.Length)
                {
                    int.TryParse(args[i + 1], out cropH);
                }
            }

            if (string.IsNullOrEmpty(gameBinPath))
            {
                var envPath = Environment.GetEnvironmentVariable("BANNERLORD_GAME_DIR");
                if (!string.IsNullOrEmpty(envPath))
                {
                    var possibleBin = Path.Combine(envPath, "bin", "Win64_Shipping_Client");
                    if (Directory.Exists(possibleBin))
                    {
                        gameBinPath = possibleBin;
                    }
                }
            }
            if (string.IsNullOrEmpty(gameBinPath))
            {
                gameBinPath = Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "refs");
            }

            if (string.IsNullOrEmpty(resourcePath))
            {
                var envPath = Environment.GetEnvironmentVariable("BANNERLORD_GAME_DIR");
                if (!string.IsNullOrEmpty(envPath))
                {
                    var possibleModules = Path.Combine(envPath, "Modules");
                    if (Directory.Exists(possibleModules))
                    {
                        resourcePath = possibleModules;
                    }
                }
            }
            if (string.IsNullOrEmpty(resourcePath))
            {
                resourcePath = Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "refs-src"); // Fallback fallback
            }

            gameBinPath = Path.GetFullPath(gameBinPath);
            outputPath = Path.GetFullPath(outputPath);

            if (!string.IsNullOrEmpty(extractSheetName))
            {
                ExtractSheet(gameBinPath, resourcePath, extractSheetName, outputPath, cropX, cropY, cropW, cropH);
                return;
            }
            Console.WriteLine($"Game bin path: {gameBinPath}");
            Console.WriteLine($"Resource path: {resourcePath}");
            Console.WriteLine($"Output path: {outputPath}");

            if (!Directory.Exists(gameBinPath))
            {
                Console.Error.WriteLine($"Error: game bin path does not exist: {gameBinPath}");
                Environment.Exit(1);
            }

            // Create PathAssemblyResolver
            var assemblyPaths = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);

            // 1. Core runtime assemblies
            string runtimeDir = RuntimeEnvironment.GetRuntimeDirectory();
            foreach (var file in Directory.GetFiles(runtimeDir, "*.dll"))
            {
                assemblyPaths[Path.GetFileName(file)] = file;
            }

            // 2. Game assemblies
            foreach (var file in Directory.GetFiles(gameBinPath, "*.dll"))
            {
                assemblyPaths[Path.GetFileName(file)] = file;
            }

            // 3. App bin directory (for NuGet dependencies like Newtonsoft.Json)
            foreach (var file in Directory.GetFiles(AppContext.BaseDirectory, "*.dll"))
            {
                if (!assemblyPaths.ContainsKey(Path.GetFileName(file)))
                {
                    assemblyPaths[Path.GetFileName(file)] = file;
                }
            }

            var resolver = new PathAssemblyResolver(assemblyPaths.Values);
            using var mlc = new MetadataLoadContext(resolver);

            // Enumerate Widget tags & attributes
            var widgetAssemblyNames = new[]
            {
                "TaleWorlds.GauntletUI",
                "TaleWorlds.GauntletUI.ExtraWidgets",
                "TaleWorlds.Engine.GauntletUI",
                "TaleWorlds.MountAndBlade.GauntletUI.Widgets",
                "SandBox.GauntletUI",
                "StoryMode.GauntletUI"
            };

            var widgets = new List<WidgetInfoModel>();
            var enumsMap = new Dictionary<string, List<string>>();

            foreach (var asmName in widgetAssemblyNames)
            {
                string asmPath = Path.Combine(gameBinPath, asmName + ".dll");
                if (!File.Exists(asmPath))
                {
                    continue;
                }

                try
                {
                    Assembly assembly = mlc.LoadFromAssemblyPath(asmPath);

                    var widgetTypes = assembly.GetTypes()
                        .Where(t => t.IsClass && !t.IsAbstract && t.IsPublic && IsDerivedFrom(t, "TaleWorlds.GauntletUI.BaseTypes.Widget"))
                        .ToList();
 
                    foreach (var type in widgetTypes)
                    {
                        var attributes = new List<AttributeInfo>();
                        var members = new List<(string Name, Type Type)>();

                        var properties = type.GetProperties(BindingFlags.Public | BindingFlags.Instance)
                            .Where(p => p.SetMethod != null && p.SetMethod.IsPublic)
                            .ToList();
                        foreach (var prop in properties)
                        {
                            members.Add((prop.Name, prop.PropertyType));
                        }

                        var fields = type.GetFields(BindingFlags.Public | BindingFlags.Instance)
                            .Where(f => !f.IsInitOnly && !f.IsLiteral)
                            .ToList();
                        foreach (var field in fields)
                        {
                            members.Add((field.Name, field.FieldType));
                        }

                        foreach (var member in members)
                        {
                            string typeKind = "other";
                            List<string> enumValues = null;

                            if (member.Type.FullName == "System.String")
                            {
                                typeKind = "string";
                            }
                            else if (member.Type.FullName == "System.Int32")
                            {
                                typeKind = "int";
                            }
                            else if (member.Type.FullName == "System.Single")
                            {
                                typeKind = "float";
                            }
                            else if (member.Type.FullName == "System.Boolean")
                            {
                                typeKind = "bool";
                            }
                            else if (member.Type.FullName == "TaleWorlds.GauntletUI.Brush")
                            {
                                typeKind = "Brush";
                            }
                            else if (member.Type.FullName == "TaleWorlds.TwoDimension.Sprite")
                            {
                                typeKind = "Sprite";
                            }
                            else if (member.Type.FullName == "TaleWorlds.Library.Color")
                            {
                                typeKind = "Color";
                            }
                            else if (IsDerivedFrom(member.Type, "TaleWorlds.GauntletUI.BaseTypes.Widget"))
                            {
                                typeKind = "WidgetReference";
                            }
                            else if (member.Type.IsEnum)
                            {
                                typeKind = "enum";
                                enumValues = new List<string>();
                                foreach (var field in member.Type.GetFields(BindingFlags.Public | BindingFlags.Static))
                                {
                                    enumValues.Add(field.Name);
                                }

                                if (!enumsMap.ContainsKey(member.Type.Name))
                                {
                                    enumsMap[member.Type.Name] = enumValues;
                                }
                            }

                            attributes.Add(new AttributeInfo
                            {
                                name = member.Name,
                                type = typeKind,
                                enumValues = enumValues
                            });
                        }

                        widgets.Add(new WidgetInfoModel
                        {
                            name = type.Name,
                            @namespace = type.Namespace,
                            assembly = asmName,
                            attributes = attributes
                        });
                    }
                }
                catch (Exception ex)
                {
                    Console.Error.WriteLine($"Error loading assembly {asmName}: {ex.Message}");
                }
            }

            // Reflect over Brush and layouts to add attached properties directly to ALL widgets
            if (widgets.Count > 0)
            {
                var attachedTypes = new Dictionary<string, string>
                {
                    { "TaleWorlds.GauntletUI.Brush", "Brush" },
                    { "TaleWorlds.GauntletUI.Layout.StackLayout", "StackLayout" },
                    { "TaleWorlds.GauntletUI.Layout.GridLayout", "GridLayout" },
                    { "TaleWorlds.GauntletUI.Layout.DefaultLayout", "DefaultLayout" },
                    { "TaleWorlds.GauntletUI.Layout.DragCarrierLayout", "DragCarrierLayout" },
                    { "TaleWorlds.GauntletUI.Layout.TextLayout", "TextLayout" }
                };

                Assembly gauntletUIAsm = mlc.LoadFromAssemblyPath(Path.Combine(gameBinPath, "TaleWorlds.GauntletUI.dll"));
                
                foreach (var kvp in attachedTypes)
                {
                    var type = gauntletUIAsm.GetType(kvp.Key);
                    if (type != null)
                    {
                        var properties = type.GetProperties(BindingFlags.Public | BindingFlags.Instance)
                            .Where(p => p.SetMethod != null && p.SetMethod.IsPublic)
                            .ToList();

                        foreach (var prop in properties)
                        {
                            string attachedName = $"{kvp.Value}.{prop.Name}";
                            string typeKind = "other";
                            List<string> enumValues = null;

                            if (prop.PropertyType.FullName == "System.String")
                            {
                                typeKind = "string";
                            }
                            else if (prop.PropertyType.FullName == "System.Int32")
                            {
                                typeKind = "int";
                            }
                            else if (prop.PropertyType.FullName == "System.Single")
                            {
                                typeKind = "float";
                            }
                            else if (prop.PropertyType.FullName == "System.Boolean")
                            {
                                typeKind = "bool";
                            }
                            else if (prop.PropertyType.FullName == "TaleWorlds.GauntletUI.Brush")
                            {
                                typeKind = "Brush";
                            }
                            else if (prop.PropertyType.FullName == "TaleWorlds.TwoDimension.Sprite")
                            {
                                typeKind = "Sprite";
                            }
                            else if (prop.PropertyType.FullName == "TaleWorlds.Library.Color")
                            {
                                typeKind = "Color";
                            }
                            else if (IsDerivedFrom(prop.PropertyType, "TaleWorlds.GauntletUI.BaseTypes.Widget"))
                            {
                                typeKind = "WidgetReference";
                            }
                            else if (prop.PropertyType.IsEnum)
                            {
                                typeKind = "enum";
                                enumValues = new List<string>();
                                foreach (var field in prop.PropertyType.GetFields(BindingFlags.Public | BindingFlags.Static))
                                {
                                    enumValues.Add(field.Name);
                                }

                                if (!enumsMap.ContainsKey(prop.PropertyType.Name))
                                {
                                    enumsMap[prop.PropertyType.Name] = enumValues;
                                }
                            }

                            foreach (var widgetModel in widgets)
                            {
                                widgetModel.attributes.Add(new AttributeInfo
                                {
                                    name = attachedName,
                                    type = typeKind,
                                    enumValues = enumValues
                                });
                            }
                        }
                    }
                }
            }

            // Enumerate view models
            var viewModelAssemblyNames = new[]
            {
                "TaleWorlds.Library",
                "TaleWorlds.Core.ViewModelCollection",
                "TaleWorlds.CampaignSystem.ViewModelCollection",
                "TaleWorlds.MountAndBlade.ViewModelCollection",
                "SandBox.ViewModelCollection",
                "StoryMode.ViewModelCollection"
            };

            var viewModels = new List<ViewModelInfoModel>();

            foreach (var asmName in viewModelAssemblyNames)
            {
                string asmPath = Path.Combine(gameBinPath, asmName + ".dll");
                if (!File.Exists(asmPath))
                {
                    continue;
                }

                try
                {
                    Assembly assembly = mlc.LoadFromAssemblyPath(asmPath);
                    var vmTypes = assembly.GetTypes()
                        .Where(t => t.IsClass && !t.IsAbstract && IsDerivedFrom(t, "TaleWorlds.Library.ViewModel"))
                        .ToList();

                    foreach (var type in vmTypes)
                    {
                        var props = type.GetProperties(BindingFlags.Public | BindingFlags.Instance)
                            .Where(p => HasAttribute(p, "TaleWorlds.Library.DataSourceProperty") || HasAttribute(p, "TaleWorlds.Library.DataSourcePropertyAttribute"))
                            .Select(p => propName(p))
                            .ToList();

                        var methods = type.GetMethods(BindingFlags.Public | BindingFlags.Instance)
                            .Where(m => HasAttribute(m, "TaleWorlds.Library.DataSourceMethod") || HasAttribute(m, "TaleWorlds.Library.DataSourceMethodAttribute"))
                            .Select(m => m.Name)
                            .ToList();

                        if (props.Count > 0 || methods.Count > 0)
                        {
                            viewModels.Add(new ViewModelInfoModel
                            {
                                name = type.Name,
                                properties = props,
                                methods = methods
                            });
                        }
                    }
                }
                catch (Exception ex)
                {
                    Console.Error.WriteLine($"Error loading view model assembly {asmName}: {ex.Message}");
                }
            }

            // Scan brushes and sprites
            var brushes = ScanBrushes(resourcePath);
            var sprites = ScanSprites(resourcePath);

            var schema = new SchemaModel
            {
                structuralTags = new List<string>
                {
                    "Prefab",
                    "Window",
                    "Children",
                    "Parameters",
                    "Parameter",
                    "Constants",
                    "Constant",
                    "Variables",
                    "VisualDefinitions",
                    "VisualDefinition",
                    "VisualState",
                    "CustomElements",
                    "ItemTemplate"
                },
                specialAttributes = new List<string>
                {
                    "Id",
                    "DataSource",
                    "Command.Click",
                    "Command.HoverBegin",
                    "Command.HoverEnd",
                    "CommandParameter.Click",
                    "CommandParameter.HoverBegin",
                    "CommandParameter.HoverEnd"
                },
                widgets = widgets,
                enums = enumsMap,
                brushes = brushes,
                sprites = sprites,
                viewModels = viewModels
            };

            var options = new JsonSerializerOptions { WriteIndented = true };
            string json = JsonSerializer.Serialize(schema, options);
            File.WriteAllText(outputPath, json);

            Console.WriteLine($"Schema successfully written to {outputPath}");
            Console.WriteLine($"Indexed {widgets.Count} widgets, {viewModels.Count} view models, {brushes.Count} brushes, {sprites.Count} sprites.");
        }

        static bool IsDerivedFrom(Type type, string targetFullName)
        {
            var current = type;
            while (current != null)
            {
                if (current.FullName == targetFullName)
                {
                    return true;
                }
                current = current.BaseType;
            }
            return false;
        }

        static bool HasAttribute(MemberInfo member, string attributeFullName)
        {
            try
            {
                foreach (var attr in member.CustomAttributes)
                {
                    if (attr.AttributeType.FullName == attributeFullName)
                    {
                        return true;
                    }
                }
            }
            catch { }
            return false;
        }

        static string propName(PropertyInfo p)
        {
            // If the property is nested/complex, we just return its name.
            return p.Name;
        }

        static List<string> ScanBrushes(string resourcePath)
        {
            var brushNames = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            if (string.IsNullOrEmpty(resourcePath) || !Directory.Exists(resourcePath))
                return new List<string>();

            var files = Directory.GetFiles(resourcePath, "*.xml", SearchOption.AllDirectories);
            foreach (var file in files)
            {
                var normalized = file.Replace('\\', '/');
                if (normalized.Contains("/GUI/Brushes/") || normalized.Contains("/Brushes/"))
                {
                    try
                    {
                        using var stream = File.OpenRead(file);
                        using var reader = XmlReader.Create(stream);
                        while (reader.Read())
                        {
                            if (reader.NodeType == XmlNodeType.Element && reader.Name == "Brush")
                            {
                                string name = reader.GetAttribute("Name") ?? reader.GetAttribute("id");
                                if (!string.IsNullOrEmpty(name))
                                {
                                    brushNames.Add(name);
                                }
                            }
                        }
                    }
                    catch { }
                }
            }
            return brushNames.OrderBy(b => b).ToList();
        }

        static List<SpriteInfoModel> ScanSprites(string resourcePath)
        {
            // Keyed by sprite name (case-insensitive) to deduplicate across files
            var spriteMap = new Dictionary<string, SpriteInfoModel>(StringComparer.OrdinalIgnoreCase);

            if (string.IsNullOrEmpty(resourcePath) || !Directory.Exists(resourcePath))
                return new List<SpriteInfoModel>();

            var files = Directory.GetFiles(resourcePath, "*.xml", SearchOption.AllDirectories);
            foreach (var file in files)
            {
                if (!Path.GetFileName(file).Contains("SpriteData", StringComparison.OrdinalIgnoreCase))
                    continue;

                try
                {
                    var doc = XDocument.Load(file);

                    // 1. Index all SpritePart entries by their Name
                    //    SpritePart/Name is e.g. "BannerBuilder\align_center"
                    var spriteParts = new Dictionary<string, SpriteInfoModel>(StringComparer.OrdinalIgnoreCase);
                    var spritePartsSection = doc.Descendants().Where(el => el.Name.LocalName == "SpritePart"
                        && el.Parent?.Name.LocalName == "SpriteParts");

                    foreach (var part in spritePartsSection)
                    {
                        string partName = part.Element("Name")?.Value;
                        if (string.IsNullOrEmpty(partName))
                            continue;

                        int.TryParse(part.Element("Width")?.Value, out int w);
                        int.TryParse(part.Element("Height")?.Value, out int h);
                        int.TryParse(part.Element("SheetX")?.Value, out int sx);
                        int.TryParse(part.Element("SheetY")?.Value, out int sy);
                        int.TryParse(part.Element("SheetID")?.Value, out int sheetId);
                        string category = part.Element("CategoryName")?.Value ?? "";

                        spriteParts[partName] = new SpriteInfoModel
                        {
                            name = partName, // placeholder, will be overwritten if a Sprite entry references it
                            categoryName = category,
                            sheetId = sheetId,
                            x = sx,
                            y = sy,
                            width = w,
                            height = h
                        };
                    }

                    // 2. Parse the <Sprites> section: <SpriteGeneric> and <NineRegionSprite>
                    //    These map a human-readable Name to a SpritePartName.
                    var referencedParts = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                    var spritesSection = doc.Descendants().Where(el =>
                        (el.Name.LocalName == "SpriteGeneric" || el.Name.LocalName == "NineRegionSprite")
                        && el.Parent?.Name.LocalName == "Sprites");

                    foreach (var sprite in spritesSection)
                    {
                        string spriteName = sprite.Element("Name")?.Value;
                        string spritePartName = sprite.Element("SpritePartName")?.Value;
                        if (string.IsNullOrEmpty(spriteName))
                            continue;

                        if (!string.IsNullOrEmpty(spritePartName))
                            referencedParts.Add(spritePartName);

                        // Look up the SpritePart to get atlas coordinates
                        if (!string.IsNullOrEmpty(spritePartName) && spriteParts.TryGetValue(spritePartName, out var partInfo))
                        {
                            spriteMap[spriteName] = new SpriteInfoModel
                            {
                                name = spriteName,
                                categoryName = partInfo.categoryName,
                                sheetId = partInfo.sheetId,
                                x = partInfo.x,
                                y = partInfo.y,
                                width = partInfo.width,
                                height = partInfo.height
                            };
                        }
                        else
                        {
                            // Sprite entry with no matching part — add with zero coordinates
                            if (!spriteMap.ContainsKey(spriteName))
                            {
                                spriteMap[spriteName] = new SpriteInfoModel
                                {
                                    name = spriteName,
                                    categoryName = "",
                                    sheetId = 0,
                                    x = 0,
                                    y = 0,
                                    width = 0,
                                    height = 0
                                };
                            }
                        }
                    }

                    // 3. Include SpritePart entries not referenced by any Sprite entry
                    //    Use the leaf name (after the last backslash) as the sprite name
                    foreach (var kvp in spriteParts)
                    {
                        if (referencedParts.Contains(kvp.Key))
                            continue;

                        string leafName = kvp.Key;
                        int lastSlash = kvp.Key.LastIndexOf('\\');
                        if (lastSlash >= 0 && lastSlash < kvp.Key.Length - 1)
                        {
                            leafName = kvp.Key.Substring(lastSlash + 1);
                        }

                        if (!spriteMap.ContainsKey(leafName))
                        {
                            var info = kvp.Value;
                            spriteMap[leafName] = new SpriteInfoModel
                            {
                                name = leafName,
                                categoryName = info.categoryName,
                                sheetId = info.sheetId,
                                x = info.x,
                                y = info.y,
                                width = info.width,
                                height = info.height
                            };
                        }
                    }
                }
                catch { }
            }
            return spriteMap.Values.OrderBy(s => s.name).ToList();
        }

        static void ExtractSheet(string gameBinPath, string resourcePath, string sheetName, string outputPath, int cropX = 0, int cropY = 0, int cropW = 0, int cropH = 0)
        {
            try
            {
                var tpacPaths = new List<string>();
                
                if (!string.IsNullOrEmpty(gameBinPath) && Directory.Exists(gameBinPath))
                {
                    string gameRoot = Path.GetFullPath(Path.Combine(gameBinPath, "..", ".."));
                    string modulesPath = Path.Combine(gameRoot, "Modules");
                    if (Directory.Exists(modulesPath))
                    {
                        tpacPaths.AddRange(Directory.GetFiles(modulesPath, "gauntlet_ui.tpac", SearchOption.AllDirectories));
                    }
                }

                if (!string.IsNullOrEmpty(resourcePath) && Directory.Exists(resourcePath))
                {
                    foreach (var file in Directory.GetFiles(resourcePath, "gauntlet_ui.tpac", SearchOption.AllDirectories))
                    {
                        if (!tpacPaths.Contains(file))
                        {
                            tpacPaths.Add(file);
                        }
                    }
                }

                if (tpacPaths.Count == 0)
                {
                    Console.Error.WriteLine("Error: Could not locate any gauntlet_ui.tpac files.");
                    Environment.Exit(1);
                }

                TpacTool.Lib.Texture? targetTexture = null;
                string foundTpacPath = "";

                foreach (var tpacPath in tpacPaths)
                {
                    try
                    {
                        Console.WriteLine($"Checking TPAC file: {tpacPath}");
                        var package = new TpacTool.Lib.AssetPackage(tpacPath, true, false);
                        var textures = package.Items.OfType<TpacTool.Lib.Texture>().ToList();
                        Console.WriteLine("Textures: " + string.Join(", ", textures.Select(t => $"{t.Name}({t.Width}x{t.Height})")));
                        var texture = textures.FirstOrDefault(t => t.Name.Equals(sheetName, StringComparison.OrdinalIgnoreCase));

                        if (texture != null)
                        {
                            targetTexture = texture;
                            foundTpacPath = tpacPath;
                            break;
                        }
                    }
                    catch { }
                }

                if (targetTexture == null)
                {
                    Console.WriteLine($"Texture '{sheetName}' not found in gauntlet_ui.tpac. Scanning all TPAC files in Modules...");
                    if (!string.IsNullOrEmpty(gameBinPath) && Directory.Exists(gameBinPath))
                    {
                        string gameRoot = Path.GetFullPath(Path.Combine(gameBinPath, "..", ".."));
                        string modulesPath = Path.Combine(gameRoot, "Modules");
                        if (Directory.Exists(modulesPath))
                        {
                            var allTpacFiles = Directory.GetFiles(modulesPath, "*.tpac", SearchOption.AllDirectories);
                            foreach (var tpacPath in allTpacFiles)
                            {
                                try
                                {
                                    var package = new TpacTool.Lib.AssetPackage(tpacPath, true, false);
                                    var textures = package.Items.OfType<TpacTool.Lib.Texture>().ToList();
                                    var texture = textures.FirstOrDefault(t => t.Name.Equals(sheetName, StringComparison.OrdinalIgnoreCase));

                                    if (texture != null)
                                    {
                                        targetTexture = texture;
                                        foundTpacPath = tpacPath;
                                        Console.WriteLine($"Found '{sheetName}' in '{tpacPath}'!");
                                        break;
                                    }
                                }
                                catch { }
                            }
                        }
                    }
                }

                if (targetTexture == null)
                {
                    Console.Error.WriteLine($"Error: Texture '{sheetName}' not found in any TPAC files.");
                    Environment.Exit(2);
                }

                Console.WriteLine($"Found sheet '{targetTexture.Name}' in '{foundTpacPath}' ({targetTexture.Width}x{targetTexture.Height}, format: {targetTexture.Format}).");
                string? dir = Path.GetDirectoryName(outputPath);
                if (!string.IsNullOrEmpty(dir) && !Directory.Exists(dir))
                {
                    Directory.CreateDirectory(dir);
                }

                Console.WriteLine($"Exporting to: {outputPath} (Crop: {cropW}x{cropH} at {cropX},{cropY})");
                TpacTool.IO.TextureExporter.ExportToFile(outputPath, targetTexture, TpacTool.IO.TextureExporter.TextureExportOption.NoMipmap, cropX, cropY, cropW, cropH);
                Console.WriteLine("Extraction complete!");
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine($"Error during sheet extraction: {ex.Message}");
                Console.Error.WriteLine(ex.StackTrace);
                Environment.Exit(3);
            }
        }
    }
}
