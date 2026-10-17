import { PERMISSION_KEYS } from '../src/types.ts';
export const ALL_FALSE_FOR_TEST = Object.fromEntries(PERMISSION_KEYS.map((k) => [k, false]));
