import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ExtensionContext, TextDocument, DiagnosticCollection, WorkspaceConfiguration, LogOutputChannel } from 'vscode';
import * as vscode from 'vscode';
import Ajv, { ValidateFunction } from 'ajv';
import type { ExtensionConfiguration, BinaryCommand, TemplateValidatorResult } from './types';
import { binaryCandidates, readableCommand, runCommand } from './typo3Binary';
import { clearViewHelperIndexCache, createViewHelperDefinitionProvider } from './viewHelpers';

const ajv = new Ajv();

/** Binary found for a workspace folder, together with the analysis that proved it works */
interface AnalyzeBinaryDiscovery {
    command: BinaryCommand,
    input: string,
    result: TemplateValidatorResult,
}

const config: ExtensionConfiguration = {
    bin: {
        typo3: {
            path: '',
            args: [],
        },
        fluid: {
            path: '',
            args: [],
        },
        useDdevIfAvailable: true,
        timeout: 10,
    },
    features: {
        liveTemplateAnalysis: true,
        viewHelperDefinitions: true,
    }
}
let binaryPathCache: { [key: string]: BinaryCommand} = {};
const binaryDiscoveries = new Map<string, Promise<AnalyzeBinaryDiscovery|null>>();
let validateFluidAnalyzeResult: ValidateFunction<TemplateValidatorResult>;
let diagnosticCollection: DiagnosticCollection;
let logChannel: LogOutputChannel;

export async function activate(ctx: ExtensionContext) {
    // Create JSON schema validator
    const fluidAnalyzeResultSchema = JSON.parse(fs.readFileSync(path.join(ctx.extensionPath, 'client', 'fluidAnalyze.schema.json'), 'utf-8'));
    validateFluidAnalyzeResult = ajv.compile<TemplateValidatorResult>(fluidAnalyzeResultSchema);

    // Create log
    logChannel = vscode.window.createOutputChannel('Fluid Language', { log: true });
    logChannel.clear();
    ctx.subscriptions.push(logChannel);

    // Read extension configuration
    initializeConfiguration(vscode.workspace.getConfiguration('fluid'));
    ctx.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('fluid')) {
            initializeConfiguration(vscode.workspace.getConfiguration('fluid'));
            // Clear runtime caches on configuration changes
            binaryPathCache = {};
            binaryDiscoveries.clear();
            clearViewHelperIndexCache();
        }
    }));

    // Register go to definition for ViewHelpers
    ctx.subscriptions.push(vscode.languages.registerDefinitionProvider(
        ['fluid', 'html-fluid'],
        createViewHelperDefinitionProvider(() => config.features.viewHelperDefinitions, logChannel),
    ));
    // Installing or removing packages changes which ViewHelpers exist
    for (const pattern of [
        '**/Configuration/Fluid/Namespaces.php',
        '**/ext_localconf.php',
        '**/composer/autoload_psr4.php',
    ]) {
        const watcher = vscode.workspace.createFileSystemWatcher(pattern);
        watcher.onDidCreate(clearViewHelperIndexCache);
        watcher.onDidChange(clearViewHelperIndexCache);
        watcher.onDidDelete(clearViewHelperIndexCache);
        ctx.subscriptions.push(watcher);
    }

    // Register as diagnostics provider
    diagnosticCollection = vscode.languages.createDiagnosticCollection('fluid');
    ctx.subscriptions.push(diagnosticCollection);
    ctx.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(editor => {
        if (editor) {
            updateDiagnostics(editor.document, diagnosticCollection);
        }
    }));
    ctx.subscriptions.push(vscode.workspace.onDidChangeTextDocument(e => {
        if (e.document && e.document.uri) {
            updateDiagnostics(e.document, diagnosticCollection);
        }
    }));
    if (vscode.window.activeTextEditor) {
        updateDiagnostics(vscode.window.activeTextEditor.document, diagnosticCollection);
    }
}

function initializeConfiguration(configuration: WorkspaceConfiguration): void {
    config.bin.fluid.path = configuration.get('bin.fluid.path') ?? '';
    config.bin.fluid.args = configuration.get('bin.fluid.args') ?? [];
    config.bin.typo3.path = configuration.get('bin.typo3.path') ?? '';
    config.bin.typo3.args = configuration.get('bin.typo3.args') ?? [];
    config.bin.useDdevIfAvailable = configuration.get('bin.useDdevIfAvailable') ?? true;
    config.bin.timeout = configuration.get('bin.timeout') ?? 10;
    config.features.liveTemplateAnalysis = configuration.get('features.liveTemplateAnalysis') ?? true;
    config.features.viewHelperDefinitions = configuration.get('features.viewHelperDefinitions') ?? true;
}

