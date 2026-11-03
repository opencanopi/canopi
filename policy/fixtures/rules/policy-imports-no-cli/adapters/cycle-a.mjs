// Planted violation of policy-imports-no-cli:no-circular (2.1-M348): two policy modules importing each other.
import { b } from './cycle-b.mjs';

export const a = () => b;
