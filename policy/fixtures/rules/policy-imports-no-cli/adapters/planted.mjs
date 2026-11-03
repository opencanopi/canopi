// Planted violation of policy-imports-no-cli (2.1-M348): an adapter importing the checker's and the gate's CLIs
// instead of their libraries.
import { closedBeadCheck } from '../../../../beads.mjs';
import '../../../../check.mjs';
import '../../../../gate/cli.ts';

export const planted = closedBeadCheck;
