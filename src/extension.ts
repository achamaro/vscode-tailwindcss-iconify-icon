import {
  generateSvgDataUri,
  parseSvg,
} from "@achamaro/tailwindcss-iconify-icon";
import { existsSync } from "fs";
import { readFile } from "fs/promises";
import { sync } from "glob";
import { minimatch } from "minimatch";
import { basename, resolve } from "path";
import { throttle } from "throttle-debounce";
import {
  ColorThemeKind,
  CompletionItem,
  CompletionItemKind,
  DecorationOptions,
  DecorationRangeBehavior,
  ExtensionContext,
  FileCreateEvent,
  Hover,
  languages,
  MarkdownString,
  Position,
  Range,
  TextDocument,
  TextEditorDecorationType,
  Uri,
  window,
  workspace,
  WorkspaceFolder,
} from "vscode";

export function activate(context: ExtensionContext) {
  // Get the window configuration.
  const config = workspace.getConfiguration(
    "tailwindcssIconifyIconIntelliSense"
  );

  // Clear icons when the configuration changes.
  workspace.onDidChangeConfiguration(
    (e) => {
      if (e.affectsConfiguration("tailwindcssIconifyIconIntelliSense")) {
        clearIcons();
      }
    },
    null,
    context.subscriptions
  );

  // Add icons when a file is created.
  workspace.onDidCreateFiles(
    ({ files }: FileCreateEvent) => {
      files
        .filter(({ path }) => path.endsWith(".json") || path.endsWith(".svg"))
        .forEach((file) => {
          const config = getConfig(file);
          const workspaceFolder = workspace.getWorkspaceFolder(file)!;
          const iconDir = getIconDir(file);
          const icons = getIcons(workspaceFolder);

          const { path } = file;

          if (path.endsWith(".svg")) {
            for (const [name, v] of Object.entries(
              config.get("customSvg") ?? {}
            )) {
              const pattern = resolve(workspaceFolder.uri.path, v, "*.svg");
              if (minimatch(path, pattern)) {
                icons.set(parseCustomSvgPath(path, name), path);
                return;
              }
            }
          }

          const pattern = resolve(
            workspaceFolder.uri.path,
            iconDir,
            "*/*.{json,svg}"
          );
          if (minimatch(path, pattern)) {
            icons.set(parseIconPath(path), path);
          }
        });
    },
    null,
    context.subscriptions
  );

  // Decoration
  const workspaceDecorationTypes = new Map<
    string,
    Map<string, Promise<TextEditorDecorationType>>
  >();
  function getDecorationTypes(workspaceFolder: WorkspaceFolder) {
    const name = workspaceFolder.name;
    if (!workspaceDecorationTypes.has(name)) {
      workspaceDecorationTypes.set(name, new Map());
    }
    return workspaceDecorationTypes.get(name)!;
  }

  // The decoration type for hiding the icon name text.
  // https://github.com/lokalise/i18n-ally/blob/43df97db80073230e528b7bf63610c903d886df8/src/editor/annotation.ts#L13-L15
  const hiddenDecorationType = window.createTextEditorDecorationType({
    textDecoration: `none; display: none;`,
  });

  const updateDecorations = throttle(1000, async () => {
    const editor = window.activeTextEditor;
    if (!editor) {
      return;
    }

    const { document, selection } = editor;
    const text = document.getText();

    const workspaceFolder = workspace.getWorkspaceFolder(document.uri);
    if (!workspaceFolder) {
      return;
    }

    const icons = getIcons(workspaceFolder);
    const decorationTypes = getDecorationTypes(workspaceFolder);

    // Search icon strings in the active editor.
    const matches = text.matchAll(/i-\[([\w/_-]+)]/g);

    const decorations: Map<TextEditorDecorationType, DecorationOptions[]> =
      new Map();
    const hideOptions: Range[] = [];
    const promises = [...matches].map(async (match) => {
      const name = match[1];
      // If `name` is not set, try to find the icon from the directory.
      const icon = icons.get(name) ?? retrieveIcon(workspaceFolder, name);
      if (!icon) {
        return;
      }

      if (!decorationTypes.has(name)) {
        decorationTypes.set(
          name,
          new Promise(async (resolve) => {
            let data = await createIconDataUri(icon);
            data = data.replace(/ xmlns/, ` height=\'0.8em\' xmlns`);
            resolve(
              window.createTextEditorDecorationType({
                before: {
                  contentIconPath: Uri.parse(data),
                  margin:
                    "0 1px; padding: 0 1px; transform: translateY(-1px); display: inline-block; vertical-align: middle",
                  backgroundColor: "rgb(255 255 255 / 10%)",
                  border:
                    "1px solid rgb(255 255 255 / 20%); border-radius: 2px;",
                  height: "1.2em",
                },
                rangeBehavior: DecorationRangeBehavior.ClosedClosed,
              })
            );
          })
        );
      }
      const decorationType = await decorationTypes.get(name)!;

      if (!decorations.has(decorationType)) {
        decorations.set(decorationType, []);
      }
      const options = decorations.get(decorationType)!;

      const range = new Range(
        editor.document.positionAt(match.index! + 3),
        editor.document.positionAt(match.index! + match[0].length - 1)
      );

      options.push({
        range,
      });

      if (
        !new Range(
          editor.document.positionAt(match.index!),
          editor.document.positionAt(match.index! + match[0].length)
        ).contains(selection)
      ) {
        hideOptions.push(range);
      }
    });

    // Wait for all decoration types to be created.
    await Promise.all(promises);

    (await Promise.all([...decorationTypes.values()])).forEach((type) => {
      editor.setDecorations(type, decorations.get(type) ?? []);
    });

    editor.setDecorations(hiddenDecorationType, hideOptions);
  });

  updateDecorations();

  window.onDidChangeActiveTextEditor(
    updateDecorations,
    null,
    context.subscriptions
  );
  window.onDidChangeTextEditorSelection(
    updateDecorations,
    null,
    context.subscriptions
  );
  workspace.onDidChangeTextDocument(
    ({ document }) => {
      if (document === window.activeTextEditor?.document) {
        updateDecorations();
      }
    },
    null,
    context.subscriptions
  );

  // Completion
  const itemSource = new WeakMap<CompletionItem, string>();
  context.subscriptions.push(
    languages.registerCompletionItemProvider(
      config.get("targetLanguage")!,
      {
        provideCompletionItems(document: TextDocument, position: Position) {
          const line = document
            .lineAt(position)
            .text.slice(0, position.character);

          const icons = getIcons(workspace.getWorkspaceFolder(document.uri)!);

          const match = line.match(/i-(?:\[[\w/_-]*)?]?$/);
          if (!match) {
            return undefined;
          }

          const range = new Range(
            new Position(position.line, position.character - match[0].length),
            position
          );

          return [...icons].map(([name, path]) => {
            const c = new CompletionItem(
              `i-[${name}]`,
              CompletionItemKind.Constant
            );
            c.range = range;
            c.detail = name;

            // Set the icon path to be used for resolving the icon path in the resolveCompletionItem method.
            itemSource.set(c, path);

            return c;
          });
        },

        async resolveCompletionItem(item) {
          const path = itemSource.get(item);
          if (path) {
            item.documentation = await createIconDocument(path);
          }
          return item;
        },
      },
      "-",
      "["
    )
  );

  // Hover
  context.subscriptions.push(
    languages.registerHoverProvider(config.get("targetLanguage")!, {
      async provideHover(document, position) {
        let wordRange = document.getWordRangeAtPosition(position, /[\w[\]/-]+/);
        if (wordRange === undefined) {
          return undefined;
        }

        let currentWord = document
          .lineAt(position.line)
          .text.slice(wordRange.start.character, wordRange.end.character);

        const match = currentWord.match(/i-\[([\w/_-]+)]$/);
        if (!match) {
          return undefined;
        }

        const icon = match[1];

        // Get the icons in the workspace folder.
        const workspaceFolder = workspace.getWorkspaceFolder(document.uri)!;
        const icons = getIcons(workspaceFolder);

        const path = icons.get(icon);
        if (!path) {
          return undefined;
        }

        return new Hover(await createIconDocument(path));
      },
    })
  );
}

