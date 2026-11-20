import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { CancellationToken, Position, TextDocument } from 'vscode';
import { readableCommand, runCommand } from './typo3Binary';
import type { FluidNamespaceMap, ViewHelperContext, ViewHelperIndex, ViewHelperReference } from './types';

const TAG_PATTERN = /<\/?([a-z][a-z0-9]*):([a-zA-Z0-9.]+)/g;
const INLINE_PATTERN = /([a-z][a-z0-9]*):([a-zA-Z0-9.]+)\s*\(/g;
const XMLNS_PATTERN = /xmlns:([A-Za-z0-9_]+)\s*=\s*["']http:\/\/typo3\.org\/ns\/([^"']+)["']/g;
const NAMESPACE_TAG_PATTERN = /\{namespace\s+([A-Za-z0-9_]+)\s*=\s*([A-Za-z0-9_\\]+)\s*\}/g;
const PSR4_ENTRY_PATTERN = /'((?:[^'\\]|\\.)+)'\s*=>\s*array\(([^)]*)\)/g;
const PSR4_DIRECTORY_PATTERN = /\$(vendorDir|baseDir)\s*\.\s*'([^']+)'/g;
const CLASS_PATTERN = /^[ \t]*(?:final\s+|abstract\s+|readonly\s+)*class\s+[A-Za-z0-9_]+/m;

/**
 * A warm DDEV project answers in about half a second, a cold one can take
 * considerably longer, so this is generous on purpose. A missing binary fails
 * within milliseconds and never waits for it.
 */
const NAMESPACES_TIMEOUT = 60000;

const indexCache = new Map<string, Promise<ViewHelperIndex|null>>();

export function clearViewHelperIndexCache(): void {
    indexCache.clear();
}

function readFile(file: string): string|null {
    try {
        return fs.readFileSync(file, 'utf-8');
    } catch {
        return null;
    }
}

function isNamespaceMap(data: unknown): data is FluidNamespaceMap {
    if (typeof data !== 'object' || data === null || Array.isArray(data)) {
        return false;
    }
    return Object.values(data).every(chain => chain === null || (
        Array.isArray(chain) && chain.every(entry => typeof entry === 'string' || entry === null)
    ));
}

/**
 * The JSON object of the command output, looked up from the last line, because
 * console wrappers and PHP warnings can precede it.
 */
export function parseNamespaceMap(stdout: string): FluidNamespaceMap|null {
    const lines = stdout.split('\n').map(line => line.trim()).filter(line => line !== '').reverse();
    for (const line of lines) {
        let data: unknown;
        try {
            data = JSON.parse(line);
        } catch {
            continue;
        }
        if (isNamespaceMap(data)) {
            return data;
        }
    }
    return null;
}

/**
 * Aliases that cannot resolve to a class are dropped: a null chain marks a
 * namespace that Fluid ignores, null entries within a chain are skipped, and a
 * wildcard alias such as "ven*" does not name a namespace to look in.
 */
export function normalizeNamespaces(map: FluidNamespaceMap): Map<string, string[]> {
    const namespaces = new Map<string, string[]>();
    for (const [alias, chain] of Object.entries(map)) {
        if (chain === null || alias.includes('*')) {
            continue;
        }
        const phpNamespaces = chain.filter((entry): entry is string => entry !== null);
        if (phpNamespaces.length) {
            namespaces.set(alias, phpNamespaces);
        }
    }
    return namespaces;
}

/**
 * The global ViewHelper namespaces exactly as Fluid itself resolves them, from
 * `typo3 fluid:namespaces --json`. That command ships with TYPO3 v14.2 and is
 * backported to v12 and v13 by EXT:fluid_companion.
 */
