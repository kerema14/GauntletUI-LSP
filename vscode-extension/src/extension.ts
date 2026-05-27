import * as path from 'path';
import * as os from 'os';
import * as vscode from 'vscode';
import { LanguageClient, LanguageClientOptions, ServerOptions, TransportKind } from 'vscode-languageclient/node';

let client: LanguageClient;

export function activate(context: vscode.ExtensionContext) {
    const serverModule = context.asAbsolutePath(path.join('dist', 'server.js'));

    const serverOptions: ServerOptions = {
        run: { module: serverModule, transport: TransportKind.ipc },
        debug: {
            module: serverModule,
            transport: TransportKind.ipc,
            options: { execArgv: ['--nolazy', '--inspect=6009'] }
        }
    };

    const clientOptions: LanguageClientOptions = {
        documentSelector: [{ scheme: 'file', language: 'xml' }],
        synchronize: {
            fileEvents: vscode.workspace.createFileSystemWatcher('**/*.xml')
        },
        markdown: {
            isTrusted: true,
            supportHtml: true
        },
        middleware: {
            provideHover: async (document, position, token, next) => {
                const hover = await next(document, position, token);
                if (hover && hover.contents) {
                    for (const content of hover.contents) {
                        if (typeof content === 'object' && 'value' in content) {
                            const markdown = content as vscode.MarkdownString;
                            markdown.isTrusted = true;
                            markdown.supportHtml = true;
                            
                            let cachePath = '';
                            const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
                            if (workspaceFolder) {
                                cachePath = path.join(workspaceFolder.uri.fsPath, '.gauntletui-cache');
                            } else {
                                cachePath = path.join(os.tmpdir(), '.gauntletui-cache');
                            }
                            // baseUri needs a trailing separator to correctly resolve relative paths in Markdown
                            markdown.baseUri = vscode.Uri.file(cachePath + '/');
                        }
                    }
                }
                return hover;
            }
        }
    };

    client = new LanguageClient(
        'gauntletuiLanguageServer',
        'GauntletUI LSP Server',
        serverOptions,
        clientOptions
    );

    client.start();
}

export function deactivate(): Thenable<void> | undefined {
    if (!client) {
        return undefined;
    }
    return client.stop();
}
