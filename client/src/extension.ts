import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ExtensionContext, TextDocument, DiagnosticCollection, WorkspaceConfiguration, LogOutputChannel } from 'vscode';
import * as vscode from 'vscode';
import Ajv, { ValidateFunction } from 'ajv';
import type { ExtensionConfiguration, BinaryCommand, TemplateValidatorResult, ViewHelperContext } from './types';
import { binaryCandidates, readableCommand } from './typo3Binary';
import { clearViewHelperIndexCache, createViewHelperDefinitionProvider, warmViewHelperIndex } from './viewHelpers';

const FLUID_LANGUAGES = ['fluid', 'html-fluid'];

const ajv = new Ajv();

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
    },
    features: {
        liveTemplateAnalysis: true,
        viewHelperDefinitions: true,
    }
}
let binaryPathCache: { [key: string]: BinaryCommand} = {};
let reportedNamespaceFailures = new Set<string>();
let viewHelperContext: ViewHelperContext;
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
            clearViewHelperCaches();
        }
    }));

    // Register go to definition for ViewHelpers
    viewHelperContext = {
        isEnabled: () => config.features.viewHelperDefinitions,
        candidates: (workspaceFolder, args) => binaryCandidates(workspaceFolder, config, { typo3: args }),
        onUnavailable: reportViewHelperNamespacesUnavailable,
        logChannel,
    };
    ctx.subscriptions.push(vscode.languages.registerDefinitionProvider(
        FLUID_LANGUAGES,
        createViewHelperDefinitionProvider(viewHelperContext),
    ));
    // Installing or removing packages, and reconfiguring TYPO3, changes which
    // ViewHelpers exist. Namespaces added by an event listener are invisible to
    // any watcher, which is what the reload command is there for.
    ctx.subscriptions.push(vscode.commands.registerCommand('fluid.reloadViewHelperIndex', () => {
        binaryPathCache = {};
        clearViewHelperCaches();
        warmOpenDocuments();
    }));
    for (const pattern of [
        '**/Configuration/Fluid/Namespaces.php',
        '**/ext_localconf.php',
        '**/composer/autoload_psr4.php',
        '**/composer.lock',
        '**/config/system/settings.php',
        '**/config/system/additional.php',
        '**/vendor/typo3/PackageArtifact.php',
    ]) {
        const watcher = vscode.workspace.createFileSystemWatcher(pattern);
        watcher.onDidCreate(clearViewHelperCaches);
        watcher.onDidChange(clearViewHelperCaches);
        watcher.onDidDelete(clearViewHelperCaches);
        ctx.subscriptions.push(watcher);
    }
    // Read the namespaces before the first lookup, which needs a moment
    ctx.subscriptions.push(vscode.workspace.onDidOpenTextDocument(warmDocument));
    warmOpenDocuments();

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
    config.features.liveTemplateAnalysis = configuration.get('features.liveTemplateAnalysis') ?? true;
    config.features.viewHelperDefinitions = configuration.get('features.viewHelperDefinitions') ?? true;
}

function clearViewHelperCaches(): void {
    clearViewHelperIndexCache();
    reportedNamespaceFailures = new Set<string>();
}

function warmDocument(document: TextDocument): void {
    if (document.uri.scheme !== 'file' || !FLUID_LANGUAGES.includes(document.languageId)) {
        return;
    }
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath;
    if (workspaceFolder) {
        warmViewHelperIndex(workspaceFolder, viewHelperContext);
    }
}

function warmOpenDocuments(): void {
    vscode.workspace.textDocuments.forEach(warmDocument);
}

/** Reported once per workspace folder, because navigation is silent otherwise. */
function reportViewHelperNamespacesUnavailable(workspaceFolder: string): void {
    if (reportedNamespaceFailures.has(workspaceFolder)) {
        return;
    }
    reportedNamespaceFailures.add(workspaceFolder);
    const typo3Version = detectTypo3Version(workspaceFolder);
    const options = [
        { identifier: 'showlog', title: 'Show log' },
        { identifier: 'disable', title: 'Disable for workspace' },
    ];
    let message = 'Unable to resolve ViewHelpers in this workspace. This requires TYPO3 14.2 or newer, '
        + 'or the companion TYPO3 extension in TYPO3 12 and 13.';
    if (typo3Version === 12 || typo3Version === 13) {
        message = `To be able to resolve ViewHelpers in TYPO3 ${typo3Version}, a companion TYPO3 extension `
            + 'needs to be installed.';
        options.unshift({ identifier: 'more', title: 'Learn more' });
    } else if (typo3Version && typo3Version < 12) {
        message = `Resolving ViewHelpers is not compatible with TYPO3 ${typo3Version}.`;
    }
    logChannel.info('Try increasing the log level to "debug" to get more information about the issue.');
    vscode.window.showInformationMessage(message, ...options).then(userOption => {
        switch (userOption?.identifier) {
            case 'more':
                vscode.env.openExternal(
                    vscode.Uri.parse('https://extensions.typo3.org/extension/fluid_companion'),
                );
                break;

            case 'showlog':
                logChannel.show();
                break;

            case 'disable':
                vscode.workspace.getConfiguration('fluid.features').update(
                    'viewHelperDefinitions',
                    false,
                    vscode.ConfigurationTarget.Workspace
                );
                break;
        }
    });
}