async function readGlobalNamespaces(
    workspaceFolder: string,
    context: ViewHelperContext,
): Promise<Map<string, string[]>|null> {
    const args = ['fluid:namespaces', '--json', '--no-interaction'];
    const candidates = context.candidates(workspaceFolder, args);
    for (const candidate of candidates) {
        const result = await runCommand(candidate, workspaceFolder, NAMESPACES_TIMEOUT);
        const parsed = parseNamespaceMap(result.stdout);
        if (parsed) {
            context.logChannel.info(
                `Using "${readableCommand(candidate)}" to resolve ViewHelpers in "${workspaceFolder}".`,
            );
            return normalizeNamespaces(parsed);
        }
        const reason = result.stderr.trim() || result.stdout.trim() || `exit code ${result.status}`;
        context.logChannel.debug(
            `Possible typo3 binary "${readableCommand(candidate)}" did not return ViewHelper namespaces `
            + `in workspace folder "${workspaceFolder}": ${reason}`,
        );
    }
    const unavailableBinaries = candidates.map(readableCommand).join('\n');
    context.logChannel.error(
        `Unable to determine the ViewHelper namespaces of "${workspaceFolder}". `
        + `Usual binaries are not available: \n${unavailableBinaries}`,
    );
    return null;
}

/** Composer's generated PSR-4 map, longest namespace prefix first. */
function readPsr4Map(workspaceFolder: string): [string, string[]][] {
    const prefixes: [string, string[]][] = [];
    for (const vendorDirectory of ['vendor', path.join('.Build', 'vendor')]) {
        const vendorPath = path.join(workspaceFolder, vendorDirectory);
        const source = readFile(path.join(vendorPath, 'composer', 'autoload_psr4.php'));
        if (!source) {
            continue;
        }
        PSR4_ENTRY_PATTERN.lastIndex = 0;
        let entry: RegExpExecArray|null;
        while ((entry = PSR4_ENTRY_PATTERN.exec(source)) !== null) {
            const directories: string[] = [];
            PSR4_DIRECTORY_PATTERN.lastIndex = 0;
            let directory: RegExpExecArray|null;
            while ((directory = PSR4_DIRECTORY_PATTERN.exec(entry[2])) !== null) {
                directories.push((directory[1] === 'vendorDir' ? vendorPath : workspaceFolder) + directory[2]);
            }
            if (directories.length) {
                prefixes.push([entry[1].replaceAll('\\\\', '\\'), directories]);
            }
        }
    }
    prefixes.sort((a, b) => b[0].length - a[0].length);
    return prefixes;
}

async function createIndex(workspaceFolder: string, context: ViewHelperContext): Promise<ViewHelperIndex|null> {
    try {
        const namespaces = await readGlobalNamespaces(workspaceFolder, context);
        if (!namespaces) {
            return null;
        }
        return {
            namespaces,
            psr4: readPsr4Map(workspaceFolder),
            classFiles: new Map<string, string|null>(),
        };
    } catch (error) {
        context.logChannel.error(`Unable to index the ViewHelpers of "${workspaceFolder}": ${error}`);
        return null;
    }
}

/**
 * One index per workspace folder, shared by all lookups while it is being built.
 * A failed attempt is not kept, so that a later one can still succeed once the
 * project is reachable.
 */
function viewHelperIndex(workspaceFolder: string, context: ViewHelperContext): Promise<ViewHelperIndex|null> {
    const cached = indexCache.get(workspaceFolder);
    if (cached) {
        return cached;
    }
    const pending = createIndex(workspaceFolder, context);
    indexCache.set(workspaceFolder, pending);
    void pending.then(index => {
        if (!index && indexCache.get(workspaceFolder) === pending) {
            indexCache.delete(workspaceFolder);
        }
    });
    return pending;
}

/** Builds the index ahead of the first lookup, so that navigation is instant. */
export function warmViewHelperIndex(workspaceFolder: string, context: ViewHelperContext): void {
    if (context.isEnabled() && vscode.workspace.isTrusted) {
        void viewHelperIndex(workspaceFolder, context);
    }
}

/** Namespaces a single template declares itself. */
function documentNamespaces(text: string): Map<string, string[]> {
    const namespaces = new Map<string, string[]>();
    const add = (alias: string, phpNamespace: string) => {
        const known = namespaces.get(alias) ?? [];
        if (!known.includes(phpNamespace)) {
            known.push(phpNamespace);
        }
        namespaces.set(alias, known);
    };
    XMLNS_PATTERN.lastIndex = 0;
    let match: RegExpExecArray|null;
    while ((match = XMLNS_PATTERN.exec(text)) !== null) {
        add(match[1], match[2].replace(/\/+$/, '').split('/').join('\\'));
    }
    NAMESPACE_TAG_PATTERN.lastIndex = 0;
    while ((match = NAMESPACE_TAG_PATTERN.exec(text)) !== null) {
        add(match[1], match[2]);
    }
    return namespaces;
}

