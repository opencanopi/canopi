// The knip rule's planted violation (2.1-M225): main.ts reads one of lib.ts's two exports.
import { used } from './lib';

console.log(used);
