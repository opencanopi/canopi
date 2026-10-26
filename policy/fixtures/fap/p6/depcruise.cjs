// The generated Desktop config's options (policy/generate.mjs), no rules, cruising only this probe's src/.
const base = require('../../../../desktop/web/.dependency-cruiser.cjs');
module.exports = {
  forbidden: [],
  options: { ...base.options, includeOnly: [...base.options.includeOnly, '^\\.\\./\\.\\./policy/fixtures/fap/p6/src/'] },
};
