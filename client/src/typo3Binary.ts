import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { BinaryCommand, CommandResult, ExtensionConfiguration } from './types';

const TYPO3_BINARIES = ['vendor/bin/typo3', 'bin/typo3', '.Build/bin/typo3'];
const FLUID_BINARIES = ['vendor/bin/fluid', 'bin/fluid', '.Build/bin/fluid'];

/**
 * Possible commands to run a TYPO3 and/or standalone Fluid subcommand in a workspace,
 * in order of preference: user-defined binaries, then ddev, then vendor/bin, bin and .Build/bin.
 * TYPO3 candidates are preferred over Fluid candidates at each of these levels.
 *
 * @example binaryCandidates(workspaceFolder, config, { typo3: ['--version'] })
 */
export function binaryCandidates(
    workspaceFolder: string,
    config: ExtensionConfiguration,
    subcommand: { typo3?: string[], fluid?: string[] },
): BinaryCommand[] {
    const { typo3, fluid } = subcommand;
    const ddev = ddevForWorkspace(workspaceFolder, config);
    const candidates: BinaryCommand[] = [];

    if (typo3 && config.bin.typo3.path) {
        candidates.push(userDefinedCandidate(config.bin.typo3, typo3, workspaceFolder));
    }
    if (fluid && config.bin.fluid.path) {
        candidates.push(userDefinedCandidate(config.bin.fluid, fluid, workspaceFolder));
    }
    if (typo3) {
        if (ddev) {
            candidates.push({ command: ddev, args: ['typo3', ...typo3] });
        }
        for (const binary of TYPO3_BINARIES) {
            candidates.push({ command: path.join(workspaceFolder, binary), args: [...typo3] });
        }
    }
    if (fluid) {
        if (ddev) {
            for (const binary of FLUID_BINARIES) {
                candidates.push({ command: ddev, args: ['exec', binary, ...fluid] });
            }
        }
        for (const binary of FLUID_BINARIES) {
            candidates.push({ command: binary, args: [...fluid] });
        }
    }
    return candidates;
}

export function readableCommand(command: BinaryCommand): string {
    return [command.command, ...command.args].join(' ');
}

/**
 * Runs a command without blocking the extension host. Never rejects: a missing
 * binary, a crash and a timeout all surface as an unsuccessful result.
 *
 * @param input Passed to the command via stdin. Without it, stdin is closed right
 *              away, so that a command asking a question fails instead of hanging.
 */
export function runCommand(
    command: BinaryCommand,
    cwd: string,
    timeout: number,
    input?: string,
): Promise<CommandResult> {
    return new Promise(resolve => {
        let child;
        try {
            child = spawn(command.command, command.args, { cwd, stdio: 'pipe' });
        } catch (error) {
            resolve({ stdout: '', stderr: String(error), status: null });
            return;
        }
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', chunk => stdout += chunk.toString());
        child.stderr.on('data', chunk => stderr += chunk.toString());
        // A command that exits without reading its input closes the pipe early,
        // which surfaces through its exit code rather than as a write error.
        child.stdin.on('error', () => {});
        child.stdin.end(input);
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

/** The ddev binary to use for a workspace folder, if the project has DDEV set up. */
function ddevForWorkspace(workspaceFolder: string, config: ExtensionConfiguration): string|null {
    if (!config.bin.useDdevIfAvailable || !fs.existsSync(path.join(workspaceFolder, '.ddev'))) {
        return null;
    }
    return spawnSync('which', ['ddev'], { shell: true }).stdout?.toString().trim() || null;
}

function userDefinedCandidate(
    binary: { path: string, args: string[] },
    subcommand: string[],
    workspaceFolder: string,
): BinaryCommand {
    return {
        command: substituteWorkspaceFolder(binary.path, workspaceFolder),
        args: [...binary.args.map(arg => substituteWorkspaceFolder(arg, workspaceFolder)), ...subcommand],
        userDefined: true,
    };
}

function substituteWorkspaceFolder(value: string, workspaceFolder: string): string {
    return value.replaceAll('${workspaceFolder}', workspaceFolder);
}
