import {
  generateSvgDataUri,
  parseSvg,
} from "@achamaro/tailwindcss-iconify-icon";
import { readFile } from "fs/promises";
import { sync } from "glob";
import { minimatch } from "minimatch";
import { basename, resolve } from "path";
import {
  CompletionItem,
  CompletionItemKind,
  ExtensionContext,
  FileCreateEvent,
  Hover,
  languages,
  MarkdownString,
  Position,
  Range,
  TextDocument,
  Uri,
  workspace,
  WorkspaceFolder,
} from "vscode";

export function activate(context: ExtensionContext) {
  const config = workspace.getConfiguration(
    "tailwindcssIconifyIconIntelliSense"
  );

  // Clear icons when the configuration changes.
  context.subscriptions.push(
    workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("tailwindcssIconifyIconIntelliSense")) {
        clearIcons();
      }
    })
  );

  // Add icons when a file is created.
  context.subscriptions.push(
    workspace.onDidCreateFiles(({ files }: FileCreateEvent) => {
      files
        .filter(({ path }) => path.endsWith(".json") || path.endsWith(".svg"))
        .forEach((file) => {
          const config = getConfig(file);
          const workspaceFolder = workspace.getWorkspaceFolder(file)!;
          const icons = getIcons(workspaceFolder);

          const { path } = file;

          if (path.endsWith(".svg")) {
            for (const [name, v] of Object.entries(
              config.get("customSvg") ?? {}
            )) {
              const pattern = resolve(workspaceFolder.uri.path, v, "*.svg");
              if (minimatch(path, pattern)) {
                icons.set(parseSvgPath(path, name), path);
                return;
              }
            }
            return;
          }

          const pattern = resolve(
            workspaceFolder.uri.path,
            config.get("downloadDir")!,
            "*/*.json"
          );
          if (minimatch(path, pattern)) {
            icons.set(parseJsonPath(path), path);
          }
        });
    })
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
          let label;
          if (typeof item.label === "string") {
            label = item.label;
          } else {
            label = item.label.label;
          }

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

        const match = currentWord.match(/i-\[([^\]]+)]$/);
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

  const iconifyIcons = sync(
    resolve(uri.path, config.get("downloadDir")!, "*/*.json")
  );
  iconifyIcons.forEach((v) => {
    icons.set(parseJsonPath(v), v);
  });

  const customIcons = [
    ...Object.entries(config.get("customSvg") ?? {}).map(
      ([k, v]) => [k, sync(resolve(uri.path, v, "*.svg"))] as const
    ),
  ];
  customIcons.forEach(([name, customIcons]) => {
    customIcons.forEach((v) => {
      icons.set(parseSvgPath(v, name), v);
    });
  });

  return icons;
}

/**
 * Retrieves the icon name from the icon file path.
 * @param path - The path of the icon file.
 * @returns The icon name.
 */
function parseJsonPath(path: string) {
  return path
    .replace(/\.json$/, "")
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
function parseSvgPath(path: string, name: string) {
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

/**
 * Create a MarkdownString that includes an icon image.
 * @param path - The path of the icon file.
 * @returns A MarkdownString that includes the icon image.
 */
async function createIconDocument(path: string) {
  const content = await readFile(path, "utf-8");
  let data;
  if (path.endsWith(".json")) {
    data = generateSvgDataUri(JSON.parse(content));
  } else {
    data = parseSvg(content).data;
  }
  const documentation = new MarkdownString();
  documentation.supportHtml = true;
  documentation.value = `<img src="${data}" height="100" />`;

  return documentation;
}
