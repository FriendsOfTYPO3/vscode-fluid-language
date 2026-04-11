import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ExtensionContext, TextDocument, DiagnosticCollection, WorkspaceConfiguration, LogOutputChannel } from 'vscode';
import * as vscode from 'vscode';
import Ajv, { ValidateFunction } from 'ajv';
import type { ExtensionConfiguration, BinaryCommand, TemplateValidatorResult } from './types';

const ajv = new Ajv();

const config: ExtensionConfiguration = {
    bin: {
        typo3: '',
        fluid: '',
        useDdevIfAvailable: true,
    },
    features: {
        liveTemplateAnalysis: true,
    }
}
let binaryPathCache: { [key: string]: BinaryCommand} = {};
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
            // Clear runtime cache on configuration changes
            binaryPathCache = {};
        }
    }));

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
    config.bin.fluid = configuration.get('bin.fluid') ?? '';
    config.bin.typo3 = configuration.get('bin.typo3') ?? '';
    config.bin.useDdevIfAvailable = configuration.get('useDdevIfAvailable') ?? true;
    config.features.liveTemplateAnalysis = configuration.get('features.liveTemplateAnalysis') ?? true;
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
            const typo3Version = detectTypo3Version(document);
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
    const candidates: BinaryCommand[] = [];
    const isDdevProject = config.bin.useDdevIfAvailable ? fs.existsSync(path.join(workspaceFolder, '.ddev')) : false;
    const ddev = isDdevProject ? spawnSync('which', ['ddev'], { shell: true }).stdout.toString().trim() : '';

    if (config.bin.typo3) {
        candidates.push({
            command: config.bin.typo3.replaceAll('${workspaceFolder}', workspaceFolder),
            args: ['fluid:analyze', '--json', '--stdin'],
            userDefined: true,
        });
    }
    if (config.bin.fluid) {
        candidates.push({
            command: config.bin.fluid.replaceAll('${workspaceFolder}', workspaceFolder),
            args: ['analyze', '--json', '--stdin'],
            userDefined: true,
        });
    }
    if (isDdevProject && ddev) {
        candidates.push({
            command: ddev,
            args: ['typo3', 'fluid:analyze', '--json', '--stdin'],
        });
    }
    for (const typo3Binary of ['vendor/bin/typo3', 'bin/typo3', '.Build/bin/typo3']) {
        candidates.push({
            command: path.join(workspaceFolder, typo3Binary),
            args: ['fluid:analyze', '--json', '--stdin'],
        });
    }
    const fluidBinaryPaths = ['vendor/bin/fluid', 'bin/fluid', '.Build/bin/fluid'];
    if (isDdevProject && ddev) {
        for (const fluidBinary of fluidBinaryPaths) {
            candidates.push({
                command: ddev,
                args: ['exec', fluidBinary, 'analyze', '--json', '--stdin'],
            });
        }
    }
    for (const fluidBinary of fluidBinaryPaths) {
        candidates.push({
            command: fluidBinary,
            args: ['analyze', '--json', '--stdin'],
        });
    }

    for (const candidate of candidates) {
        const data = tryAndVerifyAnalyzeCommand(candidate, document.getText(), workspaceFolder);
        if (data) {
            binaryPathCache[workspaceFolder] = candidate;
            const readableCommand = [candidate.command, ...candidate.args].join(' ');
            logChannel.info(`Using "${readableCommand}" as binary to analyze templates in "${workspaceFolder}".`);
            return data;
        }
    }
    const unavailableBinaries = candidates.map(candidate => [candidate.command, ...candidate.args].join(' ')).join("\n");
    logChannel.error(`Unable to find suitable fluid binary for templates in "${workspaceFolder}. Usual binaries are not available: \n${unavailableBinaries}`)
    return false;
}

function detectTypo3Version(document: TextDocument): number|null
{
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath;
    if (!workspaceFolder) {
        return null;
    }

    // Go through binary alternatives to find the best candidate
    const candidates: BinaryCommand[] = [];
    const isDdevProject = config.bin.useDdevIfAvailable ? fs.existsSync(path.join(workspaceFolder, '.ddev')) : false;
    const ddev = isDdevProject ? spawnSync('which', ['ddev'], { shell: true }).stdout.toString().trim() : '';

    // TODO optimize this to avoid duplicate calls to non-existent binaries
    if (config.bin.typo3) {
        candidates.push({
            command: config.bin.typo3.replaceAll('${workspaceFolder}', workspaceFolder),
            args: ['--version'],
            userDefined: true,
        });
    }
    if (isDdevProject && ddev) {
        candidates.push({
            command: ddev,
            args: ['typo3', '--version'],
        });
    }
    for (const typo3Binary of ['vendor/bin/typo3', 'bin/typo3', '.Build/bin/typo3']) {
        candidates.push({
            command: path.join(workspaceFolder, typo3Binary),
            args: ['--version'],
        });
    }
    for (const candidate of candidates) {
        const process = spawnSync(candidate.command, candidate.args);
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
