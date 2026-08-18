import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { LogOutputChannel, Position, TextDocument } from 'vscode';
import type { ViewHelperIndex, ViewHelperReference } from './types';

const TAG_PATTERN = /<\/?([a-z][a-z0-9]*):([a-zA-Z0-9.]+)/g;
const INLINE_PATTERN = /([a-z][a-z0-9]*):([a-zA-Z0-9.]+)\s*\(/g;
const XMLNS_PATTERN = /xmlns:([A-Za-z0-9_]+)\s*=\s*["']http:\/\/typo3\.org\/ns\/([^"']+)["']/g;
const NAMESPACE_TAG_PATTERN = /\{namespace\s+([A-Za-z0-9_]+)\s*=\s*([A-Za-z0-9_\\]+)\s*\}/g;
const PSR4_ENTRY_PATTERN = /'((?:[^'\\]|\\.)+)'\s*=>\s*array\(([^)]*)\)/g;
const PSR4_DIRECTORY_PATTERN = /\$(vendorDir|baseDir)\s*\.\s*'([^']+)'/g;
const ALIAS_ENTRY_PATTERN = /'([A-Za-z0-9_]+)'\s*=>\s*(?:\[|array\()([^\])]*)/g;
const GLOBAL_REGISTRATION_PATTERN =
    /\['fluid'\]\['namespaces'\]\['([A-Za-z0-9_]+)'\](?:\[\])?\s*=\s*(\[[^\]]*\]|'(?:[^'\\]|\\.)+')/g;
const STRING_PATTERN = /'((?:[^'\\]|\\.)+)'/g;
const CLASS_PATTERN = /^[ \t]*(?:final\s+|abstract\s+|readonly\s+)*class\s+[A-Za-z0-9_]+/m;

// Fluid standalone registers this itself, see ViewHelperResolver. TYPO3 adds
// its own namespaces on top through Configuration/Fluid/Namespaces.php.
const BUILT_IN_NAMESPACES: Record<string, string[]> = {
    f: ['TYPO3Fluid\\Fluid\\ViewHelpers'],
};

const indexCache = new Map<string, ViewHelperIndex>();

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

function listDirectories(directory: string): string[] {
    try {
        return fs.readdirSync(directory, { withFileTypes: true })
            .filter(entry => !entry.name.startsWith('.'))
            .map(entry => path.join(directory, entry.name))
            .filter(candidate => fs.statSync(candidate).isDirectory());
    } catch {
        return [];
    }
}

/** Every directory that could be a TYPO3 package, mirroring composer layouts. */
function packageDirectories(workspaceFolder: string): string[] {
    const directories = [workspaceFolder];
    for (const relative of ['packages', path.join('typo3conf', 'ext')]) {
        directories.push(...listDirectories(path.join(workspaceFolder, relative)));
    }
    for (const vendorDirectory of ['vendor', path.join('.Build', 'vendor')]) {
        for (const vendor of listDirectories(path.join(workspaceFolder, vendorDirectory))) {
            directories.push(...listDirectories(vendor));
        }
    }
    return directories;
}

function addNamespace(namespaces: Map<string, string[]>, alias: string, phpNamespace: string): void {
    const known = namespaces.get(alias) ?? [];
    if (!known.includes(phpNamespace)) {
        known.push(phpNamespace);
    }
    namespaces.set(alias, known);
}

function collectStrings(source: string): string[] {
    const values: string[] = [];
    STRING_PATTERN.lastIndex = 0;
    let match: RegExpExecArray|null;
    while ((match = STRING_PATTERN.exec(source)) !== null) {
        values.push(match[1].replaceAll('\\\\', '\\'));
    }
    return values;
}

/** Globally registered ViewHelper namespaces of all installed packages. */
function readGlobalNamespaces(workspaceFolder: string): Map<string, string[]> {
    const namespaces = new Map<string, string[]>();
    for (const [alias, phpNamespaces] of Object.entries(BUILT_IN_NAMESPACES)) {
        for (const phpNamespace of phpNamespaces) {
            addNamespace(namespaces, alias, phpNamespace);
        }
    }

    for (const directory of packageDirectories(workspaceFolder)) {
        const configured = readFile(path.join(directory, 'Configuration', 'Fluid', 'Namespaces.php'));
        if (configured) {
            ALIAS_ENTRY_PATTERN.lastIndex = 0;
            let entry: RegExpExecArray|null;
            while ((entry = ALIAS_ENTRY_PATTERN.exec(configured)) !== null) {
                for (const phpNamespace of collectStrings(entry[2])) {
                    addNamespace(namespaces, entry[1], phpNamespace);
                }
            }
        }

        // Pre v13 extensions register their namespaces in ext_localconf.php.
        const legacy = readFile(path.join(directory, 'ext_localconf.php'));
        if (legacy) {
            GLOBAL_REGISTRATION_PATTERN.lastIndex = 0;
            let entry: RegExpExecArray|null;
            while ((entry = GLOBAL_REGISTRATION_PATTERN.exec(legacy)) !== null) {
                for (const phpNamespace of collectStrings(entry[2])) {
                    addNamespace(namespaces, entry[1], phpNamespace);
                }
            }
        }
    }
    return namespaces;
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

function buildIndex(workspaceFolder: string): ViewHelperIndex {
    const cached = indexCache.get(workspaceFolder);
    if (cached) {
        return cached;
    }
    const index: ViewHelperIndex = {
        namespaces: readGlobalNamespaces(workspaceFolder),
        psr4: readPsr4Map(workspaceFolder),
        classFiles: new Map<string, string|null>(),
    };
    indexCache.set(workspaceFolder, index);
    return index;
}

/** Namespaces a single template declares itself. */
function documentNamespaces(text: string): Map<string, string[]> {
    const namespaces = new Map<string, string[]>();
    XMLNS_PATTERN.lastIndex = 0;
    let match: RegExpExecArray|null;
    while ((match = XMLNS_PATTERN.exec(text)) !== null) {
        addNamespace(namespaces, match[1], match[2].replace(/\/+$/, '').split('/').join('\\'));
    }
    NAMESPACE_TAG_PATTERN.lastIndex = 0;
    while ((match = NAMESPACE_TAG_PATTERN.exec(text)) !== null) {
        addNamespace(namespaces, match[1], match[2]);
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

export function createViewHelperDefinitionProvider(
    isEnabled: () => boolean,
    logChannel: LogOutputChannel,
): vscode.DefinitionProvider {
    return {
        provideDefinition(document: TextDocument, position: Position) {
            if (!isEnabled() || document.uri.scheme !== 'file') {
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
            const index = buildIndex(workspaceFolder);
            const file = resolveViewHelperFile(reference, index, documentNamespaces(document.getText()));
            if (!file) {
                logChannel.debug(
                    `Unable to resolve ViewHelper "${reference.alias}:${reference.name}" in "${workspaceFolder}".`,
                );
                return undefined;
            }
            return new vscode.Location(vscode.Uri.file(file), classPosition(file));
        },
    };
}
