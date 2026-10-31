// no-runtime-cycle: two modules import each other's values.
import { plantedB } from './planted-b';
export const plantedA = (): number => plantedB() + 1;
