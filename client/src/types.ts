import type { LogOutputChannel } from 'vscode';

export interface TemplateValidatorResult {
    identifier: string,
    path: string,
    errors: TemplateValidatorResultError[],
    deprecations: TemplateValidatorResultDeprecation[],
}

interface TemplateValidatorResultError {
    file: string,
    line: number,
    message: string,
    templateLocation?: {
        identifierOrPath: string,
        line: number,
        character: number,
    },
}

interface TemplateValidatorResultDeprecation {
    file: string,
    line: number,
    message: string
}

export interface BinaryCommand {
    command: string,
    args: string[],
    userDefined?: boolean
}

export interface CommandResult {
    stdout: string,
    stderr: string,
    /** Exit code, or null when the command could not be executed at all */
    status: number|null,
}

export interface ExtensionConfiguration {
    bin: {
        typo3: {
            path: string,
            args: string[],
        },
        fluid: {
            path: string,
            args: string[],
        },
        useDdevIfAvailable: boolean,
    },
    features: {
        liveTemplateAnalysis: boolean,
        viewHelperDefinitions: boolean,
    },
}

export interface ViewHelperReference {
    alias: string,
    name: string,
    start: number,
    end: number,
}

/** Raw `fluid:namespaces --json` output: each alias with its PHP namespace chain */
export type FluidNamespaceMap = Record<string, (string|null)[]|null>;

export interface ViewHelperContext {
    isEnabled: () => boolean,
    /** Commands that could run the given `typo3` subcommand, best candidate first */
    candidates: (workspaceFolder: string, args: string[]) => BinaryCommand[],
    /** Called when the ViewHelper namespaces of a workspace folder cannot be determined */
    onUnavailable: (workspaceFolder: string) => void,
    logChannel: LogOutputChannel,
}

export interface ViewHelperIndex {
    /** ViewHelper namespace alias, e.g. "f", to the PHP namespaces registered for it */
    namespaces: Map<string, string[]>,
    /** PSR-4 prefixes with their directories, longest prefix first */
    psr4: [string, string[]][],
    /** Resolved class name to file, null when the class does not exist */
    classFiles: Map<string, string|null>,
}
