// unit-scc: units utils/planted and types/planted import each other at runtime.
import { plantedB } from '../../types/planted/b';
export const plantedA = (): number => plantedB() + 1;
