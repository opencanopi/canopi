// Planted violation of policy-imports-no-cli (2.1-M348): an adapter importing the checker's CLI instead of policy/core.
import { closedBeadCheck } from '../../../../beads.mjs';
import '../../../../check.mjs';

export const planted = closedBeadCheck;