// TODO consider debouncing per document
const updateDiagnostics = debounce((document: TextDocument, collection: DiagnosticCollection) => {
    if (!vscode.workspace.isTrusted || !config.features.liveTemplateAnalysis) {
        return;
    }
    const analyzeResult = analyzeTemplate(document);
    if (!analyzeResult) {
        collection.delete(document.uri);
        if (analyzeResult === false) {
            const typo3Version = detectTypo3Version(
                vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath,
            );
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

function analyzeTemplate(document: TextDocument): TemplateValidatorResult|null|false {
    if (document.uri.scheme !== 'file' || (document.languageId !== 'fluid' && document.languageId !== 'html-fluid')) {
        return null;
    }
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath;
    if (!workspaceFolder) {
        return null;
    }

    // Try to get right binary from runtime cache
    if (binaryPathCache[workspaceFolder]) {
        const data = tryAndVerifyAnalyzeCommand(binaryPathCache[workspaceFolder], document.getText(), workspaceFolder);
        if (data) {
            return data;
        }
    }

    // Go through binary alternatives to find the best candidate
    const candidates = binaryCandidates(workspaceFolder, config, {
        typo3: ['fluid:analyze', '--json', '--stdin'],
        fluid: ['analyze', '--json', '--stdin'],
    });

    for (const candidate of candidates) {
        const data = tryAndVerifyAnalyzeCommand(candidate, document.getText(), workspaceFolder);
        if (data) {
            binaryPathCache[workspaceFolder] = candidate;
            logChannel.info(
                `Using "${readableCommand(candidate)}" as binary to analyze templates in "${workspaceFolder}".`,
            );
            return data;
        }
    }
    const unavailableBinaries = candidates.map(readableCommand).join("\n");
    logChannel.error(`Unable to find suitable fluid binary for templates in "${workspaceFolder}. Usual binaries are not available: \n${unavailableBinaries}`)
    return false;
}

function detectTypo3Version(workspaceFolder: string|undefined): number|null
{
    if (!workspaceFolder) {
        return null;
    }

    // Go through binary alternatives to find the best candidate
    // TODO optimize this to avoid duplicate calls to non-existent binaries
    for (const candidate of binaryCandidates(workspaceFolder, config, { typo3: ['--version'] })) {
        const process = spawnSync(candidate.command, candidate.args, { cwd: workspaceFolder });
        if (!process.stdout) {
            continue;
        }
        const versionOutput = process.stdout?.toString() ?? '';
        const versionMatch = versionOutput.match(/TYPO3 CMS ([0-9]+)\.[0-9]+\.[0-9]+/);
        if (versionMatch && versionMatch[1]) {
            return Number(versionMatch[1]);
        }
    }
    return null;
}

function tryAndVerifyAnalyzeCommand(command: BinaryCommand, input: string, cwd: string): TemplateValidatorResult|null {
    const readableCommand = [command.command, ...command.args].join(' ');
    let rawResult, rawError, errorCode;
    try {
        const process = spawnSync(command.command, command.args, { input, cwd });
        errorCode = process.status;
        rawError = process.stderr?.toString();
        rawResult = process.stdout?.toString();
        const data = JSON.parse(rawResult);
        if (validateFluidAnalyzeResult(data)) {
            return data;
        } else if (command.userDefined && validateFluidAnalyzeResult.errors) {
            // Log validation errors for user-defined binaries to help with debugging
            const errorMessages = validateFluidAnalyzeResult.errors.map(error => error.message).join('. ');
            logChannel.error(`JSON validation failed while executing user-defined fluid binary "${readableCommand}" in workspace folder "${cwd}": ${errorMessages}`);
        }
    } catch (error) {
        // Log errors for user-defined binaries to help with debugging
        if (command.userDefined) {
            logChannel.error(`Error while executing user-defined fluid binary "${readableCommand}" in workspace folder "${cwd}": ${error}`);
        }
    }
    if (rawResult) {
        logChannel.debug(`Possible fluid binary "${readableCommand}" in workspace folder "${cwd}" returned invalid result: ${rawResult}`);
    } else if (rawError) {
        logChannel.debug(`Possible fluid binary "${readableCommand}" in workspace folder "${cwd}" returned error message: ${rawError}`);
    } else {
        logChannel.debug(`Possible fluid binary "${readableCommand}" in workspace folder "${cwd}" returned error code: ${errorCode}`);
    }
    return null;
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
