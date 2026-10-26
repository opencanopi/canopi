import { aboutPlanted } from '../about/planted';
export const budgetPlanted = (): number => (aboutPlanted.length > 0 ? 0 : 1);
