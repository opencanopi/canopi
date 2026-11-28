// Loads policy/layers.json and policy/rules.json dynamically at runtime (Ch5, ADR 0022).
'use strict';
const path = require('node:path');
const { loadDepcruiseConfig } = require('../../policy/generate/depcruise.mjs');

module.exports = loadDepcruiseConfig('desktop', path.resolve(__dirname, '../..'));
