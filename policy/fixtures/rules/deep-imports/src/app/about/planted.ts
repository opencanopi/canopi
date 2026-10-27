// deep-imports: app/about imports a file of app/budget/, which has an index.ts, past that index.
import { inner } from '../budget/inner';
export const planted = inner;
