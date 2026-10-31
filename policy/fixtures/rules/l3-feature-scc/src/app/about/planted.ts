// l3-feature-scc: app/about and app/budget import each other at runtime.
import { budgetPlanted } from '../budget/planted';
export const aboutPlanted = (): number => budgetPlanted() + 1;