// TODO consider debouncing per document
const updateDiagnostics = debounce(async (document: TextDocument, collection: DiagnosticCollection) => {
    if (!vscode.workspace.isTrusted || !config.features.liveTemplateAnalysis) {
        return;
    }
    const version = document.version;
    const analyzeResult = await analyzeTemplate(document);
    // The document has changed in the meantime, a newer analysis is already on its way
    if (document.version !== version) {
        return;
    }
    if (!analyzeResult) {
        collection.delete(document.uri);
        if (analyzeResult === false) {
            const typo3Version = await detectTypo3Version(document);
            if (typo3Version === 12 || typo3Version === 13) {
                vscode.window.showInformationMessage(
                    `To be able to provide live analysis for Fluid templates in TYPO3 ${typo3Version}, a companion TYPO3 extension needs to be installed.`,
                    { identifier: 'more', title: 'Learn more' },
                    { identifier: 'disable', title: 'Disable for workspace' },
                ).then(userOption => {
                    switch (userOption?.identifier) {
                        case 'more':
                            vscode.env.openExternal(
                                vscode.Uri.parse('https://extensions.typo3.org/extension/fluid_companion'),
                            );
                            break;

                        case 'disable':
                            vscode.workspace.getConfiguration('fluid.features').update(
                                'liveTemplateAnalysis',
                                false,
                                vscode.ConfigurationTarget.Workspace
                            );
                            break;
                    }
                });
                return;
            }

            if (typo3Version && typo3Version < 12) {
                vscode.window.showInformationMessage(
                    `Live analysis for Fluid templates is not compatible with TYPO3 ${typo3Version}.`,
                    { identifier: 'disable', title: 'Disable for workspace' },
                ).then(userOption => {
                    switch (userOption?.identifier) {
                        case 'disable':
                            vscode.workspace.getConfiguration('fluid.features').update(
                                'liveTemplateAnalysis',
                                false,
                                vscode.ConfigurationTarget.Workspace
                            );
                            break;
                    }
                });
                return;
            }

            logChannel.info('Try increasing the log level to "debug" to get more information about the issue.');
            vscode.window.showInformationMessage(
                'Unable to provide live analysis for Fluid templates in this workspace.',
                { identifier: 'configure', title: 'Configure manually' },
                { identifier: 'showlog', title: 'Show log' },
                { identifier: 'disable', title: 'Disable for workspace' },
            ).then(userOption => {
                switch (userOption?.identifier) {
                    case 'configure':
                        vscode.commands.executeCommand(
                            'workbench.action.openWorkspaceSettings',
                            'fluid.bin'
                        );
                        break;

                    case 'showlog':
                        logChannel.show();
                        break;

                    case 'disable':
                        vscode.workspace.getConfiguration('fluid.features').update(
                            'liveTemplateAnalysis',
                            false,
                            vscode.ConfigurationTarget.Workspace
                        );
                        break;
                }
            });
        }
        return;
    }
    const errors = analyzeResult.errors.map(error => {
        // Remove redundant information from parser exception messages
        const matches = error.message.match(/Fluid parse error in template .+?, line [0-9]+ at character [0-9]+. Error: (.*?)(?: Template source chunk:|$)/s);
        // Extract position information from result if provided
        const position = error.templateLocation
            ? new vscode.Position(Number(error.templateLocation?.line ?? 1) - 1, Number(error.templateLocation?.character ?? 1) - 1)
            : new vscode.Position(0, 0);
        return new vscode.Diagnostic(
            new vscode.Range(position, position),
            (matches && matches[1]) ? matches[1] : error.message,
            vscode.DiagnosticSeverity.Error,
        );
    });
    const deprecations = analyzeResult.deprecations.map(deprecation => {
        // We currently have no template position information for deprecations
        const position = new vscode.Position(0, 0);
        return new vscode.Diagnostic(
            new vscode.Range(position, position),
            deprecation.message + ' (' + deprecation.file + ' in line ' + deprecation.line + ')',
            vscode.DiagnosticSeverity.Information,
        );
    });
    collection.set(document.uri, [...errors, ...deprecations]);
}, 300);

/**
 * @returns null if the template cannot or need not be analyzed, false if no binary
 *          to analyze it could be found in its workspace folder
 */