export function deactivate() {}

const workspaceIcons = new Map<string, Map<string, string>>();

/**
 * Get the list of icons in the specified workspace folder.
 * @param workspaceFolder - Target workspace folder
 * @returns A map of listed icons in the workspace folder.
 */
function getIcons(workspaceFolder: WorkspaceFolder): Map<string, string> {
  const { name } = workspaceFolder;

  if (!workspaceIcons.has(name)) {
    workspaceIcons.set(name, retrieveIconList(workspaceFolder));
  }
  return workspaceIcons.get(name)!;
}

/**
 * Clears all stored icons.
 */
function clearIcons() {
  workspaceIcons.clear();
}

/**
 * Retrieves a list of icons in the specified workspace folder.
 * @param workspaceFolder - The workspace folder to search for icons.
 * @returns A map of listed icons in the workspace folder.
 */
function retrieveIconList(workspaceFolder: WorkspaceFolder) {
  const { uri } = workspaceFolder;

  const icons = new Map<string, string>();

  const config = getConfig(uri);
  const iconDir = getIconDir(uri);

  const iconDirIcons = sync(resolve(uri.path, iconDir, "*/*.{json,svg}"));
  iconDirIcons.forEach((v) => {
    icons.set(parseIconPath(v), v);
  });

  const customIcons = [
    ...Object.entries(config.get("customSvg") ?? {}).map(
      ([k, v]) => [k, sync(resolve(uri.path, v, "*.svg"))] as const
    ),
  ];
  customIcons.forEach(([name, customIcons]) => {
    customIcons.forEach((v) => {
      icons.set(parseCustomSvgPath(v, name), v);
    });
  });

  return icons;
}