/** The ViewHelper the cursor sits on, in tag as well as in inline syntax. */
export function viewHelperAt(line: string, character: number): ViewHelperReference|null {
    const references: ViewHelperReference[] = [];
    TAG_PATTERN.lastIndex = 0;
    let match: RegExpExecArray|null;
    while ((match = TAG_PATTERN.exec(line)) !== null) {
        const end = match.index + match[0].length;
        references.push({ alias: match[1], name: match[2], start: end - (match[1].length + 1 + match[2].length), end });
    }
    INLINE_PATTERN.lastIndex = 0;
    while ((match = INLINE_PATTERN.exec(line)) !== null) {
        references.push({
            alias: match[1],
            name: match[2],
            start: match.index,
            end: match.index + match[1].length + 1 + match[2].length,
        });
    }
    return references.find(reference => character >= reference.start && character <= reference.end) ?? null;
}

/**
 * link.action becomes Link\ActionViewHelper, exactly as
 * ViewHelperCollection::resolveViewHelperClassName() does it.
 */
export function viewHelperClassName(name: string): string {
    return `${name.split('.').map(segment => segment.charAt(0).toUpperCase() + segment.slice(1)).join('\\')}ViewHelper`;
}

function classFile(index: ViewHelperIndex, className: string): string|null {
    const cached = index.classFiles.get(className);
    if (cached !== undefined) {
        return cached;
    }
    let resolved: string|null = null;
    for (const [phpNamespace, directories] of index.psr4) {
        if (!className.startsWith(phpNamespace)) {
            continue;
        }
        const relative = `${className.slice(phpNamespace.length).split('\\').join('/')}.php`;
        for (const directory of directories) {
            const candidate = path.join(directory, relative);
            if (fs.existsSync(candidate)) {
                resolved = candidate;
                break;
            }
        }
        if (resolved) {
            break;
        }
    }
    index.classFiles.set(className, resolved);
    return resolved;
}

/**
 * The class file a ViewHelper resolves to. Namespaces registered for an alias
 * are tried in reverse, because Fluid resolves the last registered namespace
 * first, which is what lets an extension override a core ViewHelper.
 */
function resolveViewHelperFile(
    reference: ViewHelperReference,
    index: ViewHelperIndex,
    declared: Map<string, string[]>,
): string|null {
    const candidates = [...(index.namespaces.get(reference.alias) ?? []), ...(declared.get(reference.alias) ?? [])];
    if (!candidates.length) {
        return null;
    }
    const className = viewHelperClassName(reference.name);
    for (const phpNamespace of candidates.reverse()) {
        const file = classFile(index, `${phpNamespace}\\${className}`);
        if (file) {
            return file;
        }
    }
    return null;
}

/** Position of the class declaration, so navigation skips the licence header. */
function classPosition(file: string): Position {
    const source = readFile(file);
    const match = source ? CLASS_PATTERN.exec(source) : null;
    if (!source || !match) {
        return new vscode.Position(0, 0);
    }
    return new vscode.Position(source.slice(0, match.index).split('\n').length - 1, 0);
}

export function createViewHelperDefinitionProvider(context: ViewHelperContext): vscode.DefinitionProvider {
    return {
        async provideDefinition(document: TextDocument, position: Position, token: CancellationToken) {
            // The namespaces are read by executing the project's typo3 binary.
            if (!context.isEnabled() || !vscode.workspace.isTrusted || document.uri.scheme !== 'file') {
                return undefined;
            }
            const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath;
            if (!workspaceFolder) {
                return undefined;
            }
            const reference = viewHelperAt(document.lineAt(position.line).text, position.character);
            if (!reference) {
                return undefined;
            }
            const index = await viewHelperIndex(workspaceFolder, context);
            if (token.isCancellationRequested) {
                return undefined;
            }
            if (!index) {
                context.onUnavailable(workspaceFolder);
                return undefined;
            }
            const file = resolveViewHelperFile(reference, index, documentNamespaces(document.getText()));
            if (!file) {
                context.logChannel.debug(
                    `Unable to resolve ViewHelper "${reference.alias}:${reference.name}" in "${workspaceFolder}".`,
                );
                return undefined;
            }
            return new vscode.Location(vscode.Uri.file(file), classPosition(file));
        },
    };
}
