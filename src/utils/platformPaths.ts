import * as path from 'path';

/** Common virtual-environment directory names probed at workspace root. */
export const COMMON_VENV_NAMES = [
    '.venv', 'venv', 'env', '.env', '.virtualenv', 'virtualenv', '.conda', 'pyenv',
];

/**
 * Classifies the well-known directories where each tool stores its envs.
 * Split by concern so callers can watch exactly the right directories.
 */
export interface KnownPaths {
    /** Directories whose immediate sub-dirs are virtual environments (pyvenv.cfg present). */
    venvManagerDirs: string[];
    /** Directories whose sub-dirs are named-tool envs (uv tool / pipx). */
    toolsDirs: string[];
    /** Directories whose sub-dirs are Python version installs (pyenv, uv python). */
    pythonInstallDirs: string[];
}

/**
 * Returns the platform-appropriate well-known env storage paths for the
 * given home directory. Respects XDG_DATA_HOME / XDG_CACHE_HOME on Linux.
 */
export function getKnownPaths(homeDir: string): KnownPaths {
    if (process.platform === 'win32') {
        const appData      = process.env.APPDATA      ?? '';
        const localAppData = process.env.LOCALAPPDATA ?? '';
        return {
            venvManagerDirs: [
                path.join(homeDir,      '.virtualenvs'),
                path.join(homeDir,      'Envs'),
                path.join(appData,      'pypoetry', 'Cache', 'virtualenvs'),
                path.join(localAppData, 'pypoetry', 'Cache', 'virtualenvs'),
                path.join(localAppData, 'pypa', 'pipenv', 'venvs'),
                path.join(localAppData, 'hatch', 'env', 'virtual'),
                path.join(appData,      'pdm', 'venvs'),
                path.join(localAppData, 'pdm', 'venvs'),
                path.join(homeDir,      '.tox'),
                path.join(homeDir,      '.nox'),
            ],
            toolsDirs: [
                path.join(localAppData, 'uv', 'tools'),
                path.join(homeDir,      '.local', 'share', 'pipx', 'venvs'),
            ],
            pythonInstallDirs: [
                path.join(homeDir,      '.pyenv', 'pyenv-win', 'versions'),
                path.join(localAppData, 'uv', 'python'),
            ],
        };
    }

    if (process.platform === 'darwin') {
        return {
            venvManagerDirs: [
                path.join(homeDir, '.virtualenvs'),
                path.join(homeDir, 'Library', 'Caches',             'pypoetry', 'virtualenvs'),
                path.join(homeDir, '.cache',                         'pypoetry', 'virtualenvs'),
                path.join(homeDir, '.local', 'share',                'virtualenvs'),
                path.join(homeDir, 'Library', 'Application Support', 'hatch', 'env', 'virtual'),
                path.join(homeDir, 'Library', 'Application Support', 'pdm', 'venvs'),
                path.join(homeDir, '.tox'),
                path.join(homeDir, '.nox'),
                path.join(homeDir, '.direnv'),
            ],
            toolsDirs: [
                path.join(homeDir, '.local', 'share', 'uv',   'tools'),
                path.join(homeDir, '.local', 'share', 'pipx', 'venvs'),
            ],
            pythonInstallDirs: [
                path.join(homeDir, '.pyenv', 'versions'),
                path.join(homeDir, '.local', 'share', 'uv', 'python'),
            ],
        };
    }

    // Linux — respect XDG base directories
    const xdgData  = process.env.XDG_DATA_HOME  ?? path.join(homeDir, '.local', 'share');
    const xdgCache = process.env.XDG_CACHE_HOME ?? path.join(homeDir, '.cache');
    return {
        venvManagerDirs: [
            path.join(homeDir,  '.virtualenvs'),
            path.join(xdgCache, 'pypoetry', 'virtualenvs'),
            path.join(xdgData,  'virtualenvs'),
            path.join(xdgData,  'hatch', 'env', 'virtual'),
            path.join(xdgData,  'pdm', 'venvs'),
            path.join(homeDir,  '.tox'),
            path.join(homeDir,  '.nox'),
            path.join(homeDir,  '.direnv'),
        ],
        toolsDirs: [
            path.join(xdgData, 'uv',   'tools'),
            path.join(xdgData, 'pipx', 'venvs'),
        ],
        pythonInstallDirs: [
            path.join(homeDir, '.pyenv', 'versions'),
            path.join(xdgData, 'uv',    'python'),
        ],
    };
}
