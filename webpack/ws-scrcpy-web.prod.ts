import { backend, frontend, libraryUmdConfig, libraryEsmConfig } from './ws-scrcpy-web.common';
import webpack from 'webpack';

const prodOpts: webpack.Configuration = {
    mode: 'production',
};

const front = () => Object.assign({}, frontend(), prodOpts);
const back = () => Object.assign({}, backend(), prodOpts);
const libUmd = () => Object.assign({}, libraryUmdConfig(), prodOpts);
const libEsm = () => Object.assign({}, libraryEsmConfig(), prodOpts);

module.exports = [front, back, libUmd, libEsm];
