import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { BinaryCommand, CommandResult, ExtensionConfiguration } from './types';

const TYPO3_BINARIES = ['vendor/bin/typo3', 'bin/typo3', '.Build/bin/typo3'];
const FLUID_BINARIES = ['vendor/bin/fluid', 'bin/fluid', '.Build/bin/fluid'];

let ddevBinary: string|null|undefined;

/** Location of the ddev binary, looked up once per session. */
function ddevPath(): string|null {
    if (ddevBinary === undefined) {
        ddevBinary = spawnSync('which', ['ddev'], { shell: true }).stdout?.toString().trim() || null;
    }
    return ddevBinary;
}

/** The ddev binary to use for a workspace folder, if the project has DDEV set up. */
function ddevForWorkspace(workspaceFolder: string, config: ExtensionConfiguration): string|null {
    if (!config.bin.useDdevIfAvailable || !fs.existsSync(path.join(workspaceFolder, '.ddev'))) {
        return null;
    }
    return ddevPath();
}

function substitute(value: string, workspaceFolder: string): string {
    return value.replaceAll('${workspaceFolder}', workspaceFolder);
}

/** Commands that could run a `typo3` subcommand, e. g. ["fluid:namespaces", "--json"]. */
export function typo3Candidates(
    workspaceFolder: string,
    config: ExtensionConfiguration,
    args: string[],
): BinaryCommand[] {
    const candidates: BinaryCommand[] = [];
    if (config.bin.typo3.path) {
        candidates.push({
            command: substitute(config.bin.typo3.path, workspaceFolder),
            args: [...config.bin.typo3.args.map(arg => substitute(arg, workspaceFolder)), ...args],
            userDefined: true,
        });
    }
    const ddev = ddevForWorkspace(workspaceFolder, config);
    if (ddev) {
        candidates.push({ command: ddev, args: ['typo3', ...args] });
    }
    for (const binary of TYPO3_BINARIES) {
        candidates.push({ command: path.join(workspaceFolder, binary), args: [...args] });
    }
    return candidates;
}

/** Commands that could run a standalone `fluid` subcommand, e. g. ["analyze", "--json"]. */
export function fluidCandidates(
    workspaceFolder: string,
    config: ExtensionConfiguration,
    args: string[],
): BinaryCommand[] {
    const candidates: BinaryCommand[] = [];
    if (config.bin.fluid.path) {
        candidates.push({
            command: substitute(config.bin.fluid.path, workspaceFolder),
            args: [...config.bin.fluid.args.map(arg => substitute(arg, workspaceFolder)), ...args],
            userDefined: true,
        });
    }
    const ddev = ddevForWorkspace(workspaceFolder, config);
    if (ddev) {
        for (const binary of FLUID_BINARIES) {
            candidates.push({ command: ddev, args: ['exec', binary, ...args] });
        }
    }
    for (const binary of FLUID_BINARIES) {
        candidates.push({ command: binary, args: [...args] });
    }
    return candidates;
}

/** User-defined candidates first, so that an explicit configuration always wins. */
export function orderedCandidates(...lists: BinaryCommand[][]): BinaryCommand[] {
    return [
        ...lists.flatMap(list => list.filter(candidate => candidate.userDefined)),
        ...lists.flatMap(list => list.filter(candidate => !candidate.userDefined)),
    ];
}

export function readableCommand(command: BinaryCommand): string {
    return [command.command, ...command.args].join(' ');
}

/**
 * Runs a command without blocking the extension host. Never rejects: a missing
 * binary, a crash and a timeout all surface as an unsuccessful result.
 */
export function runCommand(command: BinaryCommand, cwd: string, timeout: number): Promise<CommandResult> {
    return new Promise(resolve => {
        let child;
        try {
            // stdin is closed, so that a command asking a question fails instead of hanging.
            child = spawn(command.command, command.args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
        } catch (error) {
            resolve({ stdout: '', stderr: String(error), status: null });
            return;
        }
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', chunk => stdout += chunk.toString());
        child.stderr.on('data', chunk => stderr += chunk.toString());
        const timer = setTimeout(() => {
            stderr += `Command did not finish within ${timeout} ms.`;
            child.kill();
        }, timeout);
        const finish = (status: number|null) => {
            clearTimeout(timer);
            resolve({ stdout, stderr, status });
        };
        child.on('error', error => {
            stderr += String(error);
            finish(null);
        });
        child.on('close', status => finish(status));
    });
}