async function analyzeTemplate(document: TextDocument): Promise<TemplateValidatorResult|null|false> {
    if (document.uri.scheme !== 'file' || (document.languageId !== 'fluid' && document.languageId !== 'html-fluid')) {
        return null;
    }
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath;
    if (!workspaceFolder) {
        return null;
    }
    const input = document.getText();

    // Try to get right binary from runtime cache
    if (binaryPathCache[workspaceFolder]) {
        const data = await tryAndVerifyAnalyzeCommand(binaryPathCache[workspaceFolder], input, workspaceFolder);
        if (data) {
            return data;
        }
    }

    // Analyses started while another one is still looking for a binary wait for it,
    // so that the candidates are tried, and a failure is reported, only once
    const pending = binaryDiscoveries.get(workspaceFolder);
    if (pending) {
        const discovery = await pending;
        if (!discovery) {
            return null;
        }
        return discovery.input === input
            ? discovery.result
            : tryAndVerifyAnalyzeCommand(discovery.command, input, workspaceFolder);
    }

    const discovery = discoverAnalyzeBinary(workspaceFolder, input);
    binaryDiscoveries.set(workspaceFolder, discovery);
    const found = await discovery;
    // Only store the result if the configuration has not been changed in the meantime
    if (binaryDiscoveries.get(workspaceFolder) === discovery) {
        binaryDiscoveries.delete(workspaceFolder);
        if (found) {
            binaryPathCache[workspaceFolder] = found.command;
        }
    }
    return found ? found.result : false;
}

/** Go through binary alternatives to find the best candidate */
async function discoverAnalyzeBinary(workspaceFolder: string, input: string): Promise<AnalyzeBinaryDiscovery|null> {
    const candidates = binaryCandidates(workspaceFolder, config, {
        typo3: ['fluid:analyze', '--json', '--stdin'],
        fluid: ['analyze', '--json', '--stdin'],
    });

    for (const candidate of candidates) {
        const data = await tryAndVerifyAnalyzeCommand(candidate, input, workspaceFolder);
        if (data) {
            logChannel.info(
                `Using "${readableCommand(candidate)}" as binary to analyze templates in "${workspaceFolder}".`,
            );
            return { command: candidate, input, result: data };
        }
    }
    const unavailableBinaries = candidates.map(readableCommand).join("\n");
    logChannel.error(`Unable to find suitable fluid binary for templates in "${workspaceFolder}. Usual binaries are not available: \n${unavailableBinaries}`)
    return null;
}

async function detectTypo3Version(document: TextDocument): Promise<number|null>
{
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath;
    if (!workspaceFolder) {
        return null;
    }

    // Go through binary alternatives to find the best candidate
    // TODO optimize this to avoid duplicate calls to non-existent binaries
    for (const candidate of binaryCandidates(workspaceFolder, config, { typo3: ['--version'] })) {
        const result = await runCommand(candidate, workspaceFolder, binaryTimeout());
        const versionMatch = result.stdout.match(/TYPO3 CMS ([0-9]+)\.[0-9]+\.[0-9]+/);
        if (versionMatch && versionMatch[1]) {
            return Number(versionMatch[1]);
        }
    }
    return null;
}

async function tryAndVerifyAnalyzeCommand(command: BinaryCommand, input: string, cwd: string): Promise<TemplateValidatorResult|null> {
    const commandLine = readableCommand(command);
    const { stdout, stderr, status } = await runCommand(command, cwd, binaryTimeout(), input);
    try {
        const data = JSON.parse(stdout);
        if (validateFluidAnalyzeResult(data)) {
            return data;
        } else if (command.userDefined && validateFluidAnalyzeResult.errors) {
            // Log validation errors for user-defined binaries to help with debugging
            const errorMessages = validateFluidAnalyzeResult.errors.map(error => error.message).join('. ');
            logChannel.error(`JSON validation failed while executing user-defined fluid binary "${commandLine}" in workspace folder "${cwd}": ${errorMessages}`);
        }
    } catch (error) {
        // Log errors for user-defined binaries to help with debugging
        if (command.userDefined) {
            logChannel.error(`Error while executing user-defined fluid binary "${commandLine}" in workspace folder "${cwd}": ${stderr.trim() || error}`);
        }
    }
    if (stdout) {
        logChannel.debug(`Possible fluid binary "${commandLine}" in workspace folder "${cwd}" returned invalid result: ${stdout}`);
    } else if (stderr) {
        logChannel.debug(`Possible fluid binary "${commandLine}" in workspace folder "${cwd}" returned error message: ${stderr}`);
    } else {
        logChannel.debug(`Possible fluid binary "${commandLine}" in workspace folder "${cwd}" returned error code: ${status}`);
    }
    return null;
}

/**
 * Binaries are run on every pause while typing, so a hanging one must not block
 * analysis forever. Settings edited as JSON bypass the schema, so the value is checked here.
 */
function binaryTimeout(): number {
    const seconds = Number(config.bin.timeout);
    return Number.isFinite(seconds) ? Math.max(1, seconds) * 1000 : 10000;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function debounce(callback: any, wait: number): any {
  let timeoutId: NodeJS.Timeout;
  return (...args: any[]) => {
    clearTimeout(timeoutId);
    timeoutId = setTimeout(() => {
      callback(...args);
    }, wait);
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */
