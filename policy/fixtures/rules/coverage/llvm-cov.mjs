// A planted violation of the coverage family (policy/ratchets/coverage.json): the gate's coverage run with its region
// floor lowered, built as policy/gate/llvm-cov.mjs builds it.
export const llvmCovArgs = () => ['llvm-cov', '--workspace', '--locked', '--summary-only', '--ignore-filename-regex',
  'rust_engine/comparison\\.rs', '--fail-under-lines', '88.2', '--fail-under-functions', '77.1', '--fail-under-regions', '80'];