function retrieveIcon(workspaceFolder: WorkspaceFolder, name: string) {
  const { uri } = workspaceFolder;
  const config = getConfig(uri);
  const icons = getIcons(workspaceFolder);
  const iconDir = getIconDir(uri);

  let path;

  // retrieve the json file from the download directory.
  path = resolve(uri.path, iconDir, `${name}.{json,svg}`);
  if (existsSync(path)) {
    icons.set(name, path);
    return path;
  }

  // retrieve the svg file from the custom svg directory.
  const [svgSet, svgName] = name.split("/");
  const customSvg: Record<string, string> = config.get("customSvg") ?? {};

  if (customSvg[svgSet]) {
    path = resolve(uri.path, customSvg[svgSet], `${svgName}.svg`);
    if (existsSync(path)) {
      icons.set(name, path);
      return path;
    }
  }
}

/**
 * Retrieves the icon name from the icon file path.
 * @param path - The path of the icon file.
 * @returns The icon name.
 */
function parseIconPath(path: string) {
  return path
    .replace(/\.(json|svg)$/, "")
    .split("/")
    .slice(-2)
    .join("/");
}

/**
 * Retrieves the icon name from the icon file path and icon set name.
 * @param path - The path of the icon file.
 * @param name - The name of the icon set.
 * @returns The name icon.
 */
function parseCustomSvgPath(path: string, name: string) {
  return `${name}/${basename(path, ".svg")}`;
}

/**
 * Retrieves the extension configuration.
 * @param uri - The URI of the workspace folder.
 * @returns The extension configuration.
 */
function getConfig(uri: Uri) {
  return workspace.getConfiguration("tailwindcssIconifyIconIntelliSense", uri);
}

function getIconDir(uri: Uri): string {
  const config = getConfig(uri);
  return (
    config.get("iconDir") || config.get("downloadDir") || "src/assets/icons"
  );
}

/**
 * Create a MarkdownString that includes an icon image.
 * @param path - The path of the icon file.
 * @returns A MarkdownString that includes the icon image.
 */
async function createIconDocument(path: string) {
  const data = await createIconDataUri(path);

  const documentation = new MarkdownString();
  documentation.supportHtml = true;
  documentation.value = `<img src="${data}" height="56" />`;

  return documentation;
}

/**
 * Create a data URI of the icon.
 * @param path - The path of the icon file.
 * @returns A data URI of the icon.
 */
async function createIconDataUri(path: string) {
  const content = await readFile(path, "utf-8");
  let data;
  if (path.endsWith(".json")) {
    data = generateSvgDataUri(JSON.parse(content));
  } else {
    data = parseSvg(content).data;
  }

  if (isDark()) {
    data = data.replace(/currentColor/g, "ivory");
  }

  return data;
}

/**
 * Determines whether the active theme is dark.
 * @returns True if the active theme is dark, false otherwise.
 */
function isDark() {
  return window.activeColorTheme.kind === ColorThemeKind.Dark;
}
