import path from 'path';
import webpack from 'webpack';
import { readFileSync } from 'fs';
import MiniCssExtractPlugin from 'mini-css-extract-plugin';

export const PROJECT_ROOT = path.resolve(__dirname, '..');
export const SERVER_DIST_PATH = path.join(PROJECT_ROOT, 'dist');
export const CLIENT_DIST_PATH = path.join(PROJECT_ROOT, 'dist/public');

const buildConfigDefinePlugin = new webpack.DefinePlugin({
    '__PATHNAME__': JSON.stringify('/'),
});

const pkgVersion: string = JSON.parse(
    readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf-8'),
).version;

const versionDefinePlugin = new webpack.DefinePlugin({
    '__WSSCRCPY_VERSION__': JSON.stringify(pkgVersion),
});

// Inline plugin: generates a minimal package.json in dist/
class GenerateDistPackageJsonPlugin {
    apply(compiler: webpack.Compiler) {
        compiler.hooks.compilation.tap('GenerateDistPackageJsonPlugin', (compilation) => {
            compilation.hooks.processAssets.tap(
                {
                    name: 'GenerateDistPackageJsonPlugin',
                    stage: webpack.Compilation.PROCESS_ASSETS_STAGE_ADDITIONAL,
                },
                () => {
                    const pkg = {
                        name: 'ws-scrcpy-web',
                        version: '1.0.0',
                        scripts: { start: 'node index.js' },
                        dependencies: {
                            'node-pty': '^0.10.1',
                            'ws': '^8.18.0',
                        },
                    };
                    const content = JSON.stringify(pkg, null, 2);
                    compilation.emitAsset(
                        'package.json',
                        new webpack.sources.RawSource(content),
                    );
                },
            );
        });
    }
}

// Inline plugin: copies public/index.html into dist/public/
class CopyIndexHtmlPlugin {
    constructor(private src: string, private dest: string) {}
    apply(compiler: webpack.Compiler) {
        compiler.hooks.afterEmit.tapAsync('CopyIndexHtmlPlugin', (_: webpack.Compilation, callback: () => void) => {
            const fs = require('fs') as typeof import('fs');
            const destDir = path.dirname(this.dest);
            fs.mkdirSync(destDir, { recursive: true });
            fs.copyFileSync(this.src, this.dest);
            callback();
        });
    }
}

export const common = () => {
    return {
        module: {
            rules: [
                {
                    test: /\.css$/i,
                    use: [MiniCssExtractPlugin.loader, 'css-loader'],
                },
                {
                    test: /\.tsx?$/,
                    use: [{ loader: 'ts-loader', options: { transpileOnly: true } }],
                    exclude: /node_modules/,
                },
                {
                    test: /\.svg$/,
                    type: 'asset/source',
                },
                {
                    test: /\.(png|jpe?g|gif)$/i,
                    type: 'asset/resource',
                },
                {
                    test: /[\\/]assets[\\/]scrcpy-server/,
                    type: 'asset/resource',
                    generator: {
                        filename: 'assets/scrcpy-server',
                    },
                },
            ],
        },
        resolve: {
            extensions: ['.tsx', '.ts', '.js'],
        },
    };
};

const front: webpack.Configuration = {
    entry: path.join(PROJECT_ROOT, './src/app/index.ts'),
    externals: ['fs'],
    plugins: [
        new MiniCssExtractPlugin({ filename: 'bundle.css' }),
        new CopyIndexHtmlPlugin(
            path.resolve(PROJECT_ROOT, 'public/index.html'),
            path.resolve(CLIENT_DIST_PATH, 'index.html'),
        ),
    ],
    resolve: {
        extensions: ['.tsx', '.ts', '.js'],
    },
    output: {
        filename: 'bundle.js',
        path: CLIENT_DIST_PATH,
    },
};

export const frontend = () => {
    return Object.assign({}, common(), front);
};

const back: webpack.Configuration = {
    entry: path.join(PROJECT_ROOT, './src/server/index.ts'),
    externals: [/^[a-z@]/],
    externalsType: 'commonjs',
    plugins: [
        new GenerateDistPackageJsonPlugin(),
        buildConfigDefinePlugin,
    ],
    node: {
        global: false,
        __filename: false,
        __dirname: false,
    },
    output: {
        filename: 'index.js',
        path: SERVER_DIST_PATH,
    },
    target: 'node',
};

export const backend = () => {
    return Object.assign({}, common(), back);
};

export { versionDefinePlugin };

// Clone common()'s module.rules but swap the CSS rule to use style-loader
// instead of MiniCssExtractPlugin.loader (used by the ESM library config which
// drops the MiniCssExtractPlugin). This keeps ONE source of truth for non-CSS
// rules — new loaders added to common() automatically flow into the ESM build.
function esmModuleRules(): webpack.RuleSetRule[] {
    const baseRules = (common().module?.rules ?? []) as webpack.RuleSetRule[];
    return baseRules.map((rule) => {
        const test = (rule as { test?: RegExp }).test;
        if (test instanceof RegExp && test.source === /\.css$/i.source) {
            return { test: /\.css$/i, use: ['style-loader', 'css-loader'] };
        }
        return rule;
    });
}

const libraryCommon = {
    entry: path.join(PROJECT_ROOT, './src/app/public/index.ts'),
    externals: ['fs'],
    plugins: [
        new MiniCssExtractPlugin({ filename: 'ws-scrcpy.css' }),
        versionDefinePlugin,
    ],
    resolve: {
        extensions: ['.tsx', '.ts', '.js'],
    },
};

const libraryUmd: webpack.Configuration = {
    ...libraryCommon,
    output: {
        filename: 'ws-scrcpy.umd.js',
        path: CLIENT_DIST_PATH,
        library: { name: 'WsScrcpy', type: 'umd', export: undefined },
        globalObject: 'globalThis',
    },
};

const libraryEsm: webpack.Configuration = {
    ...libraryCommon,
    experiments: { outputModule: true },
    output: {
        filename: 'ws-scrcpy.esm.js',
        path: CLIENT_DIST_PATH,
        library: { type: 'module' },
    },
    module: { rules: esmModuleRules() },
    plugins: [versionDefinePlugin],
};

export const libraryUmdConfig = () => Object.assign({}, common(), libraryUmd);
export const libraryEsmConfig = () => Object.assign({}, common(), libraryEsm);
